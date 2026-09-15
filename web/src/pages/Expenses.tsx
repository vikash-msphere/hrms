import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Ban, Paperclip, Download, Wallet, Check, X, Send, Repeat, Zap, Pencil, ClipboardCheck, Banknote, CalendarClock, ChevronDown, ChevronUp, Eye, Pause, Play, TriangleAlert, BarChart3, Camera } from "lucide-react";
import { create, patch, invoke, upload, download, get } from "@/api";
import { describeError } from "@/lib/formError";
import { sentence } from "@/lib/problemText";
import { useCollection } from "@/hooks/useCollection";
import { useDebounced } from "@/hooks/useDebounced";
import { useMedia } from "@/hooks/useMedia";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { useRoute } from "@/router";
import { formatDate, formatMoney, idOf, cn } from "@/lib/utils";
import { orgDayOf, thisMonthStr, todayStr } from "@/lib/orgDay";
import { useOrg, currencyDecimals } from "@/lib/org";
import { bulkInvoke, bulkSummary } from "@/lib/bulk";
import { useTabActivity, markTabSeen } from "@/lib/tabActivity";
import { useRoutedTabs } from "@/lib/routedTabs";
import type { Expense, Vendor, ExpenseCategory, ExpenseBudget, Employee, Department, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { ActivitySection } from "@/components/common/ActivitySection";
import { ActivityBadge } from "@/components/common/ActivityBadge";
import { AccessTab } from "@/components/common/AccessTab";
import { DataTable, type Column, type BulkAction } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Chart, ChartCard } from "@/components/common/Chart";
import { ChartFilterNote } from "@/components/common/ChartFilterNote";
import { useChartFocus } from "@/lib/chartFocus";
import { monthlyTotals, topSlices } from "@/lib/chartTheme";
import { useKpiFocus } from "@/lib/kpiFocus";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { waitingDays, waitingLabel } from "@/components/common/ApprovalRow";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard, useDialogDraft } from "@/components/common/dialogGuard";
import { DraftNotice } from "@/components/common/DraftNotice";
import { AccessScope } from "@/components/access/AccessScope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessAction } from "@/components/access/AccessAction";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision, type Decision } from "@/lib/confirmDecision";
import { getSetting } from "@/lib/settingsStore";
import { advanceRecurrence, type RecurrenceRule } from "../../../src/domain/expenses";

