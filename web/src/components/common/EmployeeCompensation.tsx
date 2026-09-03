import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { TrendingUp, Plus, Wallet, Building2, ArrowUpRight, ArrowDownRight, Pencil, Trash2 } from "lucide-react";
import { get, create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatMoney, cn, idOf, round2 as r2 } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Compensation, PayComponent, PayGrade, SalaryStructure, Bonus } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { DetailSkeleton } from "@/components/common/Skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { useConfirm } from "@/components/common/confirm";
import { RowActivityButton } from "@/components/common/RowActivityButton";
import { AccessScope } from "@/components/access/AccessScope";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";
import { getSetting } from "@/lib/settingsStore";

const BAND_LABEL: Record<NonNullable<Compensation["band_status"]>, string> = { below: "Below band", in_band: "In band", above: "Above band" };
const BAND_VARIANT: Record<NonNullable<Compensation["band_status"]>, "secondary" | "success" | "warning"> = { below: "warning", in_band: "success", above: "warning" };
// Compact "in band · 0.96×" indicator for a compensation row that has a grade with a band.
function BandBadge({ row }: { row: Compensation }) {
  if (!row.band_status) return null;
  return (
    <Badge variant={BAND_VARIANT[row.band_status]} className="gap-1">
      {BAND_LABEL[row.band_status]}
      {row.compa_ratio != null && <span className="tabular-nums opacity-80">· {row.compa_ratio.toFixed(2)}×</span>}
    </Badge>
  );
}

const todayYmd = () => new Date().toISOString().slice(0, 10);
// Monthly value of a recurring earning component against a given base (mirrors the server's payroll/ctc math).
const monthlyOf = (c: PayComponent, basic: number) =>
  c.method === "fixed" ? c.rate ?? 0 : c.method === "percent_base" ? basic * ((c.rate ?? 0) / 100) : 0;

// Monthly value of any component dispatched purely by method, matching the server domain/payroll componentMonthly:
// percent_base sits on basic, the PF family (epf + the employer's EDLI / administration charges) on PF wages
// capped at the ceiling, esi on gross while within the ceiling (rounded up per ESIC), fixed a flat amount. Used
// for the employer-contribution CTC build-up so nothing is hardcoded.
const ctcCompMonthly = (c: PayComponent, basic: number, gross: number, pfWages = basic) =>
  c.method === "fixed" ? c.rate ?? 0
    : c.method === "percent_base" ? basic * ((c.rate ?? 0) / 100)
    : c.method === "epf" ? Math.min(pfWages, c.cap ?? Infinity) * ((c.rate ?? 12) / 100)
    : c.method === "edli" || c.method === "pf_admin" ? Math.min(pfWages, c.cap ?? Infinity) * ((c.rate ?? 0.5) / 100)
    : c.method === "esi" ? (gross <= 0 || gross > (c.cap ?? 21000) ? 0 : Math.ceil(gross * ((c.rate ?? 0) / 100)))
    : 0;

// The PF family: all three are opt-in on the employee's PF membership and priced on PF wages.
const PF_METHODS = ["epf", "edli", "pf_admin"];

// PF wages, mirroring the server pfWagesOf: basic only under the default basis, or basic + the Special Allowance
// plug + every earning HR flagged `pf_wages` under "basic_plus" (settings/ctc pf_wage_basis).
const pfWagesOf = (basic: number, special: number, earningComps: PayComponent[], basis: string) =>
  basis !== "basic_plus" ? r2(basic) : r2(basic + special + earningComps.filter((c) => c.pf_wages).reduce((s, c) => s + monthlyOf(c, basic), 0));

