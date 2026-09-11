import { useEffect, useMemo, useRef, useState } from "react";
import { PiggyBank, Plus, Copy, Wallet, TrendingUp, AlertTriangle, CircleSlash, Bell, ArrowRight, Layers, Table2, Repeat, CalendarRange } from "lucide-react";
import { create, get, patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { usePermission } from "@/lib/perm";
import { idOf, formatMoney, formatDate, round2, cn } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import { navigate } from "@/router";
import type { Expense, ExpenseBudget, ExpenseCategory, Department, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { StatRow } from "@/components/common/StatRow";
import { Chart } from "@/components/common/Chart";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { TableSkeleton } from "@/components/common/Skeletons";
import { DataTable, type Column, type BulkAction } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { SoftDeleteRowActions } from "@/components/common/SoftDeleteRowActions";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type PeriodType = "monthly" | "quarterly" | "yearly";
// Where a period sits relative to today. A budgets list is almost always asked "what are we spending against
// NOW" - a wall of finished periods is history, not a working set - so the page opens on the live ones.
type Phase = "current" | "upcoming" | "past" | "all";
const DAY = 86400000;

// ---- period keys ----------------------------------------------------------------------------------------
// The key format is the server's own (domain/expenses periodKeyFor): "2026" | "2026-Q3" | "2026-07". These
// helpers let the page sort chronologically, label a period in prose, measure how much of it has elapsed and
// roll one forward - all without asking the server, which only ever hands back the opaque key.
function periodRange(type: string, key: string): { start: number; end: number } | null {
  const y = Number(key.slice(0, 4));
  if (!Number.isFinite(y) || key.length < 4) return null;
  if (type === "yearly") return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) };
  if (type === "quarterly") {
    const q = Number(key.slice(6));
    if (!(q >= 1 && q <= 4)) return null;
    return { start: Date.UTC(y, (q - 1) * 3, 1), end: Date.UTC(y, q * 3, 1) };
  }
  const m = Number(key.slice(5, 7));
  if (!(m >= 1 && m <= 12)) return null;
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}

