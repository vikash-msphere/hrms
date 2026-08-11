import { Fragment, useEffect, useMemo, useState } from "react";
import { PlayCircle, Plus, Hammer, Send, CheckCircle2, Rocket, Loader2, FileSpreadsheet, Trash2, Eye, ChevronRight, AlertTriangle } from "lucide-react";
import { api, get, create, invoke, download, remove } from "@/api";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { idOf, formatMoney } from "@/lib/utils";
import { navigate } from "@/router";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { BankFormat, Me, Operation, PayPeriod, PayrollRun, PayrollRunItem } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { AccessTab } from "@/components/common/AccessTab";
import { ActivityBadge } from "@/components/common/ActivityBadge";
import { useTabActivity, markTabSeen } from "@/lib/tabActivity";
import { DataState } from "@/components/common/DataState";
import { ActivitySection } from "@/components/common/ActivitySection";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { metaColumns } from "@/components/common/metaColumns";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Field, FieldRow } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccessAction } from "@/components/access/AccessAction";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { useToast } from "@/components/ui/use-toast";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";
import { useConfirm } from "@/components/common/confirm";
import PayPeriods from "@/pages/PayPeriods";
import { PayrollBonuses } from "@/components/common/PayrollBonuses";

type Verb = "build" | "submit" | "approve" | "publish";
const NEXT: Record<string, { verb: Verb; label: string; icon: typeof Hammer; variant?: "success" }[]> = {
  DRAFT: [
    { verb: "build", label: "Build", icon: Hammer },
    { verb: "submit", label: "Submit", icon: Send },
  ],
  REVIEW: [{ verb: "approve", label: "Approve", icon: CheckCircle2, variant: "success" }],
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
function defaultMonth(): { y: number; m: number } {
  const now = new Date();
  const offset = now.getUTCDate() <= 10 ? -1 : 0; // first ~third of the month -> previous month
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}

// Does a pay period fall in calendar month (y, m)? Matched on its start date.
function isMonth(period: PayPeriod, y: number, m: number): boolean {
  const d = new Date(period.period_start);
  return d.getUTCFullYear() === y && d.getUTCMonth() === m;
}

export default function PayrollRuns({ me, tab }: { me: Me; tab?: string }) {
  const isSuperAdmin = me.role === "super_admin";
  const { rows, state, error, reload } = useCollection<PayrollRun>("payroll-runs");
  const { rows: periods, reload: reloadPeriods } = useCollection<PayPeriod>("pay-periods");
  // A quick monthly run creates the period AND the run in one go, so it needs both rights. Only super_admin
  // holds both (HR defines periods, payroll runs them) - so this convenience is, by design, super-only.
  const canQuick = usePermission("pay-periods.write") && usePermission("payroll-runs.write");
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));

  // Per-employee breakdown review (opened from a run row).
  const [reviewRun, setReviewRun] = useState<PayrollRun | null>(null);
  const [items, setItems] = useState<PayrollRunItem[] | null>(null);
  type SplitDrift = { stale: string[]; skipped: string[] };
  const [reviewStale, setReviewStale] = useState<{ stale: boolean; changes: string[]; split_drift?: SplitDrift } | null>(null);
  // Re-apply machinery for the split-drift warning below (prompt-only; the banner here is the surface).
  const { canReapply, reapplying, reapply: doReapply } = useSplitStaleness({ auto: false });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [itemQuery, setItemQuery] = useState("");
  // Fetch the run DETAIL (carries staleness: inputs changed since the last build) + the per-employee breakdown.
  // The detail response has a fresh etag, so it's stored as reviewRun and drives an in-place rebuild.
  type RunDetail = PayrollRun & { stale?: boolean; changes?: string[]; built_time?: string | null; split_drift?: SplitDrift };
  async function openReview(run: PayrollRun) {
    setReviewRun(run);
    setItems(null);
    setReviewStale(null);
    setExpanded(new Set());
    setItemQuery("");
    try {
      const [detail, r] = await Promise.all([
        get<RunDetail>("payroll-runs/" + idOf(run.path)),
        get<{ results: PayrollRunItem[] }>("payroll-runs/" + idOf(run.path) + "/items"),
      ]);
      setReviewRun(detail);
      setReviewStale({ stale: !!detail.stale, changes: detail.changes ?? [], split_drift: detail.split_drift });
      setItems(r.results ?? []);
    } catch (e) {
      setItems([]);
      toast({ title: "Couldn't load breakdown", description: (e as Error).message, variant: "destructive" });
    }
  }
  // Rebuild in place from the review dialog: recompute lines from current inputs, then refresh the breakdown +
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
      toast({ title: "Couldn't rebuild the run", description: (e as Error).message, variant: "destructive" });
    } finally {
      setActing(null);
    }
  }
  // Split drift needs BOTH steps and in this order: re-apply re-solves each employee's basic / Special Allowance
  // from their (unchanged) annual CTC, then the rebuild re-prices the run off the corrected rows. Re-applying
  // alone would leave the run's stored items on the old numbers.
  async function reapplyAndRebuild() {
    await doReapply();
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
  // The bank file is super-admin-only (it exposes every employee's account number), so only super needs the
  // list of configured banks to populate the per-bank download menu.
  const [banks, setBanks] = useState<string[]>([]);
  useEffect(() => {
    if (!isSuperAdmin) return;
    let live = true;
    get<{ results: BankFormat[] }>("bank-formats")
      .then((r) => live && setBanks((r.results ?? []).map((f) => f.bank).filter(Boolean) as string[]))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isSuperAdmin]);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [publishing, setPublishing] = useState<string | null>(null);

  // Quick monthly run: pick a month (smart default), prefilled editable period + run created together.
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickYM, setQuickYM] = useState<{ y: number; m: number }>(defaultMonth);
  const [quickForm, setQuickForm] = useState(() => monthDefaults(defaultMonth().y, defaultMonth().m));
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
      toast({ title: "Couldn't create monthly run", description: (e as Error).message, variant: "destructive" });
    } finally {
      setQuickBusy(false);
    }
  }

  const periodName = useMemo(() => {
    const m = new Map(periods.map((p) => [idOf(p.path), p.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [periods]);

  async function createRun() {
    try {
      await create("payroll-runs", { pay_period: selected });
      toast({ title: "Payroll run created", variant: "success" });
      setSelected("");
      setOpen(false);
      reload();
    } catch (e) {
      toast({ title: "Couldn't create run", description: (e as Error).message, variant: "destructive" });
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
        if (op?.path) pollOperation(op.path);
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
      toast({ title: `Couldn't ${verb} the run`, description: (e as Error).message, variant: "destructive" });
    } finally {
      setActing(null);
    }
  }

  const columns: Column<PayrollRun>[] = [
    { id: "period", header: "Pay period", filter: "select", accessor: (r) => periodName(r.pay_period), cell: (r) => <span className="font-medium">{periodName(r.pay_period)}</span> },
    { id: "state", header: "State", filter: "select", accessor: (r) => r.state, cell: (r) => <StatusBadge state={r.state} /> },
    { id: "submitted_by", header: "Submitted by", defaultHidden: true, accessor: (r) => r.submitted_by_name ?? (r.submitted_by ? idOf(r.submitted_by) : ""), cell: (r) => r.submitted_by_name ?? (r.submitted_by ? idOf(r.submitted_by) : "-") },
    { id: "approved_by", header: "Approved by", defaultHidden: true, accessor: (r) => r.approved_by_name ?? (r.approved_by ? idOf(r.approved_by) : ""), cell: (r) => r.approved_by_name ?? (r.approved_by ? idOf(r.approved_by) : "-") },
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
        // Approval is restricted to super admins (also enforced server-side).
        const steps = (NEXT[run.state?.toUpperCase()] ?? []).filter((s) => s.verb !== "approve" || isSuperAdmin);
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
          ...(canDelete ? [{ label: "Delete run", icon: <Trash2 className="h-4 w-4" />, onClick: () => removeRun(run), destructive: true, verb: "delete" }] : []),
        ];
        return <RowActions actions={actions} objectPath={run.path} can={run.access?.can} />;
      },
    },
  ];

  const quickRunBtn = canQuick ? (
    <Button variant="outline" onClick={openQuick}><Rocket className="h-4 w-4" /> Quick monthly run</Button>
  ) : null;
  const newRunBtn = (
    <AccessAction collection="payroll-runs" create label="New run">
      <Button onClick={() => setOpen(true)} disabled={periods.length === 0}><Plus className="h-4 w-4" /> New run</Button>
    </AccessAction>
  );
  const runActions = (
    <>
      {quickRunBtn}
      {newRunBtn}
    </>
  );

  const activeTab = ["periods", "bonuses"].includes(tab ?? "") ? tab! : "runs";
  // "New since last looked" counts per sub-tab; the tab you're on is suppressed and marked seen.
  const activity = useTabActivity([
    { key: "payroll-runs:runs", collection: "payroll-runs" },
    { key: "payroll-runs:periods", collection: "pay-periods" },
    { key: "payroll-runs:bonuses", collection: "bonuses" },
  ]);
  useEffect(() => {
    markTabSeen(`payroll-runs:${activeTab}`);
  }, [activeTab]);
  const tabBadge = (t: string) => (activeTab === t ? 0 : activity[`payroll-runs:${t}`] ?? 0);

  return (
    <div>
      <Tabs value={activeTab} onValueChange={(v) => navigate(`payroll-runs/${v}`)}>
        <TabsList variant="underline">
          <AccessTab value="runs" target={{ collection: "payroll-runs", label: "Payroll Runs" }}>Runs<ActivityBadge count={tabBadge("runs")} /></AccessTab>
          <AccessTab value="periods" target={{ collection: "pay-periods", label: "Pay periods" }}>Pay periods<ActivityBadge count={tabBadge("periods")} /></AccessTab>
          <AccessTab value="bonuses" target={{ collection: "bonuses", label: "Bonuses" }}>Bonuses<ActivityBadge count={tabBadge("bonuses")} /></AccessTab>
        </TabsList>

        <TabsContent value="runs">
          <PageHeader title="Payroll" description="Build, review and publish payroll." actions={<>{runActions}<PageSettings me={me} host="payroll-runs" /></>} />
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
          <PayPeriods />
        </TabsContent>

        <TabsContent value="bonuses">
          <PayrollBonuses />
        </TabsContent>
      </Tabs>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New payroll run</DialogTitle>
          </DialogHeader>
          <Field label="Pay period">
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger><SelectValue placeholder="Select a pay period…" /></SelectTrigger>
              <SelectContent>
                {periods.filter((p) => !p.disabled).map((p) => (
                  <SelectItem key={p.path} value={`pay-periods/${idOf(p.path)}`}>{p.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={createRun} disabled={!selected}>Create run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={quickOpen} onOpenChange={setQuickOpen}>
        <DialogContent onEnterSubmit={() => { if (!quickBusy && (quickExisting || (quickForm.display_name.trim() && quickForm.period_start && quickForm.period_end >= quickForm.period_start && quickForm.pay_date))) void createQuickRun(); }}>
          <DialogHeader>
            <DialogTitle>Quick monthly run</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Pick a month and start a draft run. Defaulted to {defaultMonth().m === new Date().getUTCMonth() ? "this month" : "last month"} based on today.</p>
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
            <p className="text-sm text-muted-foreground">A pay period already exists for this month - the run will use it ({quickExisting.period_start} to {quickExisting.period_end}, pay {quickExisting.pay_date}).</p>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuickOpen(false)}>Cancel</Button>
            <Button onClick={createQuickRun} loading={quickBusy} disabled={!quickExisting && (!quickForm.display_name.trim() || !quickForm.period_start || !quickForm.period_end || !quickForm.pay_date)}>
              Create run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-employee breakdown - the review surface */}
      <Dialog open={!!reviewRun} onOpenChange={(o) => !o && setReviewRun(null)}>
        <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Payroll breakdown · {periodName(reviewRun?.pay_period)}</DialogTitle>
          </DialogHeader>
          {reviewStale?.stale && (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
              <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
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
          {/* Split drift: the run priced a CACHED basic / Special Allowance that the current pay-component setup no
              longer produces, so these people's gross doesn't reconcile to the CTC they were promised. Invisible to
              the staleness check above (that only sees inputs touched AFTER the build; this usually predates it).
              A warning, not a block - paying the contracted stored split can be deliberate. */}
          {reviewStale?.split_drift?.stale?.length ? (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
              <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
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
          {items === null ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No lines yet. Build the run to compute payroll, then review it here.</p>
          ) : (
            <div className="flex min-h-0 flex-col gap-2">
              {items.length > 8 && (
                <Input placeholder="Find an employee…" value={itemQuery} onChange={(e) => setItemQuery(e.target.value)} className="max-w-xs" />
              )}
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b text-left">
                    <th className="px-2 py-2 font-semibold">Employee</th>
                    <th className="px-2 py-2 text-right font-semibold">Gross</th>
                    <th className="px-2 py-2 text-right font-semibold">Deductions</th>
                    <th className="px-2 py-2 text-right font-semibold">Tax (TDS)</th>
                    <th className="px-2 py-2 text-right font-semibold">Net</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {items.filter((it) => !itemQuery.trim() || it.employee_name.toLowerCase().includes(itemQuery.trim().toLowerCase())).map((it) => {
                    const open = expanded.has(it.employee);
                    return (
                      <Fragment key={it.employee}>
                        <tr className="cursor-pointer border-b hover:bg-accent/40" onClick={() => setExpanded((s) => { const n = new Set(s); n.has(it.employee) ? n.delete(it.employee) : n.add(it.employee); return n; })}>
                          <td className="px-2 py-1.5 font-medium"><span className="inline-flex items-center gap-1"><ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} /> {it.employee_name}</span></td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{money(it.gross)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{money(it.total_deductions)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{money(it.tax)}</td>
                          <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{money(it.net)}</td>
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
                            <td colSpan={6} className="px-6 py-2">
                              <div className="space-y-1">
                                {/* Pay lines: earnings (loss of pay rides here as a negative earning - it is pay
                                    that was never earned, so it leaves gross and every tax/statutory base) and
                                    deductions. */}
                                {it.lines.filter((l) => l.kind === "earning" || l.kind === "deduction").map((l, i) => (
                                  <div key={i} className="flex justify-between text-xs">
                                    <span className={l.kind === "deduction" ? "text-destructive" : ""}>{l.name}{l.kind === "earning" && l.taxable === false ? " (non-taxable)" : ""}</span>
                                    <span className="tabular-nums">{l.kind === "deduction" ? "-" : ""}{money(l.amount)}</span>
                                  </div>
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
                                      <div key={i} className="flex justify-between text-xs text-blue-700 dark:text-blue-400">
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
                    <td className="px-2 py-2 text-right tabular-nums">{money(totals.gross)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(totals.total_deductions)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(totals.tax)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(totals.net)}</td>
                    <td className="px-2 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
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
          {reviewRun && <ActivitySection resource={reviewRun.path} className="border-t pt-3" />}
        </DialogContent>
      </Dialog>

      {/* Draft payslip viewer (pre-publish check) - nothing is persisted server-side. */}
      <PdfPreviewDialog source={slipPreview} onClose={() => setSlipPreview(null)} />
    </div>
  );
}