// Salary history + a salary/CTC breakdown (earnings, deductions incl. EPF, employer PF, net & CTC), and a
// "Revise / give increment" action. Payroll/super only (gated by the caller). `epfEnrolled` comes from the
// employee record (EPF is opt-in) so the breakdown includes PF only for enrolled employees, matching payroll
// + the CTC letters.
export default function EmployeeCompensation({ employeeId, canEdit, epfEnrolled = false }: { employeeId: string; canEdit: boolean; epfEnrolled?: boolean }) {
  const { toast } = useToast();
  const { org } = useOrg();
  const money = (n: number, cc?: string) => formatMoney(n, cc || org.default_currency, currencyDecimals(cc, org));
  const { rows: payComponents } = useCollection<PayComponent>("pay-components");
  const { rows: payGrades } = useCollection<PayGrade>("pay-grades");
  const { rows: structures } = useCollection<SalaryStructure>("salary-structures");
  // Re-apply machinery (payroll/super only) so the stale-split warning below can be acted on from here, rather
  // than only from the Pay components / CTC provisions panels where the change was originally made.
  const { canReapply, reapplying, reapply: doReapply } = useSplitStaleness({ auto: false });
  const [rows, setRows] = useState<Compensation[]>([]);
  const [bonuses, setBonuses] = useState<Bonus[]>([]);
  // Projected monthly TDS from the tax endpoint (best-effort; absent grant / not configured = null) so the
  // card can show an after-tax take-home estimate next to the contractual pre-tax figure.
  const [monthlyTds, setMonthlyTds] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  // Set while the dialog is CORRECTING an existing revision rather than adding one. Both write the same five
  // fields, so they share one form; only the verb, the copy and the date bounds differ.
  const [editing, setEditing] = useState<Compensation | null>(null);
  const [form, setForm] = useState({ ctc: "", effective_from: todayYmd(), pay_grade: "", salary_structure: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();
  const guard = useDialogGuard(open, form, () => { setOpen(false); setEditing(null); }, { label: editing ? "correction" : "revision" });
  // Monthly/annual display toggle for the breakdown figures (annual = ×12); CTC is stored annual.
  const [unit, setUnit] = useState<"monthly" | "annual">("monthly");
  const mult = unit === "annual" ? 12 : 1;
  // The top-down split ratio: basic = basic_pct% of monthly CTC. The employer contributions that lift gross to
  // CTC are data (employer_contribution pay components), not config - including which side of CTC each sits on
  // (their own `in_ctc`), so nothing about gratuity/PF/ESI is configured or hardcoded here.
  const [ctcCfg, setCtcCfg] = useState<{ basic_pct: number; pf_wage_basis?: string }>({ basic_pct: 50, pf_wage_basis: "basic" });
  useEffect(() => {
    getSetting<Partial<typeof ctcCfg>>("ctc").then((s) => { if (s.value) setCtcCfg((p) => ({ ...p, ...s.value })); }).catch(() => {});
  }, []);

  async function load() {
    try {
      const r = await get<{ results: Compensation[] }>(`compensation?employee=${encodeURIComponent("employees/" + employeeId)}`);
      setRows(r.results ?? []);
      // Bonuses fold the year's variable pay into the total-compensation view (best-effort; absent grant = none).
      try { const b = await get<{ results: Bonus[] }>(`bonuses?employee=${encodeURIComponent("employees/" + employeeId)}`); setBonuses(b.results ?? []); } catch { setBonuses([]); }
      try { const t = await get<{ tds_configured?: boolean; monthly_tds?: number }>(`employees/${employeeId}/tax`); setMonthlyTds(t.monthly_tds && t.monthly_tds > 0 ? t.monthly_tds : null); } catch { setMonthlyTds(null); }
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't load compensation", description: (e as Error).message });
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void load();
  }, [employeeId]);

  const current = rows.find((r) => r.current);
  const cc = current?.currency_code;

  // Derived salary breakdown, per the standard Indian structure: the stored base pay is the contractual
  // BASIC. Gross = basic + earning components; employee EPF (on basic) and other deductions come out of gross
  // for take-home; the employer's matching PF sits ON TOP of gross (cost to company, never withheld from pay).
  // Mirrors the server's payroll + CTC-letter math.
  // Earnings honour the employee's assigned salary structure (if any): only its components apply, each at the
  // structure's rate override when set. Shared by the breakdown and the top-down (CTC-in) split preview, so
  // both resolve the exact same earning set the server does.
  const earningCompsFor = useCallback((structurePath?: string) => {
    const comps = payComponents.filter((c) => c.recurring && !c.disabled && c.kind === "earning");
    const struct = structurePath ? structures.find((s) => s.path === structurePath) : undefined;
    if (!struct) return comps;
    const byComp = new Map((struct.lines ?? []).map((l) => [idOf(l.component), l]));
    return comps
      .filter((c) => byComp.has(idOf(c.path)))
      .map((c) => { const ov = byComp.get(idOf(c.path)); return ov?.rate != null ? { ...c, rate: ov.rate } : c; });
  }, [payComponents, structures]);

  const breakdown = useMemo(() => {
    const basic = current?.base_pay ?? 0;
    const pcs = payComponents.filter((c) => c.recurring && !c.disabled);
    const earningComps = earningCompsFor(current?.salary_structure);
    const earnings = earningComps.map((c) => ({ name: c.display_name, amount: r2(monthlyOf(c, basic)) })).filter((l) => l.amount > 0);
    // Special Allowance: the balancing plug of a top-down (CTC-in) row. A taxable fixed earning, so it rides
    // in gross exactly like any other allowance. 0 for basic-in rows, so nothing shows.
    const special = current?.special_allowance ?? 0;
    if (special > 0) earnings.push({ name: "Special Allowance", amount: r2(special) });
    const otherDeductions = pcs
      .filter((c) => c.kind === "deduction" && c.method !== "epf" && c.method !== "income_tax")
      .map((c) => ({ name: c.display_name, amount: r2(monthlyOf(c, basic)) }))
      .filter((l) => l.amount > 0);
    const epf = pcs.find((c) => c.method === "epf" && c.kind === "deduction");
    const enrolled = !!epf && epfEnrolled; // the employee-side PF DEDUCTION applies (needs that component)
    // PF wages per the org's configured basis (basic, or basic + the flagged allowances).
    const pfWages = pfWagesOf(basic, special, earningComps, ctcCfg.pf_wage_basis ?? "basic");
    // Employee EPF share = rate% of PF wages up to the wage ceiling (a payslip deduction). Employer provisions
    // (matching PF, EDLI/admin charges, ESI, gratuity) are the CTC build-up itemised below.
    const epfShare = enrolled && epf ? r2(Math.min(pfWages, epf.cap ?? Infinity) * ((epf.rate ?? 12) / 100)) : 0;
    const hasTds = pcs.some((c) => c.method === "income_tax");
    const earningsTotal = earnings.reduce((s, l) => s + l.amount, 0);
    const grossEarnings = r2(basic + earningsTotal);
    const totalDeductions = r2(epfShare + otherDeductions.reduce((s, l) => s + l.amount, 0));
    // CTC build-up: every employer_contribution component (matching PF, ESI while eligible, gratuity, or
    // anything HR adds), each by its own method. These sit ABOVE gross and account for the CTC-minus-gross gap,
    // so gross + these = the stored annual CTC / 12. PF (method epf) is skipped when the employee opted out.
    // Fully data-driven - mirrors the server ctcLines, nothing about specific provisions hardcoded here.
    // `aboveCtc`: employer PF sits over and above CTC when the org opts out of counting it in - shown as a
    // line but excluded from the CTC total, mirroring the server ctcLines.
    const employerContribs = pcs
      // The employer side gates on the employee's ENROLMENT only - exactly as the server's employerCostLines
      // does - not on an employee-side deduction component existing. An org can run employer PF without one.
      .filter((c) => c.kind === "employer_contribution" && !(PF_METHODS.includes(c.method) && !epfEnrolled))
      .map((c) => ({ name: c.display_name, amount: r2(ctcCompMonthly(c, basic, grossEarnings, pfWages)), aboveCtc: c.in_ctc === false }))
      .filter((l) => l.amount > 0);
    const ctcMonthly = r2(grossEarnings + employerContribs.reduce((s, l) => s + (l.aboveCtc ? 0 : l.amount), 0));
    return {
      basic, earnings, otherDeductions, epf, enrolled, epfShare, hasTds, grossEarnings, totalDeductions,
      netMonthly: r2(grossEarnings - totalDeductions),
      employerContribs, ctcMonthly,
      // The employer's PF match is a pay component like any other, so it is absent from CTC until one exists.
      // Enrolled with no such component = say so, rather than quietly leaving the match out of the CTC.
      missingEmployerPf: epfEnrolled && !pcs.some((c) => c.kind === "employer_contribution" && c.method === "epf"),
      pfWages,
    };
  }, [current, payComponents, earningCompsFor, epfEnrolled, ctcCfg]);

  // Top-down (CTC-in) split preview: mirror the server `splitCtc` exactly - pin basic at ctcCfg.basic_pct% of
  // the monthly CTC, then bisect the balancing Special Allowance so the all-in CTC lands on the target. Same
  // employer-contribution math as the breakdown above, so the preview matches what the server will store.
  const splitPreview = useCallback((annualCtc: number, structurePath?: string) => {
    if (!(annualCtc > 0)) return null;
    const monthlyCtc = annualCtc / 12;
    const basic = r2(monthlyCtc * (ctcCfg.basic_pct / 100));
    const earningComps = earningCompsFor(structurePath);
    const pcs = payComponents.filter((c) => c.recurring && !c.disabled);
    // Employer PF applies on the employee's enrolment alone (server: employerCostLines), so the split solves the
    // same target the server will - no dependency on an employee-side deduction component existing.
    const employerComps = pcs.filter((c) => c.kind === "employer_contribution" && !(PF_METHODS.includes(c.method) && !epfEnrolled));
    const ctcOf = (special: number) => {
      const earn = earningComps.reduce((s, c) => s + monthlyOf(c, basic), 0) + special;
      const gross = r2(basic + earn);
      const pfWages = pfWagesOf(basic, special, earningComps, ctcCfg.pf_wage_basis ?? "basic");
      // Off-CTC employer PF ("CTC + PF") is excluded from the target the split solves - it rides on top.
      const employer = employerComps.reduce((s, c) => s + (c.in_ctc === false ? 0 : r2(ctcCompMonthly(c, basic, gross, pfWages))), 0);
      return r2(gross + employer);
    };
    if (ctcOf(0) > monthlyCtc + 0.5) return null; // infeasible: committed cost already exceeds the target
    let lo = 0, hi = monthlyCtc;
    for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (ctcOf(mid) < monthlyCtc) lo = mid; else hi = mid; }
    return { basic, special: r2((lo + hi) / 2), monthlyCtc: r2(monthlyCtc) };
  }, [payComponents, earningCompsFor, epfEnrolled, ctcCfg]);

  // The stored split vs a FRESH solve under the current catalog. basic + Special Allowance are CACHED on the
  // compensation row when it is saved, so anything changed afterwards - a contribution added, its CTC side
  // flipped, the employee's EPF enrolment toggled, a rate edited - leaves those cached figures describing the
  // OLD setup. The visible symptom is exactly this: the build-up no longer reconciles to the promised CTC (an
  // employer contribution appears to ride on top of it). Same solver the server re-applies with, so a warning
  // here means a re-apply really would change this row.
  const staleSplit = useMemo(() => {
    if (!current || !(current.annual_ctc > 0) || !payComponents.length) return null;
    const fresh = splitPreview(current.annual_ctc, current.salary_structure);
    if (!fresh) return null; // infeasible now - the org-wide banner reports these as "skipped"
    const drift = Math.abs(fresh.basic - (current.base_pay ?? 0)) + Math.abs(fresh.special - (current.special_allowance ?? 0));
    return drift > 1 ? fresh : null; // > ₹1: bisection converges to within a rupee, so ignore solver noise
  }, [current, payComponents, splitPreview]);

  // Variable pay = bonuses awarded in the current financial year (Apr–Mar). Annual actuals, so they fold into
  // a "total compensation" figure on top of the annualised fixed CTC (not into the monthly numbers).
  const variableFy = useMemo(() => {
    const now = new Date();
    const fyStartYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // FY starts in April
    const start = `${fyStartYear}-04-01`, end = `${fyStartYear + 1}-03-31`;
    const total = bonuses.filter((b) => b.award_date >= start && b.award_date <= end).reduce((s, b) => s + (b.amount || 0), 0);
    return { total: r2(total), label: `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}` };
  }, [bonuses]);

  // Revision-over-revision change: each history row's % change in annual CTC vs the row it superseded (by
  // effective date), for the ↑/↓ chips in the history table. Keyed by row path; the oldest row has no predecessor.
  const deltaByPath = useMemo(() => {
    const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    const out = new Map<string, number>();
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!.annual_ctc;
      if (prev > 0) out.set(sorted[i]!.path, ((sorted[i]!.annual_ctc - prev) / prev) * 100);
    }
    return out;
  }, [rows]);

  // Saveable when the CTC is positive, dated, and actually solvable against the chosen structure - the same
  // three conditions the footer and the Enter key both need, so they read it from one place.
  const canSave = !busy && !!form.effective_from && Number(form.ctc) > 0 && !!splitPreview(Number(form.ctc), form.salary_structure || undefined);

  // The revisions on either side of `row` in the timeline (`rows` is newest first). A correction may move a
  // date only BETWEEN these two - past a neighbour it would silently re-order which revision supersedes which
  // - so they bound the date input, and the server enforces the same window.
  const neighbours = useCallback((row: Compensation) => {
    const asc = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    const i = asc.findIndex((r) => r.path === row.path);
    return { prev: i > 0 ? asc[i - 1] : undefined, next: i >= 0 && i < asc.length - 1 ? asc[i + 1] : undefined };
  }, [rows]);
  // Exclusive bounds as INCLUSIVE input attributes: the day after the previous revision, the day before the next.
  const dayShift = (ymd: string, days: number) => new Date(Date.parse(ymd + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
  const dateBounds = useMemo(() => {
    if (!editing) return {};
    const { prev, next } = neighbours(editing);
    return { min: prev ? dayShift(prev.effective_from, 1) : undefined, max: next ? dayShift(next.effective_from, -1) : undefined };
  }, [editing, neighbours]);

  // Live band feedback for the revise dialog: the selected grade's annual-CTC range + where the entered CTC
  // sits in it. Bands are guardrails, so this just informs - it never blocks saving.
  const selectedBand = useMemo(() => {
    const g = payGrades.find((x) => x.path === form.pay_grade);
    if (!g || (g.band_min == null && g.band_mid == null && g.band_max == null)) return undefined;
    const range = `Band ${g.band_min != null ? money(g.band_min, g.currency_code) : "·"} – ${g.band_mid != null ? money(g.band_mid, g.currency_code) : "·"} – ${g.band_max != null ? money(g.band_max, g.currency_code) : "·"}`;
    const ctc = form.ctc ? Number(form.ctc) : NaN;
    if (!Number.isFinite(ctc) || ctc <= 0) return range;
    let note = "in band";
    if (g.band_min != null && ctc < g.band_min) note = "below band";
    else if (g.band_max != null && ctc > g.band_max) note = "above band";
    const compa = g.band_mid ? ` · ${(ctc / g.band_mid).toFixed(2)}×` : "";
    return `${range} (${note}${compa})`;
  }, [payGrades, form.pay_grade, form.ctc]);

  const Row = ({ label, amount, kind, strong }: { label: ReactNode; amount?: number; kind?: "earning" | "deduction"; strong?: boolean }) => (
    <div className={cn("flex items-center justify-between py-1.5", strong && "border-t font-semibold")}>
      <span>{label}</span>
      <span className={cn("tabular-nums", kind === "deduction" && "text-destructive")}>
        {amount == null ? "" : (kind === "deduction" ? "−" : "") + money(amount * mult, cc)}
      </span>
    </div>
  );

  // Open the dialog to ADD a revision (prefilled from the current salary, as a raise usually starts there), or
  // to CORRECT `row` (prefilled from that row).
  function openDialog(row?: Compensation) {
    setEditing(row ?? null);
    setForm(row
      ? { ctc: String(row.annual_ctc), effective_from: row.effective_from, pay_grade: row.pay_grade ?? "", salary_structure: row.salary_structure ?? "" }
      : { ctc: current ? String(current.annual_ctc) : "", effective_from: todayYmd(), pay_grade: current?.pay_grade ?? "", salary_structure: current?.salary_structure ?? "" });
    setErr(null);
    setOpen(true);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // Comp is set as an annual CTC; the server derives the monthly basic + Special Allowance plug. A
      // correction sends the same fields to the row's own path, and the server re-solves the split (and the
      // arrears, unless they have already been paid out).
      const body = {
        annual_ctc: Math.round(Number(form.ctc) * 100) / 100,
        effective_from: form.effective_from,
        pay_grade: form.pay_grade.trim(),
        salary_structure: form.salary_structure.trim(),
      };
      if (editing) await patch(editing.path, body, editing.etag);
      else await create("compensation", { employee: "employees/" + employeeId, ...body });
      toast({ title: editing ? "Revision corrected" : "Compensation revised" });
      setOpen(false);
      setEditing(null);
      setForm({ ctc: "", effective_from: todayYmd(), pay_grade: "", salary_structure: "" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Removing a revision is not "delete a record": the preceding revision takes the window back and, for the
  // current row, becomes the salary again. Say which salary the employee ends up on, since that is the part
  // the caller has to be right about.
  async function removeRevision(row: Compensation) {
    const { prev } = neighbours(row);
    const ok = await confirm({
      title: `Remove the revision effective ${row.effective_from}?`,
      description: prev
        ? `The previous revision (${money(prev.annual_ctc, prev.currency_code)} from ${prev.effective_from}) takes over this period${row.current ? " and becomes the current salary again" : ""}. Payroll reprices any editable run that covered it.`
        : "This is the only revision on record, so the employee will be left with no compensation and payroll cannot price them until one is set.",
      confirmLabel: "Remove revision",
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove(row.path, row.etag);
      toast({ title: "Revision removed" });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't remove the revision", description: (e as Error).message });
    }
  }

  return (
    <Card className="sentry-mask">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="compensation" label="Compensation">
            <span className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" /> Compensation</span>
          </AccessAction>
        </CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 rounded-md border p-0.5">
            <Button size="sm" variant={unit === "monthly" ? "default" : "ghost"} className="h-7" onClick={() => setUnit("monthly")}>Monthly</Button>
            <Button size="sm" variant={unit === "annual" ? "default" : "ghost"} className="h-7" onClick={() => setUnit("annual")}>Annual</Button>
          </div>
          {canEdit && (
            <AccessAction collection="compensation" create label="Revise compensation">
              <Button size="sm" onClick={() => openDialog()}><Plus className="h-4 w-4" /> Revise</Button>
            </AccessAction>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <>
            <Skeleton className="mb-3 h-6 w-48 rounded-full" />
            <Skeleton className="mb-5 h-24 w-full rounded-lg" />
            <DetailSkeleton rows={5} />
          </>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No compensation on record.{canEdit ? " Use Revise to set the CTC." : ""}</p>
        ) : (
          <>
            {/* Grade / band / structure identity chips - the "where this pay sits" context, above the numbers. */}
            {(current?.pay_grade_name || current?.salary_structure_name) && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {current?.pay_grade_name && <Badge variant="secondary">Grade · {current.pay_grade_name}</Badge>}
                {current && <BandBadge row={current} />}
                {current?.salary_structure_name && <Badge variant="outline">Structure · {current.salary_structure_name}</Badge>}
              </div>
            )}

            {/* Hero: the two numbers that matter - what the employee costs, and what they take home. Gross
                sits between them and lives in the payslip below (in India it hugs CTC, so a card would just
                echo it). */}
            <div className="mb-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Building2 className="h-3.5 w-3.5" /> Cost to company</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{money((current?.annual_ctc ?? 0) / (unit === "annual" ? 1 : 12), cc)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">all-in: gross + employer PF/ESI/gratuity</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Wallet className="h-3.5 w-3.5" /> Net salary</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-primary">{money(breakdown.netMonthly * mult, cc)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {monthlyTds != null
                    ? <>≈ <span className="font-medium text-foreground">{money((breakdown.netMonthly - monthlyTds) * mult, cc)}</span> after TDS (projected)</>
                    : breakdown.hasTds ? "before income tax (TDS)" : "after deductions"}
                </p>
              </div>
            </div>

            {/* Stored-split warning: these figures were derived when the salary was saved, so a later change to the
                component catalog (or to this employee's EPF enrolment) leaves them describing the old setup - the
                build-up then reads as if a contribution sits on top of the promised CTC. Re-applying re-solves
                every current row against today's catalog, holding each annual CTC fixed. */}
            {staleSplit && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-800 dark:bg-amber-950/40">
                <span className="text-amber-800 dark:text-amber-200">
                  These figures were derived when this salary was saved and no longer match the current pay-component setup, so the build-up below
                  won't reconcile to the {money(current!.annual_ctc, cc)} CTC. Under today's setup the split is basic {money(staleSplit.basic, cc)} + Special
                  Allowance {money(staleSplit.special, cc)} per month.{canReapply ? "" : " Ask Payroll to re-apply the split."}
                </span>
                {canReapply && (
                  <AccessAction collection="compensation" verb="reapplySplit" label="re-apply the split">
                    <Button size="sm" onClick={async () => { await doReapply(); await load(); }} disabled={reapplying}>{reapplying ? "Re-applying…" : "Re-apply split"}</Button>
                  </AccessAction>
                )}
              </div>
            )}

            {/* Cost-to-company build-up: reconciles gross -> CTC via the employer_contribution components (matching
                PF, ESI while eligible, gratuity, or anything HR configures). Without this, the CTC hero and the
                payslip gross look like they disagree; here the gap is itemised so gross + contributions = CTC. */}
            {(breakdown.employerContribs.length > 0 || breakdown.missingEmployerPf) && (
              <div className="mb-6">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cost to company build-up ({unit})</p>
                {/* Enrolled in PF but no employer-PF component: the match is genuinely absent from CTC and payroll,
                    so name the gap and where to close it instead of showing a CTC that quietly omits it. */}
                {breakdown.missingEmployerPf && (
                  <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                    This employee is enrolled in EPF, but no <span className="font-medium">Employer PF</span> pay component exists - the employer's match is in neither this CTC nor payroll. Add one under Payroll - Pay components (kind: employer contribution, method: epf).
                  </p>
                )}
                <div className="text-sm">
                  <Row label="Gross salary" amount={breakdown.grossEarnings} />
                  {breakdown.employerContribs.filter((l) => !l.aboveCtc).map((l) => <Row key={l.name} label={l.name} amount={l.amount} kind="earning" />)}
                  <div className="mt-1 flex items-baseline justify-between border-t pt-2">
                    <span className="font-semibold">Cost to company</span>
                    <span className="text-lg font-bold tabular-nums">{money(breakdown.ctcMonthly * mult, cc)}</span>
                  </div>
                  {/* Over-and-above-CTC lines (employer PF when the org excludes it from CTC): shown for the full
                      cost-to-employer picture, but sit outside the CTC figure above - so they get their own
                      all-in total rather than being folded into the CTC the employee was promised. */}
                  {breakdown.employerContribs.filter((l) => l.aboveCtc).map((l) => <Row key={l.name} label={`${l.name} (over & above CTC)`} amount={l.amount} kind="earning" />)}
                  {breakdown.employerContribs.some((l) => l.aboveCtc) && (
                    <div className="mt-1 flex items-baseline justify-between border-t pt-2">
                      <span className="font-medium">Total company cost</span>
                      <span className="font-semibold tabular-nums">{money((breakdown.ctcMonthly + breakdown.employerContribs.filter((l) => l.aboveCtc).reduce((s, l) => s + l.amount, 0)) * mult, cc)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* The employee's payslip flow. Gross feeds this take-home view; the employer provisions above lift
                gross to the authoritative CTC hero. */}
            <div className="mb-6">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payslip preview ({unit})</p>
              <div className="text-sm">
                {/* Standard payslip layout: earnings and deductions side by side, net salary spanning below. */}
                <div className="grid gap-x-8 sm:grid-cols-2">
                  <div className="sm:border-r sm:pr-8">
                    <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Earnings</p>
                    <Row label="Basic" amount={breakdown.basic} kind="earning" />
                    {breakdown.earnings.map((l) => <Row key={l.name} label={l.name} amount={l.amount} kind="earning" />)}
                    <Row label="Gross salary" amount={breakdown.grossEarnings} strong />
                  </div>
                  <div>
                    <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Deductions</p>
                    {breakdown.epf && breakdown.enrolled && (
                      <Row label={`EPF (employee, ${breakdown.epf.rate ?? 12}% of basic${breakdown.epf.cap ? ` up to ${money(breakdown.epf.cap, cc)}` : ""})`} amount={breakdown.epfShare} kind="deduction" />
                    )}
                    {breakdown.epf && !breakdown.enrolled && (
                      <div className="flex items-center justify-between py-1.5 text-muted-foreground"><span>EPF</span><span>opted out</span></div>
                    )}
                    {breakdown.otherDeductions.map((l) => <Row key={l.name} label={l.name} amount={l.amount} kind="deduction" />)}
                    {breakdown.hasTds && (
                      <div className="flex items-center justify-between py-1.5">
                        <span>Income Tax{monthlyTds != null ? " (projected)" : ""}</span>
                        {monthlyTds != null
                          ? <span className="tabular-nums text-destructive">−{money(monthlyTds * mult, cc)}</span>
                          : <span className="text-xs text-muted-foreground">computed at payroll</span>}
                      </div>
                    )}
                    <Row label={`Total deductions${breakdown.hasTds && monthlyTds == null ? " (excl. TDS)" : ""}`} amount={breakdown.totalDeductions + (monthlyTds ?? 0)} kind="deduction" strong />
                  </div>
                </div>
                <div className="mt-2 grid gap-x-8 sm:grid-cols-2">
                  <div className="hidden sm:block" />
                  <div className="flex items-baseline justify-between border-t pt-2">
                    <span className="font-semibold">Net salary{breakdown.hasTds && monthlyTds == null ? " (before TDS)" : monthlyTds != null ? " (projected)" : ""}</span>
                    <span className="text-lg font-bold tabular-nums text-primary">{money((breakdown.netMonthly - (monthlyTds ?? 0)) * mult, cc)}</span>
                  </div>
                </div>
                {variableFy.total > 0 && (
                  <div className="mt-4 rounded-md border bg-muted/30 px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Bonuses · {variableFy.label}</span>
                      <span className="tabular-nums">{money(variableFy.total, cc)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between border-t pt-1.5 font-semibold">
                      <span>Total comp (annual, incl. variable)</span>
                      <span className="tabular-nums">{money((current?.annual_ctc ?? 0) + variableFy.total, cc)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Revision history</p>
            {/* One labelled block per revision on a phone, five columns from `sm` up. */}
            <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--card))]">
            <table className="table-stack w-full text-sm sm:min-w-[32rem]">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Effective</th><th className="py-2 pr-3 font-medium">CTC ({unit})</th><th className="py-2 pr-3 font-medium">Change</th><th className="py-2 pr-3 font-medium">Grade</th><th className="py-2 pr-3 font-medium">Until</th><th className="py-2 font-medium"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const delta = deltaByPath.get(r.path);
                  return (
                    <tr key={r.path} className={cn("border-b last:border-0", r.current && "bg-muted/30")}>
                      <td data-label="Effective" className="py-2 pr-3 font-medium"><span className="inline-block text-right sm:text-left">{r.effective_from}{r.arrears_amount ? <Badge variant={r.arrears_paid ? "success" : "warning"} className="ml-1.5 align-middle">{r.arrears_paid ? "arrears paid" : `arrears ${money(r.arrears_amount, r.currency_code)}`}</Badge> : null}</span></td>
                      <td data-label={`CTC (${unit})`} className="py-2 pr-3 tabular-nums">{money(r.annual_ctc / (unit === "annual" ? 1 : 12), r.currency_code)}</td>
                      <td data-label="Change" className="py-2 pr-3">
                        {delta == null ? <span className="text-muted-foreground">-</span> : (
                          <span className={cn("inline-flex items-center gap-0.5 tabular-nums", delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                            {delta >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                            {Math.abs(delta).toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td data-label="Grade" className="py-2 pr-3">
                        {r.pay_grade_name ? (
                          <span className="flex flex-wrap items-center gap-1.5">{r.pay_grade_name}<BandBadge row={r} /></span>
                        ) : "-"}
                      </td>
                      <td data-label="Until" className="py-2 pr-3 text-muted-foreground">{r.current ? <Badge variant="success">current</Badge> : r.effective_to ?? "-"}</td>
                      {/* Correct or remove this revision. Both are gated on the row's own server-computed
                          `access.can`, so a reader who may only look never sees them. Removing a revision whose
                          arrears a payroll run already paid is refused server-side - say so on the button
                          rather than letting the confirm end in an error. */}
                      {/* No `data-label`: an action cell stacks as a plain block on a phone (index.css). */}
                      <td className="py-2">
                        <div className="flex items-center justify-end gap-0.5">
                          {/* The trail for THIS revision: who set it, what it was before, what it became, and
                              who corrected or removed it. Renders only for a caller with the activity grant. */}
                          <RowActivityButton resource={r.path} label="Revision history" />
                          <AccessAction collection="compensation" verb="update" objectPath={r.path} can={r.access?.can} label="Correct revision">
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Correct this revision" aria-label={`Correct the revision effective ${r.effective_from}`} onClick={() => openDialog(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                          </AccessAction>
                          <AccessAction collection="compensation" verb="delete" objectPath={r.path} can={r.access?.can} label="Remove revision">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              disabled={!!r.arrears_paid}
                              title={r.arrears_paid ? "Its retro arrears have already been paid - reverse that payroll run first" : "Remove this revision"}
                              aria-label={`Remove the revision effective ${r.effective_from}`}
                              onClick={() => void removeRevision(r)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AccessAction>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={guard.onOpenChange}>
        <DialogContent className="sentry-mask" scrollBody onEnterSubmit={() => { if (canSave) void save(); }}>
          <AccessScope collection="compensation">
          <DialogHeader>
            <DialogTitle>{editing ? "Correct revision" : "Revise compensation"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Fix what was entered wrong. The basic/allowance split and any retro arrears are re-derived from the corrected figures - except arrears a payroll run has already paid, which stay at the amount that was actually disbursed."
                : "Enter the new annual CTC; basic and allowances are derived from it. The revision takes effect on the date you choose, and payroll picks it up from its next run."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
          <FormError error={err} />
          {payComponents.filter((c) => c.kind === "earning" && !c.delete_time).length === 0 && (
            /* Without earning components there is nothing to split a CTC ACROSS, and the split preview below
               fails with a message about the structure rather than the real cause. */
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              No earning components are set up, so a CTC can't be broken into basic and allowances yet. Payroll needs at least a basic earning before this revision will price.
            </p>
          )}
          <FieldRow>
            <Field label="Annual CTC" hint={`Basic = ${ctcCfg.basic_pct}% of CTC; a Special Allowance balances the rest.`}>
              <MoneyInput value={form.ctc} onChange={(v) => setForm({ ...form, ctc: v })} min={1} autoFocus suffix="a year" />
            </Field>
            {/* A date anywhere is allowed on a new revision, including one that lands inside the existing
                history (a salary that was never entered). A correction may only move within its own slot, so
                the input is bounded by the neighbouring revisions and the hint names the window. */}
            <Field
              label="Effective from"
              hint={editing
                ? `Between the neighbouring revisions${dateBounds.min ? `, from ${dateBounds.min}` : ""}${dateBounds.max ? ` to ${dateBounds.max}` : ""}. To move it further, remove this revision and add it at the new date.`
                : form.effective_from < todayYmd()
                  ? "Backdated - payroll prices past periods at the new rate when they're rebuilt, and already-published periods are owed the difference as arrears."
                  : undefined}
            >
              <Input type="date" min={dateBounds.min} max={dateBounds.max} value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
            </Field>
          </FieldRow>
          {/* A revision is nearly always expressed as a raise, so the raise is what the form shows back: the
              delta against what they earn today, and one-tap chips for the usual increments. */}
          {!editing && current && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Raise</span>
              {[5, 10, 15, 20, 30].map((pct) => {
                const target = Math.round((current.annual_ctc * (1 + pct / 100)) / 100) * 100;
                return (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setForm({ ...form, ctc: String(target) })}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent",
                      Number(form.ctc) === target && "border-primary bg-primary/10 text-primary",
                    )}
                  >
                    +{pct}%
                  </button>
                );
              })}
            </div>
          )}
          {!editing && current && Number(form.ctc) > 0 && Number(form.ctc) !== current.annual_ctc && (
            <p className="text-sm">
              <span className={cn("font-medium tabular-nums", Number(form.ctc) > current.annual_ctc ? "text-success" : "text-destructive")}>
                {Number(form.ctc) > current.annual_ctc ? "+" : "−"}{money(Math.abs(Number(form.ctc) - current.annual_ctc))}
                {" "}({Number(form.ctc) > current.annual_ctc ? "+" : "−"}{Math.abs(((Number(form.ctc) - current.annual_ctc) / current.annual_ctc) * 100).toFixed(1)}%)
              </span>
              <span className="text-muted-foreground"> against the current {money(current.annual_ctc)}.</span>
            </p>
          )}
          {Number(form.ctc) > 0 && (() => {
            const p = splitPreview(Number(form.ctc), form.salary_structure || undefined);
            if (!p) return <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">This CTC is too low for the selected structure: basic + fixed components already exceed it. Raise the CTC, or lower the basic %.</p>;
            return (
              <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Monthly basic ({ctcCfg.basic_pct}%)</span><span className="font-medium tabular-nums">{money(p.basic)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Special Allowance (plug)</span><span className="font-medium tabular-nums">{money(p.special)}</span></div>
                <div className="flex justify-between border-t pt-1"><span className="text-muted-foreground">Monthly CTC</span><span className="font-semibold tabular-nums">{money(p.monthlyCtc)}</span></div>
              </div>
            );
          })()}
          <Field label="Pay grade (optional)" hint={selectedBand}>
            <Select value={form.pay_grade || "none"} onValueChange={(v) => setForm({ ...form, pay_grade: v === "none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="No grade" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No grade</SelectItem>
                {[...payGrades].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)).map((g) => (
                  <SelectItem key={g.path} value={g.path}>{g.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Salary structure (optional)" hint="Defines which earning components apply to this employee. No structure = all org-wide earnings.">
            <Select value={form.salary_structure || "none"} onValueChange={(v) => setForm({ ...form, salary_structure: v === "none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="No structure" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No structure (all earnings)</SelectItem>
                {structures.map((s) => <SelectItem key={s.path} value={s.path}>{s.display_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} loading={busy} disabled={!canSave}>{editing ? "Save correction" : "Save revision"}</Button>
          </DialogFooter>
          </AccessScope>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
