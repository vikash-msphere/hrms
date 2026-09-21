import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayCircle, Plus, Hammer, Send, CheckCircle2, Rocket, Loader2, FileSpreadsheet, Trash2, Eye, ChevronRight, AlertTriangle } from "lucide-react";
import { api, get, create, invoke, download, remove, ApiError } from "@/api";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { cn, idOf, formatDate, formatMoney, round2 } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { daysUntil, fmtDaysCount } from "@/lib/tableDerive";
import { navigate } from "@/router";
import { exportTable } from "@/lib/exportTable";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { BankFormat, Me, Operation, PayPeriod, PayrollRun, PayrollRunItem, RunReconciliation, RunJournal, RunVariance } from "@/types";
// The statement's row labels live with the arithmetic that produces them, so a bucket cannot be renamed on the
// server and keep its old caption here.
import { MOVEMENT_LABEL } from "../../../src/domain/payrollReconcile";
import { Chart } from "@/components/common/Chart";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessTab } from "@/components/common/AccessTab";
import { ActivityBadge } from "@/components/common/ActivityBadge";
import { useTabActivity, markTabSeen } from "@/lib/tabActivity";
import { DataState } from "@/components/common/DataState";
import { ActivitySection } from "@/components/common/ActivitySection";
import { EmptyState } from "@/components/common/EmptyState";
import { TableSkeleton } from "@/components/common/Skeletons";
import { DataTable, type Column } from "@/components/common/DataTable";
import type { TableInsight } from "@/components/common/TableInsights";
import { metaColumns } from "@/components/common/metaColumns";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { AccessScope } from "@/components/access/AccessScope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { useToast } from "@/components/ui/use-toast";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";
import { useConfirm } from "@/components/common/confirm";
import PayPeriods from "@/pages/PayPeriods";
import { PayrollBonuses } from "@/components/common/PayrollBonuses";
import { PayrollBudgets } from "@/components/common/PayrollBudgets";

// A run's state as the page compares it. The API's casing is not guaranteed, which is why every comparison
// in this file upper-cases first.
const up = (s?: string) => (s ?? "").toUpperCase();

// The run's own steps, named for a reader rather than for the state machine. `pay_date` is the only planned
// one; every other entry is a fact about something that has already happened.
// What a flag means when its own line set does not explain it - a fallback caption, never a substitute for
// the reasons, which are the point.
const VARIANCE_LABEL: Record<string, string> = {
  net_moved_gross_flat: "same gross, different take-home",
  net_moved: "take-home moved",
  gross_moved: "gross moved",
  component_added: "a new pay line",
  component_removed: "a pay line stopped",
  first_run: "first run for this person",
};

const MILESTONE_LABEL: Record<string, string> = {
  cutoff: "Inputs close", created: "Created", built: "Built", submitted: "Sent for review", approved: "Approved",
  bank_file: "Bank file", published: "Published", pay_date: "Pay date",
};
// How close a pay date has to be before an unfinished run is worth chasing. A week: long enough to build,
// review and approve without a rush, short enough that the chip means something when it appears.
const PAY_DATE_SOON_DAYS = 7;