const EMPTY = { employee: "", vendor: "", category: "", department: "", amount: "", tax_amount: "", incurred_on: "", invoice_number: "", description: "", reimbursable: false, recurring: false, recurrence_rule: "monthly", next_occurrence_on: "" };
const up = (s?: string) => (s ?? "").toUpperCase();
// `todayStr` comes from lib/orgDay: the ORG's day. This file used to define its own from the browser's
// local parts, which is a different day for part of every day and a different day again from the one the
// server validates against.
const sum = (rs: Expense[]) => rs.reduce((n, r) => n + (r.amount || 0), 0);
const PAY_METHODS = ["bank", "card", "cash", "upi", "cheque"] as const;
const RULE_LABEL: Record<string, string> = { monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
// The rejections a reviewer actually writes, offered as one tap each. Sentences, not codes: the submitter
// reads them verbatim in the notification.
const REJECT_REASONS: { label: string; note: string }[] = [
  { label: "Missing invoice", note: "Missing the vendor invoice - please attach it and file again." },
  { label: "Wrong category", note: "Filed against the wrong category or cost centre - please correct it and file again." },
  { label: "Over policy", note: "Above what policy allows without prior approval - get it approved first, then file again." },
  { label: "Duplicate", note: "This looks like it has already been filed - please check before filing again." },
];
const TAB_KEYS = ["review", "pay", "mine", "all", "recurring"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The budget period a date falls in, in the server's own key format (domain/expenses periodKeyFor) - so the
// form can find the cap this expense will land against without asking the server to compute it.
function periodKeyOf(dateStr: string, type?: string): string {
  // An absent date falls back to the ORG's today, never the browser's - a bare `new Date()` here would read
  // the viewer's clock and put a period boundary a timezone away from the one the server computes.
  const d = new Date(`${dateStr || todayStr()}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (type === "yearly") return String(y);
  if (type === "quarterly") return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

// The next few dates a schedule will fire, so "monthly from the 1st" can be read as dates instead of trusted.
// `rule` is nullable on the wire (a one-off expense has no schedule), so this takes null as "no rule".
function nextOccurrences(from: string | undefined, rule: string | null | undefined, count: number): string[] {
  if (!from || !rule) return [];
  const out: string[] = [];
  // Through the SERVER'S own step (domain/expenses.ts#advanceRecurrence), not a second copy of it. The copy
  // rolled end-of-month overflow forward where the server clamps it, so "monthly from the 31st" previewed
  // 3 March and then generated 28 February - a schedule that disagreed with itself before it had run once.
  let d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d = advanceRecurrence(d, rule as RecurrenceRule);
  }
  return out;
}

type ExpenseSettings = { auto_approve_threshold?: number; default_payment_method?: string; recurring_default_state?: string };

export default function Expenses({ me }: { me: Me }) {
  const { rows, state, error, reload, hasMore, loadMore } = useCollection<Expense>("expenses");
  // Server-side search across the whole collection - a list page caps at 100 rows, so filtering the cached
  // rows could never reach a record past the first page. Below two characters it stays off.
  const [search, setSearch] = useState("");
  const debouncedQ = useDebounced(search.trim(), 250);
  const searching = debouncedQ.length >= 2;
  const { rows: searchRows, hasMore: searchHasMore, loadMore: loadMoreSearch } = useCollection<Expense>("expenses", { q: debouncedQ, enabled: searching });
  // Both are lookups and pickers, not list windows: a category or vendor past the first page would render as
  // a bare wire id on every expense that names it, and could not be chosen for a new one.
  const { rows: categories } = useCollection<ExpenseCategory>("expense-categories", { all: true });
  const { rows: vendors } = useCollection<Vendor>("vendors", { all: true }); // empty for callers without vendors.read (403 isolated)
  const { rows: budgets } = useCollection<ExpenseBudget>("expense-budgets"); // finance-only; empty otherwise
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const { org } = useOrg();
  const { toast } = useToast();
  const confirm = useConfirm();
  const isPhone = useMedia("(max-width: 639px)");
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));

  const canApprove = usePermission("expenses.approve");
  const canPay = usePermission("expenses.pay");

  // Workflow settings the form and the pay path need to tell the truth about: the auto-approve threshold (so a
  // small expense doesn't silently skip approval unannounced) and the house payment method.
  const [settings, setSettings] = useState<ExpenseSettings>({});
  useEffect(() => {
    getSetting<ExpenseSettings>("expenses").then((s) => setSettings(s.value ?? {})).catch(() => {});
  }, []);
  const defaultMethod = PAY_METHODS.includes(settings.default_payment_method as typeof PAY_METHODS[number])
    ? (settings.default_payment_method as typeof PAY_METHODS[number])
    : "bank";

  // ---- tabs -----------------------------------------------------------------------------------------------
  // Deep-linkable (`#/expenses/review`), so a queue can be shared or reached from a notification.
  const route = useRoute();
  const { value: tab, onValueChange: setTab } = useRoutedTabs("expenses", TAB_KEYS, me.employee_id ? "mine" : "all");
  const tabFromUrl = route.page === "expenses" && TAB_KEYS.includes(route.id ?? "");
  useEffect(() => { markTabSeen(`expenses:${tab}`); }, [tab]);

  // The queue tabs read their slice from the SERVER (`?state=`), not from the cached first page: on a ledger
  // past 100 rows a submitted expense could otherwise sit unseen forever. Each read is lazy - it only fires
  // while its tab is open (D1 reads are scarce), and falls back to the client-derived slice until it lands.
  const reviewQ = useCollection<Expense>("expenses", { params: { state: "SUBMITTED" }, enabled: tab === "review" });
  const payQ = useCollection<Expense>("expenses", { params: { state: "APPROVED" }, enabled: tab === "pay" });
  // Cost-centre scoping, also server-side (`?department=`) for the same reason. Empty = the whole ledger.
  const [deptFilter, setDeptFilter] = useState("");
  const deptQ = useCollection<Expense>("expenses", { params: { department: deptFilter }, enabled: !!deptFilter });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [submitNow, setSubmitNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "expense" });
  // Company expenses get filed off a paper invoice, with interruptions; only a NEW one is drafted, since
  // restoring a draft over someone else's edit of an existing expense would silently revive stale values.
  const draft = useDialogDraft("expense-new", open && !editing, form, setForm, !editing);

  function resetForm(recurring = form.recurring) {
    setEditing(null);
    setForm({ ...EMPTY, incurred_on: todayStr(), recurring });
    setFile(null);
    setSubmitNow(true);
  }
  function openCreate(recurring = false) {
    resetForm(recurring);
    setErr(null);
    setOpen(true);
  }
  function openEdit(r: Expense) {
    setErr(null);
    setEditing(r);
    setForm({
      employee: r.employee ? `employees/${idOf(r.employee)}` : "",
      vendor: r.vendor ? `vendors/${idOf(r.vendor)}` : "",
      category: r.category ? `expense-categories/${idOf(r.category)}` : "",
      department: r.department ? `departments/${idOf(r.department)}` : "",
      amount: String(r.amount ?? ""),
      tax_amount: r.tax_amount ? String(r.tax_amount) : "",
      incurred_on: r.incurred_on ?? "",
      invoice_number: r.invoice_number ?? "",
      description: r.description ?? "",
      reimbursable: !!r.reimbursable,
      recurring: !!r.recurring,
      recurrence_rule: r.recurrence_rule ?? "monthly",
      next_occurrence_on: r.next_occurrence_on ?? "",
    });
    setFile(null);
    setSubmitNow(false);
    setOpen(true);
  }
  useIntent("new-expense", () => openCreate());

  // Quick add: a stripped path for small expenses (snacks, meals, cabs) - amount, optional category/note and a
  // photo of the receipt, submitted straight away. Details can be filled in later via Edit.
  const [quickOpen, setQuickOpen] = useState(false);
  const [quick, setQuick] = useState({ amount: "", category: "", description: "" });
  const [quickFile, setQuickFile] = useState<File | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickErr, setQuickErr] = useState<string | null>(null);
  function openQuick() { setQuick({ amount: "", category: "", description: "" }); setQuickFile(null); setQuickErr(null); setQuickOpen(true); }
  useIntent("quick-expense", openQuick);
  // The phone form most likely to be interrupted - a receipt is photographed in a taxi, mid-conversation - so
  // its typed values survive the app being switched away from. The photo itself can't be stored; the note can.
  const quickDraft = useDialogDraft("expense-quick", quickOpen, quick, setQuick);
  // The receipt counts as filled-in work: a photo taken and then lost to a stray tap outside the sheet is the
  // one thing on this form that can't be retyped.
  const quickGuard = useDialogGuard(quickOpen, { ...quick, file: quickFile?.name ?? "" }, () => setQuickOpen(false), { label: "expense" });
  async function quickSubmit() {
    setQuickBusy(true);
    setQuickErr(null);
    try {
      const row = await create<Expense>("expenses", {
        category: quick.category,
        amount: Number(quick.amount),
        incurred_on: todayStr(),
        description: quick.description,
      });
      // THE ROW EXISTS FROM HERE ON, so neither follow-up may fail as though nothing happened. Before this, an
      // upload or submit that threw left the expense filed as a DRAFT - real to the server, invisible in the
      // reviewer's queue - while the person saw only an error over a form that still had everything they typed,
      // and pressing the button again created a second row (unlike Reimbursements, this sheet has no duplicate
      // detector). Each follow-up now reports itself and the sheet still closes.
      const missed: string[] = [];
      if (quickFile) {
        try {
          await upload(`expenses/${idOf(row.path)}`, quickFile);
        } catch {
          missed.push("the receipt didn't attach");
        }
      }
      try {
        await invoke("expenses/" + idOf(row.path), "submit", row.etag);
      } catch {
        missed.push("it was filed as a draft rather than submitted");
      }
      toast(
        missed.length
          ? { title: "Expense added, with something left to do", description: `${sentence(missed.join(", "))} Finish it from the Expenses list.`, variant: "destructive" }
          : { title: "Expense added", variant: "success" },
      );
      quickDraft.clear();
      setQuickOpen(false);
      reload();
    } catch (e) {
      setQuickErr(describeError(e));
    } finally {
      setQuickBusy(false);
    }
  }

  const fileRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<Expense | null>(null);

  // `unknown` is a WORD, never the raw wire id - the rule lib/utils.ts `personName` states. Each of these
  // lists is scoped to what the caller may read, so a ref outside that slice (an expense submitted by
  // somebody in another department, most often) is ordinary, and a 26-character uuid in place of the name
  // is an internal identifier leaked onto the screen.
  const nameOf = (list: { path: string; display_name?: string; first_name?: string; last_name?: string }[], unknown: string) => {
    const m = new Map(list.map((x) => [idOf(x.path), x.display_name ?? `${x.first_name ?? ""} ${x.last_name ?? ""}`.trim()]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? unknown : "-");
  };
  const catName = useMemo(() => nameOf(categories as any, "Unknown category"), [categories]);
  const vendorName = useMemo(() => nameOf(vendors as any, "Unknown vendor"), [vendors]);
  const deptName = useMemo(() => nameOf(departments as any, "Unknown department"), [departments]);
  const empName = useMemo(() => nameOf(employees as any, "Someone"), [employees]);
  const payeeName = (r: Expense) => (r.vendor ? vendorName(r.vendor) : empName(r.employee));
  // The category's accounting code, carried onto the expense so a finance export reconciles without a lookup.
  const catGl = useMemo(() => {
    const m = new Map(categories.map((c) => [idOf(c.path), c.gl_code ?? ""]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "" : "");
  }, [categories]);

  const selectedCat = categories.find((c) => form.category && idOf(c.path) === idOf(form.category));
  const invoiceRequired = !!selectedCat?.requires_receipt && !form.recurring;
  const threshold = settings.auto_approve_threshold ?? 0;
  const autoApproves = threshold > 0 && !form.recurring && !!form.amount && Number(form.amount) <= threshold;

  // ---- buckets -------------------------------------------------------------------------------------------
  // A recurring row is a TEMPLATE, not money spent: it lives on its own tab so the ledger and its totals only
  // ever count real expenses (the cron clones a concrete expense from it, carrying `template`).
  // `useCallback` so the memo below can name the predicate it actually calls, instead of restating the one
  // field the predicate happens to read today. Identity moves with that field, so nothing recomputes more
  // often than it did - but a change to the predicate can no longer leave a stale dependency behind it.
  const isOwn = useCallback((r: Expense) => !!(r.employee && me.employee_id && idOf(r.employee) === me.employee_id), [me.employee_id]);
  const ledgerAll = useMemo(() => rows.filter((r) => !r.recurring), [rows]);
  const ledger = useMemo(
    () => (deptFilter && deptQ.state === "ready" ? deptQ.rows.filter((r) => !r.recurring) : ledgerAll),
    [deptFilter, deptQ.state, deptQ.rows, ledgerAll],
  );
  const templates = useMemo(() => rows.filter((r) => r.recurring), [rows]);
  const toReviewLocal = useMemo(() => ledgerAll.filter((r) => up(r.state) === "SUBMITTED"), [ledgerAll]);
  const toPayLocal = useMemo(() => ledgerAll.filter((r) => up(r.state) === "APPROVED" && !r.reimbursable), [ledgerAll]);
  const toReview = reviewQ.state === "ready" && tab === "review" ? reviewQ.rows.filter((r) => !r.recurring) : toReviewLocal;
  const toPay = payQ.state === "ready" && tab === "pay" ? payQ.rows.filter((r) => !r.recurring && !r.reimbursable) : toPayLocal;
  const viaPayroll = useMemo(() => ledgerAll.filter((r) => up(r.state) === "APPROVED" && r.reimbursable), [ledgerAll]);
  const mine = useMemo(() => ledgerAll.filter(isOwn), [ledgerAll, isOwn]);
  // "This month" is the ORG's month, not the browser's. A local-clock boundary
  // (`new Date(n.getFullYear(), n.getMonth(), 1)`) made this figure differ per viewer: for an org on IST read
  // from New York, an expense paid at 02:00 IST on the 1st sits before the reader's month start and drops out
  // of the total; west of UTC the previous month's late payments get counted in. `useMemo(…, [])` froze the
  // boundary at mount too, so a tab left open across a month boundary kept reporting the old month. Comparing
  // org-local `YYYY-MM` strings is the form the rest of this file already uses, and it has neither problem.
  const paidInThisMonth = (r: Expense) => up(r.state) === "PAID" && !!r.paid_time && orgDayOf(r.paid_time).slice(0, 7) === thisMonthStr();
  const paidThisMonth = useMemo(() => ledgerAll.filter(paidInThisMonth), [ledgerAll]);
  // An unpaid expense with no invoice on it is the one accounts will hand back, so it earns a metric.
  const noInvoice = useMemo(() => ledgerAll.filter((r) => !r.has_invoice && up(r.state) !== "PAID"), [ledgerAll]);
  // Committed money only: an expense that is still submitted or was rejected has not been spent, and putting
  // it on a spend chart is how a month reads as 40% worse than it was. Dated by when the cost was INCURRED,
  // not when it was paid - that is the month it belongs to.
  const spendCharts = useMemo(() => {
    const committed = ledgerAll.filter((r) => ["APPROVED", "PAID"].includes(up(r.state)) && r.incurred_on);
    return {
      months: monthlyTotals(committed.map((r) => ({ date: r.incurred_on!, value: r.amount || 0 })), 12, todayStr()),
      categories: topSlices(committed, (r) => (r.category ? catName(r.category) : "Uncategorised"), (r) => r.amount || 0, 7),
    };
  }, [ledgerAll, catName]);

  // Metrics whose rows live on no queue tab of their own narrow the whole ledger instead.
  const kf = useKpiFocus<Expense, "viaPayroll" | "paidThisMonth" | "noInvoice">({
    viaPayroll: { label: "employee-fronted approvals", match: (r) => up(r.state) === "APPROVED" && !!r.reimbursable },
    // The same predicate the tile counts, so the drill-through and the figure cannot disagree.
    paidThisMonth: { label: "expenses paid this month", match: paidInThisMonth },
    noInvoice: { label: "unpaid expenses with no invoice", match: (r) => !r.has_invoice && up(r.state) !== "PAID" },
  });
  const ledgerKpi = (key: "viaPayroll" | "paidThisMonth" | "noInvoice") => {
    const base = kf.kpi(key);
    return { ...base, onClick: () => { setTab("all"); base.onClick(); } };
  };
  // Both spend charts narrow the ledger, so pressing one lands on the ledger the way a metric tile does -
  // a filter applied to a tab the reader is not on is a filter they cannot see working.
  const cf = useChartFocus<Expense, "month" | "category">({
    month: {
      keys: spendCharts.months.keys,
      label: (k) => spendCharts.months.labels[spendCharts.months.keys.indexOf(k)] ?? k,
      match: (r, k) => (r.incurred_on ?? "").slice(0, 7) === k,
    },
    category: {
      keys: spendCharts.categories.keys,
      label: (k) => k,
      match: (r, k) => (r.category ? catName(r.category) : "Uncategorised") === k,
    },
  });
  const ledgerChart = (dim: "month" | "category") => {
    const base = cf.chart(dim);
    return { ...base, onSelect: (i: number) => { setTab("all"); base.onSelect(i); } };
  };
  // A metric belongs to the ledger, which is the only tab that applies it. Leaving the ledger drops it rather
  // than parking a narrowing nothing on screen reflects - not the tab counts, not the queue tables.
  const pickTab = (next: string) => { if (next !== "all") kf.clear(); setTab(next); };

  // "New since you last looked" on the queues that carry other people's work; "Mine" is your own, so it never badges.
  const activity = useTabActivity(
    [
      { key: "expenses:review", collection: "expenses", filter: (r: Expense) => !r.recurring && up(r.state) === "SUBMITTED" },
      { key: "expenses:pay", collection: "expenses", filter: (r: Expense) => !r.recurring && up(r.state) === "APPROVED" && !r.reimbursable },
      { key: "expenses:all", collection: "expenses" },
    ],
    [me.employee_id],
  );

  // Land a reviewer/payer on their queue the first time the rows arrive - before that every bucket is empty,
  // so choosing at mount would always pick the fallback. A tab reached by URL wins over the landing rule.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || state !== "ready") return;
    landed.current = true;
    if (tabFromUrl) return; // an explicit `#/expenses/<tab>` wins over the landing rule
    if (canApprove && toReviewLocal.length) setTab("review");
    else if (canPay && toPayLocal.length) setTab("pay");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, canApprove, canPay, toReviewLocal.length, toPayLocal.length]);
  const showReview = canApprove;
  const showPay = canPay;
  const showRecurring = templates.length > 0 || canApprove;
  // A tab the caller has no queue for must not strand them on an empty panel.
  useEffect(() => {
    if ((tab === "review" && !showReview) || (tab === "pay" && !showPay) || (tab === "recurring" && !showRecurring)) setTab("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, showReview, showPay, showRecurring]);

  // ---- duplicate guard -----------------------------------------------------------------------------------
  // Filing the same invoice twice is the classic expense error (and the classic fraud). Same invoice number,
  // or same payee + amount + date, on a row that isn't cancelled/rejected, is worth a word before saving.
  // Both entry points ask: quick add is the phone path, where a second tap files the same lunch twice.
  function duplicateOf(q: { amount: string; invoice_number?: string; vendor?: string; incurred_on?: string }, skipPath?: string) {
    const amount = Number(q.amount);
    if (!amount) return null;
    const others = rows.filter((r) => r.path !== skipPath && !r.recurring && !["CANCELLED", "REJECTED"].includes(up(r.state)));
    const inv = (q.invoice_number ?? "").trim().toLowerCase();
    if (inv) {
      const hit = others.find((r) => (r.invoice_number ?? "").trim().toLowerCase() === inv);
      if (hit) return { row: hit, why: `invoice ${hit.invoice_number}` };
    }
    const vendorId = q.vendor ? idOf(q.vendor) : "";
    const hit = others.find((r) =>
      r.amount === amount &&
      (r.incurred_on ?? "") === (q.incurred_on ?? "") &&
      (vendorId ? r.vendor && idOf(r.vendor) === vendorId : !r.vendor && isOwn(r)));
    return hit ? { row: hit, why: "same payee, amount and date" } : null;
  }
  const duplicate = useMemo(
    () => (form.recurring ? null : duplicateOf(form, editing?.path)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, form.amount, form.invoice_number, form.vendor, form.incurred_on, form.recurring, editing?.path],
  );

  // ---- budget interlock ----------------------------------------------------------------------------------
  // What this expense does to the cap it lands against, BEFORE it is filed - the budget card only ever told
  // you after the fact. Matches the most specific cap for the (category, cost centre, period) being entered.
  function impactOf(q: { amount: string; category?: string; department?: string; incurred_on?: string }, already = 0) {
    const amount = Number(q.amount);
    if (!amount || budgets.length === 0) return null;
    const catId = q.category ? idOf(q.category) : "";
    const deptId = q.department ? idOf(q.department) : "";
    const candidates = budgets
      .filter((b) => !b.delete_time)
      .filter((b) => (b.category ? idOf(b.category) === catId : true))
      .filter((b) => (b.department ? idOf(b.department) === deptId : true))
      .filter((b) => b.period_key === periodKeyOf(q.incurred_on || todayStr(), b.period_type))
      // Most specific first: a (category + cost centre) cap beats a category cap beats an org-wide one.
      .sort((a, b) => (Number(!!b.category) + Number(!!b.department)) - (Number(!!a.category) + Number(!!a.department)));
    const b = candidates[0];
    if (!b || !b.amount) return null;
    const projected = (b.spent ?? 0) - already + amount;
    return { budget: b, projected, pct: Math.round((projected / b.amount) * 100), cap: b.amount };
  }
  const budgetImpact = useMemo(
    // an edit replaces its own amount
    () => impactOf(form, editing && up(editing.state) !== "DRAFT" ? editing.amount : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [budgets, form.amount, form.category, form.department, form.incurred_on, editing],
  );

  // The same two warnings, drawn once - the quick form shows them too, so a phone filing is no less informed
  // than a desk one.
  const budgetNotice = (impact: NonNullable<ReturnType<typeof impactOf>>) => (
    <p className={cn(
      "rounded-lg border px-3 py-2 text-xs",
      impact.pct >= 100 ? "border-destructive/40 bg-destructive/5 text-destructive" : impact.pct >= 80 ? "border-warning/40 bg-warning/5 text-warning" : "text-muted-foreground",
    )}>
      {impact.pct >= 100 ? <TriangleAlert className="mr-1 inline h-3.5 w-3.5" /> : null}
      {impact.budget.category ? catName(impact.budget.category) : "All categories"}
      {impact.budget.department ? ` · ${deptName(impact.budget.department)}` : ""} budget for {impact.budget.period_key}:
      {" "}this takes it to {money(impact.projected)} of {money(impact.cap)} ({impact.pct}%).
    </p>
  );
  const duplicateNotice = (dup: NonNullable<ReturnType<typeof duplicateOf>>) => (
    <p className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
      <TriangleAlert className="mr-1 inline h-3.5 w-3.5" />
      Possible duplicate ({dup.why}): {payeeName(dup.row)} · {money(dup.row.amount)}
      {dup.row.incurred_on ? ` on ${formatDate(dup.row.incurred_on)}` : ""} is already filed as {up(dup.row.state).toLowerCase()}.
    </p>
  );
  const pickedVendor = useMemo(() => (form.vendor ? vendors.find((v) => idOf(v.path) === idOf(form.vendor)) ?? null : null), [vendors, form.vendor]);

  // One definition of "this form can be saved", shared by the Save button, the form's Enter and Cmd+Enter.
  // Three copies had already drifted apart: Enter used to submit a future-dated or scheduleless expense that
  // the button refused.
  const formValid =
    !!form.amount && Number(form.amount) > 0 &&
    !(invoiceRequired && !file && !editing) &&
    !(form.recurring && !form.next_occurrence_on) &&
    !(form.incurred_on && form.incurred_on > todayStr());

  // Quick add files today, in your own name, with no vendor - so its duplicate check is exactly that shape.
  const quickDuplicate = useMemo(
    () => (quickOpen ? duplicateOf({ amount: quick.amount, incurred_on: todayStr() }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, quick.amount, quickOpen],
  );
  const quickImpact = useMemo(
    () => (quickOpen ? impactOf({ amount: quick.amount, category: quick.category }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [budgets, quick.amount, quick.category, quickOpen],
  );

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        vendor: form.vendor,
        category: form.category,
        department: form.department,
        amount: Number(form.amount),
        tax_amount: form.tax_amount ? Number(form.tax_amount) : 0,
        // Date fields are `format: date`, and "" is not a date - an empty one is left out.
        ...(form.incurred_on ? { incurred_on: form.incurred_on } : {}),
        invoice_number: form.invoice_number,
        description: form.description,
        reimbursable: form.reimbursable,
        recurring: form.recurring,
        // A one-off expense has NO rule, and "no rule" on the wire is null: the field is an enum
        // (monthly/quarterly/yearly), so an empty string is not a value it has - it is rejected outright, and
        // every plain expense filed from this form came back 400.
        recurrence_rule: form.recurring ? form.recurrence_rule : null,
        ...(form.recurring && form.next_occurrence_on ? { next_occurrence_on: form.next_occurrence_on } : {}),
      };
      // Who fronted it: only settable at create, and only by someone recording on another's behalf.
      if (!editing && form.employee) body.employee = form.employee;
      // Same rule as the quick sheet: once the record is written, the attachment and the submit are FOLLOW-UPS.
      // A throw from either used to look like a save that did not happen, over a form that still held
      // everything - so pressing the button again wrote a second row (or, on an edit, re-patched a row that was
      // already correct).
      const missed: string[] = [];
      const attach = async (path: string) => {
        if (!file) return;
        try {
          await upload(`expenses/${idOf(path)}`, file);
        } catch {
          missed.push("the receipt didn't attach");
        }
      };
      if (editing) {
        await patch("expenses/" + idOf(editing.path), body, editing.etag);
        await attach(editing.path);
        toast(missed.length
          ? { title: "Saved, but the receipt didn't attach", description: "Use the expense's attach button on the list to add it.", variant: "destructive" }
          : { title: "Expense updated", variant: "success" });
      } else {
        const row = await create<Expense>("expenses", body);
        await attach(row.path);
        if (submitNow && !form.recurring) {
          try {
            await invoke("expenses/" + idOf(row.path), "submit", row.etag);
          } catch {
            missed.push("it was filed as a draft rather than submitted");
          }
        }
        toast(missed.length
          ? { title: "Filed, with something left to do", description: `${sentence(missed.join(", "))} Finish it from the Expenses list.`, variant: "destructive" }
          : { title: form.recurring ? "Recurring expense created" : submitNow ? "Expense submitted" : "Draft saved", variant: "success" });
      }
      draft.clear();
      guard.markSaved();
      setOpen(false);
      reloadAll();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Every view of the collection this page holds open (the ledger plus the server-filtered queues) refreshes
  // together, so a decision made on one tab can't leave another showing the row it just moved.
  function reloadAll() {
    reload();
    reviewQ.reload();
    payQ.reload();
    if (deptFilter) deptQ.reload();
  }

  async function action(r: Expense, verb: string, body?: Record<string, unknown>) {
    const label: Record<string, string> = { submit: "Submitted", approve: "Approved", reject: "Rejected", cancel: "Cancelled", pay: "Marked paid" };
    // `reject` arrives already confirmed - it comes from its own dialog, which collects the reason.
    if (verb !== "reject" && !(await confirmDecision(confirm, verb as Decision, `${r.description || "this expense"} (${money(r.amount ?? 0)})`))) return;
    try {
      await invoke("expenses/" + idOf(r.path), verb, r.etag, body);
      toast({ title: label[verb] ?? "Updated", variant: "success" });
      reloadAll();
    } catch (e) {
      toast({ title: "Couldn't update expense", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Pause / resume a schedule: a PATCH, not a workflow verb - the schedule is still alive, just on hold.
  async function setPaused(r: Expense, paused: boolean) {
    try {
      await patch("expenses/" + idOf(r.path), { paused }, r.etag);
      toast({ title: paused ? "Schedule paused" : "Schedule resumed", variant: "success" });
      reloadAll();
    } catch (e) {
      toast({ title: "Couldn't update the schedule", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Reject with a reason: the submitter is told why, so the next attempt fixes the actual problem.
  const [rejectFor, setRejectFor] = useState<Expense | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectErr, setRejectErr] = useState<string | null>(null);
  function openReject(r: Expense) { setRejectNote(""); setRejectErr(null); setRejectFor(r); }
  async function confirmReject() {
    if (!rejectFor) return;
    setRejectBusy(true);
    setRejectErr(null);
    try {
      // already confirmed: fired by the reject dialog's own button, which collected the note.
      await invoke("expenses/" + idOf(rejectFor.path), "reject", rejectFor.etag, { note: rejectNote.trim() || null });
      toast({ title: "Rejected", variant: "success" });
      setRejectFor(null);
      reloadAll();
    } catch (e) {
      // Kept in the dialog: a toast about this form would land behind the form it is about.
      setRejectErr((e as Error).message);
    } finally {
      setRejectBusy(false);
    }
  }

  // Pay dialog (method + reference) for a non-reimbursable approved expense.
  const [payFor, setPayFor] = useState<Expense | null>(null);
  const [payForm, setPayForm] = useState<{ payment_method: string; payment_ref: string }>({ payment_method: defaultMethod, payment_ref: "" });
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);
  function openPay(r: Expense) {
    setPayForm({ payment_method: r.payment_method ?? defaultMethod, payment_ref: "" });
    setPayErr(null);
    setPayFor(r);
  }
  // Bulk pay: a vendor run leaves the bank as ONE transfer with ONE reference, so the batch is paid through
  // the same dialog as a single expense rather than fired blind on the org default with no reference at all.
  // The bulk bar's promise stays open until this settles - resolving clears the selection, rejecting keeps it.
  const [payBulkFor, setPayBulkFor] = useState<Expense[] | null>(null);
  const payBulkDone = useRef<{ resolve: () => void; reject: () => void } | null>(null);
  function openPayBulk(sel: Expense[]) {
    setPayForm({ payment_method: defaultMethod, payment_ref: "" });
    setPayErr(null);
    setPayBulkFor(sel);
    return new Promise<void>((resolve, reject) => { payBulkDone.current = { resolve, reject }; });
  }
  function closePayBulk() {
    if (payBusy) return;
    payBulkDone.current?.reject();
    payBulkDone.current = null;
    setPayBulkFor(null);
  }
  async function commitPayBulk() {
    if (!payBulkFor || payBusy) return;
    setPayBusy(true);
    setPayErr(null);
    try {
      // already confirmed: this is the bulk pay dialog's own button, which names the count and the total.
      await runBulk("pay", "Marked paid", payBulkFor, { payment_method: payForm.payment_method, payment_ref: payForm.payment_ref || null });
      payBulkDone.current?.resolve();
      payBulkDone.current = null;
      setPayBulkFor(null);
    } catch (e) {
      // runBulk has already toasted the per-row tally; the dialog stays open so the reference isn't retyped.
      setPayErr((e as Error).message === "partial" ? "Some of them couldn't be paid - they're still selected, so you can retry." : (e as Error).message);
    } finally {
      setPayBusy(false);
    }
  }

  async function confirmPay() {
    if (!payFor || payBusy) return;
    setPayBusy(true);
    setPayErr(null);
    try {
      // already confirmed: fired by the pay dialog's own button, which names the expense and collected the
      // method and reference. A generic confirm on top of it would be the same question asked twice.
      await invoke("expenses/" + idOf(payFor.path), "pay", payFor.etag, { payment_method: payForm.payment_method, payment_ref: payForm.payment_ref || null });
      toast({ title: "Marked paid", variant: "success" });
      setPayFor(null);
      reloadAll();
    } catch (e) {
      setPayErr((e as Error).message);
    } finally {
      setPayBusy(false);
    }
  }

  // ---- invoice ------------------------------------------------------------------------------------------
  function pickInvoice(r: Expense) { uploadTarget.current = r; fileRef.current?.click(); }
  async function attachTo(r: Expense, f: File) {
    try {
      await upload(`expenses/${idOf(r.path)}`, f);
      toast({ title: "Invoice attached", variant: "success" });
      reloadAll();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    }
  }
  async function onInvoicePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const r = uploadTarget.current;
    e.target.value = "";
    if (f && r) await attachTo(r, f);
  }
  const getInvoice = (r: Expense) => download("expenses/" + idOf(r.path), `invoice-${idOf(r.path)}`);
  // Viewing beats downloading for a decision: the reviewer reads the invoice without leaving the queue.
  const [preview, setPreview] = useState<PdfSource | null>(null);
  const viewInvoice = (r: Expense) =>
    setPreview({ path: r.path, verb: "download", title: `Invoice · ${payeeName(r)}`, description: `${money(r.amount)}${r.invoice_number ? ` · ${r.invoice_number}` : ""}`, fileName: `invoice-${idOf(r.path)}` });

  // The row the detail dialog is showing, re-resolved from the collection so a workflow action inside it
  // repaints with the server's new state instead of the stale snapshot the row was opened from.
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const detail = detailPath ? [...rows, ...reviewQ.rows, ...payQ.rows, ...deptQ.rows, ...searchRows].find((r) => r.path === detailPath) ?? null : null;

  // ---- per-row affordances -------------------------------------------------------------------------------
  // One primary button (the move this row is actually waiting for) with everything else behind the row menu:
  // six inline ghost buttons per row read as a toolbar, not a decision.
  const canDo = (r: Expense, verb: string) => (r.access?.can ?? []).includes(verb);
  function primaryAction(r: Expense) {
    const s = up(r.state);
    if (s === "DRAFT" && !r.recurring && (isOwn(r) || canApprove) && canDo(r, "submit")) {
      return { verb: "submit", label: "Submit", icon: <Send className="h-4 w-4" />, run: () => action(r, "submit"), variant: "ghost" as const };
    }
    if (s === "SUBMITTED" && canApprove && canDo(r, "approve")) {
      return { verb: "approve", label: "Approve", icon: <Check className="h-4 w-4" />, run: () => action(r, "approve"), variant: "ghost" as const };
    }
    if (s === "APPROVED" && !r.reimbursable && canPay && canDo(r, "pay")) {
      return { verb: "pay", label: "Mark paid", icon: <Wallet className="h-4 w-4" />, run: () => openPay(r), variant: "success" as const };
    }
    return null;
  }
  function rowActions(r: Expense): RowAction[] {
    const s = up(r.state);
    const owner = isOwn(r);
    const primary = primaryAction(r);
    const acts: RowAction[] = [];
    if (s === "DRAFT" && !r.recurring && (owner || canApprove) && primary?.verb !== "submit") {
      acts.push({ label: "Submit for approval", icon: <Send className="h-4 w-4" />, verb: "submit", onClick: () => action(r, "submit") });
    }
    if (s === "SUBMITTED" && primary?.verb !== "approve") {
      acts.push({ label: "Approve", icon: <Check className="h-4 w-4" />, verb: "approve", onClick: () => action(r, "approve") });
    }
    if (s === "SUBMITTED") acts.push({ label: "Reject with a reason", icon: <X className="h-4 w-4" />, verb: "reject", onClick: () => openReject(r) });
    if (s === "APPROVED" && !r.reimbursable && primary?.verb !== "pay") {
      acts.push({ label: "Mark paid", icon: <Wallet className="h-4 w-4" />, verb: "pay", onClick: () => openPay(r) });
    }
    if (s === "DRAFT") acts.push({ label: "Edit", icon: <Pencil className="h-4 w-4" />, onClick: () => openEdit(r) });
    if (r.recurring && s === "DRAFT") {
      acts.push(r.paused
        ? { label: "Resume schedule", icon: <Play className="h-4 w-4" />, onClick: () => setPaused(r, false) }
        : { label: "Pause schedule", icon: <Pause className="h-4 w-4" />, onClick: () => setPaused(r, true) });
    }
    if (s === "DRAFT" || s === "SUBMITTED") {
      acts.push({ label: r.has_invoice ? "Replace invoice" : "Attach invoice", icon: <Paperclip className="h-4 w-4" />, onClick: () => pickInvoice(r) });
    }
    if (r.has_invoice) {
      acts.push({ label: "View invoice", icon: <Eye className="h-4 w-4" />, onClick: () => viewInvoice(r) });
      acts.push({ label: "Download invoice", icon: <Download className="h-4 w-4" />, onClick: () => getInvoice(r) });
    }
    if ((s === "DRAFT" || s === "SUBMITTED") && (owner || canApprove)) {
      acts.push({
        label: r.recurring ? "Stop schedule for good" : "Cancel",
        icon: <Ban className="h-4 w-4" />,
        verb: "cancel",
        destructive: true,
        onClick: () => action(r, "cancel"),
      });
    }
    return acts;
  }

  const stateCell = (r: Expense) => up(r.state) === "APPROVED" && r.reimbursable
    ? <span className="inline-flex items-center gap-1.5"><Badge variant="secondary">Approved</Badge><span className="text-xs text-muted-foreground">via payroll</span></span>
    : up(r.state) === "PAID"
      ? <span className="inline-flex items-center gap-1.5"><Badge variant="success">Paid</Badge>{r.paid_time ? <span className="text-xs text-muted-foreground">{formatDate(r.paid_time)}</span> : null}</span>
      : up(r.state) === "REJECTED" && r.decision_note
        ? <span className="inline-flex items-center gap-1.5" title={r.decision_note}><Badge variant="destructive">Rejected</Badge><span className="max-w-[12rem] truncate text-xs text-muted-foreground">{r.decision_note}</span></span>
        : <StatusBadge state={r.state} />;

  const actionsColumn: Column<Expense> = {
    id: "actions", header: "", sortable: false, filter: "none", align: "right",
    cell: (r) => {
      const primary = primaryAction(r);
      return (
        // The row itself opens the detail dialog; an action inside it is its own decision.
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {primary && (
            <AccessAction collection="expenses" objectPath={r.path} verb={primary.verb} can={r.access?.can} label={primary.label}>
              <Button size="sm" variant={primary.variant} onClick={primary.run}>{primary.icon} {primary.label}</Button>
            </AccessAction>
          )}
          <RowActions actions={rowActions(r)} objectPath={r.path} can={r.access?.can} />
        </div>
      );
    },
  };

  const payeeColumn: Column<Expense> = {
    id: "payee", header: "Vendor / payee", mobilePriority: 1, accessor: (r) => payeeName(r),
    cell: (r) => (
      <div className="min-w-0">
        <span className="font-medium">{payeeName(r)}</span>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {r.reimbursable && <span>Employee-fronted</span>}
          {r.template && <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" /> from a schedule</span>}
          {r.description && !r.reimbursable && !r.template && <span className="truncate">{r.description}</span>}
        </div>
      </div>
    ),
  };
  const amountColumn: Column<Expense> = {
    id: "amount", header: "Amount", align: "right", mobilePriority: 2, accessor: (r) => r.amount,
    // Totalled under the column (and over any selection) - "how much is in this queue" without a spreadsheet.
    aggregate: "sum", formatTotal: (n) => money(n),
    cell: (r) => (
      <div className="tabular-nums">
        {money(r.amount)}
        {r.tax_amount ? <div className="text-xs text-muted-foreground">incl. {money(r.tax_amount)} tax</div> : null}
      </div>
    ),
  };
  const invoiceColumn: Column<Expense> = {
    id: "invoice", header: "Invoice", sortable: false, filter: "none", accessor: (r) => (r.has_invoice ? "yes" : ""),
    cell: (r) => (r.has_invoice
      ? <Button size="icon" variant="ghost" className="h-7 w-7" title="View invoice" aria-label="View invoice" onClick={(e) => { e.stopPropagation(); viewInvoice(r); }}><Eye className="h-3.5 w-3.5" /></Button>
      : <span className="text-muted-foreground" title="No invoice attached">-</span>),
  };
  // How long this has been waiting on a decision - a queue is worked oldest-first, and a week-old expense that
  // looks identical to a fresh one is how approvals rot.
  const waitingColumn: Column<Expense> = {
    id: "waiting", header: "Waiting", align: "right", accessor: (r) => waitingDays(r.create_time),
    cell: (r) => {
      const d = waitingDays(r.create_time);
      return <span className={cn("tabular-nums text-xs", d >= 7 ? "font-medium text-destructive" : d >= 3 ? "font-medium text-warning" : "text-muted-foreground")}>{waitingLabel(d)}</span>;
    },
  };

  const baseLedgerColumns: Column<Expense>[] = [
    payeeColumn,
    { id: "category", header: "Category", filter: "select", mobilePriority: 4, accessor: (r) => catName(r.category) },
    { id: "gl", header: "GL code", defaultHidden: true, accessor: (r) => catGl(r.category), cell: (r) => catGl(r.category) || <span className="text-muted-foreground">-</span> },
    { id: "department", header: "Cost centre", filter: "select", accessor: (r) => deptName(r.department), defaultHidden: true },
    amountColumn,
    { id: "incurred", header: "Incurred", accessor: (r) => r.incurred_on ?? "", cell: (r) => (r.incurred_on ? formatDate(r.incurred_on) : "-") },
    { id: "state", header: "Status", filter: "select", mobilePriority: 3, accessor: (r) => up(r.state), cell: stateCell },
    { id: "invoice_number", header: "Invoice no.", defaultHidden: true, accessor: (r) => r.invoice_number ?? "", cell: (r) => r.invoice_number || "-" },
    {
      id: "payment", header: "Payment", defaultHidden: true,
      accessor: (r) => [r.payment_method ? up(r.payment_method) : "", r.payment_ref ?? ""].filter(Boolean).join(" "),
      cell: (r) => (r.payment_method || r.payment_ref
        ? <span className="text-xs">{r.payment_method ? up(r.payment_method) : ""}{r.payment_ref ? ` · ${r.payment_ref}` : ""}</span>
        : <span className="text-muted-foreground">-</span>),
    },
    invoiceColumn,
    { id: "description", header: "Description", defaultHidden: true, accessor: (r) => r.description ?? "", cell: (r) => r.description || "-" },
  ];
  const ledgerColumns: Column<Expense>[] = [...baseLedgerColumns, ...metaColumns<Expense>(), actionsColumn];
  // The decision queues gain the waiting time and drop the status column (every row shares one state).
  const queueColumns: Column<Expense>[] = [
    ...baseLedgerColumns.filter((c) => c.id !== "state"),
    waitingColumn,
    ...metaColumns<Expense>(),
    actionsColumn,
  ];

  // Templates are a schedule, not a ledger line: what matters is what recurs, how often, and when next.
  const recurringColumns: Column<Expense>[] = [
    payeeColumn,
    { id: "category", header: "Category", filter: "select", mobilePriority: 4, accessor: (r) => catName(r.category) },
    { id: "amount", header: "Amount", align: "right", mobilePriority: 2, accessor: (r) => r.amount, aggregate: "sum", formatTotal: (n) => money(n), cell: (r) => <span className="tabular-nums">{money(r.amount)}</span> },
    { id: "rule", header: "Repeats", filter: "select", mobilePriority: 3, accessor: (r) => RULE_LABEL[r.recurrence_rule ?? ""] ?? "-" },
    {
      id: "next", header: "Next occurrence", accessor: (r) => r.next_occurrence_on ?? "",
      cell: (r) => {
        const upcoming = nextOccurrences(r.next_occurrence_on, r.recurrence_rule, 3);
        return r.next_occurrence_on
          ? (
            <span className={cn("inline-flex items-center gap-1.5", r.paused && "text-muted-foreground line-through")} title={upcoming.length ? `Then ${upcoming.slice(1).map((d) => formatDate(d)).join(", ")}` : undefined}>
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />{formatDate(r.next_occurrence_on)}
            </span>
          )
          : "-";
      },
    },
    { id: "last", header: "Last generated", defaultHidden: true, accessor: (r) => r.last_generated_time ?? "", cell: (r) => (r.last_generated_time ? formatDate(r.last_generated_time) : <span className="text-muted-foreground">never</span>) },
    { id: "department", header: "Cost centre", filter: "select", accessor: (r) => deptName(r.department), defaultHidden: true },
    {
      id: "state", header: "Status", filter: "select",
      accessor: (r) => (up(r.state) === "CANCELLED" ? "Stopped" : r.paused ? "Paused" : "Active"),
      cell: (r) => (up(r.state) === "CANCELLED"
        ? <Badge variant="muted">Stopped</Badge>
        : r.paused
          ? <Badge variant="warning">Paused</Badge>
          : <Badge variant="success">Active</Badge>),
    },
    { id: "description", header: "Description", defaultHidden: true, accessor: (r) => r.description ?? "", cell: (r) => r.description || "-" },
    ...metaColumns<Expense>(),
    actionsColumn,
  ];

  // ---- bulk operations ------------------------------------------------------------------------------------
  // Finance works a queue in batches. Each action is enabled only when EVERY selected row can make the move,
  // so the scope is never a surprise; per-row ACLs and the state machine still decide server-side.
  const runBulk = async (verb: string, past: string, sel: Expense[], body?: Record<string, unknown>) => {
    const r = await bulkInvoke("expenses", verb, sel, body);
    toast(bulkSummary(past, r));
    reloadAll();
    // Only the FAILED rows stay selected. Keeping all of them (which is what throwing did) was a dead end on
    // this queue: after `reloadAll` the approved ones are APPROVED, each action's `disabled` guard requires
    // EVERY selected row to be SUBMITTED, so the button greyed out over a selection nothing on screen
    // explained - and the only way forward was to deselect the successes by hand.
    return r.failedRows;
  };
  const approveBulk: BulkAction<Expense> = {
    label: "Approve",
    icon: <Check className="h-4 w-4" />,
    confirm: { title: "Approve the selected expenses?", description: "Employee-fronted ones queue a reimbursement for the next payroll run." },
    disabled: (sel) => (sel.every((r) => up(r.state) === "SUBMITTED" && canDo(r, "approve")) ? null : "Only submitted expenses you may approve"),
    run: (sel) => runBulk("approve", "Approved", sel),
  };
  const rejectBulk: BulkAction<Expense> = {
    label: "Reject",
    icon: <X className="h-4 w-4" />,
    destructive: true,
    confirm: { title: "Reject the selected expenses?", description: "Submitters are notified. A bulk reject carries no reason - reject one at a time to explain why." },
    disabled: (sel) => (sel.every((r) => up(r.state) === "SUBMITTED" && canDo(r, "reject")) ? null : "Only submitted expenses you may reject"),
    run: (sel) => runBulk("reject", "Rejected", sel),
  };
  const payBulk: BulkAction<Expense> = {
    label: "Mark paid",
    icon: <Banknote className="h-4 w-4" />,
    disabled: (sel) => (sel.every((r) => up(r.state) === "APPROVED" && !r.reimbursable && canDo(r, "pay")) ? null : "Only approved vendor expenses you may pay (employee-fronted ones pay via payroll)"),
    run: (sel) => openPayBulk(sel), // the dialog is the confirmation, and it collects the method and reference
  };
  const bulkFor = (which: "review" | "pay" | "all"): BulkAction<Expense>[] | undefined => {
    const acts = which === "review"
      ? [canApprove && approveBulk, canApprove && rejectBulk]
      : which === "pay"
        ? [canPay && payBulk]
        : [canApprove && approveBulk, canApprove && rejectBulk, canPay && payBulk];
    const list = acts.filter(Boolean) as BulkAction<Expense>[];
    return list.length ? list : undefined;
  };

  // ---- budgets --------------------------------------------------------------------------------------------
  // Worst first, and only the budgets that are actually under pressure - a wall of 0%-used caps is noise.
  const activeBudgets = useMemo(
    () => budgets.filter((b) => (b.utilization ?? 0) > 0 || (b.spent ?? 0) > 0).sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0)),
    [budgets],
  );
  const overBudget = activeBudgets.filter((b) => (b.utilization ?? 0) >= 1);
  const [allBudgets, setAllBudgets] = useState(false);
  const shownBudgets = allBudgets ? activeBudgets : activeBudgets.slice(0, Math.max(3, overBudget.length));

  // ---- insight --------------------------------------------------------------------------------------------
  // Six months of committed spend (approved, paid, or awaiting payment - a draft is not spend), by month and
  // by category. Reads the rows the page already has; no extra query, no chart library.
  const insight = useMemo(() => {
    const counted = ledger.filter((r) => ["APPROVED", "PAID"].includes(up(r.state)));
    // Stepped back from the ORG's month, in UTC. Off the reader's local parts, the six buckets a report
    // covered depended on who opened it on the first or last day of a month.
    const thisMonth = todayStr().slice(0, 7);
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 1 - (5 - i), 1));
      return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, label: MONTHS[d.getUTCMonth()]!, year: d.getUTCFullYear(), total: 0 };
    });
    const byMonth = new Map(months.map((m) => [m.key, m]));
    const byCat = new Map<string, number>();
    const byVendor = new Map<string, number>();
    for (const r of counted) {
      const key = (r.incurred_on ?? r.create_time ?? "").slice(0, 7);
      const m = byMonth.get(key);
      if (m) m.total += r.amount || 0;
      const cat = r.category ? catName(r.category) : "Uncategorised";
      byCat.set(cat, (byCat.get(cat) ?? 0) + (r.amount || 0));
      if (r.vendor) byVendor.set(vendorName(r.vendor), (byVendor.get(vendorName(r.vendor)) ?? 0) + (r.amount || 0));
    }
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { months, cats: top(byCat), vendors: top(byVendor), total: counted.reduce((n, r) => n + (r.amount || 0), 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, categories, vendors]);
  const [showInsight, setShowInsight] = useState(false);

  // ---- table ----------------------------------------------------------------------------------------------
  // Search hits the whole collection, so a searching table shows search rows on every tab (the tab's own
  // filter would hide the very record the search reached past the first page).
  const renderTable = (data: Expense[], columns: Column<Expense>[], tableId: string, emptyTitle: string, emptyDescription: string, opts?: { bulk?: "review" | "pay" | "all"; more?: { hasMore: boolean; loadMore: () => void }; costCentre?: boolean }) => (
    <DataTable
      columns={columns}
      tableId={tableId}
      rows={searching ? searchRows : data}
      search={{ value: search, onChange: setSearch, placeholder: "Search all expenses…" }}
      hasMore={searching ? searchHasMore : opts?.more?.hasMore ?? hasMore}
      onLoadMore={searching ? loadMoreSearch : opts?.more?.loadMore ?? loadMore}
      getRowId={(r) => r.path}
      onRowClick={(r) => setDetailPath(r.path)}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      accessCollection="expenses"
      accessTargetOf={(r) => ({ objectPath: r.path, label: `${payeeName(r)} · ${money(r.amount)}`, can: r.access?.can })}
      bulkActions={opts?.bulk ? bulkFor(opts.bulk) : undefined}
      // The cost-centre picker filters SERVER-side, so it rides only on the whole-ledger table - on a
      // state-scoped queue it would silently narrow a list whose rows came from a different read.
      toolbar={opts?.costCentre && departments.length > 0 ? (
        <Select value={deptFilter || "all"} onValueChange={(v) => setDeptFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-[190px]"><SelectValue placeholder="All cost centres" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All cost centres</SelectItem>
            {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : undefined}
    />
  );

  const newBtn = (
    <AccessAction collection="expenses" create label="New expense">
      <Button onClick={() => openCreate()}><Plus className="h-4 w-4" /> New expense</Button>
    </AccessAction>
  );

  return (
    <div>
      {/* On a phone the camera IS the scanner: capture opens it directly instead of a file browser. */}
      <input ref={fileRef} type="file" accept="image/*,application/pdf" {...(isPhone ? { capture: "environment" as const } : {})} className="hidden" onChange={onInvoicePicked} />
      <PageHeader
        accessCollection="expenses"
        title="Expenses"
        description="Track, approve and pay operational and office expenses."
        actions={<>
          <AccessAction collection="expenses" create label="Quick add"><Button variant="outline" onClick={openQuick}><Zap className="h-4 w-4" /> Quick add</Button></AccessAction>
          {newBtn}
          <PageSettings me={me} host="expenses" />
        </>}
      />

      {/* Spend has a shape, and a ledger hides it: the month-by-month line is how a creeping run rate shows
          up before a budget breaches, and the category split is what the conversation about it starts from. */}
      {state === "ready" && rows.length > 2 && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <ChartCard title="Spend by month" description="Approved and paid expenses, over the last twelve months.">
            <Chart
              type="line"
              height={200}
              labels={spendCharts.months.labels}
              datasets={[{ name: "Spend", values: spendCharts.months.values }]}
              format={(v) => money(v)}
              areaFill
              ariaLabel="Approved expense spend in each of the last twelve months"
              {...ledgerChart("month")}
            />
          </ChartCard>
          <ChartCard title="Where it goes" description="The same spend, by category.">
            <Chart
              type="donut"
              height={200}
              labels={spendCharts.categories.labels}
              datasets={[{ name: "Spend", values: spendCharts.categories.values }]}
              format={(v) => money(v)}
              ariaLabel="Approved expense spend by category"
              {...ledgerChart("category")}
            />
          </ChartCard>
        </div>
      )}

      {activeBudgets.length > 0 && (
        <Card className="mb-4">
          <CardContent className="space-y-3 pt-4 sm:pt-6">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                Budget utilization
                {overBudget.length > 0 && <Badge variant="destructive">{overBudget.length} over cap</Badge>}
              </p>
              {activeBudgets.length > shownBudgets.length || allBudgets ? (
                <Button size="sm" variant="ghost" onClick={() => setAllBudgets((v) => !v)}>
                  {allBudgets ? <>Show less <ChevronUp className="h-3.5 w-3.5" /></> : <>Show all {activeBudgets.length} <ChevronDown className="h-3.5 w-3.5" /></>}
                </Button>
              ) : null}
            </div>
            {shownBudgets.map((b) => {
              const pct = Math.round((b.utilization ?? 0) * 100);
              const over = pct >= 100;
              const left = (b.amount ?? 0) - (b.spent ?? 0);
              return (
                <div key={b.path} className="space-y-1">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{b.category ? catName(b.category) : "All categories"}{b.department ? ` · ${deptName(b.department)}` : ""} <span className="text-muted-foreground">({b.period_key})</span></span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {money(b.spent ?? 0)} / {money(b.amount)}
                      <span className={cn("ml-2", over ? "font-medium text-destructive" : pct >= 80 ? "font-medium text-warning" : "")}>
                        {over ? `${money(-left)} over` : `${money(left)} left`}
                      </span>
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded bg-muted">
                    <div className={`h-full rounded ${over ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* The strip is the table's filter surface, so it sits directly on top of it - below the charts, which
          are only there to be read. */}
      {state === "ready" && rows.length > 0 && (
        <SummaryStrip
          items={[
            {
              label: "Pending approval", value: money(sum(toReviewLocal)), icon: ClipboardCheck,
              hint: `${toReviewLocal.length} expense${toReviewLocal.length === 1 ? "" : "s"}`,
              tone: toReviewLocal.length ? "warning" : "muted",
              ...(showReview ? { onClick: () => pickTab("review"), active: tab === "review" } : {}),
            },
            {
              label: "Awaiting payment", value: money(sum(toPayLocal)), icon: Wallet,
              hint: toPayLocal.length ? `${toPayLocal.length} to pay` : "all settled",
              tone: toPayLocal.length ? "default" : "muted",
              ...(showPay ? { onClick: () => pickTab("pay"), active: tab === "pay" } : {}),
            },
            ...(viaPayroll.length
              ? [{
                  label: "Via payroll", value: money(sum(viaPayroll)), icon: Repeat, hint: `${viaPayroll.length} fronted`, tone: "default" as const,
                  // Employee-fronted approvals never reach the "to pay" queue (payroll settles them), so this
                  // one lands on the whole ledger narrowed to exactly those rows.
                  ...ledgerKpi("viaPayroll"),
                }]
              : []),
            { label: "Paid this month", value: money(sum(paidThisMonth)), icon: Banknote, hint: `${paidThisMonth.length} expense${paidThisMonth.length === 1 ? "" : "s"}`, tone: "success", ...ledgerKpi("paidThisMonth") },
            ...(noInvoice.length
              ? [{ label: "No invoice attached", value: noInvoice.length, icon: ClipboardCheck, tone: "warning" as const, hint: "nothing to file", ...ledgerKpi("noInvoice") }]
              : []),
          ]}
        />
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            illustration="expenses"
            icon={Wallet}
            title="No expenses yet"
            description="Record an operational or office expense to get started."
            action={newBtn}
          />
        ) : (
          <Tabs value={tab} onValueChange={pickTab}>
            <TabsList>
              {showReview && (
                <TabsTrigger value="review">
                  To approve{toReviewLocal.length ? ` (${toReviewLocal.length})` : ""}
                  <ActivityBadge count={tab === "review" ? 0 : activity["expenses:review"] ?? 0} />
                </TabsTrigger>
              )}
              {showPay && (
                <TabsTrigger value="pay">
                  To pay{toPayLocal.length ? ` (${toPayLocal.length})` : ""}
                  <ActivityBadge count={tab === "pay" ? 0 : activity["expenses:pay"] ?? 0} />
                </TabsTrigger>
              )}
              {me.employee_id && <TabsTrigger value="mine">Mine{mine.length ? ` (${mine.length})` : ""}</TabsTrigger>}
              {/* review/pay/mine are scope filters of the same collection; the collection-level access key
                  rides on "All" (the whole ledger), with per-row keys inside each table. */}
              <AccessTab value="all" target={{ collection: "expenses", label: "Expenses" }}>
                All<ActivityBadge count={tab === "all" ? 0 : activity["expenses:all"] ?? 0} />
              </AccessTab>
              {showRecurring && <TabsTrigger value="recurring">Recurring{templates.length ? ` (${templates.length})` : ""}</TabsTrigger>}
            </TabsList>

            {showReview && (
              <TabsContent value="review">
                {toReview.length === 0 && !searching
                  ? <EmptyState icon={ClipboardCheck} title="Nothing to approve" description="Submitted expenses waiting on your decision land here." />
                  : renderTable(toReview, queueColumns, "expenses-review", "No expenses match", "Adjust the filters to see the queue.", { bulk: "review", more: { hasMore: reviewQ.hasMore, loadMore: reviewQ.loadMore } })}
              </TabsContent>
            )}
            {showPay && (
              <TabsContent value="pay">
                {toPay.length === 0 && !searching
                  ? <EmptyState icon={Wallet} title="Nothing awaiting payment" description="Approved vendor expenses appear here until they're marked paid. Employee-fronted ones pay out through payroll." />
                  : renderTable(toPay, queueColumns, "expenses-pay", "No expenses match", "Adjust the filters to see what's payable.", { bulk: "pay", more: { hasMore: payQ.hasMore, loadMore: payQ.loadMore } })}
              </TabsContent>
            )}
            {me.employee_id && (
              <TabsContent value="mine">
                {mine.length === 0 && !searching
                  ? <EmptyState icon={Wallet} title="You have no expenses" description="Record an expense you paid for, or one the company owes a vendor." action={newBtn} />
                  : renderTable(mine, ledgerColumns, "expenses-mine", "No expenses match", "Adjust the filters to see your expenses.")}
              </TabsContent>
            )}
            <TabsContent value="all">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowInsight((v) => !v)}>
                  <BarChart3 className="h-4 w-4" /> {showInsight ? "Hide spend breakdown" : "Spend breakdown"}
                </Button>
                {deptFilter && (
                  <Badge variant="secondary" className="gap-1">
                    {deptName(deptFilter)}
                    <button type="button" aria-label="Clear cost centre filter" onClick={() => setDeptFilter("")}><X className="h-3 w-3" /></button>
                  </Badge>
                )}
              </div>
              {showInsight && <SpendBreakdown insight={insight} money={money} />}
              {kf.focus && (
                <p className="mb-3 text-xs text-muted-foreground">
                  Showing {kf.activeLabel} only.{" "}
                  <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show the whole ledger</button>
                </p>
              )}
              <ChartFilterNote label={cf.activeLabel} shown={cf.count(kf.apply(ledger))} total={ledger.length} onClear={cf.clear} />
              {renderTable(cf.apply(kf.apply(ledger)), ledgerColumns, "expenses", cf.activeLabel ? `Nothing in ${cf.activeLabel}` : kf.activeLabel ? `No ${kf.activeLabel}` : "No expenses match", "Adjust the filters to see the ledger.", {
                bulk: "all",
                costCentre: true,
                ...(deptFilter ? { more: { hasMore: deptQ.hasMore, loadMore: deptQ.loadMore } } : {}),
              })}
            </TabsContent>
            {showRecurring && (
              <TabsContent value="recurring">
                {templates.length === 0
                  ? <EmptyState
                      icon={Repeat}
                      title="No recurring expenses"
                      description="A schedule generates a fresh expense every month, quarter or year - rent, subscriptions, retainers - so nobody has to remember to file it."
                      action={<AccessAction collection="expenses" create label="New recurring expense"><Button onClick={() => openCreate(true)}><Plus className="h-4 w-4" /> New schedule</Button></AccessAction>}
                    />
                  : renderTable(templates, recurringColumns, "expenses-recurring", "No schedules match", "Adjust the filters to see the schedules.")}
              </TabsContent>
            )}
          </Tabs>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        {/* The form's own Enter handling stops at the description textarea; Cmd/Ctrl+Enter finishes from anywhere. */}
        <DialogContent scrollBody onEnterSubmit={() => { if (formValid && !busy) void save(); }}>
          <AccessScope collection="expenses" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? (editing.recurring ? "Edit recurring expense" : "Edit expense") : form.recurring ? "New recurring expense" : "New expense"}</DialogTitle>
            <DialogDescription>
              {form.recurring
                ? "A schedule files a fresh expense on every occurrence - nobody has to remember it."
                : submitNow
                  ? `Submitted for approval when you save${threshold > 0 ? `, or approved on the spot at or below ${money(threshold)}` : ""}.`
                  : "Saved as a draft; it goes for approval when you submit it."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col gap-5"
            onSubmit={(e) => { e.preventDefault(); if (formValid && !busy) void save(); }}
          >
            <DialogBody>
            <FormError error={err} />
            {draft.restored && <DraftNotice onStartOver={() => { draft.clear(); resetForm(); }} />}
            <FieldRow>
              <Field label="Category">
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {categories.filter((c) => !c.disabled).map((c) => (
                      <SelectItem key={c.path} value={`expense-categories/${idOf(c.path)}`}>
                        {c.display_name}{c.requires_receipt ? <span className="text-muted-foreground"> · invoice required</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Amount"
                hint={autoApproves ? `At or below ${money(threshold)} this approves itself on submit.` : undefined}
                error={form.amount !== "" && Number(form.amount) <= 0 ? "Enter an amount greater than 0." : undefined}
              >
                <MoneyInput value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} min={0} autoFocus />
              </Field>
            </FieldRow>

            {/* What this expense does to its budget, before it exists. */}
            {budgetImpact && budgetNotice(budgetImpact)}
            {/* The classic expense error: the same invoice filed twice. Say so; don't block it. */}
            {duplicate && duplicateNotice(duplicate)}

            <FieldRow>
              {vendors.length > 0 && (
                <Field label="Vendor (optional)" hint={pickedVendor?.payment_terms ? `Terms: ${pickedVendor.payment_terms}` : undefined}>
                  <Combobox
                    value={form.vendor}
                    onValueChange={(v) => {
                      // A vendor carries its defaults onto the expense - that is what authoring one is for. Only
                      // an empty category is filled: a category chosen by hand is never overwritten by a picker.
                      const vendor = v === "none" ? null : vendors.find((x) => idOf(x.path) === idOf(v));
                      setForm({
                        ...form,
                        vendor: v === "none" ? "" : v,
                        category: form.category || (vendor?.default_category ? `expense-categories/${idOf(vendor.default_category)}` : ""),
                      });
                    }}
                    searchPlaceholder="Search vendors…"
                    placeholder="Select…"
                    options={[{ value: "none", label: "No vendor" }, ...vendors.filter((v) => !v.disabled).map((v) => ({ value: `vendors/${idOf(v.path)}`, label: v.display_name ?? "Unnamed vendor" }))]}
                  />
                </Field>
              )}
              <Field label="Cost centre (optional)" info="Which department's budget this spend lands against.">
                <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field
                label="Tax / GST (optional)"
                info="The tax already included in the amount above - recorded for reconciliation, not added on top."
                error={Number(form.tax_amount) > 0 && Number(form.amount) > 0 && Number(form.tax_amount) > Number(form.amount) ? "More tax than the total amount." : undefined}
              >
                <MoneyInput value={form.tax_amount} onChange={(v) => setForm({ ...form, tax_amount: v })} min={0} suffix="of the amount above" />
              </Field>
              <Field label={form.recurring ? "First incurred on" : "Date incurred"} error={form.incurred_on && form.incurred_on > todayStr() ? "That's in the future." : undefined}>
                <Input type="date" max={todayStr()} value={form.incurred_on} onChange={(e) => setForm({ ...form, incurred_on: e.target.value })} />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Invoice number (optional)">
                <Input value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })} placeholder="e.g. INV-2043" />
              </Field>
              <Field label="Description (optional)">
                <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </FieldRow>
            <div className="flex items-center gap-2">
              <Checkbox id="reimbursable" checked={form.reimbursable} onCheckedChange={(v) => setForm({ ...form, reimbursable: v === true })} />
              <Label htmlFor="reimbursable">An employee fronted this (reimburse via payroll on approval)</Label>
            </div>
            {/* Recording on someone else's behalf: only at create, and only for a caller who can see people. */}
            {form.reimbursable && !editing && canApprove && employees.length > 0 && (
              <Field label="Who fronted it" hint="Leave as yourself unless you're filing on someone else's behalf.">
                <Combobox
                  value={form.employee}
                  onValueChange={(v) => setForm({ ...form, employee: v === "me" ? "" : v })}
                  searchPlaceholder="Search people…"
                  options={[
                    { value: "me", label: "Me" },
                    ...employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` })),
                  ]}
                />
              </Field>
            )}
            <div className="flex items-center gap-2">
              <Checkbox id="recurring" checked={form.recurring} onCheckedChange={(v) => setForm({ ...form, recurring: v === true })} disabled={!!editing} />
              <Label htmlFor="recurring">Recurring expense (auto-generated on a schedule)</Label>
            </div>
            {form.recurring && (
              <>
                <FieldRow>
                  <Field label="Repeats">
                    <Select value={form.recurrence_rule} onValueChange={(v) => setForm({ ...form, recurrence_rule: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="quarterly">Quarterly</SelectItem>
                        <SelectItem value="yearly">Yearly</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Next occurrence" hint="The date the next expense is generated.">
                    <Input type="date" value={form.next_occurrence_on} onChange={(e) => setForm({ ...form, next_occurrence_on: e.target.value })} />
                  </Field>
                </FieldRow>
                {form.next_occurrence_on && (
                  <p className="text-xs text-muted-foreground">
                    Generates on {nextOccurrences(form.next_occurrence_on, form.recurrence_rule, 3).map((d) => formatDate(d)).join(", ")}, and so on.
                  </p>
                )}
              </>
            )}
            {!form.recurring && (
              <Field label={invoiceRequired ? "Invoice" : "Invoice (optional)"} hint={invoiceRequired && !file && !editing ? "This category requires an invoice." : undefined}>
                <FileDrop file={file} onFile={setFile} capture={isPhone} />
              </Field>
            )}
            {!editing && !form.recurring && (
              <div className="flex items-center gap-2">
                <Checkbox id="submitNow" checked={submitNow} onCheckedChange={(v) => setSubmitNow(v === true)} />
                <Label htmlFor="submitNow">Submit for approval now</Label>
              </div>
            )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!formValid}>
                {editing ? "Save changes" : form.recurring ? "Create schedule" : submitNow ? "Submit" : "Save draft"}
              </Button>
            </DialogFooter>
          </form>
          </AccessScope>
        </DialogContent>
      </Dialog>

      <Dialog open={quickOpen} onOpenChange={quickGuard.onOpenChange}>
        <DialogContent scrollBody>
          <AccessScope collection="expenses">
          <DialogHeader>
            <DialogTitle>Quick add expense</DialogTitle>
            <DialogDescription>The short form: amount, what for, a photo of the receipt. Dated today and sent for approval.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={quickErr} />
          {quickDraft.restored && <DraftNotice onStartOver={() => { quickDraft.clear(); setQuick({ amount: "", category: "", description: "" }); }} />}
          {/* The form ends before the footer so the footer can sit outside the scroll area and stay put; the
              submit button reaches it by id instead of by nesting, which keeps Enter-to-submit working. */}
          <form id="quick-expense" className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (quick.amount && Number(quick.amount) > 0 && !quickBusy) void quickSubmit(); }}>
            <FieldRow>
              <Field label="Amount" error={quick.amount !== "" && Number(quick.amount) <= 0 ? "Enter an amount greater than 0." : undefined}>
                <MoneyInput value={quick.amount} onChange={(v) => setQuick({ ...quick, amount: v })} min={0} autoFocus />
              </Field>
              <Field label="Category (optional)">
                <Select value={quick.category} onValueChange={(v) => setQuick({ ...quick, category: v })}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {categories.filter((c) => !c.disabled).map((c) => (
                      <SelectItem key={c.path} value={`expense-categories/${idOf(c.path)}`}>{c.display_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldRow>
            {quickImpact && budgetNotice(quickImpact)}
            {quickDuplicate && duplicateNotice(quickDuplicate)}
            <Field label="What for? (optional)">
              <Input value={quick.description} onChange={(e) => setQuick({ ...quick, description: e.target.value })} placeholder="e.g. Team lunch, cab, snacks" />
            </Field>
            <Field label={isPhone ? "Receipt photo (optional)" : "Receipt (optional)"}>
              <FileDrop file={quickFile} onFile={setQuickFile} capture={isPhone} />
            </Field>
            <p className="text-xs text-muted-foreground">
              Dated today and submitted for approval{threshold > 0 && quick.amount && Number(quick.amount) <= threshold ? ` (at or below ${money(threshold)} it approves itself)` : ""}. Use New expense for vendor, cost centre, tax or invoice details.
            </p>
          </form>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => quickGuard.onOpenChange(false)}>Cancel</Button>
            <Button type="submit" form="quick-expense" loading={quickBusy} disabled={!quick.amount || Number(quick.amount) <= 0}>Add expense</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>

      <Dialog open={!!payFor} onOpenChange={(o) => { if (!o && !payBusy) setPayFor(null); }}>
        <DialogContent onEnterSubmit={confirmPay}>
          <AccessScope collection="expenses" objectPath={payFor?.path}>
          <DialogHeader>
            <DialogTitle>Mark expense paid</DialogTitle>
            <DialogDescription>Records that the money has actually left - the expense is closed and stops showing as owed. This is the payment record, so the reference is what reconciliation matches against.</DialogDescription>
          </DialogHeader>
          <FormError error={payErr} />
          {payFor && (
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{payeeName(payFor)}</span>
                <span className="font-semibold tabular-nums">{money(payFor.amount)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {payFor.category ? catName(payFor.category) : "Uncategorised"}
                {payFor.invoice_number ? ` · invoice ${payFor.invoice_number}` : ""}
                {payFor.incurred_on ? ` · incurred ${formatDate(payFor.incurred_on)}` : ""}
              </p>
            </div>
          )}
          <div className="grid gap-4">
            <Field label="Payment method">
              <Select value={payForm.payment_method} onValueChange={(v) => setPayForm({ ...payForm, payment_method: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAY_METHODS.map((m) => <SelectItem key={m} value={m}>{m.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Payment reference (optional)" hint="Kept on the expense and shown in its detail - a UTR, cheque or transaction number is what ties this row to the bank statement.">
              <Input value={payForm.payment_ref} onChange={(e) => setPayForm({ ...payForm, payment_ref: e.target.value })} placeholder="e.g. UTR / cheque no." autoFocus />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={payBusy} onClick={() => setPayFor(null)}>Cancel</Button>
            <Button variant="success" loading={payBusy} onClick={confirmPay}><Banknote className="h-4 w-4" /> Mark paid</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>

      <Dialog open={!!payBulkFor} onOpenChange={(o) => { if (!o) closePayBulk(); }}>
        <DialogContent onEnterSubmit={commitPayBulk}>
          <DialogHeader>
            <DialogTitle>Mark {payBulkFor?.length ?? 0} expenses paid</DialogTitle>
            <DialogDescription>One method and one reference for the whole batch - the shape of a single bank transfer covering several invoices. Each expense is closed and stops showing as owed.</DialogDescription>
          </DialogHeader>
          <FormError error={payErr} />
          {payBulkFor && (
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{payBulkFor.length} approved {payBulkFor.length === 1 ? "expense" : "expenses"}</span>
                <span className="font-semibold tabular-nums">{money(sum(payBulkFor))}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {payBulkFor.slice(0, 3).map((r) => payeeName(r)).join(", ")}{payBulkFor.length > 3 ? ` and ${payBulkFor.length - 3} more` : ""}
              </p>
            </div>
          )}
          <div className="grid gap-4">
            <Field label="Payment method">
              <Select value={payForm.payment_method} onValueChange={(v) => setPayForm({ ...payForm, payment_method: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAY_METHODS.map((m) => <SelectItem key={m} value={m}>{m.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Payment reference (optional)" hint="Recorded on every expense in this batch - the one UTR or cheque number that paid them all.">
              <Input value={payForm.payment_ref} onChange={(e) => setPayForm({ ...payForm, payment_ref: e.target.value })} placeholder="e.g. UTR / cheque no." autoFocus />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={payBusy} onClick={closePayBulk}>Cancel</Button>
            <Button variant="success" loading={payBusy} onClick={commitPayBulk}><Banknote className="h-4 w-4" /> Mark {payBulkFor?.length ?? 0} paid</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejectFor} onOpenChange={(o) => { if (!o && !rejectBusy) setRejectFor(null); }}>
        {/* Cmd/Ctrl+Enter submits: the only field is a textarea, where plain Enter has to stay a newline. */}
        <DialogContent onEnterSubmit={confirmReject}>
          <AccessScope collection="expenses" objectPath={rejectFor?.path}>
          <DialogHeader>
            <DialogTitle>Reject expense</DialogTitle>
            <DialogDescription>The submitter is notified with your reason and can fix the problem and file again.</DialogDescription>
          </DialogHeader>
          <FormError error={rejectErr} />
          {rejectFor && (
            <p className="text-sm text-muted-foreground">
              {payeeName(rejectFor)} · <span className="font-medium text-foreground tabular-nums">{money(rejectFor.amount)}</span>
              {rejectFor.incurred_on ? ` · ${formatDate(rejectFor.incurred_on)}` : ""}
            </p>
          )}
          <Field label="Reason" hint="Sent to the submitter with the decision, and kept on the record. Without one they only learn that it was refused.">
            <Textarea rows={3} autoFocus value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="e.g. Missing the vendor invoice - please attach it and file again." />
          </Field>
          {/* The same four rejections account for most of them. One tap writes the sentence, still editable -
              a reviewer working a queue shouldn't retype "please attach the invoice" twenty times a week. */}
          <div className="flex flex-wrap gap-1.5">
            {REJECT_REASONS.map((r) => (
              <Button key={r.label} type="button" size="sm" variant="outline" className="h-7 rounded-full text-xs font-normal" title={r.note} onClick={() => setRejectNote(r.note)}>
                {r.label}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={rejectBusy} onClick={() => setRejectFor(null)}>Cancel</Button>
            <Button variant="destructive" loading={rejectBusy} onClick={confirmReject}><X className="h-4 w-4" /> Reject</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>

      <PdfPreviewDialog source={preview} onClose={() => setPreview(null)} />

      <ExpenseDetail
        expense={detail}
        onClose={() => setDetailPath(null)}
        money={money}
        payeeName={payeeName}
        catName={catName}
        deptName={deptName}
        empName={empName}
        glOf={catGl}
        stateCell={stateCell}
        primary={detail ? primaryAction(detail) : null}
        actions={detail ? rowActions(detail) : []}
        onDropInvoice={detail && ["DRAFT", "SUBMITTED"].includes(up(detail.state)) ? (f) => attachTo(detail, f) : undefined}
      />
    </div>
  );
}

// A file field that also accepts a drop, and on a phone offers the camera - a receipt is usually a photo, and
// dragging the PDF out of the mail client is how one arrives on a desktop.
function FileDrop({ file, onFile, capture }: { file: File | null; onFile: (f: File | null) => void; capture?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cn("rounded-lg border border-dashed p-2 transition-colors", over ? "border-primary bg-primary/5" : "border-border")}
    >
      <Input type="file" accept="image/*,application/pdf" {...(capture ? { capture: "environment" as const } : {})} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      <p className="mt-1 px-1 text-xs text-muted-foreground">
        {file ? file.name : capture ? "Take a photo, or pick a file." : "Drop a file here, or choose one."}
      </p>
    </div>
  );
}

// Where the money actually went: committed spend over six months, and the categories and vendors taking the
// biggest share of it. One measure, one hue - bar length carries the magnitude and the value is labelled, so
// nothing here depends on telling colours apart.
function SpendBreakdown({ insight, money }: {
  insight: { months: { key: string; label: string; year: number; total: number }[]; cats: [string, number][]; vendors: [string, number][]; total: number };
  money: (n: number) => string;
}) {
  const peak = Math.max(1, ...insight.months.map((m) => m.total));
  const catPeak = Math.max(1, ...insight.cats.map(([, v]) => v));
  const vendorPeak = Math.max(1, ...insight.vendors.map(([, v]) => v));
  const bars = (rows: [string, number][], peakValue: number) => (
    <div className="space-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(5rem,8rem)_1fr_auto] items-center gap-2 text-xs" title={`${label}: ${money(value)}`}>
          <span className="truncate text-muted-foreground">{label}</span>
          <span className="block h-2 rounded bg-muted">
            <span className="block h-2 rounded bg-primary" style={{ width: `${Math.max(2, Math.round((value / peakValue) * 100))}%` }} />
          </span>
          <span className="tabular-nums font-medium">{money(value)}</span>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-muted-foreground">Nothing committed yet.</p>}
    </div>
  );
  return (
    <Card className="mb-4">
      <CardContent className="grid gap-6 pt-4 sm:grid-cols-2 sm:pt-6">
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-medium">Committed spend · last 6 months</p>
          <p className="mb-3 text-xs text-muted-foreground">Approved and paid expenses, by the month they were incurred. Total {money(insight.total)}.</p>
          <div className="flex h-28 items-end gap-2">
            {insight.months.map((m) => (
              <div key={m.key} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${m.label} ${m.year}: ${money(m.total)}`}>
                <span className="text-[10px] tabular-nums text-muted-foreground">{m.total ? money(m.total) : ""}</span>
                <span className="block w-full rounded-t bg-primary" style={{ height: `${Math.max(2, Math.round((m.total / peak) * 76))}px` }} />
                <span className="text-[10px] text-muted-foreground">{m.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Top categories</p>
          {bars(insight.cats, catPeak)}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Top vendors</p>
          {bars(insight.vendors, vendorPeak)}
        </div>
      </CardContent>
    </Card>
  );
}

// One expense, whole: every field the table hides (tax, invoice number, payment reference, cost centre, GL
// code, the schedule it came from, why it was rejected) plus its audit trail, so a reviewer decides from the
// record instead of guessing from six columns. Reached by clicking the row.
function ExpenseDetail({ expense: r, onClose, money, payeeName, catName, deptName, empName, glOf, stateCell, primary, actions, onDropInvoice }: {
  expense: Expense | null;
  onClose: () => void;
  money: (n: number) => string;
  payeeName: (r: Expense) => string;
  catName: (p?: string) => string;
  deptName: (p?: string) => string;
  empName: (p?: string) => string;
  glOf: (p?: string) => string;
  stateCell: (r: Expense) => React.ReactNode;
  primary: { verb: string; label: string; icon: React.ReactNode; run: () => void; variant: "ghost" | "success" } | null;
  actions: RowAction[];
  onDropInvoice?: (f: File) => void;
}) {
  // Same belt-and-braces as RowActions: a verb the caller may not invoke on THIS row is dropped, while access
  // mode shows everything (an admin manages gates for actions they can't use themselves).
  const am = useAccessMode();
  const shown = am.enabled ? actions : actions.filter((a) => !a.verb || (r?.access?.can ?? []).includes(a.verb));
  const [over, setOver] = useState(false);
  const upcoming = r?.recurring ? nextOccurrences(r.next_occurrence_on, r.recurrence_rule, 3) : [];
  return (
    <Dialog open={!!r} onOpenChange={(o) => !o && onClose()}>
      <DialogContent scrollBody className="max-w-2xl lg:max-w-3xl">
        {r && (
          <div
            onDragOver={onDropInvoice ? (e) => { e.preventDefault(); setOver(true); } : undefined}
            onDragLeave={onDropInvoice ? () => setOver(false) : undefined}
            onDrop={onDropInvoice ? (e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onDropInvoice(f);
            } : undefined}
            className={cn("flex min-h-0 flex-1 flex-col gap-4 rounded-lg transition-colors", over && "ring-2 ring-primary ring-offset-4 ring-offset-background")}
          >
            <DialogHeader>
              <DialogTitle className="flex items-baseline gap-2 pr-6">
                <span className="tabular-nums">{money(r.amount)}</span>
                <span className="truncate text-base font-normal text-muted-foreground">{payeeName(r)}</span>
              </DialogTitle>
              <DialogDescription>
                Filed by {empName(r.employee)}{r.create_time ? ` on ${formatDate(r.create_time)}` : ""}.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {stateCell(r)}
              {r.category && <Badge variant="secondary">{catName(r.category)}</Badge>}
              {r.reimbursable && <Badge variant="secondary">Employee-fronted</Badge>}
              {r.recurring && <Badge variant="secondary"><Repeat className="h-3 w-3" /> Schedule</Badge>}
              {r.recurring && r.paused && <Badge variant="warning">Paused</Badge>}
              {r.template && <Badge variant="secondary"><Repeat className="h-3 w-3" /> From a schedule</Badge>}
            </div>

            {up(r.state) === "REJECTED" && r.decision_note && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                Rejected: {r.decision_note}
              </p>
            )}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div><dt className="text-muted-foreground">Cost centre</dt><dd>{deptName(r.department)}</dd></div>
              {r.tax_amount ? <div><dt className="text-muted-foreground">Of which tax</dt><dd className="tabular-nums">{money(r.tax_amount)}</dd></div> : null}
              <div><dt className="text-muted-foreground">Incurred</dt><dd>{r.incurred_on ? formatDate(r.incurred_on) : "-"}</dd></div>
              {glOf(r.category) && <div><dt className="text-muted-foreground">GL code</dt><dd>{glOf(r.category)}</dd></div>}
              {r.invoice_number && <div><dt className="text-muted-foreground">Invoice number</dt><dd>{r.invoice_number}</dd></div>}
              {r.payment_method && <div><dt className="text-muted-foreground">Paid by</dt><dd>{up(r.payment_method)}{r.payment_ref ? ` · ${r.payment_ref}` : ""}</dd></div>}
              {r.paid_time && <div><dt className="text-muted-foreground">Paid on</dt><dd>{formatDate(r.paid_time)}</dd></div>}
              {r.recurring && (
                <>
                  <div><dt className="text-muted-foreground">Repeats</dt><dd>{RULE_LABEL[r.recurrence_rule ?? ""] ?? "-"}</dd></div>
                  <div>
                    <dt className="text-muted-foreground">Next occurrences</dt>
                    <dd>{upcoming.length ? upcoming.map((d) => formatDate(d)).join(", ") : "-"}</dd>
                  </div>
                  <div><dt className="text-muted-foreground">Last generated</dt><dd>{r.last_generated_time ? formatDate(r.last_generated_time) : "never"}</dd></div>
                </>
              )}
            </dl>

            {r.description && <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{r.description}</p>}

            {r.reimbursable && up(r.state) === "APPROVED" && (
              <p className="text-xs text-muted-foreground">Queued as a reimbursement - it pays out with the next payroll run, not from this page.</p>
            )}
            {onDropInvoice && !r.has_invoice && (
              <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                <Paperclip className="mr-1 inline h-3.5 w-3.5" />No invoice attached - drop a file anywhere in this dialog, or use "Attach invoice" below.
              </p>
            )}

            <ActivitySection resource={r.path} className="border-t pt-3" />
            </DialogBody>

            {/* Every move this expense can make, spelled out - the dialog is where a decision gets made, so the
                actions are buttons here rather than hidden behind the row menu's hover-revealed trigger. They
                sit outside the scrolling middle, so a long record never pushes the decision below the fold. */}
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              {primary && (
                <AccessAction collection="expenses" objectPath={r.path} verb={primary.verb} can={r.access?.can} label={primary.label}>
                  <Button size="sm" variant={primary.variant === "success" ? "success" : "default"} onClick={() => { primary.run(); onClose(); }}>
                    {primary.icon} {primary.label}
                  </Button>
                </AccessAction>
              )}
              {shown.map((a) => {
                const btn = (
                  <Button
                    key={a.label}
                    size="sm"
                    variant="outline"
                    className={a.destructive ? "text-destructive" : undefined}
                    onClick={() => { a.onClick(); if (a.verb) onClose(); }}
                  >
                    {a.icon} {a.label}
                  </Button>
                );
                return a.verb ? (
                  <AccessAction key={a.label} collection="expenses" objectPath={r.path} verb={a.verb} can={r.access?.can} label={a.label}>
                    {btn}
                  </AccessAction>
                ) : btn;
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