function periodLabel(type: string, key: string): string {
  const r = periodRange(type, key);
  if (!r) return key;
  const d = new Date(r.start);
  if (type === "yearly") return String(d.getUTCFullYear());
  if (type === "quarterly") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function keyFor(type: PeriodType, at: Date): string {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  if (type === "yearly") return String(y);
  if (type === "quarterly") return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

// The period straight after this one, in the same type - what "duplicate to next period" and roll-forward mean.
function nextKey(type: string, key: string): string | null {
  const r = periodRange(type, key);
  if (!r) return null;
  return keyFor(type as PeriodType, new Date(r.end));
}

// The period straight before this one - what the create dialog reads to anchor a new cap on the last one.
function prevKey(type: string, key: string): string | null {
  const r = periodRange(type, key);
  if (!r) return null;
  return keyFor(type as PeriodType, new Date(r.start - DAY));
}

function phaseOf(b: ExpenseBudget, now: number): Exclude<Phase, "all"> {
  const r = periodRange(b.period_type, b.period_key);
  if (!r) return "current"; // an unparseable key is never hidden behind a phase filter
  if (now >= r.end) return "past";
  if (now < r.start) return "upcoming";
  return "current";
}

// How far into its period a cap is, and the spend that pace implies. A cap at 60% on day 5 of 30 is in
// trouble; one at 60% on day 26 is fine. Without this, every number on the page is a post-mortem.
function paceOf(b: ExpenseBudget, now: number): { elapsed: number; day: number; days: number; projected: number | null } | null {
  const r = periodRange(b.period_type, b.period_key);
  if (!r) return null;
  const days = Math.max(1, Math.round((r.end - r.start) / DAY));
  const elapsed = Math.min(1, Math.max(0, (now - r.start) / (r.end - r.start)));
  const day = Math.min(days, Math.max(0, Math.ceil((now - r.start) / DAY)));
  // Below a fiftieth of the period the divisor is noise ("₹500 on day 1" is not a ₹15,000 month), so no forecast.
  const projected = elapsed >= 0.02 ? (b.utilization ?? 0) / elapsed : null;
  return { elapsed, day, days, projected };
}

const scopeKey = (b: { department?: string; category?: string; period_type: string; period_key: string }) =>
  `${b.department ? idOf(b.department) : "-"}|${b.category ? idOf(b.category) : "-"}|${b.period_type}|${b.period_key}`;

const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const covers = (type: string, key: string) => {
  const r = periodRange(type, key);
  return r ? `${fmtDay(r.start)} to ${fmtDay(r.end - DAY)}` : null;
};
const dayParam = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Health = "Deleted" | "Over" | "At risk" | "Trending over" | "Unused" | "On track";
const HEALTH_TONE: Record<Health, "muted" | "destructive" | "warning" | "success"> = {
  Deleted: "muted", Over: "destructive", "At risk": "warning", "Trending over": "warning", Unused: "muted", "On track": "success",
};

const EMPTY = { department: "", category: "", period_type: "monthly" as PeriodType, period_key: "", amount: "", recurring: true };

// One line of a roll-forward: the cap being copied, the period it lands in, and the amount to open it at
// (editable, because last period's number is the starting point and rarely the answer).
type RollLine = { source: ExpenseBudget; key: string; amount: string; blocked?: string };

export default function ExpenseBudgets({ me, openId }: { me: Me; openId?: string }) {
  const [phase, setPhase] = useState<Phase>("current");
  const [risk, setRisk] = useState<"all" | "risk" | "over">("all");
  // Period and risk scoping happen SERVER-side. A monthly cap per category per cost centre is hundreds of rows
  // a year and a page holds 100, so filtering the loaded array would answer with page one while reading as the
  // whole collection. The same read carries `summary` (totals over the whole filtered set) and `phase_counts`.
  const params = useMemo(() => ({
    ...(phase === "all" ? {} : { period: phase }),
    ...(risk === "all" ? {} : { status: risk === "over" ? "over" : "at_risk" }),
  }), [phase, risk]);
  // Deleted caps are their own view, reached by picking "Deleted" in the Status filter (offered whether or not
  // any is loaded). Never mixed in by default: this list paginates and carries server-side filters, so the
  // trash would otherwise spend part of the 100-row page - and every viewer's D1 reads - on rows nobody asked
  // for, and push live caps off it.
  const [statusFilter, setStatusFilter] = useState("");
  const deletedOnly = statusFilter === "Deleted";
  const { rows, state, error, reload, hasMore, loadMore, meta } = useCollection<ExpenseBudget>("expense-budgets", { deletedOnly, params });
  const summary = meta?.summary as { count: number; amount: number; spent: number; pending: number; over: number; at_risk: number } | undefined;
  const phaseCounts = (meta?.phase_counts ?? { current: 0, upcoming: 0, past: 0 }) as { current: number; upcoming: number; past: number };
  const { rows: categories } = useCollection<ExpenseCategory>("expense-categories");
  const { rows: departments } = useCollection<Department>("departments");
  const { org } = useOrg();
  const { toast } = useToast();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [busy, setBusy] = useState(false);
  const sd = useSoftDelete("expense-budgets", "budget", reload);
  const writable = usePermission("expense-budgets.write");
  const canPurge = usePermission("expense-budgets.admin");
  const canReadExpenses = usePermission("expenses.read");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseBudget | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [rollErr, setRollErr] = useState<string | null>(null);
  const guard = useDialogGuard(open, form, () => setOpen(false), { label: "budget" });
  const [amountTouched, setAmountTouched] = useState(false);
  const [view, setView] = useState<"table" | "rollup" | "matrix">("table");
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [groupBy, setGroupBy] = useState<"department" | "category">("department");
  const [detailPath, setDetail] = useState<string | null>(null);
  // A deep link (#/expense-budgets/<id>) opens that cap's detail panel.
  useDeepOpen(openId, rows, (b) => setDetail(b.path));

  // The "at risk" line is the same threshold the daily budget-alert cron fires on (settings/expenses
  // budget_alert_thresholds), so the page's amber never disagrees with the alert an admin already configured.
  const [warnAt, setWarnAt] = useState(80);
  useEffect(() => {
    getSetting<{ budget_alert_thresholds?: number[] }>("expenses")
      .then((s) => {
        const ts = (s.value?.budget_alert_thresholds ?? []).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
        const warn = ts.find((t) => t < 100);
        if (warn) setWarnAt(warn);
      })
      .catch(() => {});
  }, []);

  const catName = useMemo(() => { const m = new Map(categories.map((c) => [idOf(c.path), c.display_name])); return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "All categories"); }, [categories]);
  const deptName = useMemo(() => { const m = new Map(departments.map((d) => [idOf(d.path), d.display_name])); return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "Org-wide"); }, [departments]);

  const now = Date.now();
  const pctOf = (b: ExpenseBudget) => Math.round((b.utilization ?? 0) * 100);
  const healthOf = (b: ExpenseBudget): Health => {
    if (b.delete_time) return "Deleted";
    const pct = pctOf(b);
    if (pct >= 100) return "Over";
    if (pct >= warnAt) return "At risk";
    const ph = phaseOf(b, now);
    if (ph === "past") return pct === 0 ? "Unused" : "On track";
    const projected = paceOf(b, now)?.projected;
    if (ph === "current" && projected != null && projected >= 1) return "Trending over";
    return "On track";
  };

  const live = useMemo(() => rows.filter((b) => !b.delete_time), [rows]);
  // The chart takes the eight biggest caps in view. A budget page can hold hundreds of rows; eight bars is
  // what fits legibly, and the largest caps are where the money actually is - the table below keeps the rest.
  const capChart = useMemo(() => {
    const top = [...live].filter((b) => (b.amount || 0) > 0).sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 8);
    return {
      labels: top.map((b) => catName(b.category) || deptName(b.department) || "Unscoped"),
      spent: top.map((b) => Math.round(b.spent ?? 0)),
      caps: top.map((b) => Math.round(b.amount || 0)),
    };
  }, [live, catName, deptName]);
  // Newest period first, then the caps under most pressure - the two orders a budget owner reads in. Deleted
  // rows are only here at all when the reader asked for them.
  const shown = useMemo(
    () => [...rows].sort((a, b) => {
      const sa = periodRange(a.period_type, a.period_key)?.start ?? 0;
      const sb = periodRange(b.period_type, b.period_key)?.start ?? 0;
      return sb - sa || (b.utilization ?? 0) - (a.utilization ?? 0);
    }),
    [rows],
  );

  // Straight from the server's aggregate over the whole filtered set. The fallback sums the loaded rows, which
  // only matters for the instant before the first response lands.
  const totals = useMemo(() => {
    const budgeted = summary?.amount ?? live.reduce((n, b) => n + (b.amount || 0), 0);
    const spent = summary?.spent ?? live.reduce((n, b) => n + (b.spent ?? 0), 0);
    return {
      count: summary?.count ?? live.length,
      budgeted,
      spent,
      pending: summary?.pending ?? live.reduce((n, b) => n + (b.pending ?? 0), 0),
      remaining: budgeted - spent,
      pct: budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0,
      atRisk: summary?.at_risk ?? 0,
      over: summary?.over ?? 0,
    };
  }, [summary, live]);

  // ---- year matrix ----------------------------------------------------------------------------------------
  // A year of monthly caps as scope x month, which is the read a page of hundreds of rows cannot give. Its own
  // bounded query (monthly caps in one calendar year), fetched only while the view is open, following the
  // cursor so the grid is complete rather than quietly showing page one.
  const matrixQ = useCollection<ExpenseBudget>("expense-budgets", {
    params: { period_type: "monthly", year: String(year) },
    enabled: view === "matrix",
    max: 100,
  });
  const MATRIX_ROW_CAP = 400; // ~33 scopes across 12 months; past this, ask for a filter instead of paging on
  const matrixCapped = matrixQ.hasMore && matrixQ.rows.length >= MATRIX_ROW_CAP;
  useEffect(() => {
    if (view === "matrix" && matrixQ.hasMore && matrixQ.rows.length < MATRIX_ROW_CAP) void matrixQ.loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, matrixQ.hasMore, matrixQ.rows.length]);

  // The next period's caps, read only while the Current chip is up AND some current cap does not repeat itself
  // (a recurring cap opens its own successor, so nothing to nag about). One bounded read, skipped otherwise.
  const needsUpcoming = phase === "current" && live.some((b) => !b.recurring);
  const { rows: upcoming } = useCollection<ExpenseBudget>("expense-budgets", { params: { period: "upcoming" }, enabled: needsUpcoming });

  // ---- what needs attention -------------------------------------------------------------------------------
  // Budgets fail by omission as much as by overspend: a category nobody capped, a next period nobody opened,
  // dept caps quietly adding up past the org-wide cap they sit under. All three read from rows already loaded.
  const attention = useMemo(() => {
    const current = live.filter((b) => phaseOf(b, now) === "current");
    // Whether a cap's next period is already open is a fact about rows this read does not carry (the Current
    // chip returns current caps only), so the companion read below supplies them.
    const claimed = new Set([...live, ...upcoming].map((b) => scopeKey(b as any)));

    // A cap with no category is a blanket cap - it already covers everything, so per-category gaps are moot.
    const blanket = current.some((b) => !b.category);
    const capped = new Set(current.map((b) => (b.category ? idOf(b.category) : "")));
    const gaps = blanket ? [] : categories.filter((c) => !c.disabled && !c.delete_time && !capped.has(idOf(c.path)));

    // A recurring cap opens its own next period at rollover, so it is not a gap - nagging about it every day
    // of the current period would make the band permanent noise.
    const rollable = current.filter((b) => {
      if (b.recurring) return false;
      const key = nextKey(b.period_type, b.period_key);
      return key && !claimed.has(scopeKey({ department: b.department, category: b.category, period_type: b.period_type, period_key: key }));
    });

    // Dept caps under an org-wide cap for the same category+period: their sum is an allocation, and an
    // allocation above the parent cap means the parent is already broken before anyone spends.
    const overAllocated: { label: string; by: number }[] = [];
    const byParent = new Map<string, { parent: ExpenseBudget; children: ExpenseBudget[] }>();
    for (const b of current) {
      const key = `${b.category ? idOf(b.category) : "-"}|${b.period_type}|${b.period_key}`;
      const slot = byParent.get(key) ?? { parent: undefined as unknown as ExpenseBudget, children: [] };
      if (b.department) slot.children.push(b);
      else slot.parent = b;
      byParent.set(key, slot);
    }
    for (const { parent, children } of byParent.values()) {
      if (!parent || children.length === 0) continue;
      const allocated = children.reduce((n, c) => n + (c.amount || 0), 0);
      if (allocated > parent.amount) overAllocated.push({ label: `${catName(parent.category)} ${periodLabel(parent.period_type, parent.period_key)}`, by: allocated - parent.amount });
    }
    return { gaps, rollable, overAllocated };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, upcoming, categories, now]);

  function openCreate(seed?: { category?: string; department?: string }) {
    setEditing(null);
    setAmountTouched(false);
    setForm({ ...EMPTY, ...seed, period_key: keyFor("monthly", new Date()) });
    setOpen(true);
  }
  function openEdit(b: ExpenseBudget) {
    setEditing(b);
    setAmountTouched(true);
    setForm({
      department: b.department ? `departments/${idOf(b.department)}` : "",
      category: b.category ? `expense-categories/${idOf(b.category)}` : "",
      period_type: b.period_type as PeriodType, period_key: b.period_key, amount: String(b.amount ?? ""),
      recurring: !!b.recurring,
    });
    setOpen(true);
  }

  // Two caps over the same scope and period would both be checked against the same expenses and both alert -
  // the server has no uniqueness on the tuple, so the page refuses to author the collision.
  const taken = useMemo(() => {
    const m = new Set<string>();
    for (const b of rows) if (!b.delete_time && b.path !== editing?.path) m.add(scopeKey(b as any));
    return m;
  }, [rows, editing]);
  const formKey = scopeKey({ department: form.department || undefined, category: form.category || undefined, period_type: form.period_type, period_key: form.period_key });
  const duplicate = !!form.period_key && taken.has(formKey);
  const amountNum = Number(form.amount);
  const valid = !!form.period_key.trim() && amountNum > 0 && !duplicate;

  // Last period's cap for the same scope: what the new one should probably be, and what actually got spent
  // against it. Prefilling beats an empty field the author has to guess into.
  const priorCap = useMemo(() => {
    if (!form.period_key) return null;
    const key = prevKey(form.period_type, form.period_key);
    if (!key) return null;
    const want = scopeKey({ department: form.department || undefined, category: form.category || undefined, period_type: form.period_type, period_key: key });
    return live.find((b) => scopeKey(b as any) === want) ?? null;
  }, [live, form.department, form.category, form.period_type, form.period_key]);
  useEffect(() => {
    if (!open || editing || amountTouched || !priorCap) return;
    setForm((f) => ({ ...f, amount: String(priorCap.amount) }));
  }, [open, editing, amountTouched, priorCap]);

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        department: form.department, category: form.category,
        period_type: form.period_type, period_key: form.period_key.trim(), amount: amountNum,
        recurring: form.recurring,
      };
      if (editing) {
        await patch("expense-budgets/" + idOf(editing.path), body, editing.etag);
        toast({ title: "Budget updated", variant: "success" });
      } else {
        await create("expense-budgets", body);
        toast({ title: "Budget created", variant: "success" });
      }
      guard.markSaved();
      setOpen(false);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ---- roll forward ---------------------------------------------------------------------------------------
  // Budgets repeat: last month's caps are next month's starting point. Copying beats retyping the scope - but
  // creating N rows on one click, at amounts nobody looked at, is not something to do blind. Every entry point
  // (row action, bulk bar, the attention band) opens the same review sheet: what will be created, at what
  // amount, with one uplift control for the usual "same again, +5%".
  const [roll, setRoll] = useState<RollLine[] | null>(null);
  const [uplift, setUplift] = useState("0");
  // Resolves when the review is committed and rejects when it is dismissed, so DataTable keeps a selection the
  // user backed out of (its bulk runner treats a throw as "keep the selection for a retry").
  const rollDone = useRef<{ resolve: () => void; reject: () => void } | null>(null);

  function openRoll(list: ExpenseBudget[]): Promise<void> {
    const claimed = new Set(live.map((b) => scopeKey(b as any)));
    const lines: RollLine[] = list.map((b) => {
      const key = nextKey(b.period_type, b.period_key);
      if (!key) return { source: b, key: b.period_key, amount: String(b.amount), blocked: "Period can't be advanced" };
      const target = scopeKey({ department: b.department, category: b.category, period_type: b.period_type, period_key: key });
      return { source: b, key, amount: String(b.amount), blocked: claimed.has(target) ? "Already budgeted" : undefined };
    });
    setUplift("0");
    setRoll(lines);
    return new Promise<void>((resolve, reject) => { rollDone.current = { resolve, reject }; });
  }
  function closeRoll(committed: boolean) {
    setRoll(null);
    setRollErr(null);
    const d = rollDone.current;
    rollDone.current = null;
    if (committed) d?.resolve();
    else d?.reject();
  }

  async function commitRoll() {
    const lines = (roll ?? []).filter((l) => !l.blocked);
    if (lines.length === 0) { closeRoll(true); return; }
    setBusy(true);
    setRollErr(null);
    let made = 0;
    try {
      for (const l of lines) {
        const amount = Number(l.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        await create("expense-budgets", {
          department: l.source.department ? `departments/${idOf(l.source.department)}` : "",
          category: l.source.category ? `expense-categories/${idOf(l.source.category)}` : "",
          period_type: l.source.period_type, period_key: l.key, amount,
          recurring: l.source.recurring, // a repeating cap's copy repeats too
        });
        made++;
      }
      toast({ title: made === 1 ? "Budget rolled forward" : `${made} budgets rolled forward`, variant: "success" });
      closeRoll(true);
    } catch (e) {
      // The loop creates budgets one at a time, so a failure part-way leaves some already made. Closing here
      // would throw away every edited cap AND hide how far it got - so it stays open, says both, and the
      // already-created lines come back as "already has a budget" when the list reloads.
      setRollErr(
        made > 0
          ? `${made} of ${lines.length} created, then it stopped: ${(e as Error).message}`
          : (e as Error).message,
      );
      if (made > 0) reload();
    } finally {
      setBusy(false);
      reload();
    }
  }

  const rollValid = (roll ?? []).some((l) => !l.blocked && Number(l.amount) > 0);
  // The consequence of the whole sheet, before it is committed: what next period is being capped at, against
  // what this period is capped at today. An uplift applied to twenty lines is otherwise twenty numbers to add up.
  const rollTotals = useMemo(() => {
    const live = (roll ?? []).filter((l) => !l.blocked && Number(l.amount) > 0);
    if (live.length === 0) return null;
    return { next: live.reduce((n, l) => n + Number(l.amount), 0), current: live.reduce((n, l) => n + (l.source.amount || 0), 0) };
  }, [roll]);
  const applyUplift = () => {
    const pct = Number(uplift);
    if (!Number.isFinite(pct)) return;
    // `round2` (lib/utils), never an inline `Math.round(n * 100) / 100`: the inline form multiplies in float, so
    // a decimal half-case rounds down where the server rounds up, and the amount typed into this field is the
    // one that gets saved. Same helper the CTC previews use, for the same reason.
    setRoll((ls) => (ls ?? []).map((l) => ({ ...l, amount: String(round2(l.source.amount * (1 + pct / 100))) })));
  };
  // The other way to size next period's cap: what the scope actually spent this one. A cap set at 10 lakh that
  // consumed 3 is not a 5% uplift question, and the utilisation column next to it is the evidence.
  const matchSpend = () => {
    setRoll((ls) => (ls ?? []).map((l) => (l.source.spent ? { ...l, amount: String(round2(l.source.spent)) } : l)));
  };

  const columns: Column<ExpenseBudget>[] = [
    { id: "scope", header: "Scope", mobilePriority: 1, accessor: (b) => `${catName(b.category)} ${deptName(b.department)}`, cell: (b) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{catName(b.category)}</div>
        <div className="truncate text-xs text-muted-foreground">{b.department ? deptName(b.department) : "Org-wide"}</div>
      </div>
    ) },
    { id: "period", header: "Period", mobilePriority: 2, accessor: (b) => periodRange(b.period_type, b.period_key)?.start ?? 0, cell: (b) => {
      const p = paceOf(b, now);
      const ph = phaseOf(b, now);
      return (
        <div className="min-w-0 whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            {periodLabel(b.period_type, b.period_key)}
            <span className="text-xs text-muted-foreground">{b.period_type}</span>
            {b.recurring && (
              <TooltipProvider delayDuration={150}>
                {/* tapToOpen: an icon that stands for a sentence, and does nothing when tapped otherwise. */}
                <Tooltip tapToOpen>
                  <TooltipTrigger asChild><span><Repeat className="h-3.5 w-3.5 text-muted-foreground" /></span></TooltipTrigger>
                  <TooltipContent className="font-normal">Repeats: the next period opens automatically at this cap</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          {ph === "current" && p && <div className="text-xs text-muted-foreground">day {p.day} of {p.days}</div>}
          {ph === "upcoming" && <div className="text-xs text-muted-foreground">not started</div>}
        </div>
      );
    } },
    { id: "amount", header: "Budget", align: "right", mobilePriority: 3, accessor: (b) => b.amount, aggregate: "sum", formatTotal: money, cell: (b) => <span className="tabular-nums">{money(b.amount)}</span> },
    { id: "spent", header: "Spent", align: "right", accessor: (b) => b.spent ?? 0, aggregate: "sum", formatTotal: money, cell: (b) => <span className="tabular-nums">{money(b.spent ?? 0)}</span> },
    { id: "pending", header: "Pending", align: "right", accessor: (b) => b.pending ?? 0, aggregate: "sum", formatTotal: money, cell: (b) => (
      (b.pending ?? 0) > 0 ? <span className="tabular-nums text-muted-foreground">{money(b.pending ?? 0)}</span> : <span className="text-muted-foreground">-</span>
    ) },
    { id: "remaining", header: "Remaining", align: "right", accessor: (b) => b.remaining ?? b.amount - (b.spent ?? 0), aggregate: "sum", formatTotal: money, cell: (b) => {
      const left = b.remaining ?? b.amount - (b.spent ?? 0);
      return <span className={`tabular-nums ${left < 0 ? "text-destructive" : ""}`}>{money(left)}</span>;
    } },
    { id: "util", header: "Utilization", mobilePriority: 4, accessor: (b) => b.utilization ?? 0, filter: "none", cell: (b) => (
      <BudgetBar b={b} warnAt={warnAt} now={now} money={money} />
    ) },
    { id: "projected", header: "Projected", align: "right", accessor: (b) => paceOf(b, now)?.projected ?? -1, filter: "none", cell: (b) => {
      const ph = phaseOf(b, now);
      if (ph !== "current") return <span className="text-muted-foreground">-</span>;
      const projected = paceOf(b, now)?.projected;
      if (projected == null) return <span className="text-muted-foreground">-</span>;
      const pj = Math.round(projected * 100);
      return (
        <span className={`tabular-nums ${pj >= 100 ? "text-destructive" : pj >= warnAt ? "text-warning" : "text-muted-foreground"}`} title={`At this pace, ${money(projected * b.amount)} by period end`}>
          {pj}%
        </span>
      );
    } },
    { id: "repeats", header: "Repeats", filter: "select", defaultHidden: true, accessor: (b) => (b.recurring ? "Yes" : "No") },
    // No `hideValueByDefault`: the fetch decides whether deleted caps are present. "Deleted" is offered as a
    // filter value regardless, because its rows arrive only once it is picked.
    { id: "status", header: "Status", filter: "select", filterOptions: ["Deleted"], accessor: healthOf, cell: (b) => {
      const h = healthOf(b);
      return (
        <span className="inline-flex items-center gap-1.5">
          <Badge variant={HEALTH_TONE[h]}>{h}</Badge>
          {(b.alert_level ?? 0) > 0 && (
            <TooltipProvider delayDuration={150}>
              <Tooltip tapToOpen>
                <TooltipTrigger asChild><span><Bell className="h-3.5 w-3.5 text-muted-foreground" /></span></TooltipTrigger>
                <TooltipContent className="font-normal">{b.alert_level}% alert already sent for this period</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </span>
      );
    } },
    ...metaColumns<ExpenseBudget>(),
    { id: "actions", header: "", sortable: false, filter: "none", align: "right", cell: (b) => (
      <SoftDeleteRowActions
        row={b}
        writable={writable}
        canPurge={canPurge}
        actions={sd}
        onEdit={openEdit}
        extra={writable ? [{ label: "Duplicate to next period", icon: <Copy className="h-4 w-4" />, onClick: () => { void openRoll([b]).catch(() => {}); } }] : undefined}
      />
    ) },
  ];

  // Set `recurring` across a selection. One PATCH per cap: the batch transport is GET-only by design (a write
  // batch raises partial-failure and audit questions it deliberately refuses), and a per-cap PATCH keeps the
  // per-row audit diff the collection already writes.
  async function setRepeat(list: ExpenseBudget[], on: boolean) {
    let changed = 0;
    try {
      for (const b of list) {
        if (!!b.recurring === on) continue;
        await patch("expense-budgets/" + idOf(b.path), { recurring: on }, b.etag);
        changed++;
      }
      toast({
        title: changed === 0 ? (on ? "Already repeating" : "Already not repeating") : `${changed} ${changed === 1 ? "cap" : "caps"} ${on ? "now repeat" : "no longer repeat"}`,
        description: on && changed > 0 ? "Each opens its next period automatically once the current one closes." : undefined,
        variant: changed === 0 ? undefined : "success",
      });
    } catch (e) {
      toast({ title: "Couldn't change repeat", description: (e as Error).message, variant: "destructive" });
      throw e; // keep the selection so the rest can be retried
    } finally {
      reload();
    }
  }

  const bulkActions: BulkAction<ExpenseBudget>[] | undefined = writable
    ? [
        {
          label: "Roll forward to next period",
          icon: <Copy className="h-4 w-4" />,
          disabled: (rs) => (rs.some((r) => r.delete_time) ? "Deleted budgets can't be rolled forward." : null),
          run: (rs) => openRoll(rs), // opens the review sheet; resolves on commit, rejects on dismiss
        },
        {
          label: "Turn on repeat",
          icon: <Repeat className="h-4 w-4" />,
          confirm: { title: "Repeat these budgets every period?", description: "Each cap's next period opens automatically at the same amount once the current one closes." },
          disabled: (rs) => (rs.some((r) => r.delete_time) ? "Deleted budgets can't repeat." : null),
          run: (rs) => setRepeat(rs, true),
        },
        {
          label: "Turn off repeat",
          icon: <Repeat className="h-4 w-4" />,
          disabled: (rs) => (rs.some((r) => r.delete_time) ? "Deleted budgets can't repeat." : null),
          run: (rs) => setRepeat(rs, false),
        },
      ]
    : undefined;

  const createBtn = writable && (
    <AccessAction collection="expense-budgets" create><Button onClick={() => openCreate()}><Plus className="h-4 w-4" /> New budget</Button></AccessAction>
  );

  const PHASES: { key: Phase; label: string }[] = [
    { key: "current", label: "Current" },
    { key: "upcoming", label: "Upcoming" },
    { key: "past", label: "Past" },
    { key: "all", label: "All" },
  ];

  const detail = detailPath ? rows.find((b) => b.path === detailPath) ?? null : null;
  // Same scope, this period and earlier: whether a cap always overruns or had one bad month.
  const history = useMemo(() => {
    if (!detail) return [];
    const start = periodRange(detail.period_type, detail.period_key)?.start ?? 0;
    return live
      .filter((b) => b.period_type === detail.period_type && (b.department ? idOf(b.department) : "-") === (detail.department ? idOf(detail.department) : "-") && (b.category ? idOf(b.category) : "-") === (detail.category ? idOf(detail.category) : "-"))
      .filter((b) => (periodRange(b.period_type, b.period_key)?.start ?? 0) <= start)
      .sort((a, b) => (periodRange(a.period_type, a.period_key)?.start ?? 0) - (periodRange(b.period_type, b.period_key)?.start ?? 0))
      .slice(-6);
  }, [detail, live]);

  return (
    <div>
      <PageHeader
        accessCollection="expense-budgets"
        title="Budgets"
        description="Spend caps per category, department and period. Spend is derived from approved and paid expenses."
        actions={<>{createBtn}<PageSettings me={me} host="expense-budgets" /></>}
      />
      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState icon={PiggyBank} title="No budgets" description="Set a cap for a category, cost centre and period - spend against it is tracked from approved and paid expenses." action={createBtn} />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {PHASES.map((p) => (
                  <Button key={p.key} variant={phase === p.key ? "default" : "outline"} size="sm" onClick={() => { setPhase(p.key); setRisk("all"); }}>
                    {p.label}
                    <span className="ml-1.5 text-xs opacity-70 tabular-nums">
                      {p.key === "all" ? phaseCounts.current + phaseCounts.upcoming + phaseCounts.past : phaseCounts[p.key]}
                    </span>
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant={view === "table" ? "default" : "outline"} size="sm" onClick={() => setView("table")}><Table2 className="h-4 w-4" /> Caps</Button>
                <Button variant={view === "rollup" ? "default" : "outline"} size="sm" onClick={() => setView("rollup")}><Layers className="h-4 w-4" /> Rollup</Button>
                <Button variant={view === "matrix" ? "default" : "outline"} size="sm" onClick={() => setView("matrix")}><CalendarRange className="h-4 w-4" /> Year</Button>
              </div>
            </div>

            {phase === "current" && (attention.gaps.length > 0 || attention.rollable.length > 0 || attention.overAllocated.length > 0) && (
              <div id="budget-attention" className="mb-6 scroll-mt-24 space-y-2 rounded-xl border bg-card p-4 shadow-card">
                {attention.overAllocated.map((o) => (
                  <p key={o.label} className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <span>Cost-centre caps for <span className="font-medium">{o.label}</span> exceed the org-wide cap by <span className="tabular-nums">{money(o.by)}</span>.</span>
                  </p>
                ))}
                {attention.rollable.length > 0 && writable && (
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>{attention.rollable.length} {attention.rollable.length === 1 ? "cap has" : "caps have"} no budget for the next period.</span>
                    <Button size="sm" variant="outline" onClick={() => { void openRoll(attention.rollable).catch(() => {}); }}><Copy className="h-4 w-4" /> Review and roll forward</Button>
                  </p>
                )}
                {attention.gaps.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <PiggyBank className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>{attention.gaps.length === 1 ? "1 category has" : `${attention.gaps.length} categories have`} no cap for the current period:</span>
                    {attention.gaps.slice(0, 5).map((c) => (
                      <Button key={c.path} size="sm" variant="outline" disabled={!writable} onClick={() => openCreate({ category: `expense-categories/${idOf(c.path)}` })}>
                        <Plus className="h-3.5 w-3.5" /> {c.display_name}
                      </Button>
                    ))}
                    {attention.gaps.length > 5 && <span className="text-muted-foreground">+{attention.gaps.length - 5} more</span>}
                  </div>
                )}
              </div>
            )}

            {/* Spend against the cap it is being measured by. Bars and a line rather than two sets of bars:
                the cap is not another quantity being compared, it is the level the spend is judged against,
                and a line is the shape that says "the ceiling" - a bar over it reads instantly as over. */}
            {view !== "matrix" && capChart.labels.length > 0 && (
              <div className="mb-6 rounded-xl border bg-card p-4">
                <p className="mb-1 text-sm font-medium">Spend against cap</p>
                <p className="mb-3 text-xs text-muted-foreground">The {capChart.labels.length} biggest caps in view, by what has been spent under them.</p>
                <Chart
                  type="axis-mixed"
                  height={Math.min(320, Math.max(180, capChart.labels.length * 42 + 60))}
                  labels={capChart.labels}
                  datasets={[
                    { name: "Spent", values: capChart.spent, chartType: "bar" },
                    { name: "Cap", values: capChart.caps, chartType: "line" },
                  ]}
                  format={(v) => money(v)}
                  ariaLabel="Spend against the cap, for the largest budgets in view"
                />
              </div>
            )}

            {/* Every tile narrows or re-scopes what is listed below, so the strip sits against the list -
                under the chart, which is only there to be read. */}
            <SummaryStrip
              items={[
                // Budgeted is the whole set (so it clears any risk narrowing); spend and headroom are read by
                // scope, which is what the rollup view is for.
                { label: "Budgeted", value: money(totals.budgeted), icon: Wallet, hint: `${totals.count} ${totals.count === 1 ? "cap" : "caps"}`, onClick: () => setRisk("all"), active: risk === "all" },
                { label: "Spent", value: money(totals.spent), icon: TrendingUp, tone: totals.pct >= 100 ? "destructive" : totals.pct >= warnAt ? "warning" : "default", hint: `${totals.pct}% of budgeted${totals.pending > 0 ? " · some pending" : ""}`, onClick: () => setView("rollup"), active: view === "rollup" },
                { label: "Remaining", value: money(totals.remaining), tone: totals.remaining < 0 ? "destructive" : "success", hint: "headroom by scope", onClick: () => setView("rollup"), active: view === "rollup" },
                ...(phase === "current" && attention.gaps.length
                  ? [{ label: "Categories with no cap", value: attention.gaps.length, icon: AlertTriangle, tone: "warning" as const, hint: "nobody budgeted", onClick: () => document.getElementById("budget-attention")?.scrollIntoView({ behavior: "smooth", block: "start" }) }]
                  : []),
                { label: `At risk (${warnAt}%+)`, value: totals.atRisk, icon: AlertTriangle, tone: totals.atRisk > 0 ? "warning" : "muted", hint: totals.atRisk > 0 ? "show only these" : "none near the cap", onClick: () => setRisk(risk === "risk" ? "all" : "risk"), active: risk === "risk" },
                { label: "Over budget", value: totals.over, icon: CircleSlash, tone: totals.over > 0 ? "destructive" : "muted", hint: totals.over > 0 ? "show only these" : "all within cap", onClick: () => setRisk(risk === "over" ? "all" : "over"), active: risk === "over" },
              ]}
            />

            {view === "matrix" ? (
              <YearMatrix
                rows={matrixQ.rows.filter((b) => !b.delete_time)}
                year={year}
                onYear={setYear}
                loading={matrixQ.state === "loading"}
                capped={matrixCapped}
                money={money}
                warnAt={warnAt}
                now={now}
                catName={catName}
                deptName={deptName}
                onOpen={(b) => setDetail(b.path)}
                onRoll={writable ? (caps) => { void openRoll(caps).catch(() => {}); } : undefined}
              />
            ) : view === "rollup" ? (
              <Rollup rows={shown.filter((b) => !b.delete_time)} groupBy={groupBy} onGroupBy={setGroupBy} name={groupBy === "department" ? deptName : catName} money={money} warnAt={warnAt} partial={hasMore} onLoadMore={loadMore} />
            ) : (
              <DataTable
                columns={columns}
                tableId="expense-budgets"
                rows={shown}
                getRowId={(b) => b.path}
                onRowClick={(b) => setDetail(b.path)}
                rowClassName={(b) => (b.delete_time ? "opacity-60" : undefined)}
                hasMore={hasMore}
                onLoadMore={loadMore}
                bulkActions={bulkActions}
                emptyTitle="No budgets match"
                emptyDescription={phase === "current" ? "No budget covers today's date. Check Upcoming or All." : undefined}
                accessCollection="expense-budgets"
                accessTargetOf={(b) => ({ objectPath: b.path, label: `${catName(b.category)} ${b.period_key}`, can: b.access?.can })}
              />
            )}
          </>
        )}
      </DataState>

      <Sheet open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <SheetContent>
          {detail && (
            <BudgetDetail
              b={detail}
              history={history}
              money={money}
              warnAt={warnAt}
              now={now}
              catName={catName}
              deptName={deptName}
              canReadExpenses={canReadExpenses}
              writable={writable}
              onEdit={() => { setDetail(null); openEdit(detail); }}
              onDuplicate={() => { setDetail(null); void openRoll([detail]).catch(() => {}); }}
            />
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={!!roll} onOpenChange={(o) => { if (!o) closeRoll(false); }}>
        <DialogContent scrollBody className="max-w-2xl lg:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Roll forward to the next period</DialogTitle>
            <DialogDescription>Copies these caps into their next period, so a new month opens with budgets already in place. Nothing about the current period changes, and unspent budget is not carried over.</DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={rollErr} />
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Uplift" hint="Applies to every line below, from each cap's current amount">
                <div className="flex flex-wrap items-center gap-2">
                  <Input type="number" step="0.5" className="w-20 sm:w-24" value={uplift} onChange={(e) => setUplift(e.target.value)} />
                  <span className="text-sm text-muted-foreground">%</span>
                  <Button size="sm" variant="outline" onClick={applyUplift}>Apply</Button>
                  <Button size="sm" variant="ghost" onClick={matchSpend} title="Set every new cap to what its scope actually spent this period">Match spend</Button>
                </div>
              </Field>
            </div>
            <div className="rounded-lg border">
              {/* Five money columns do not fit a phone. The two context columns (what the cap is now, what the
                  scope actually spent) fold away below `sm`; scope, period and the editable new cap - the
                  decision itself - always stay. The container still scrolls, with a shadow to say so. */}
              <Table containerClassName="scroll-shadow-x [--scroll-ground:hsl(var(--card))]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Scope</TableHead>
                    <TableHead className="hidden sm:table-cell">New period</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Current cap</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Spent</TableHead>
                    <TableHead className="text-right">New cap</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(roll ?? []).map((l, i) => (
                    <TableRow key={l.source.path} className={l.blocked ? "opacity-60" : undefined}>
                      <TableCell>
                        <div className="font-medium">{catName(l.source.category)}</div>
                        <div className="text-xs text-muted-foreground">{l.source.department ? deptName(l.source.department) : "Org-wide"}</div>
                        {/* The folded-away columns reappear here as a sub-line, so nothing is actually lost
                            on a phone - only re-laid-out. */}
                        <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">
                          {periodLabel(l.source.period_type, l.key)} · now {money(l.source.amount)} · spent{" "}
                          {money(l.source.spent ?? 0)} ({Math.round((l.source.utilization ?? 0) * 100)}%)
                        </div>
                        {l.blocked && <div className="text-xs text-muted-foreground sm:hidden">{l.blocked}</div>}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap sm:table-cell">
                        {periodLabel(l.source.period_type, l.key)}
                        {l.blocked && <div className="text-xs text-muted-foreground">{l.blocked}</div>}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{money(l.source.amount)}</TableCell>
                      {/* What the scope did with the cap it has - the number an uplift should be argued from. */}
                      <TableCell className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
                        {money(l.source.spent ?? 0)}
                        <span className={cn("ml-1 text-xs", (l.source.utilization ?? 0) >= 1 ? "text-destructive" : (l.source.utilization ?? 0) * 100 >= warnAt ? "text-warning" : "text-muted-foreground")}>
                          {Math.round((l.source.utilization ?? 0) * 100)}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {l.blocked ? <span className="text-muted-foreground">-</span> : (
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            className="ml-auto w-24 text-right sm:w-32"
                            value={l.amount}
                            onChange={(e) => setRoll((ls) => (ls ?? []).map((x, xi) => (xi === i ? { ...x, amount: e.target.value } : x)))}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {(roll ?? []).every((l) => l.blocked) && (
              <p className="text-sm text-muted-foreground">Every selected cap already has a budget for its next period - nothing to create.</p>
            )}
            {/* What is about to be committed, in one number: the caps being opened against what they replace. */}
            {rollTotals && (
              <p className="text-sm text-muted-foreground">
                Opening {money(rollTotals.next)} of new caps against {money(rollTotals.current)} today
                {rollTotals.current > 0 && <> - {rollTotals.next === rollTotals.current ? "unchanged" : `${rollTotals.next > rollTotals.current ? "+" : ""}${Math.round(((rollTotals.next - rollTotals.current) / rollTotals.current) * 100)}%`}</>}.
              </p>
            )}
          </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => closeRoll(false)}>Cancel</Button>
            <Button onClick={commitRoll} loading={busy} disabled={!rollValid}>
              Create {(roll ?? []).filter((l) => !l.blocked && Number(l.amount) > 0).length || ""} {(roll ?? []).filter((l) => !l.blocked).length === 1 ? "budget" : "budgets"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!busy) submit(); }}>
          <AccessScope collection="expense-budgets" objectPath={editing?.path}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit budget" : "New budget"}</DialogTitle>
            <DialogDescription>
              A cap for one scope and one period. Expenses aren't blocked when it's exceeded - the budget reports and warns, and approvers see the impact before they approve.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          <div className="grid gap-4">
            <FieldRow>
              <Field label="Category" hint="Leave on all categories for a blanket cap">
                <Select value={form.category || "all"} onValueChange={(v) => setForm({ ...form, category: v === "all" ? "" : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {categories.filter((c) => !c.disabled).map((c) => <SelectItem key={c.path} value={`expense-categories/${idOf(c.path)}`}>{c.display_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Cost centre">
                <Select value={form.department || "org"} onValueChange={(v) => setForm({ ...form, department: v === "org" ? "" : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="org">Org-wide</SelectItem>
                    {departments.map((d) => <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Period type">
                <Select
                  value={form.period_type}
                  onValueChange={(v) => {
                    const type = v as PeriodType;
                    // Keep the same point in time while changing granularity: Jul 2026 becomes Q3 2026, not a
                    // blank field the user has to retype.
                    const at = periodRange(form.period_type, form.period_key)?.start;
                    setForm({ ...form, period_type: type, period_key: keyFor(type, at != null ? new Date(at) : new Date()) });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Period"
                hint={duplicate ? undefined : covers(form.period_type, form.period_key) ?? undefined}
                error={duplicate ? "A budget already caps this scope for that period." : undefined}
              >
                <PeriodPicker type={form.period_type} value={form.period_key} onChange={(period_key) => setForm({ ...form, period_key })} />
              </Field>
            </FieldRow>
            <Field
              label="Budget amount"
              hint={
                editing && amountNum > 0
                  ? `Spent so far ${money(editing.spent ?? 0)} - ${Math.round(((editing.spent ?? 0) / amountNum) * 100)}% of this cap`
                  : priorCap
                    ? `${periodLabel(priorCap.period_type, priorCap.period_key)}: cap ${money(priorCap.amount)}, spent ${money(priorCap.spent ?? 0)} (${Math.round((priorCap.utilization ?? 0) * 100)}%)`
                    : undefined
              }
              error={form.amount !== "" && amountNum <= 0 ? "Enter an amount greater than 0." : undefined}
            >
              <MoneyInput value={form.amount} onChange={(v) => { setAmountTouched(true); setForm({ ...form, amount: v }); }} min={0} suffix={form.period_type === "monthly" ? "a month" : form.period_type === "quarterly" ? "a quarter" : "a year"} />
            </Field>
            {!editing && (
              <ScopeSpendSoFar
                open={open}
                category={form.category}
                department={form.department}
                periodType={form.period_type}
                periodKey={form.period_key}
                amount={amountNum}
                money={money}
              />
            )}
            <label className="flex items-start gap-2.5 rounded-lg border p-3 text-sm">
              <Checkbox checked={form.recurring} onCheckedChange={(v) => setForm({ ...form, recurring: !!v })} className="mt-0.5" />
              <span>
                <span className="font-medium">Repeat every period</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  When this period closes, the same cap opens for the next one automatically, at this amount. Unspent budget is never carried over.
                  {form.period_key && ` Next: ${periodLabel(form.period_type, nextKey(form.period_type, form.period_key) ?? "")}.`}
                </span>
              </span>
            </label>
            {/* Who moved a cap, and when: a budget that grew mid-period is a question somebody eventually asks. */}
            {editing && <ActivitySection resource={editing.path} className="border-t pt-3" />}
          </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!valid}>{editing ? "Save changes" : "Create"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- the bar --------------------------------------------------------------------------------------------
// Three facts in one 8px strip: spend (solid), the queue behind it (striped - submitted, not yet approved, so
// not counted in utilization but already committed in practice), and where today sits in the period (tick).
// A bar without the tick can only be read after the fact; with it, "60% at the third of the month" is obvious.
function BudgetBar({ b, warnAt, now, money }: { b: ExpenseBudget; warnAt: number; now: number; money: (n: number) => string }) {
  const pct = Math.round((b.utilization ?? 0) * 100);
  const over = pct >= 100;
  const pendPct = b.amount > 0 ? Math.round(((b.pending ?? 0) / b.amount) * 100) : 0;
  const spentW = Math.min(pct, 100);
  const pendW = Math.max(0, Math.min(pendPct, 100 - spentW));
  const p = paceOf(b, now);
  const showTick = p != null && p.elapsed > 0 && p.elapsed < 1;
  const bar = (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-24 overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of budget used`}>
        <div className="flex h-full">
          <div className={over ? "bg-destructive" : pct >= warnAt ? "bg-warning" : "bg-primary"} style={{ width: `${spentW}%` }} />
          {pendW > 0 && <div className="bg-primary/30" style={{ width: `${pendW}%` }} />}
        </div>
        {showTick && <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${p!.elapsed * 100}%` }} />}
      </div>
      <span className={`text-xs tabular-nums ${over ? "text-destructive" : "text-muted-foreground"}`}>{pct}%</span>
    </div>
  );
  return (
    <TooltipProvider delayDuration={150}>
      {/* tapToOpen: the bar shows the ratio, and this is where the numbers behind it live. */}
      <Tooltip tapToOpen>
        <TooltipTrigger asChild><span>{bar}</span></TooltipTrigger>
        <TooltipContent className="font-normal leading-snug">
          <div>Spent {money(b.spent ?? 0)} of {money(b.amount)} ({pct}%)</div>
          {(b.pending ?? 0) > 0 && <div>{money(b.pending ?? 0)} awaiting approval</div>}
          {p && p.elapsed > 0 && p.elapsed < 1 && <div>Day {p.day} of {p.days} - {Math.round(p.elapsed * 100)}% of the period elapsed</div>}
          {p?.projected != null && <div>At this pace: {money(p.projected * b.amount)} ({Math.round(p.projected * 100)}%)</div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---- rollup ---------------------------------------------------------------------------------------------
// The same caps read as a budget book: one line per cost centre (or category) with its subtotals. Answers
// "which team is the overspend in" without filtering the list one value at a time.
function Rollup({
  rows, groupBy, onGroupBy, name, money, warnAt, partial, onLoadMore,
}: {
  rows: ExpenseBudget[];
  groupBy: "department" | "category";
  onGroupBy: (g: "department" | "category") => void;
  name: (p?: string) => string;
  money: (n: number) => string;
  warnAt: number;
  // Group subtotals are summed from the loaded rows, so when the scope runs past a page they are partial and
  // say so. The strip above stays honest either way: those totals come from the server.
  partial?: boolean;
  onLoadMore?: () => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; caps: number; budgeted: number; spent: number; pending: number }>();
    for (const b of rows) {
      const ref = groupBy === "department" ? b.department : b.category;
      const key = ref ? idOf(ref) : "-";
      const g = m.get(key) ?? { label: name(ref), caps: 0, budgeted: 0, spent: 0, pending: 0 };
      g.caps++;
      g.budgeted += b.amount || 0;
      g.spent += b.spent ?? 0;
      g.pending += b.pending ?? 0;
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => b.spent / (b.budgeted || 1) - a.spent / (a.budgeted || 1));
  }, [rows, groupBy, name]);
  const total = groups.reduce((t, g) => ({ caps: t.caps + g.caps, budgeted: t.budgeted + g.budgeted, spent: t.spent + g.spent }), { caps: 0, budgeted: 0, spent: 0 });

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Rollup</h2>
        <Select value={groupBy} onValueChange={(v) => onGroupBy(v as "department" | "category")}>
          <SelectTrigger className="h-8 w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="department">By cost centre</SelectItem>
            <SelectItem value="category">By category</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {groups.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">No budgets in this view.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{groupBy === "department" ? "Cost centre" : "Category"}</TableHead>
              <TableHead className="text-right">Caps</TableHead>
              <TableHead className="text-right">Budgeted</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead>Utilization</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => {
              const pct = g.budgeted > 0 ? Math.round((g.spent / g.budgeted) * 100) : 0;
              const left = g.budgeted - g.spent;
              return (
                <TableRow key={g.label}>
                  <TableCell className="font-medium">{g.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.caps}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(g.budgeted)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(g.spent)}{g.pending > 0 && <span className="ml-1 text-xs text-muted-foreground">+{money(g.pending)}</span>}</TableCell>
                  <TableCell className={`text-right tabular-nums ${left < 0 ? "text-destructive" : ""}`}>{money(left)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded bg-muted">
                        <div className={`h-full ${pct >= 100 ? "bg-destructive" : pct >= warnAt ? "bg-warning" : "bg-primary"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <span className={`text-xs tabular-nums ${pct >= 100 ? "text-destructive" : "text-muted-foreground"}`}>{pct}%</span>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow className="border-t bg-muted/40 font-medium">
              <TableCell>Total</TableCell>
              <TableCell className="text-right tabular-nums">{total.caps}</TableCell>
              <TableCell className="text-right tabular-nums">{money(total.budgeted)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(total.spent)}</TableCell>
              <TableCell className={`text-right tabular-nums ${total.budgeted - total.spent < 0 ? "text-destructive" : ""}`}>{money(total.budgeted - total.spent)}</TableCell>
              <TableCell className="tabular-nums">{total.budgeted > 0 ? Math.round((total.spent / total.budgeted) * 100) : 0}%</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
      {partial && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>Subtotals cover the {rows.length} caps loaded so far, not the whole scope.</span>
          {onLoadMore && <Button size="sm" variant="outline" onClick={onLoadMore}>Load more</Button>}
        </div>
      )}
    </div>
  );
}

// ---- year matrix ----------------------------------------------------------------------------------------
// One row per scope, one cell per month: a year of monthly caps read at a glance instead of scrolled through
// as hundreds of rows. The row total is the cumulative read - caps to date versus spend to date - which is the
// honest way to answer "are we over for the year" without carrying unspent budget between periods.
function YearMatrix({
  rows, year, onYear, loading, capped, money, warnAt, now, catName, deptName, onOpen, onRoll,
}: {
  rows: ExpenseBudget[];
  year: number;
  onYear: (y: number) => void;
  loading: boolean;
  capped: boolean;
  money: (n: number) => string;
  warnAt: number;
  now: number;
  catName: (p?: string) => string;
  deptName: (p?: string) => string;
  onOpen: (b: ExpenseBudget) => void;
  onRoll?: (caps: ExpenseBudget[]) => void;
}) {
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 4 + i);

  const scopes = useMemo(() => {
    const m = new Map<string, { label: string; sub: string; cells: (ExpenseBudget | undefined)[] }>();
    for (const b of rows) {
      const key = `${b.department ? idOf(b.department) : "-"}|${b.category ? idOf(b.category) : "-"}`;
      const row = m.get(key) ?? { label: catName(b.category), sub: b.department ? deptName(b.department) : "Org-wide", cells: Array(12).fill(undefined) };
      const month = Number(b.period_key.slice(5, 7));
      if (month >= 1 && month <= 12) row.cells[month - 1] = b;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label) || a.sub.localeCompare(b.sub));
  }, [rows, catName, deptName]);

  // Months that have started, for the cumulative column: a cap for December is budget, not yet performance.
  const elapsed = (i: number) => Date.UTC(year, i, 1) <= now;
  const monthTotals = Array.from({ length: 12 }, (_, i) => {
    const cells = scopes.map((s) => s.cells[i]).filter(Boolean) as ExpenseBudget[];
    return { amount: cells.reduce((n, b) => n + (b.amount || 0), 0), spent: cells.reduce((n, b) => n + (b.spent ?? 0), 0), caps: cells };
  });
  // The latest month that has caps: what "open the next month" copies forward.
  const lastFilled = monthTotals.reduce((last, m, i) => (m.caps.length ? i : last), -1);
  const nextMonthLabel = lastFilled >= 0 && lastFilled < 11 ? MONTHS[lastFilled + 1] : null;

  const cellTone = (pct: number) => (pct >= 100 ? "bg-destructive/15 text-destructive" : pct >= warnAt ? "bg-warning/20 text-warning" : pct > 0 ? "bg-primary/10 text-foreground" : "text-muted-foreground");

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Monthly caps by scope</h2>
          <Select value={String(year)} onValueChange={(y) => onYear(Number(y))}>
            <SelectTrigger className="h-8 w-[110px]"><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {onRoll && nextMonthLabel && (
          <Button size="sm" variant="outline" onClick={() => onRoll(monthTotals[lastFilled]!.caps)}>
            <Copy className="h-4 w-4" /> Open {nextMonthLabel} for every scope
          </Button>
        )}
      </div>
      {loading && rows.length === 0 ? (
        <TableSkeleton rows={5} cols={4} className="px-4" />
      ) : scopes.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">No monthly caps in {year}.</p>
      ) : (
        <div className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card px-4 py-2 text-left font-medium">Scope</th>
                {MONTHS.map((m, i) => (
                  <th key={m} className={`px-2 py-2 text-center font-medium ${elapsed(i) ? "" : "opacity-60"}`}>{m}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium">To date</th>
              </tr>
            </thead>
            <tbody>
              {scopes.map((s) => {
                const capsToDate = s.cells.reduce((n, b, i) => n + (b && elapsed(i) ? b.amount || 0 : 0), 0);
                const spentToDate = s.cells.reduce((n, b, i) => n + (b && elapsed(i) ? b.spent ?? 0 : 0), 0);
                const ytd = capsToDate > 0 ? Math.round((spentToDate / capsToDate) * 100) : 0;
                return (
                  <tr key={`${s.label}|${s.sub}`} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 max-w-[14rem] bg-card px-4 py-2">
                      <div className="truncate font-medium">{s.label}</div>
                      <div className="truncate text-xs text-muted-foreground">{s.sub}</div>
                    </td>
                    {s.cells.map((b, i) => {
                      if (!b) return <td key={i} className="px-2 py-2 text-center text-xs text-muted-foreground">-</td>;
                      const pct = Math.round((b.utilization ?? 0) * 100);
                      return (
                        <td key={i} className="px-1.5 py-1.5 text-center">
                          <button
                            type="button"
                            onClick={() => onOpen(b)}
                            title={`${money(b.spent ?? 0)} of ${money(b.amount)}${(b.pending ?? 0) > 0 ? ` (+${money(b.pending ?? 0)} pending)` : ""}`}
                            className={`w-full rounded px-1.5 py-1 text-xs font-medium tabular-nums transition-colors hover:ring-1 hover:ring-ring ${cellTone(pct)}`}
                          >
                            {pct}%
                          </button>
                        </td>
                      );
                    })}
                    <td className={`px-3 py-2 text-right text-xs tabular-nums ${ytd >= 100 ? "text-destructive" : ytd >= warnAt ? "text-warning" : "text-muted-foreground"}`}>
                      {capsToDate > 0 ? <>{ytd}%<span className="ml-1 opacity-70">{money(spentToDate)}</span></> : "-"}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t bg-muted/40 text-xs font-medium">
                <td className="sticky left-0 z-10 bg-muted/40 px-4 py-2">All scopes</td>
                {monthTotals.map((m, i) => {
                  const pct = m.amount > 0 ? Math.round((m.spent / m.amount) * 100) : 0;
                  return (
                    <td key={i} className={`px-2 py-2 text-center tabular-nums ${pct >= 100 ? "text-destructive" : pct >= warnAt ? "text-warning" : ""}`} title={m.amount > 0 ? `${money(m.spent)} of ${money(m.amount)}` : undefined}>
                      {m.amount > 0 ? `${pct}%` : "-"}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(monthTotals.reduce((n, m, i) => n + (elapsed(i) ? m.spent : 0), 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {capped && (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Showing the first {rows.length} caps of {year}. Narrow by category or cost centre on the Caps view to see a complete grid.
        </p>
      )}
    </div>
  );
}

// ---- detail ---------------------------------------------------------------------------------------------
// One cap, in full: the numbers, the pace, how the same scope did in earlier periods, and - the thing the page
// could not answer before - WHICH expenses filled it. The expense list is fetched only when this panel opens
// and is server-filtered to the cap's own category/cost centre/period, so it is one bounded read.
function BudgetDetail({
  b, history, money, warnAt, now, catName, deptName, canReadExpenses, writable, onEdit, onDuplicate,
}: {
  b: ExpenseBudget;
  history: ExpenseBudget[];
  money: (n: number) => string;
  warnAt: number;
  now: number;
  catName: (p?: string) => string;
  deptName: (p?: string) => string;
  canReadExpenses: boolean;
  writable: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  // Memoized so the query below can depend on the range itself rather than on two properties reached through
  // an optional chain - an expression the linter cannot check, and one that silently stopped matching the
  // body if the range ever grew a third field.
  const range = useMemo(() => periodRange(b.period_type, b.period_key), [b.period_type, b.period_key]);
  const params = useMemo(() => ({
    ...(b.category ? { category: b.category } : {}),
    ...(b.department ? { department: b.department } : {}),
    ...(range ? { from: dayParam(range.start), to: dayParam(range.end) } : {}),
  }), [b.category, b.department, range]);
  const { rows: expenses, state, hasMore } = useCollection<Expense>("expenses", { params, enabled: canReadExpenses && !!range });
  const counted = expenses.filter((e) => ["SUBMITTED", "APPROVED", "PAID"].includes((e.state ?? "").toUpperCase()));
  const pct = Math.round((b.utilization ?? 0) * 100);
  const p = paceOf(b, now);

  return (
    <>
      <SheetHeader>
        <SheetTitle>{catName(b.category)} · {periodLabel(b.period_type, b.period_key)}</SheetTitle>
        <SheetDescription>
          {b.department ? deptName(b.department) : "Org-wide"}
          {range && ` · ${fmtDay(range.start)} to ${fmtDay(range.end - DAY)}`}
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="space-y-6">
        {/* Four money figures inside a sheet, which is ~480px wide however wide the window is: the row is
            sized against the sheet (a container query) rather than the viewport, so they do not get squeezed
            to 110px each just because the screen is large. */}
        <StatRow caps={[2, 2, 4]} gap={{ base: "1rem" }}>
          {[
            { label: "Cap", value: money(b.amount) },
            { label: "Spent", value: money(b.spent ?? 0), tone: pct >= 100 ? "text-destructive" : pct >= warnAt ? "text-warning" : "" },
            { label: "Pending", value: money(b.pending ?? 0), tone: "text-muted-foreground" },
            { label: "Remaining", value: money(b.remaining ?? b.amount - (b.spent ?? 0)), tone: (b.remaining ?? 0) < 0 ? "text-destructive" : "text-success" },
          ].map((s) => (
            <div key={s.label}>
              <div className="text-xs font-medium text-muted-foreground">{s.label}</div>
              <div className={`text-lg font-semibold tabular-nums ${s.tone ?? ""}`}>{s.value}</div>
            </div>
          ))}
        </StatRow>

        <div className="space-y-2">
          <BudgetBar b={b} warnAt={warnAt} now={now} money={money} />
          <p className="text-sm text-muted-foreground">
            {p && p.elapsed > 0 && p.elapsed < 1
              ? <>Day {p.day} of {p.days} - {Math.round(p.elapsed * 100)}% of the period elapsed. {p.projected != null && <>At this pace the period ends at <span className={p.projected >= 1 ? "font-medium text-destructive" : "font-medium text-foreground"}>{money(p.projected * b.amount)} ({Math.round(p.projected * 100)}%)</span>.</>}</>
              : p && p.elapsed >= 1
                ? "Period closed."
                : "Period hasn't started."}
          </p>
          {(b.alert_level ?? 0) > 0 && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Bell className="h-3.5 w-3.5" /> {b.alert_level}% budget alert already sent for this period.</p>
          )}
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Repeat className="h-3.5 w-3.5" />
            {b.recurring
              ? <>Repeats: {periodLabel(b.period_type, nextKey(b.period_type, b.period_key) ?? "")} opens automatically at {money(b.amount)} once this period closes.</>
              : <>Doesn't repeat - the next period stays unbudgeted unless someone opens it.</>}
          </p>
        </div>

        {history.length > 1 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">Same scope, earlier periods</h3>
            <div className="flex items-end gap-3">
              {history.map((h) => {
                const hp = Math.round((h.utilization ?? 0) * 100);
                return (
                  <div key={h.path} className="flex w-14 flex-col items-center gap-1">
                    <span className={`text-xs tabular-nums ${hp >= 100 ? "text-destructive" : "text-muted-foreground"}`}>{hp}%</span>
                    <div className="flex h-16 w-6 items-end overflow-hidden rounded bg-muted">
                      <div className={`w-full ${hp >= 100 ? "bg-destructive" : hp >= warnAt ? "bg-warning" : "bg-primary"}`} style={{ height: `${Math.min(hp, 100)}%` }} />
                    </div>
                    <span className="text-center text-[11px] leading-tight text-muted-foreground">{periodLabel(h.period_type, h.period_key)}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Only periods this scope was capped for.</p>
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Expenses in this period</h3>
            <Button size="sm" variant="outline" onClick={() => navigate("expenses")}>Open ledger</Button>
          </div>
          {!canReadExpenses ? (
            <p className="text-sm text-muted-foreground">You don't have access to the expense ledger, so the spend behind this cap can't be listed.</p>
          ) : state === "loading" ? (
            <TableSkeleton rows={3} cols={4} />
          ) : counted.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing charged to this cap yet.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Incurred</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {counted.map((e) => {
                    const st = (e.state ?? "").toUpperCase();
                    return (
                      <TableRow key={e.path}>
                        <TableCell className="whitespace-nowrap">{e.incurred_on ? formatDate(e.incurred_on) : "-"}</TableCell>
                        <TableCell className="max-w-[16rem] truncate">{e.description || e.invoice_number || "Expense"}</TableCell>
                        <TableCell><Badge variant={st === "PAID" ? "success" : st === "APPROVED" ? "secondary" : "warning"}>{st}</Badge></TableCell>
                        <TableCell className="text-right tabular-nums">{money(e.amount || 0)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {hasMore && <p className="mt-2 text-xs text-muted-foreground">Showing the first page only - open the ledger for the rest. The totals above come from the server, not this list.</p>}
            </>
          )}
        </div>
      </SheetBody>
      {writable && (
        <SheetFooter>
          <Button variant="outline" onClick={onDuplicate}><Copy className="h-4 w-4" /> Duplicate to next period</Button>
          <Button onClick={onEdit}>Edit budget</Button>
        </SheetFooter>
      )}
    </>
  );
}

// ---- what the scope has already spent -------------------------------------------------------------------
// Authoring a cap is the moment to learn that the period is half gone and most of the proposed number is
// already committed; the alternative is finding out from an alert next week. Only for a NEW cap - an existing
// one carries a server-computed `spent` - and only while the dialog is open, so the ledger read is paid for
// exactly once, by someone who asked for it.
function ScopeSpendSoFar({ open, category, department, periodType, periodKey, amount, money }: {
  open: boolean;
  category: string;
  department: string;
  periodType: PeriodType;
  periodKey: string;
  amount: number;
  money: (n: number) => string;
}) {
  const range = periodRange(periodType, periodKey);
  const params = useMemo(() => ({
    ...(category ? { category } : {}),
    ...(department ? { department } : {}),
    ...(range ? { from: dayParam(range.start), to: dayParam(range.end) } : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [category, department, range?.start, range?.end]);
  const { rows, state, hasMore } = useCollection<Expense>("expenses", { params, enabled: open && !!range });
  if (!range || state !== "ready") return null;
  // Committed spend only: a draft or a rejected expense never reaches a budget.
  const counted = rows.filter((e) => ["SUBMITTED", "APPROVED", "PAID"].includes((e.state ?? "").toUpperCase()));
  if (counted.length === 0) return null;
  const spent = counted.reduce((n, e) => n + (e.amount || 0), 0);
  const over = amount > 0 && spent >= amount;
  const more = hasMore ? "+" : "";
  return (
    <p className={cn("rounded-lg border px-3 py-2 text-xs", over ? "border-destructive/40 bg-destructive/5 text-destructive" : "text-muted-foreground")}>
      {over ? <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> : null}
      This scope has already spent {money(spent)}{more} in that period, across {counted.length}{more} {counted.length === 1 && !hasMore ? "expense" : "expenses"}
      {amount > 0 ? ` - ${over ? "the cap you're setting is already exceeded" : `${Math.round((spent / amount) * 100)}% of the cap you're setting`}` : ""}.
    </p>
  );
}

// ---- period picker --------------------------------------------------------------------------------------
// The period a cap covers, entered in the shape of its own type - a month input, a year+quarter pair, or a
// year. It emits exactly the key format the server validates ("2026-07" | "2026-Q3" | "2026"), so nobody has
// to learn that format to author a budget.
function PeriodPicker({ type, value, onChange }: { type: PeriodType; value: string; onChange: (key: string) => void }) {
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 7 }, (_, i) => thisYear - 2 + i);
  const parsed = periodRange(type, value);
  const year = parsed ? new Date(parsed.start).getUTCFullYear() : thisYear;
  const quarter = parsed ? Math.floor(new Date(parsed.start).getUTCMonth() / 3) + 1 : 1;

  if (type === "monthly") {
    return <Input type="month" value={/^\d{4}-\d{2}$/.test(value) ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
  const yearSelect = (
    <Select value={String(year)} onValueChange={(y) => onChange(type === "yearly" ? y : `${y}-Q${quarter}`)}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
    </Select>
  );
  if (type === "yearly") return yearSelect;
  return (
    <div className="flex gap-2">
      {yearSelect}
      <Select value={String(quarter)} onValueChange={(q) => onChange(`${year}-Q${q}`)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{[1, 2, 3, 4].map((q) => <SelectItem key={q} value={String(q)}>Q{q}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