type Verb = "build" | "submit" | "approve" | "publish";
const NEXT: Record<string, { verb: Verb; label: string; icon: typeof Hammer; variant?: "success" }[]> = {
  DRAFT: [
    { verb: "build", label: "Build", icon: Hammer },
    { verb: "submit", label: "Submit", icon: Send },
  ],
  // REVIEW offers Rebuild as well as Approve, and it has to. `:approve` refuses a run whose income inputs
  // moved since it was built - "this run was built before its inputs changed (...); rebuild it before
  // approving" - with no override, deliberately: approving a stale run pays the wrong money. A run in review
  // is still an editable state on the server (`isEditable` covers DRAFT and REVIEW), so rebuilding it is
  // exactly what that refusal asks for. Offering Approve alone made the refusal a dead end: the only remedy
  // the server names was not on the menu that raised it, and the run could only be sent back to draft - if
  // the reviewer thought to try that - to get at the same button.
  //
  // Labelled "Rebuild", not "Build", because the run is already priced here: pressing it re-prices it at
  // today's inputs, which is a different thing to say than "build" on an empty draft. Same verb underneath.
  REVIEW: [
    { verb: "approve", label: "Approve", icon: CheckCircle2, variant: "success" },
    { verb: "build", label: "Rebuild", icon: Hammer },
  ],
  APPROVED: [{ verb: "publish", label: "Publish", icon: Rocket, variant: "success" }],
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ymd = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// Prefill for a calendar month (m is 0-indexed): full-month period, pay date on the last day. The fields stay
// editable in the dialog. UTC throughout to match how periods are stored/displayed.
function monthDefaults(y: number, m: number) {
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { display_name: `${MONTHS[m]} ${y}`, period_start: ymd(y, m, 1), period_end: ymd(y, m, lastDay), pay_date: ymd(y, m, lastDay) };
}

// Which month to default to: payroll is usually run for the current month near its end, or for the previous
// month in the first days of the next one. So early in the month -> last month, otherwise current month.
// Read off the ORG's day, not a UTC clock: for an IST org between 00:00 and 05:30 on the 11th, `getUTCDate()`
// still said the 10th and the dialog defaulted to the previous month.
function defaultMonth(): { y: number; m: number } {
  const today = todayStr();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const offset = Number(today.slice(8, 10)) <= 10 ? -1 : 0; // first ~third of the month -> previous month
  const d = new Date(Date.UTC(y, m + offset, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}

/** The org's current calendar month index (0-11) - what `defaultMonth` is compared against. */
const orgMonthIdx = (): number => Number(todayStr().slice(5, 7)) - 1;

// Does a pay period fall in calendar month (y, m)? Matched on its start date.
function isMonth(period: PayPeriod, y: number, m: number): boolean {
  const d = new Date(period.period_start);
  return d.getUTCFullYear() === y && d.getUTCMonth() === m;
}

export default function PayrollRuns({ me, tab, openId }: { me: Me; tab?: string; openId?: string }) {
  const { rows, state, error, reload } = useCollection<PayrollRun>("payroll-runs");
  const { rows: periods, reload: reloadPeriods } = useCollection<PayPeriod>("pay-periods");
  // A quick monthly run creates the period AND the run in one go, so it needs both rights. Only super_admin
  // holds both (HR defines periods, payroll runs them) - so this convenience is, by design, super-only.
  // Both hooks are read unconditionally and combined after. `&&` short-circuits, so writing this as one
  // expression skips the second `usePermission` whenever the first is false - and capabilities arrive after
  // the first paint, so that flip changes the hook count mid-life and React throws.
  const canWritePeriods = usePermission("pay-periods.write");
  const canWriteRuns = usePermission("payroll-runs.write");
  const canQuick = canWritePeriods && canWriteRuns;
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));

  // Per-employee breakdown review (opened from a run row).
  const [reviewRun, setReviewRun] = useState<PayrollRun | null>(null);
  // Which run the OPEN review is for, readable from inside the fetch below. A breakdown is two requests over a
  // whole payroll, so it is perfectly normal to close it before they land - and applying their answers then
  // would reopen a dialog the reader has already dismissed.
  const reviewFor = useRef<string | null>(null);
  const [items, setItems] = useState<PayrollRunItem[] | null>(null);
  type SplitDrift = { stale: string[]; skipped: string[] };
  const [reviewStale, setReviewStale] = useState<{ stale: boolean; diverged?: boolean; changes: string[]; split_drift?: SplitDrift; unpriced?: string[] } | null>(null);
  // Re-apply machinery for the split-drift warning below (prompt-only; the banner here is the surface).
  const { canReapply, reapplying, reapply: doReapply } = useSplitStaleness({ auto: false });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [itemQuery, setItemQuery] = useState("");
  // Comparison against the previous run, loaded ON REQUEST. Reviewing payroll is mostly asking "who moved, and
  // why" - a total tells you nothing about that - but a second run's items is a second page of D1 reads, so it
  // waits for an explicit ask rather than riding along with every review.
  const [compare, setCompare] = useState<{ label: string; net: Map<string, number> } | null>(null);
  const [comparing, setComparing] = useState(false);
  // The org-level half of the same question. `compare` answers "whose pay moved"; this answers "what the
  // movement is made of", and the two are fetched by one gesture because nobody wants one without the other.
  const [reconcile, setReconcile] = useState<RunReconciliation | null>(null);
  // Which rows to look at, and what must be true before approving. Loaded WITH the review rather than behind
  // a gesture like the comparison is: the reconciliation answers a question somebody chose to ask, while this
  // answers the one they are about to be asked anyway - a reviewer who has to press something to find out
  // which rows are wrong will approve first and press second.
  const [variance, setVariance] = useState<RunVariance | null>(null);
  // The flags name employees by id; the breakdown already carries their names, so the band borrows them
  // rather than the server sending a second copy or the page reading `employees` for a dialog.
  const empName = useCallback(
    (id?: string | null) => (id ? items?.find((it) => idOf(it.employee ?? "") === id)?.employee_name ?? id : ""),
    [items],
  );
  // Fetch the run DETAIL (carries staleness: inputs changed since the last build) + the per-employee breakdown.
  // The detail response has a fresh etag, so it's stored as reviewRun and drives an in-place rebuild.
  type RunDetail = PayrollRun & { stale?: boolean; diverged?: boolean; changes?: string[]; built_time?: string | null; split_drift?: SplitDrift; unpriced?: string[] };
  async function openReview(run: PayrollRun) {
    reviewFor.current = idOf(run.path);
    setReviewRun(run);
    setItems(null);
    setReviewStale(null);
    setExpanded(new Set());
    setItemQuery("");
    setCompare(null);
    setReconcile(null);
    setVariance(null);
    try {
      const [detail, r, v] = await Promise.all([
        get<RunDetail>("payroll-runs/" + idOf(run.path)),
        get<{ results: PayrollRunItem[] }>("payroll-runs/" + idOf(run.path) + "/items"),
        // A review that cannot compute its flags is still a usable review, so a failure here drops the band
        // rather than the dialog.
        get<RunVariance>("payroll-runs/" + idOf(run.path) + "/variance").catch(() => null),
      ]);
      // Closed (or moved to another run) while these were in flight: their answers belong to a dialog that is
      // no longer open, and setting the run again would put it back on screen.
      if (reviewFor.current !== idOf(run.path)) return;
      setReviewRun(detail);
      setReviewStale({ stale: !!detail.stale, diverged: !!detail.diverged, changes: detail.changes ?? [], split_drift: detail.split_drift, unpriced: detail.unpriced });
      setItems(r.results ?? []);
      setVariance(v);
    } catch (e) {
      if (reviewFor.current !== idOf(run.path)) return;
      setItems([]);
      toast({ title: "Couldn't load breakdown", description: (e as Error).message, variant: "destructive" });
    }
  }
  // The run that paid the period before this one - the only meaningful thing to compare against, and the reason
  // the lookup goes through periods rather than run creation order (runs are often built out of order).
  const priorRun = useMemo(() => {
    const periodOf = (r: PayrollRun) => periods.find((p) => r.pay_period && idOf(p.path) === idOf(r.pay_period));
    const mine = reviewRun ? periodOf(reviewRun) : undefined;
    if (!mine) return null;
    const candidates = rows
      .filter((r) => r.path !== reviewRun?.path)
      .map((r) => ({ run: r, period: periodOf(r) }))
      .filter((x): x is { run: PayrollRun; period: PayPeriod } => !!x.period && x.period.period_start < mine.period_start)
      .sort((a, b) => b.period.period_start.localeCompare(a.period.period_start));
    return candidates[0] ?? null;
  }, [rows, periods, reviewRun]);

  async function loadCompare() {
    if (!priorRun) return;
    setComparing(true);
    try {
      // The statement is computed server-side against the run's OWN idea of the previous run (by pay date,
      // finalized only), which is the same rule `priorRun` uses here for the label. Fetched together so the
      // per-person diff and the totals above it can never describe two different comparisons.
      const [r, rec] = await Promise.all([
        get<{ results: PayrollRunItem[] }>("payroll-runs/" + idOf(priorRun.run.path) + "/items"),
        get<RunReconciliation>("payroll-runs/" + idOf(reviewRun!.path) + "/reconciliation").catch(() => null),
      ]);
      setCompare({ label: priorRun.period.display_name, net: new Map((r.results ?? []).map((it) => [it.employee, it.net])) });
      setReconcile(rec);
    } catch (e) {
      toast({ title: "Couldn't load the previous run", description: (e as Error).message, variant: "destructive" });
    } finally {
      setComparing(false);
    }
  }

  // Rebuild in place from the review dialog: recompute lines from current inputs, then refresh the breakdown +
  /**
   * Report a refused verb - and RE-READ the run when the refusal was a lost update.
   *
   * Every verb on this page carries the etag the list was read with, and 409 means exactly one thing: the run
   * moved in between - another payroll admin built or submitted it, or this page's own other tab did. The
   * page then still holds the etag it was refused for, so pressing again sends the same stale header and is
   * refused identically, for as long as the page stays open: the button is dead and the toast says only
   * "etag mismatch". Re-reading is what makes the second press a different request, and the message says
   * that is what happened rather than naming the header.
   */
  function staleToast(e: unknown, fallback: string) {
    const stale = e instanceof ApiError && e.status === 409;
    if (stale) reload();
    toast({
      title: stale ? "Somebody else changed this run" : fallback,
      description: stale ? "It has been re-read - look at where it is now, then try again." : (e as Error).message,
      variant: "destructive",
    });
  }

  // staleness. NOTE: like any build, one-off inputs (LOP, ad-hoc lines) are re-entered per build, not preserved.
  async function rebuildReview() {
    if (!reviewRun) return;
    const id = idOf(reviewRun.path);
    if (acting === id) return;
    setActing(id);
    try {
      await invoke("payroll-runs/" + id, "build", reviewRun.etag);
      toast({ title: DONE_TOAST.build, variant: "success" });
      reload();
      await openReview(reviewRun);
    } catch (e) {
      staleToast(e, "Couldn't rebuild the run");
    } finally {
      setActing(null);
    }
  }
  // Split drift needs BOTH steps and in this order: re-apply re-solves each employee's basic / Special Allowance
  // from their (unchanged) annual CTC, then the rebuild re-prices the run off the corrected rows. Re-applying
  // alone would leave the run's stored items on the old numbers.
  // The invariant above is now ENFORCED, not just stated: `reapply` reports whether it succeeded, and a
  // rebuild over uncorrected splits is worse than no rebuild - it re-prices the run off the exact rows this
  // button exists to fix and then clears the drift banner over them. The failure toast has already been shown
  // by `reapply`.
  async function reapplyAndRebuild() {
    if (!(await doReapply())) return;
    await rebuildReview();
  }

  // Pre-publish payslip preview: render one employee's slip from the run's computed lines, exactly as it will
  // be issued, without persisting anything. Gated per run by the `previewPayslip` custom method.
  const [slipPreview, setSlipPreview] = useState<PdfSource | null>(null);
  function previewSlip(it: PayrollRunItem) {
    if (!reviewRun) return;
    setSlipPreview({
      path: "payroll-runs/" + idOf(reviewRun.path),
      verb: "previewPayslip",
      body: { employee: it.employee },
      title: `Payslip preview · ${it.employee_name}`,
      description: `${periodName(reviewRun.pay_period)} · draft, not yet issued. Publishing the run generates the real payslip.`,
      fileName: `payslip-preview-${it.code || idOf(it.employee)}.pdf`,
    });
  }

  // Run totals. `employer_cost` / `above_ctc_cost` are the employer's own contributions for the period (in-CTC
  // and over-and-above-CTC respectively), so the reviewer sees what the run actually costs the company, not just
  // what leaves as net pay.
  const totals = useMemo(() => {
    const t = { gross: 0, total_deductions: 0, tax: 0, net: 0, employer_cost: 0, above_ctc_cost: 0 };
    for (const it of items ?? []) {
      t.gross += it.gross; t.total_deductions += it.total_deductions; t.tax += it.tax; t.net += it.net;
      t.employer_cost += it.employer_cost ?? 0; t.above_ctc_cost += it.above_ctc_cost ?? 0;
    }
    return t;
  }, [items]);
  // The configured banks, which populate the per-bank download menu on an approved run.
  //
  // Read UNCONDITIONALLY. This used to be gated on `me.role === "super_admin"`, which is the same defect the
  // comment on Approve below describes having fixed: it asks about a ROLE where the decision is a PERMISSION.
  // `bankFile` is one of the candidate verbs accessHint computes for this collection
  // (src/http/accessHint.ts), so `run.access.can` already carries it exactly when the caller may invoke it -
  // and the row then hid the action anyway, because `banks` was empty for anyone whose role was not
  // super_admin. The gate also bought nothing: the `.catch` below already swallows a 403, so a caller without
  // `bank-formats.read` ends up with an empty list either way.
  //
  // WORTH KNOWING WHEN GRANTING: `bankFile` without `bank-formats.read` leaves a verb the UI cannot drive -
  // the caller may invoke it, but there is no bank to pick, so no menu renders.
  const [banks, setBanks] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    get<{ results: BankFormat[] }>("bank-formats")
      .then((r) => live && setBanks((r.results ?? []).map((f) => f.bank).filter(Boolean) as string[]))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [newBusy, setNewBusy] = useState(false);
  const [newErr, setNewErr] = useState<string | null>(null);
  const [quickErr, setQuickErr] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);

  // Quick monthly run: pick a month (smart default), prefilled editable period + run created together.
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickYM, setQuickYM] = useState<{ y: number; m: number }>(defaultMonth);
  const [quickForm, setQuickForm] = useState(() => monthDefaults(defaultMonth().y, defaultMonth().m));
  // The quick run's prefilled period is real work (a name and three dates); the plain new-run dialog holds one
  // pick, so only the former needs a discard guard.
  const quickGuard = useDialogGuard(quickOpen, quickForm, () => setQuickOpen(false), { label: "monthly run" });
  // A window of months to choose from: next month back through the last 12, newest first.
  const monthOptions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1 - i, 1));
      const y = d.getUTCFullYear(), m = d.getUTCMonth();
      return { key: `${y}-${m}`, y, m, label: `${MONTHS[m]} ${y}`, exists: periods.some((p) => isMonth(p, y, m)) };
    });
  }, [periods]);
  // An existing period for the chosen month is reused (no duplicate); otherwise we create one.
  const quickExisting = useMemo(() => periods.find((p) => isMonth(p, quickYM.y, quickYM.m)), [periods, quickYM]);

  function openQuick() {
    const def = defaultMonth();
    setQuickYM(def);
    setQuickForm(monthDefaults(def.y, def.m));
    setQuickOpen(true);
  }
  function pickMonth(key: string) {
    const [y, m] = key.split("-").map(Number) as [number, number];
    setQuickYM({ y, m });
    setQuickForm(monthDefaults(y, m));
  }
  async function createQuickRun() {
    setQuickBusy(true);
    setQuickErr(null);
    try {
      // Reuse the month's period if one exists, else create it from the (editable) prefill.
      const periodPath = quickExisting
        ? quickExisting.path
        : (await create<PayPeriod>("pay-periods", {
            display_name: quickForm.display_name.trim(),
            period_start: quickForm.period_start,
            period_end: quickForm.period_end,
            pay_date: quickForm.pay_date,
          })).path;
      await create("payroll-runs", { pay_period: periodPath });
      toast({ title: "Monthly run created", description: quickForm.display_name, variant: "success" });
      setQuickOpen(false);
      reloadPeriods();
      reload();
    } catch (e) {
      setQuickErr((e as Error).message);
    } finally {
      setQuickBusy(false);
    }
  }

  const periodName = useMemo(() => {
    const m = new Map(periods.map((p) => [idOf(p.path), p.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Unknown period" : "-");
  }, [periods]);
  // The pay date a run is working towards. It belongs to the PERIOD, which is why nothing on the runs list
  // could say how long there is left.
  const payDateOf = useMemo(() => {
    const m = new Map(periods.map((p) => [idOf(p.path), p.pay_date]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [periods]);

  // Periods that already carry a run, so the picker can say so instead of letting the create collide. A second
  // run on one period is a genuine mistake (two payments for the same days), not a workflow.
  const periodsWithRun = useMemo(() => new Set(rows.map((r) => idOf(r.pay_period ?? "")).filter(Boolean)), [rows]);
  const selectedPeriod = periods.find((p) => `pay-periods/${idOf(p.path)}` === selected);
  const reviewPeriod = periods.find((p) => reviewRun?.pay_period && idOf(p.path) === idOf(reviewRun.pay_period));

  async function createRun() {
    setNewBusy(true);
    setNewErr(null);
    try {
      await create("payroll-runs", { pay_period: selected });
      toast({ title: "Payroll run created", variant: "success" });
      setSelected("");
      setOpen(false);
      reload();
    } catch (e) {
      setNewErr((e as Error).message);
    } finally {
      setNewBusy(false);
    }
  }

  async function pollOperation(opPath: string) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const op = await api<Operation>(`/${opPath}`);
        if (op.done) {
          setPublishing(null);
          if (op.error?.detail) toast({ title: "Publish failed", description: op.error.detail, variant: "destructive" });
          else toast({ title: "Payroll published", description: "Payslips generated.", variant: "success" });
          reload();
          return;
        }
      } catch {
        /* keep polling */
      }
    }
    setPublishing(null);
    toast({ title: "Still processing", description: "Payslip generation is taking longer than expected." });
    reload();
  }

  async function downloadBankFile(run: PayrollRun, bank: string) {
    const slug = bank.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      await download("payroll-runs/" + idOf(run.path), `${slug}-bulk-payment.xlsx`, { verb: "bankFile", params: { bank } });
    } catch (e) {
      toast({ title: "Couldn't generate bank file", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function downloadStatutory(run: PayrollRun, format?: "ecr") {
    try {
      const name = format === "ecr" ? `ECR-${idOf(run.path)}.txt` : `statutory-${idOf(run.path)}.xlsx`;
      await download("payroll-runs/" + idOf(run.path), name, { verb: "statutoryReport", ...(format ? { params: { format } } : {}) });
    } catch (e) {
      toast({ title: "Couldn't generate statutory report", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function removeRun(run: PayrollRun) {
    const ok = await confirm({
      title: "Delete payroll run?",
      description: `This permanently removes the ${run.state?.toLowerCase()} run and its computed lines. Published runs can't be deleted.`,
      destructive: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await remove("payroll-runs/" + idOf(run.path), run.etag);
      toast({ title: "Run deleted", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Couldn't delete run", description: (e as Error).message, variant: "destructive" });
    }
  }

  // One transition in flight at a time (prevents a double-fired Build/Submit from the kebab).
  const [acting, setActing] = useState<string | null>(null);
  const DONE_TOAST: Record<Exclude<Verb, "publish">, string> = {
    build: "Run built - lines recomputed (safe to rebuild while in draft or review)",
    submit: "Submitted for review",
    approve: "Run approved - ready to publish",
  };
  async function transition(run: PayrollRun, verb: Verb) {
    const id = idOf(run.path);
    if (acting === id || publishing === id) return;
    // Publishing is the point of no return: it notifies every employee in the run and generates payslips.
    if (verb === "publish") {
      const ok = await confirm({
        title: "Publish this payroll run?",
        description: `${periodName(run.pay_period)}: every employee in the run is notified and payslips are generated. A published run can't be edited or deleted.`,
        confirmLabel: "Publish",
      });
      if (!ok) return;
    }
    setActing(id);
    try {
      if (verb === "publish") {
        setPublishing(id);
        const op = await invoke<Operation>("payroll-runs/" + id, "publish", run.etag);
        toast({ title: "Publishing…", description: "Generating payslips in the background." });
        if (op?.path) void pollOperation(op.path);
        else {
          setPublishing(null);
          reload();
        }
      } else {
        await invoke("payroll-runs/" + id, verb, run.etag);
        toast({ title: DONE_TOAST[verb], variant: "success" });
        reload();
      }
    } catch (e) {
      setPublishing(null);
      staleToast(e, `Couldn't ${verb} the run`);
    } finally {
      setActing(null);
    }
  }

  // What payroll needs to know before anything else: which runs are about to miss their own pay date. A
  // published run is done whatever its date says, so only the unfinished ones count.
  const runInsights = (rs: PayrollRun[]): TableInsight[] => {
    const out: TableInsight[] = [];
    const due = rs.filter((r) => {
      if (up(r.state) === "PUBLISHED") return false;
      const d = daysUntil(payDateOf(r.pay_period));
      return d != null && d >= 0 && d <= PAY_DATE_SOON_DAYS;
    });
    if (due.length > 0) {
      out.push({
        id: "pay-soon",
        label: `${due.length} to finish within ${PAY_DATE_SOON_DAYS} days`,
        tone: "warning",
        hint: "Unpublished runs whose pay date is nearly here.",
        filters: { pay_in: `0..${PAY_DATE_SOON_DAYS}` },
        sort: "pay_in.asc",
      });
    }
    const late = rs.filter((r) => {
      if (up(r.state) === "PUBLISHED") return false;
      const d = daysUntil(payDateOf(r.pay_period));
      return d != null && d < 0;
    });
    if (late.length > 0) {
      out.push({
        id: "pay-past",
        label: `${late.length} past their pay date`,
        tone: "destructive",
        hint: "The date the money was meant to move has gone and the run is not published.",
        filters: { pay_in: "<0" },
        sort: "pay_in.asc",
      });
    }
    return out;
  };

  const columns: Column<PayrollRun>[] = [
    { id: "period", header: "Pay period", filter: "select", groupBy: true, accessor: (r) => periodName(r.pay_period), cell: (r) => <span className="font-medium">{periodName(r.pay_period)}</span> },
    { id: "state", header: "State", filter: "select", groupBy: true, accessor: (r) => r.state, cell: (r) => <StatusBadge state={r.state} /> },
    { id: "submitted_by", header: "Submitted by", defaultHidden: true, filter: "select", groupBy: true, accessor: (r) => r.submitted_by_name ?? (r.submitted_by ? idOf(r.submitted_by) : ""), cell: (r) => r.submitted_by_name ?? (r.submitted_by ? idOf(r.submitted_by) : "-") },
    { id: "approved_by", header: "Approved by", defaultHidden: true, filter: "select", groupBy: true, accessor: (r) => r.approved_by_name ?? (r.approved_by ? idOf(r.approved_by) : ""), cell: (r) => r.approved_by_name ?? (r.approved_by ? idOf(r.approved_by) : "-") },
    // The size of each run, stamped by its own build. A run list that showed only a state made you open every
    // one to find out whether it paid four people or four hundred - and the three figures are the first thing
    // anybody checks against last month before approving.
    //
    // Blank, not zero, until the run is built: `undefined` from the API says "never priced", which is a
    // different claim from a run that priced nobody, and it keeps an unbuilt run out of the averages.
    {
      id: "headcount", header: "People", align: "right", filter: "number", aggregate: "avg",
      accessor: (r) => r.headcount ?? null,
      cell: (r) => (r.headcount == null ? <span className="text-muted-foreground">not built</span> : <span className="tabular-nums">{r.headcount}</span>),
    },
    {
      // Summed across whatever the table is narrowed to, which is how "what did we pay out this year" gets
      // answered - and per pay period the moment it is grouped.
      id: "gross", header: "Gross", align: "right", defaultHidden: true, filter: "number", aggregate: "sum", formatTotal: (n) => money(n),
      accessor: (r) => r.gross ?? null,
      cell: (r) => (r.gross == null ? <span className="text-muted-foreground">-</span> : <span className="tabular-nums">{money(r.gross)}</span>),
    },
    {
      id: "net", header: "Net", align: "right", filter: "number", aggregate: "sum", formatTotal: (n) => money(n),
      accessor: (r) => r.net ?? null,
      cell: (r) => (r.net == null ? <span className="text-muted-foreground">-</span> : <span className="font-medium tabular-nums">{money(r.net)}</span>),
    },
    {
      // How long until the money is supposed to move. A run list ordered by creation says nothing about
      // urgency: the run that has to be approved TODAY looks exactly like the one for next quarter, and the
      // pay date it is measured against lives on the period, one page across.
      // Empty once the run is published, and deliberately so: a published run has paid, so "three days left"
      // is not a thing anybody needs to act on. It also makes the countdown the exact set the chips above
      // count, since a range filter leaves the blanks out.
      id: "pay_in", header: "Pay date in", align: "right", filter: "number", formatTotal: fmtDaysCount,
      accessor: (r) => (up(r.state) === "PUBLISHED" ? null : daysUntil(payDateOf(r.pay_period))),
      cell: (r) => {
        if (up(r.state) === "PUBLISHED") return <span className="text-muted-foreground">paid</span>;
        const d = daysUntil(payDateOf(r.pay_period));
        if (d == null) return <span className="text-muted-foreground">-</span>;
        return (
          <span className={cn("tabular-nums text-xs", d <= 3 && "font-medium text-destructive", d > 3 && d <= PAY_DATE_SOON_DAYS && "text-warning")}>
            {d < 0 ? `${fmtDaysCount(-d)} ago` : fmtDaysCount(d)}
          </span>
        );
      },
    },
    ...metaColumns<PayrollRun>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (run) => {
        const id = idOf(run.path);
        if (publishing === id)
          return (
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Generating payslips…
            </span>
          );
        // Every step is gated the way the three lines below are: by the ROW's server-computed `can`, applied
        // centrally in RowActions. `approve` is one of the candidate verbs accessHint computes for this
        // collection, so `can` already holds it exactly when the caller may invoke it. Asking `me.role ===
        // "super_admin"` here instead asked about a ROLE rather than a PERMISSION, and cost two things: a
        // finance director granted `payroll-runs.*.approve` by an access rule still saw no button (the only
        // remedy being an edit to grants.ts, which is the thing access rules exist to avoid), and because the
        // filter ran before RowActions - which deliberately bypasses its own filter in access mode so an admin
        // can manage gates they cannot use - Approve had no manage-access affordance anywhere in the app.
        // Separation of duties stays where it is enforced: grants.ts and the authz middleware.
        const steps = NEXT[run.state?.toUpperCase()] ?? [];
        // Bank file: downloadable once the run is approved (or published), one file per configured bank.
        const canBankFile = run.access?.can?.includes("bankFile") && ["APPROVED", "PUBLISHED"].includes(run.state?.toUpperCase() ?? "") && banks.length > 0;
        // Statutory report (PF/ESI/PT/TDS): available once the run is built (review onward).
        const canStatutory = run.access?.can?.includes("statutoryReport") && ["REVIEW", "APPROVED", "PUBLISHED"].includes(run.state?.toUpperCase() ?? "");
        // Unpublished runs can be deleted (the server rejects PUBLISHED too) - but not once a bank payout file
        // has been generated: deleting releases every payable the run paid, and the money may already be out.
        const canDelete = run.access?.can?.includes("delete") && run.state?.toUpperCase() !== "PUBLISHED" && !run.bank_file_time;
        const actions: RowAction[] = [
          { label: "Review", icon: <Eye className="h-4 w-4" />, onClick: () => openReview(run) },
          ...steps.map((s) => ({ label: s.label, icon: <s.icon className="h-4 w-4" />, onClick: () => transition(run, s.verb), verb: s.verb })),
          ...(canBankFile ? banks.map((b) => ({ label: `Bank file · ${b}`, icon: <FileSpreadsheet className="h-4 w-4" />, onClick: () => downloadBankFile(run, b), verb: "bankFile" })) : []),
          ...(canStatutory ? [
            { label: "Statutory report (.xlsx)", icon: <FileSpreadsheet className="h-4 w-4" />, onClick: () => downloadStatutory(run), verb: "statutoryReport" },
            { label: "PF ECR file (.txt)", icon: <FileSpreadsheet className="h-4 w-4" />, onClick: () => downloadStatutory(run, "ecr"), verb: "statutoryReport" },
          ] : []),
          // Built onward, the same point the statutory report becomes meaningful: before the run is priced
          // there is nothing to post. No verb gate - the journal is a GET on the run, so seeing the row is
          // already the read decision.
          ...(["REVIEW", "APPROVED", "PUBLISHED"].includes(run.state?.toUpperCase() ?? "")
            ? [{ label: "Accounting journal (.csv)", icon: <FileSpreadsheet className="h-4 w-4" />, onClick: () => downloadJournal(run) }]
            : []),
          ...(canDelete ? [{ label: "Delete run", icon: <Trash2 className="h-4 w-4" />, onClick: () => removeRun(run), destructive: true, verb: "delete" }] : []),
        ];
        return <RowActions actions={actions} objectPath={run.path} can={run.access?.can} />;
      },
    },
  ];

  /**
   * The month as a journal, for the accounting system.
   *
   * THE REFUSAL IS REAL HERE, not only in the API. An entry that does not balance, or one missing a component
   * nobody mapped, must not reach a CSV somebody imports - an unmapped component dropped silently would still
   * produce a file whose debits equal its credits, just for less money than the run actually paid. So the
   * failure is a toast naming the reason and no download at all, which is the one outcome that cannot be
   * posted by mistake.
   */
  async function downloadJournal(run: PayrollRun) {
    try {
      const j = await get<RunJournal>("payroll-runs/" + idOf(run.path) + "/journal");
      if (j.unmapped?.length) {
        toast({
          title: "No journal yet",
          description: `These pay components have no GL code: ${j.unmapped.join(", ")}. Map them in Pay components, then try again.`,
          variant: "destructive",
        });
        return;
      }
      if (!j.balanced) {
        toast({
          title: "The journal does not balance",
          description: `Debits ${money(j.total_debit ?? 0)} against credits ${money(j.total_credit ?? 0)}, out by ${money(j.residual ?? 0)}. This is a problem with the run's figures, not with the export - report it rather than posting it.`,
          variant: "destructive",
        });
        return;
      }
      await exportTable(
        `payroll-journal-${j.posted_from || idOf(run.path)}`,
        ["Account", "Cost centre", "Debit", "Credit", "Narration", "Reference"],
        (j.lines ?? []).map((l) => [l.account, l.department ?? "", l.debit || "", l.credit || "", l.label, j.posted_from ?? ""]),
        "csv",
        "payroll-runs",
      );
    } catch (e) {
      toast({ title: "Couldn't build the journal", description: (e as Error).message, variant: "destructive" });
    }
  }

  const quickRunBtn = canQuick ? (
    <Button variant="outline" onClick={openQuick}><Rocket className="h-4 w-4" /> Quick monthly run</Button>
  ) : null;
  const newRunBtn = (
    <AccessAction collection="payroll-runs" create label="New run">
      {/* Deliberately NOT disabled when there are no pay periods: a dead button explains nothing, while the
          dialog can say what's missing and send you to the tab that fixes it. */}
      <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New run</Button>
    </AccessAction>
  );
  const runActions = (
    <>
      {quickRunBtn}
      {newRunBtn}
    </>
  );

  const activeTab = ["periods", "bonuses", "budgets"].includes(tab ?? "") ? tab! : "runs";
  // `payroll-runs/runs/<id>` opens that run's breakdown - the link you send when asking someone to check a run.
  useDeepOpen(activeTab === "runs" ? openId : undefined, rows, openReview);
  // "New since last looked" counts per sub-tab; the tab you're on is suppressed and marked seen.
  const activity = useTabActivity([
    { key: "payroll-runs:runs", collection: "payroll-runs" },
    { key: "payroll-runs:periods", collection: "pay-periods" },
    { key: "payroll-runs:bonuses", collection: "bonuses" },
    { key: "payroll-runs:budgets", collection: "payroll-budgets" },
  ]);
  useEffect(() => {
    markTabSeen(`payroll-runs:${activeTab}`);
  }, [activeTab]);
  const tabBadge = (t: string) => (activeTab === t ? 0 : activity[`payroll-runs:${t}`] ?? 0);

  return (
    <div>
      {/* The page's own heading, above the tab bar rather than inside the Runs tab: the Pay periods and
          Bonuses tabs embed panels that carry no header of their own, so a header living in one tab's content
          left the other two as pages with no title at all - nothing for a screen reader to land on, and
          nothing on screen saying where you are. The create actions stay with the tab they act on. */}
      <PageHeader
        title="Payroll"
        description="Build, review and publish payroll."
        actions={<>{activeTab === "runs" && runActions}<PageSettings me={me} host="payroll-runs" /></>}
      />
      <Tabs value={activeTab} onValueChange={(v) => navigate(`payroll-runs/${v}`)}>
        <TabsList variant="underline">
          <AccessTab value="runs" target={{ collection: "payroll-runs", label: "Payroll Runs" }}>Runs<ActivityBadge count={tabBadge("runs")} /></AccessTab>
          <AccessTab value="periods" target={{ collection: "pay-periods", label: "Pay periods" }}>Pay periods<ActivityBadge count={tabBadge("periods")} /></AccessTab>
          <AccessTab value="bonuses" target={{ collection: "bonuses", label: "Bonuses" }}>Bonuses<ActivityBadge count={tabBadge("bonuses")} /></AccessTab>
          {/* The pay bill against what was budgeted for it. Here rather than on the expenses budget page:
              spend comes from these runs, and the two are read together. */}
          <AccessTab value="budgets" target={{ collection: "payroll-budgets", label: "Payroll budgets" }}>Budgets<ActivityBadge count={tabBadge("budgets")} /></AccessTab>
        </TabsList>

        <TabsContent value="runs">
          <DataState state={state} error={error} onRetry={reload}>
            {rows.length === 0 ? (
              <EmptyState
                icon={PlayCircle}
                illustration="payroll"
                title="No payroll runs"
                description={canQuick ? "Start a quick monthly run (prefilled), or pick a pay period." : periods.length === 0 ? "Create a pay period first (Pay periods tab), then start a run." : "Start a run against a pay period."}
                action={quickRunBtn ?? (periods.length > 0 ? newRunBtn : undefined)}
              />
            ) : (
              <DataTable
                tableId="payroll-runs"
                columns={columns}
                rows={rows}
                insights={runInsights}
                getRowId={(r) => r.path}
                emptyTitle="No runs match"
                rowClassName={() => "group"}
                accessCollection="payroll-runs"
                accessTargetOf={(r) => ({ objectPath: r.path, label: `Payroll run (${r.state})`, can: r.access?.can })}
              />
            )}
          </DataState>
        </TabsContent>

        <TabsContent value="periods">
          <PayPeriods openId={activeTab === "periods" ? openId : undefined} />
        </TabsContent>

        <TabsContent value="bonuses">
          <PayrollBonuses />
        </TabsContent>

        <TabsContent value="budgets">
          <PayrollBudgets />
        </TabsContent>
      </Tabs>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setNewErr(null); }}>
        <DialogContent onEnterSubmit={() => { if (selected && !newBusy) void createRun(); }}>
          <DialogHeader>
            <DialogTitle>New payroll run</DialogTitle>
            <DialogDescription>Creates an empty draft. Nothing is computed until you build it, and nobody is paid until you publish.</DialogDescription>
          </DialogHeader>
          <FormError error={newErr} />
          {periods.filter((p) => !p.disabled).length === 0 ? (
            <p className="rounded-lg border bg-muted/40 p-3 text-sm">
              There are no pay periods to run against yet - a period is the span of days a run pays for.{" "}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setOpen(false); navigate("payroll-runs/periods"); }}>
                Create a pay period
              </button>{" "}
              first.
            </p>
          ) : (
            <Field label="Pay period">
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger><SelectValue placeholder="Select a pay period…" /></SelectTrigger>
                <SelectContent>
                  {periods.filter((p) => !p.disabled).map((p) => (
                    <SelectItem key={p.path} value={`pay-periods/${idOf(p.path)}`}>
                      {p.display_name}{periodsWithRun.has(idOf(p.path)) ? " · already has a run" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {selectedPeriod && (
            <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Pays for</span><span className="font-medium">{formatDate(selectedPeriod.period_start)} - {formatDate(selectedPeriod.period_end)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Pay date</span><span className="font-medium">{formatDate(selectedPeriod.pay_date)}</span></div>
            </div>
          )}
          {selectedPeriod && periodsWithRun.has(idOf(selectedPeriod.path)) && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              This period already has a payroll run. A second run pays the same days again - review the existing one instead unless you meant a correction run.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={createRun} loading={newBusy} disabled={!selected}>Create run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={quickOpen} onOpenChange={quickGuard.onOpenChange}>
        <DialogContent scrollBody onEnterSubmit={() => { if (!quickBusy && (quickExisting || (quickForm.display_name.trim() && quickForm.period_start && quickForm.period_end >= quickForm.period_start && quickForm.pay_date))) void createQuickRun(); }}>
          <DialogHeader>
            <DialogTitle>Quick monthly run</DialogTitle>
            <DialogDescription>
              Pick a month: the pay period is created for you if it doesn't exist, and a draft run opens against it. Defaulted to {defaultMonth().m === orgMonthIdx() ? "this month" : "last month"} based on today.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={quickErr} />
          <Field label="Month">
            <Select value={`${quickYM.y}-${quickYM.m}`} onValueChange={pickMonth}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {monthOptions.map((o) => (
                  <SelectItem key={o.key} value={o.key}>{o.label}{o.exists ? " · period exists" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {quickExisting ? (
            <>
              <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <p className="text-muted-foreground">This month already has a pay period - the run will use it.</p>
                <div className="flex justify-between"><span className="text-muted-foreground">Pays for</span><span className="font-medium">{formatDate(quickExisting.period_start)} - {formatDate(quickExisting.period_end)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Pay date</span><span className="font-medium">{formatDate(quickExisting.pay_date)}</span></div>
              </div>
              {periodsWithRun.has(idOf(quickExisting.path)) && (
                <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                  A run already exists for {quickExisting.display_name}. Creating another pays the same days twice.
                </p>
              )}
            </>
          ) : (
            <>
              <Field label="Name">
                <Input value={quickForm.display_name} onChange={(e) => setQuickForm({ ...quickForm, display_name: e.target.value })} />
              </Field>
              <FieldRow>
                <Field label="Period start">
                  <Input type="date" value={quickForm.period_start} onChange={(e) => setQuickForm({ ...quickForm, period_start: e.target.value })} />
                </Field>
                <Field label="Period end" error={quickForm.period_end && quickForm.period_end < quickForm.period_start ? "Before the period start." : undefined}>
                  <Input type="date" min={quickForm.period_start} value={quickForm.period_end} onChange={(e) => setQuickForm({ ...quickForm, period_end: e.target.value })} />
                </Field>
              </FieldRow>
              <Field label="Pay date">
                <Input type="date" value={quickForm.pay_date} onChange={(e) => setQuickForm({ ...quickForm, pay_date: e.target.value })} />
              </Field>
            </>
          )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuickOpen(false)}>Cancel</Button>
            <Button onClick={createQuickRun} loading={quickBusy} disabled={!quickExisting && (!quickForm.display_name.trim() || !quickForm.period_start || !quickForm.period_end || !quickForm.pay_date)}>
              Create run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-employee breakdown - the review surface */}
      <Dialog open={!!reviewRun} onOpenChange={(o) => { if (!o) { reviewFor.current = null; setReviewRun(null); } }}>
        {/* 85vh from `sm` up; a phone keeps the shared keyboard-aware sheet height (see ui/dialog.tsx). */}
        {/* `scrollBody`, so the panel has ONE scroller and the header stays put above it. Hand-rolled before
            - a flex column that clipped (`overflow-hidden`) with a table box bounded to its own slice of the
            viewport - and the arithmetic could not hold: the staleness notice above the table names every
            affected employee, so on a 100-person run it took the whole panel and the table underneath was
            squeezed to NOTHING. Its rows were still in the DOM (and still found by anything looking for
            them), just zero pixels tall, with the chart below them collecting the clicks meant for the row
            buttons. One scroller means the notice, the table and the chart each keep their own height and
            the reader scrolls between them. */}
        <DialogContent scrollBody className="max-w-4xl sm:max-h-[85vh]">
          <AccessScope collection="payroll-runs" objectPath={reviewRun?.path}>
          <DialogHeader>
            <DialogTitle>Payroll breakdown · {periodName(reviewRun?.pay_period)}</DialogTitle>
            <DialogDescription>
              {reviewRun?.state?.toUpperCase() === "PUBLISHED"
                ? "Published - these are the figures on the payslips employees can see."
                : "Draft figures. Nothing reaches an employee until the run is published."}
              {reviewPeriod ? ` Pays for ${formatDate(reviewPeriod.period_start)} - ${formatDate(reviewPeriod.period_end)}, on ${formatDate(reviewPeriod.pay_date)}.` : ""}
              {/* Publishing writes the payslips; this is the only place that says whether anybody received one.
                  Counted from the owner's own first view, so it is a delivery figure and not a record of who
                  has been reading what. Silent once everybody has opened theirs - a line that always reads
                  "0 outstanding" is a line people stop seeing. */}
              {(reviewRun?.payslips_unopened ?? 0) > 0 && (
                <> <span className="text-warning">{reviewRun!.payslips_unopened} {reviewRun!.payslips_unopened === 1 ? "person has" : "people have"} not opened their payslip yet.</span></>
              )}
            </DialogDescription>
          </DialogHeader>
          {/* Where the month has got to. Planned dates and actual ones on one line, so "are we late" is a
              glance rather than a reconstruction across three pages. Steps that have not happened are shown
              greyed rather than hidden - the gap IS the information, and a list that only showed what was done
              would read as complete at every stage. */}
          {(reviewRun?.timeline?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              {reviewRun!.timeline!.map((m) => (
                <span key={m.key} className={cn("whitespace-nowrap", m.at_time ? "text-foreground" : "text-muted-foreground/60")}>
                  <span className="font-medium">{MILESTONE_LABEL[m.key] ?? m.key}</span>{" "}
                  {m.at_time ? formatDate(m.at_time) : "-"}
                  {m.actor ? <span className="text-muted-foreground"> · {m.actor}</span> : null}
                </span>
              ))}
            </div>
          )}
          {/* `scroll-pt-10` is the height of the table's own sticky header row: it pins to THIS scroller, so
              anything that scrolls a row into view here has to leave room for it or the row lands underneath
              it, unreadable and unclickable. */}
          <DialogBody className="scroll-pt-10">
          {reviewStale?.stale && (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <div className="flex items-start gap-2 text-warning-foreground dark:text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Inputs changed since this run was built — rebuild to update the numbers.</p>
                  <p className="mt-0.5 text-xs">Changed: {reviewStale.changes.join(", ")}.</p>
                </div>
              </div>
              {reviewRun?.access?.can?.includes("build") && (
                <Button size="sm" onClick={rebuildReview} disabled={acting === idOf(reviewRun.path)}>
                  {acting === idOf(reviewRun.path) ? "Rebuilding…" : "Rebuild now"}
                </Button>
              )}
            </div>
          )}
          {/* The same scan on a COMMITTED run, and deliberately a different banner with NO rebuild button.
              A published run is the record of what was actually paid; rebuilding it is the one thing nobody
              should do here, so offering the button would be offering the mistake. This states the fact and
              names where the correction belongs instead. Before this, a committed run reported nothing at
              all and the payslip and the live data could disagree with nothing on screen saying which was
              true. */}
          {reviewStale?.diverged && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground dark:text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Inputs have changed since this run was built, and it can no longer be rebuilt.</p>
                <p className="mt-0.5 text-xs">
                  Changed: {reviewStale.changes.join(", ")}. The payslips here remain the record of what was paid. Anything owed as a
                  result belongs in a later run - a back-dated pay revision is paid as arrears, and bonuses, claims, encashments and
                  overtime stay queued until the next run picks them up.
                </p>
              </div>
            </div>
          )}
          {/* Split drift: the run priced a CACHED basic / Special Allowance that the current pay-component setup no
              longer produces, so these people's gross doesn't reconcile to the CTC they were promised. Invisible to
              the staleness check above (that only sees inputs touched AFTER the build; this usually predates it).
              A warning, not a block - paying the contracted stored split can be deliberate. */}
          {reviewStale?.split_drift?.stale?.length ? (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <div className="flex items-start gap-2 text-warning-foreground dark:text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">
                    This run priced an out-of-date pay split for {reviewStale.split_drift.stale.length} employee{reviewStale.split_drift.stale.length === 1 ? "" : "s"}.
                  </p>
                  <p className="mt-0.5 text-xs">
                    {reviewStale.split_drift.stale.join(", ")} - their basic / Special Allowance was derived under an earlier pay-component setup, so it no
                    longer solves the CTC they were promised. Re-apply the split (each annual CTC stays fixed), then rebuild.
                    {canReapply ? "" : " Ask Payroll to re-apply the split."}
                  </p>
                </div>
              </div>
              {canReapply && reviewRun?.access?.can?.includes("build") && (
                <AccessAction collection="compensation" verb="reapplySplit" label="re-apply the split">
                  <Button size="sm" onClick={reapplyAndRebuild} disabled={reapplying || acting === idOf(reviewRun.path)}>
                    {reapplying || acting === idOf(reviewRun.path) ? "Working…" : "Re-apply & rebuild"}
                  </Button>
                </AccessAction>
              )}
            </div>
          ) : null}
          {/* Rows whose CTC no longer fits the components at all: a re-apply changes nothing, so this needs a CTC
              raise or a trimmed catalog. Separate colour because the action is different. */}
          {reviewStale?.split_drift?.skipped?.length ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">{reviewStale.split_drift.skipped.length} employee{reviewStale.split_drift.skipped.length === 1 ? "'s" : "s'"} CTC no longer fits the components.</p>
                <p className="mt-0.5 text-xs">{reviewStale.split_drift.skipped.join(", ")} - no split fits that CTC, so re-applying can't fix it. Raise the CTC or trim components.</p>
              </div>
            </div>
          ) : null}
          {/* People the build walked and could not price: they are ABSENT from the breakdown below rather than
              wrong in it, which is why no amount of reading the item list finds them. Destructive colour, like
              the CTC-doesn't-fit case: both mean the run is not yet a correct payroll and both need a data fix
              before a rebuild. A warning rather than a block - somebody genuinely owed nothing for the period
              is correctly unpriced, so the reviewer decides (see the note on `transition` in services/payroll.ts). */}
          {reviewStale?.unpriced?.length ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">
                  {reviewStale.unpriced.length} employee{reviewStale.unpriced.length === 1 ? " is" : "s are"} not on this run.
                </p>
                <p className="mt-0.5 text-xs">
                  {reviewStale.unpriced.join(", ")} - no compensation is in force for this period, so there was nothing to price and they are
                  missing from the breakdown entirely. Set their compensation, then rebuild. If they are genuinely owed nothing for this period,
                  this is expected.
                </p>
              </div>
            </div>
          ) : null}
          {items === null ? (
            <TableSkeleton rows={6} cols={5} />
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No lines yet. Build the run to compute payroll, then review it here.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {items.length > 8 ? (
                  <Input placeholder="Find an employee…" value={itemQuery} onChange={(e) => setItemQuery(e.target.value)} className="max-w-xs" />
                ) : <span />}
                {/* "Compare with November 2026" is a single nowrap label wider than a phone's content
                    column on its own, and it shares this row with two more controls. */}
                <div className="flex flex-wrap items-center gap-1">
                  {priorRun && (compare ? (
                    <Button variant="ghost" size="sm" onClick={() => setCompare(null)}>Hide comparison</Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={loadCompare} loading={comparing}>Compare with {priorRun.period.display_name}</Button>
                  ))}
                  {/* Checking a run means reading the lines, not the totals: one control opens every breakdown
                      instead of a click per person. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpanded((s) => (s.size === items.length ? new Set() : new Set(items.map((it) => it.employee))))}
                  >
                    {expanded.size === items.length ? "Collapse all" : "Expand all"}
                  </Button>
                </div>
              </div>
              {/* The headline a reviewer actually needs: not the total, but how many people's pay moved since
                  last month, and who is new. Everything else can be left unread. */}
              {/* THE POINTER. A reviewer with 240 rows and nothing saying where to look reads the first screen and
              approves; the whole value of this band is that it names the rows and the reason each one moved.
              Blocking issues are separated out because they will refuse :approve - saying so here is cheaper
              than letting somebody find out by pressing it. Absent entirely when there is nothing to say,
              which on a quiet month is most months. */}
          {variance && (variance.flags?.length || variance.preflight?.length) ? (
            <div className="space-y-2">
              {(variance.preflight ?? []).some((i) => i.blocking) && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
                  <p className="font-medium text-destructive">
                    {(variance.preflight ?? []).filter((i) => i.blocking).length} item(s) are arithmetically wrong - this run cannot be approved until it is rebuilt.
                  </p>
                  {(variance.preflight ?? []).filter((i) => i.blocking).slice(0, 5).map((i, n) => (
                    <p key={n} className="text-xs text-muted-foreground">{i.employee_id ? empName(i.employee_id) : "This run"}: {i.detail}</p>
                  ))}
                </div>
              )}
              {(variance.flags ?? []).length > 0 && (
                <details className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <summary className="cursor-pointer select-none">
                    <span className="font-medium">{(variance.flags ?? []).length}</span> of {items?.length ?? 0} worth a look
                    {variance.compared_against ? <span className="text-muted-foreground"> · against the last {variance.compared_against} run{variance.compared_against === 1 ? "" : "s"}</span> : null}
                  </summary>
                  <div className="mt-2 space-y-1">
                    {(variance.flags ?? []).slice(0, 25).map((f, n) => (
                      <div key={n} className="flex items-baseline justify-between gap-3 text-xs">
                        <span>
                          <span className="font-medium">{empName(f.employee_id)}</span>
                          {" "}
                          <span className="text-muted-foreground">
                            {f.reasons?.length ? f.reasons.join(", ") : VARIANCE_LABEL[f.kind] ?? f.kind}
                          </span>
                        </span>
                        {f.kind !== "first_run" && (
                          <span className={cn("shrink-0 tabular-nums", (f.delta ?? 0) < 0 ? "text-destructive" : "text-foreground")}>
                            {(f.delta ?? 0) > 0 ? "+" : ""}{money(f.delta ?? 0)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {(variance.preflight ?? []).some((i) => !i.blocking) && (
                <p className="text-xs text-muted-foreground">
                  Also worth checking: {(variance.preflight ?? []).filter((i) => !i.blocking).slice(0, 4).map((i) => `${i.employee_id ? empName(i.employee_id) : "run"} - ${i.detail}`).join("; ")}.
                </p>
              )}
            </div>
          ) : null}
          {/* What the movement is MADE of, above the per-person diff. Every row is signed and they sum to
                  the difference between the two runs' gross, so the statement closes: a reviewer who accepts
                  these five lines has accounted for the whole month without opening anybody's breakdown.
                  `residual` is zero unless the server's own bucketing is broken, so it is shown ONLY when it
                  is not - a zero on screen every month teaches people to stop reading it. */}
              {reconcile && reconcile.compared_to && (
                <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <table className="w-full tabular-nums">
                    <tbody>
                      <tr className="text-muted-foreground">
                        <td className="py-0.5">Gross last run ({reconcile.opening.employees} paid)</td>
                        <td className="py-0.5 text-right">{money(reconcile.opening.gross)}</td>
                      </tr>
                      {reconcile.movements.filter((m) => m.amount !== 0 || m.employees > 0).map((m) => (
                        <tr key={m.key}>
                          <td className="py-0.5 pl-3 text-muted-foreground">
                            {MOVEMENT_LABEL[m.key]}
                            {m.employees > 0 ? <span className="text-xs"> ({m.employees})</span> : null}
                          </td>
                          <td className={cn("py-0.5 text-right", m.amount < 0 ? "text-muted-foreground" : "text-foreground")}>
                            {m.amount > 0 ? "+" : ""}{money(m.amount)}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t font-medium">
                        <td className="py-0.5">Gross this run ({reconcile.closing.employees} paid)</td>
                        <td className="py-0.5 text-right">{money(reconcile.closing.gross)}</td>
                      </tr>
                      {(reconcile.residual !== 0 || reconcile.headcount_residual !== 0) && (
                        <tr className="text-destructive">
                          <td className="py-0.5">Unexplained - report this, the breakdown above is incomplete</td>
                          <td className="py-0.5 text-right">{money(reconcile.residual)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {compare && (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {(() => {
                    const changed = items.filter((it) => compare.net.has(it.employee) && Math.abs(it.net - compare.net.get(it.employee)!) >= 0.01).length;
                    const fresh = items.filter((it) => !compare.net.has(it.employee)).length;
                    const gone = [...compare.net.keys()].filter((e) => !items.some((it) => it.employee === e)).length;
                    return (
                      <>
                        <span className="font-medium text-foreground">{changed}</span> of {items.length} changed net pay vs {compare.label}
                        {fresh > 0 ? ` · ${fresh} not in that run` : ""}
                        {gone > 0 ? ` · ${gone} paid then but not now` : ""}
                        {changed === 0 && fresh === 0 && gone === 0 ? " - identical to last run" : ""}
                      </>
                    );
                  })()}
                </p>
              )}
            {/* No scroller of its own: the dialog body is the one scroller (see `scrollBody` above), and the
                `sticky` header below pins to it. A nested box here is what used to bound the table to a slice
                of the viewport the dialog could not actually spare. `overflow-x-auto` stays, for a run wide
                enough to need it on a narrow window - a horizontal scroller does not bound the height. */}
            <div className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto">
              {/* Five money columns per employee: on a phone each row becomes a labelled block (the expand
                  row it opens is a `colSpan` note, which stacks as a plain block under it). */}
              <table className="table-stack w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b text-left">
                    <th className="px-2 py-2 font-semibold">Employee</th>
                    <th className="px-2 py-2 text-right font-semibold">Gross</th>
                    <th className="px-2 py-2 text-right font-semibold">Deductions</th>
                    <th className="px-2 py-2 text-right font-semibold">Tax (TDS)</th>
                    <th className="px-2 py-2 text-right font-semibold">Net</th>
                    {compare && <th className="px-2 py-2 text-right font-semibold">vs {compare.label}</th>}
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.filter((it) => !itemQuery.trim() || it.employee_name.toLowerCase().includes(itemQuery.trim().toLowerCase())).map((it) => {
                    const open = expanded.has(it.employee);
                    return (
                      <Fragment key={it.employee}>
                        {/* The row is the disclosure for this employee's lines, so it has to work from the
                            keyboard as well as the pointer: a tab stop, Enter/Space, and a state a screen
                            reader can hear. `role="button"` on the <tr> would replace its row semantics, so
                            the expanded state is announced with aria-expanded on the row itself. */}
                        <tr
                          className="cursor-pointer border-b hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          tabIndex={0}
                          aria-expanded={expanded.has(it.employee)}
                          onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setExpanded((s) => { const n = new Set(s); n.has(it.employee) ? n.delete(it.employee) : n.add(it.employee); return n; }); } }}
                          onClick={() => setExpanded((s) => { const n = new Set(s); n.has(it.employee) ? n.delete(it.employee) : n.add(it.employee); return n; })}
                        >
                          <td className="px-2 py-1.5 font-medium"><span className="inline-flex items-center gap-1"><ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} /> {it.employee_name}</span></td>
                          <td data-label="Gross" className="px-2 py-1.5 text-right tabular-nums">{money(it.gross)}</td>
                          <td data-label="Deductions" className="px-2 py-1.5 text-right tabular-nums">{money(it.total_deductions)}</td>
                          <td data-label="Tax (TDS)" className="px-2 py-1.5 text-right tabular-nums">{money(it.tax)}</td>
                          <td data-label="Net" className="px-2 py-1.5 text-right font-semibold tabular-nums">{money(it.net)}</td>
                          {compare && (
                            <td data-label={`vs ${compare.label}`} className="px-2 py-1.5 text-right tabular-nums">
                              {(() => {
                                const was = compare.net.get(it.employee);
                                if (was == null) return <span className="text-xs text-muted-foreground">new</span>;
                                const d = round2(it.net - was);
                                if (Math.abs(d) < 0.01) return <span className="text-xs text-muted-foreground">-</span>;
                                return <span className={d > 0 ? "text-success" : "text-destructive"}>{d > 0 ? "+" : "−"}{money(Math.abs(d))}</span>;
                              })()}
                            </td>
                          )}
                          <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <AccessAction collection="payroll-runs" objectPath={reviewRun?.path} verb="previewPayslip" can={reviewRun?.access?.can} label="Preview payslip">
                              <Button variant="ghost" size="sm" title="Preview this payslip" onClick={() => previewSlip(it)}>
                                <Eye className="h-4 w-4" />
                              </Button>
                            </AccessAction>
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-b bg-muted/30">
                            <td colSpan={compare ? 7 : 6} className="px-6 py-2">
                              <div className="space-y-1">
                                {/* Pay lines: earnings (loss of pay rides here as a negative earning - it is pay
                                    that was never earned, so it leaves gross and every tax/statutory base) and
                                    deductions. */}
                                {it.lines.filter((l) => l.kind === "earning" || l.kind === "deduction").map((l, i) => (
                                  <Fragment key={i}>
                                    <div className="flex justify-between text-xs">
                                      <span className={l.kind === "deduction" ? "text-destructive" : ""}>{l.name}{l.kind === "earning" && l.taxable === false ? " (non-taxable)" : ""}</span>
                                      <span className="tabular-nums">{l.kind === "deduction" ? "-" : ""}{money(l.amount)}</span>
                                    </div>
                                    {/* What the line is made of, where the lump alone cannot be checked - arrears
                                        naming the months they cover. Indented and muted: this explains a figure
                                        already counted above, so it must not read as more money. */}
                                    {l.parts?.map((pt, pi) => (
                                      <div key={pi} className="flex justify-between pl-3 text-[11px] text-muted-foreground">
                                        <span>{pt.label}</span>
                                        <span className="tabular-nums">{money(pt.amount)}</span>
                                      </div>
                                    ))}
                                  </Fragment>
                                ))}
                                {/* Perquisites: taxable VALUE the employee never receives in cash (e.g. the interest
                                    concession on a cheap employer loan). They lift the taxable gross - and so the
                                    TDS - and touch nothing else, which is worth saying explicitly on the review. */}
                                {it.lines.some((l) => l.kind === "perquisite") && (
                                  <div className="mt-2 space-y-1 border-t pt-2">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Taxable perquisites (not paid in cash)</p>
                                    {it.lines.filter((l) => l.kind === "perquisite").map((l, i) => (
                                      <div key={i} className="flex justify-between text-xs">
                                        <span>{l.name}</span>
                                        <span className="tabular-nums">{money(l.amount)}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {/* Employer's own cost for the period: paid by the company, not to the employee, so
                                    it sits apart from the pay lines. A contribution the org keeps outside CTC is
                                    labelled and left out of the cost-to-company subtotal, mirroring the payslip. */}
                                {it.lines.some((l) => l.kind === "employer_contribution") && (
                                  <div className="mt-2 space-y-1 border-t pt-2">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Employer contributions (not paid to the employee)</p>
                                    {it.lines.filter((l) => l.kind === "employer_contribution").map((l, i) => (
                                      <div key={i} className="flex justify-between text-xs text-brand-blue-700 dark:text-brand-blue-300">
                                        <span>{l.name}{l.above_ctc ? " (over & above CTC)" : ""}</span>
                                        <span className="tabular-nums">{money(l.amount)}</span>
                                      </div>
                                    ))}
                                    <div className="flex justify-between text-xs font-semibold">
                                      <span>Cost to company{it.above_ctc_cost ? " (CTC)" : ""}</span>
                                      <span className="tabular-nums">{money(it.gross + it.employer_cost)}</span>
                                    </div>
                                    {it.above_ctc_cost > 0 && (
                                      <div className="flex justify-between text-xs font-semibold">
                                        <span>Total company cost</span>
                                        <span className="tabular-nums">{money(it.gross + it.employer_cost + it.above_ctc_cost)}</span>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="px-2 py-2">{items.length} employee{items.length === 1 ? "" : "s"}</td>
                    <td data-label="Gross" className="px-2 py-2 text-right tabular-nums">{money(totals.gross)}</td>
                    <td data-label="Deductions" className="px-2 py-2 text-right tabular-nums">{money(totals.total_deductions)}</td>
                    <td data-label="Tax (TDS)" className="px-2 py-2 text-right tabular-nums">{money(totals.tax)}</td>
                    <td data-label="Net" className="px-2 py-2 text-right tabular-nums">{money(totals.net)}</td>
                    {compare && (
                      <td data-label={`vs ${compare.label}`} className="px-2 py-2 text-right tabular-nums">
                        {(() => {
                          // Only employees present in BOTH runs: a joiner's whole salary is not a "change" in
                          // the payroll, and lumping them in makes every month look like a big movement.
                          const both = items.filter((it) => compare.net.has(it.employee));
                          const d = round2(both.reduce((s, it) => s + it.net - compare.net.get(it.employee)!, 0));
                          if (Math.abs(d) < 0.01) return <span className="text-muted-foreground">-</span>;
                          return <span className={d > 0 ? "text-success" : "text-destructive"}>{d > 0 ? "+" : "−"}{money(Math.abs(d))}</span>;
                        })()}
                      </td>
                    )}
                    <td className="px-2 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
            {/* Where the money in this run goes. A pie is right for exactly this shape and almost nothing
                else: the slices are the parts of ONE whole (what the run costs), they add to it exactly, and
                there are four of them. The numbers themselves stay in the table above - this is the ratio. */}
            {totals.gross > 0 && (
              <div className="mt-4 border-t pt-4">
                <p className="mb-3 text-sm font-medium">Where this run goes</p>
                <Chart
                  type="pie"
                  height={220}
                  labels={["Take-home", "Tax (TDS)", "Other deductions", "Employer contributions"]}
                  datasets={[{
                    name: "Cost",
                    values: [
                      round2(totals.net),
                      round2(totals.tax),
                      round2(Math.max(0, totals.total_deductions - totals.tax)),
                      round2(totals.employer_cost + totals.above_ctc_cost),
                    ],
                  }]}
                  format={(v) => money(v)}
                  ariaLabel="How this payroll run's cost divides between take-home pay, tax, other deductions and employer contributions"
                  // Deliberately not a filter. Each slice is a COMPONENT of every line's cost, not a group
                  // of lines: every payslip in the run contributes to all four, so "show me the take-home
                  // slice" is the whole table. See `everyChart.spec.ts`'s exemption list.
                />
              </div>
            )}

            {/* What the run costs the company: gross + the employer contributions that count inside CTC, plus any
                the org keeps over and above CTC (employer PF under a "CTC + PF" policy). */}
            {(totals.employer_cost > 0 || totals.above_ctc_cost > 0) && (
              <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
                <span>Employer contributions <span className="font-medium tabular-nums text-foreground">{money(totals.employer_cost)}</span></span>
                {totals.above_ctc_cost > 0 && <span>Over &amp; above CTC <span className="font-medium tabular-nums text-foreground">{money(totals.above_ctc_cost)}</span></span>}
                <span>Cost to company <span className="font-semibold tabular-nums text-foreground">{money(totals.gross + totals.employer_cost + totals.above_ctc_cost)}</span></span>
              </div>
            )}
            </div>
          )}
          {/* The run's own trail says it was created, built, approved, published. The case says what it PAID:
              every bonus, encashment, overtime claim, reimbursement, retro-arrears revision and loan it
              settled - each with the approval that authorised the money, which no payslip links back to. */}
          {reviewRun && <ActivitySection resource={reviewRun.path} className="border-t pt-3" label="Changes to this run" />}
          {reviewRun && <ActivitySection caseRoot={reviewRun.path} label="What this run paid, and who approved it" />}
          </DialogBody>
          </AccessScope>
        </DialogContent>
      </Dialog>

      {/* Draft payslip viewer (pre-publish check) - nothing is persisted server-side. */}
      <PdfPreviewDialog source={slipPreview} onClose={() => setSlipPreview(null)} />
    </div>
  );
}
