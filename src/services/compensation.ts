import { allocOwnedCode } from "./codeAlloc";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { applyScope } from "./listScope";
import { applyStructure, ctcLines, splitCtc, pfWagesOf, DEFAULT_CTC_CONFIG, type CtcConfig } from "../domain/payroll";
import { round2 } from "../domain/money";
import { structureLinesById } from "./salaryStructures";
import { monthlyRecurringGross } from "./taxProjection";
import { getSettingValue, orgCurrency } from "./settings";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition, aborted } from "../lib/errors";
import { notify } from "./notifications";
import { refPayComponents, refPayPeriods } from "../lib/refData";

// Effective-dated base pay. A salary revision (increment/appraisal) is a NEW row effective from a chosen date;
// the previously-current row is closed (effective_to set). Payroll prices each period at the row effective
// during it (period-effective), and a backdated raise's delta for already-published periods is paid as arrears.
// There is no in-place edit of pay - history is preserved by design.

// One-off payments a run carries alongside the regular monthly wage. They are not part of the recurring rate a
// raise moves, so they never count toward how much of a month was paid at the old rate.
const ONE_OFF_EARNING_CODES = new Set(["BONUS", "ENCASH", "OT", "ARREARS", "REIMB", "ROUND"]);

// How many MONTH-EQUIVALENTS of regular wage this employee was ALREADY PAID at the old rate inside
// [fromMs, toMs). Drives backdated-increment arrears: only PUBLISHED periods are immutable and priced at the
// old rate, so only they are owed the delta - unpublished/future periods get the new rate from period-effective
// pricing and must NOT be counted (that would double-pay the raise).
//
// This is a weight, not a count. Counting whole periods over-paid the delta three ways: a mid-period joiner or
// leaver was paid a fraction of the month but credited a full month of arrears, a month with loss of pay was
// credited as if fully worked, and a raise effective mid-period was back-paid from the period start. Each
// period therefore contributes:
//   (regular wage actually paid that period / the old full monthly rate) x (the share of the period on or after
//   the effective date)
// The first factor comes from the run's own stored lines - the regular earnings including the negative
// loss-of-pay line - so it reflects exactly what the payslip paid, whatever prorated or docked it.
async function publishedRegularMonthsPaid(deps: Deps, employeeId: string, fromMs: number, toMs: number, oldMonthlyGross: number): Promise<number> {
  if (!(oldMonthlyGross > 0)) return 0;
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.employeeId, employeeId));
  if (!items.length) return 0;
  const itemByRun = new Map(items.map((it) => [it.runId, it]));
  const periods = new Map((await refPayPeriods(deps)).map((p) => [p.uuid, p]));
  let months = 0;
  // Only the runs this employee actually has an item in: every other run is skipped below anyway, so reading
  // the whole table grew this query with the org's payroll history for nothing.
  const runs = await deps.db.select().from(schema.payrollRuns).where(inArray(schema.payrollRuns.uuid, [...itemByRun.keys()]));
  for (const r of runs) {
    const it = itemByRun.get(r.uuid);
    if (r.state !== "PUBLISHED" || !it) continue;
    const p = periods.get(r.payPeriodId);
    if (!p) continue;
    const ps = +new Date(p.periodStart);
    const pe = +new Date(p.periodEnd);
    if (pe < fromMs || ps >= toMs) continue; // wholly outside the backdated window
    let regular = 0;
    let sawEarning = false;
    try {
      for (const l of JSON.parse(it.linesJson) as { code?: string; kind?: string; amount?: number }[]) {
        if (l.kind !== "earning" || ONE_OFF_EARNING_CODES.has(l.code ?? "")) continue;
        sawEarning = true;
        regular += l.amount ?? 0; // the loss-of-pay line is a NEGATIVE earning, so docking nets out here
      }
    } catch {
      continue; // an unreadable item states nothing about what was paid; crediting a full month would over-pay
    }
    // An item with no earning lines at all carries no breakdown to read (a hand-written row, or one stored
    // before lines were). Its own gross is then the only statement of what the period paid - a docked or
    // prorated month still shows up in it, so it is a sound fallback where the lines are simply absent.
    if (!sawEarning) regular = it.gross;
    const paidShare = Math.max(0, Math.min(1, regular / oldMonthlyGross));
    // The share of the period on or after the effective date: a raise effective mid-period is owed only the
    // remainder of that period, not the whole of it.
    const periodDays = Math.max(1, Math.round((pe - ps) / 86_400_000) + 1);
    const coveredFrom = Math.max(ps, fromMs);
    const coveredDays = Math.max(0, Math.round((Math.min(pe, toMs - 1) - coveredFrom) / 86_400_000) + 1);
    months += paidShare * Math.min(1, coveredDays / periodDays);
  }
  return round2(months);
}
export type CompensationInput = {
  employee?: string | null;
  annual_ctc?: number; // the authoritative figure; the server derives the monthly basic + Special Allowance
  currency_code?: string;
  pay_grade?: string | null;
  salary_structure?: string | null;
  effective_from?: string; // YYYY-MM-DD
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Decorate compensation rows with their pay grade (name + band, for compa-ratio/in-band) and salary-structure
// name, so the serializer can render them. One read per catalog for the whole set.
async function withGrades<T extends { payGradeId: string | null; structureId: string | null }>(deps: Deps, rows: T[]) {
  const gradeIds = new Set(rows.map((r) => r.payGradeId).filter(Boolean) as string[]);
  const structIds = new Set(rows.map((r) => r.structureId).filter(Boolean) as string[]);
  if (!gradeIds.size && !structIds.size) return rows;
  const grades = gradeIds.size ? new Map((await deps.db.select().from(schema.payGrades)).filter((g) => gradeIds.has(g.uuid)).map((g) => [g.uuid, g])) : new Map();
  const structs = structIds.size ? new Map((await deps.db.select().from(schema.salaryStructures)).filter((s) => structIds.has(s.uuid)).map((s) => [s.uuid, s])) : new Map();
  return rows.map((r) => ({
    ...r,
    ...(r.payGradeId ? { grade: grades.get(r.payGradeId) } : {}),
    ...(r.structureId ? { structure: structs.get(r.structureId) } : {}),
  }));
}

// Self-service shaping + the CTC build-up, on the one path every compensation answer passes through (the
// factory's `decorate`, so an item read and a list are shaped identically).
//
// A caller whose breadth is `own` is reading their OWN pay (My Profile). They see the CTC, its build-up and
// their revision history - but NOT the pay grade, band or compa-ratio: where a salary sits against the ladder
// is HR's comparative guardrail, not a fact about this employee's pay.
//
// The build-up comes from the domain `ctcLines`, the same pricing the CTC letter and the payroll run use, so
// nothing re-derives the split client-side. It needs the pay-component catalog, the org's PF wage basis and
// this row's salary structure - none of which an employee may read - so the server prices it. Only a
// single-employee read pays for those lookups; an org-wide list would otherwise spend them per employee.
export async function decorateCompensation(deps: Deps, _actor: AppUser, rows: any[], scope: ListScope | undefined) {
  const self = scope?.breadth === "own"; // the middleware's verdict, bound here - nothing is decided in this file
  const shaped = self ? rows.map((r) => ({ ...r, payGradeId: null, structureId: null, grade: undefined, structure: undefined })) : rows;
  const current = rows.find((r) => !r.effectiveTo);
  if (new Set(rows.map((r) => r.employeeId)).size !== 1 || !current) return shaped;
  const emp = (await deps.db.select({ epfEnrolled: schema.employees.epfEnrolled }).from(schema.employees).where(eq(schema.employees.uuid, current.employeeId)).limit(1))[0];
  const components = await refPayComponents(deps);
  const pfBasis = (await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG)).pf_wage_basis ?? "basic";
  const ctc = ctcLines(
    current.basePay,
    applyStructure(components, await structureLinesById(deps, current.structureId)),
    !!emp?.epfEnrolled,
    current.specialAllowance,
    pfBasis,
  );
  return shaped.map((r, i) => (rows[i] === current ? { ...r, ctc } : r));
}

// One employee's salary history (newest first), or - unfiltered - everything the caller may see.
export async function listCompensation(deps: Deps, scope: ListScope, employeeId?: string) {
  const conds = [applyScope(scope, schema.compensation.code, schema.compensation.employeeId)];
  if (employeeId) conds.push(eq(schema.compensation.employeeId, employeeId));
  const rows = await deps.db.select().from(schema.compensation).where(conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as any)) : undefined);
  rows.sort((a, b) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom) || b.uuid.localeCompare(a.uuid));
  return withGrades(deps, rows);
}

export async function getCompensation(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.uuid, id)).limit(1))[0];
  if (!row) throw notFound("compensation record not found");
  return (await withGrades(deps, [row]))[0]!;
}

// Revise pay: close the current open row at the new effective date and insert the new current row.
export async function reviseCompensation(deps: Deps, actor: AppUser, input: CompensationInput) {
  const employeeId = idFromPath(input.employee);
  const from = dayMs(input.effective_from);
  if (!employeeId) throw invalidArgument("employee is required");
  const annualCtc = input.annual_ctc;
  if (typeof annualCtc !== "number" || annualCtc <= 0) throw invalidArgument("annual_ctc must be greater than 0");
  if (Number.isNaN(from)) throw invalidArgument("effective_from is required");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");
  const payGradeId = idFromPath(input.pay_grade);
  if (payGradeId) {
    const grade = (await deps.db.select().from(schema.payGrades).where(eq(schema.payGrades.uuid, payGradeId)).limit(1))[0];
    if (!grade || grade.deleteTime) throw notFound("pay grade not found");
  }
  const structureId = idFromPath(input.salary_structure);
  if (structureId) {
    const st = (await deps.db.select().from(schema.salaryStructures).where(eq(schema.salaryStructures.uuid, structureId)).limit(1))[0];
    if (!st || st.deleteTime) throw notFound("salary structure not found");
  }

  // Derive the monthly basic + Special Allowance plug from the authoritative annual CTC: pin basic at
  // ctc.basic_pct% of the monthly CTC and solve the plug that makes this employee's full CTC (structure
  // earnings + employer PF/ESI/gratuity) land on the target - the same math letters and the comp tab render,
  // so the figures never drift. getSettingValue merges over DEFAULT_CTC_CONFIG, so a stored ctc setting
  // predating basic_pct still resolves to a full config.
  const cfg = await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG);
  const components = (await refPayComponents(deps)).filter((c) => !c.disabled && !c.deleteTime);
  const effective = applyStructure(components, await structureLinesById(deps, structureId));
  const split = splitCtc(annualCtc / 12, effective, emp.epfEnrolled, cfg);
  if (!split) throw invalidArgument("annual_ctc is too low for this structure: basic + fixed components already exceed it. Raise the CTC, lower ctc.basic_pct, or trim component rates.");
  const basePay = split.basePay;
  const specialAllowance = split.specialAllowance;

  const current = (await deps.db
    .select()
    .from(schema.compensation)
    .where(and(eq(schema.compensation.employeeId, employeeId), isNull(schema.compensation.effectiveTo)))
    .limit(1))[0];
  if (current && +new Date(current.effectiveFrom) >= from) {
    throw failedPrecondition("the effective date must be after the current compensation's start");
  }
  // Half-open intervals: the prior row ends where the new one begins. Guarded on the row still being OPEN, so
  // closing it is EXACTLY-ONCE: two concurrent revisions both read the same current row, and the loser must
  // stop here rather than insert a second open row - which would leave an ambiguous current salary and pay the
  // arrears delta twice. (`comp_open_idx`, the partial unique index on the open row, is the DB backstop.)
  if (current) {
    const [closed] = await deps.db
      .update(schema.compensation)
      .set({ effectiveTo: new Date(from), updatedAt: new Date() })
      .where(and(eq(schema.compensation.uuid, current.uuid), isNull(schema.compensation.effectiveTo)))
      .returning();
    if (!closed) throw aborted("this employee's compensation was revised concurrently; reload and try again");
  }
  // Retro arrears for a BACKDATED increment: the rise in MONTHLY RECURRING GROSS (basic + recurring earnings +
  // the Special Allowance plug) x the number of PERIODS THIS EMPLOYEE WAS ALREADY PAID (a published run) in the
  // backdated window [effective_from, now). Keying off gross (not bare basic) matters under the top-down CTC
  // split, where a raise mostly lands in the Special Allowance. Only published periods need arrears: payroll now
  // prices each period at the comp effective THEN (compForPeriod), so any un-published or future period in the
  // window is paid at the new rate directly - counting it here too would double-pay the raise. Only positive
  // deltas; a backdated cut isn't auto-recovered. The next run pays the stored amount as a taxable earning.
  const nowMs = +new Date();
  const newGross = monthlyRecurringGross(basePay, effective, specialAllowance);
  const oldGross = current
    ? monthlyRecurringGross(current.basePay, applyStructure(components, await structureLinesById(deps, current.structureId)), current.specialAllowance)
    : 0;
  // Month-EQUIVALENTS already paid at the old rate, not a period count: a part-month or docked period owes only
  // the delta on the wage it actually paid.
  const paidMonths = current ? await publishedRegularMonthsPaid(deps, employeeId, from, nowMs, oldGross) : 0;
  const arrears = paidMonths > 0 ? Math.max(0, round2((newGross - oldGross) * paidMonths)) : 0;
  // The PF-wage slice of those arrears: the rise in BASIC (plus, under the "basic_plus" wage basis, the same
  // allowances PF counts) over the same months. PF is due on arrears of basic wages while ESI is due on the whole
  // amount, so the run needs the two figures apart - deriving it later from a single lump is guesswork.
  const pfBasis = cfg.pf_wage_basis ?? "basic";
  const newPfWages = pfWagesOf(basePay, specialAllowance, effective, pfBasis);
  const oldPfWages = current
    ? pfWagesOf(current.basePay, current.specialAllowance, applyStructure(components, await structureLinesById(deps, current.structureId)), pfBasis)
    : 0;
  const arrearsBase = paidMonths > 0 ? Math.max(0, round2((newPfWages - oldPfWages) * paidMonths)) : 0;
  const row = (await deps.db
    .insert(schema.compensation)
    .values({
      code: await allocOwnedCode(deps, schema.compensation, schema.compensation.employeeId, employeeId),
      employeeId,
      ctcAnnual: annualCtc,
      basePay,
      specialAllowance,
      // The org's own currency, never a literal: the app is single-currency and payroll rejects a payable that
      // is not in it, so a first compensation row minted as "INR" in a non-INR org blocks every run.
      currency: input.currency_code?.trim() || current?.currency || await orgCurrency(deps),
      payGradeId: payGradeId ?? null,
      structureId: structureId ?? null,
      effectiveFrom: new Date(from),
      effectiveTo: null,
      arrearsAmount: arrears,
      arrearsBaseAmount: arrearsBase,
    })
    .returning())[0]!;
  await audit(deps, actor, "compensation.revise", "compensation", row.uuid, { employee: `employees/${employeeId}` });
  // Let the employee know their pay was revised (details on their profile). Skip a self-initiated change.
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "compensation.revised", title: "Your compensation was revised", body: `Effective ${input.effective_from ?? "your next cycle"}${arrears > 0 ? ` (with arrears).` : "."}`, link: "profile", subject: `compensation/${row.uuid}`, actorId: actor.employeeId });
  return (await withGrades(deps, [row]))[0]!;
}

// Re-solve the split for every CURRENT comp row under the live components + ctc config, holding each row's
// stored annual_ctc (the promise) fixed. Pure planning step (no writes): classifies each row as `stale` (the
// cached basic/special no longer matches what the live catalog derives), `unchanged`, or `skipped` (the CTC no
// longer fits - e.g. committed cost now exceeds it). Shared by the dry-run status check and the actual reapply,
// so the count you preview is exactly what a reapply would change.
type SplitPlanRow = { uuid: string; employeeId: string; basePay: number; specialAllowance: number; status: "stale" | "unchanged" | "skipped" };
async function splitPlan(deps: Deps): Promise<SplitPlanRow[]> {
  const cfg = await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG);
  const components = (await refPayComponents(deps)).filter((c) => !c.disabled && !c.deleteTime);
  const rows = await deps.db.select().from(schema.compensation).where(isNull(schema.compensation.effectiveTo));
  const emps = await deps.db.select({ uuid: schema.employees.uuid, epfEnrolled: schema.employees.epfEnrolled }).from(schema.employees);
  const epfById = new Map(emps.map((e) => [e.uuid, e.epfEnrolled]));
  const plan: SplitPlanRow[] = [];
  for (const row of rows) {
    const effective = applyStructure(components, await structureLinesById(deps, row.structureId));
    const split = splitCtc(row.ctcAnnual / 12, effective, epfById.get(row.employeeId) ?? true, cfg);
    if (!split) { plan.push({ uuid: row.uuid, employeeId: row.employeeId, basePay: row.basePay, specialAllowance: row.specialAllowance, status: "skipped" }); continue; }
    const changed = split.basePay !== row.basePay || split.specialAllowance !== row.specialAllowance;
    plan.push({ uuid: row.uuid, employeeId: row.employeeId, basePay: split.basePay, specialAllowance: split.specialAllowance, status: changed ? "stale" : "unchanged" });
  }
  return plan;
}

// Which of `employeeIds` currently hold a split the live catalog no longer produces. Used by a payroll run to
// warn that it priced a stale split: the run's numbers come from the CACHED basic / Special Allowance on each
// compensation row, so a row solved under an older catalog pays a gross that no longer reconciles to the CTC the
// employee was promised - and neither the build time nor any input's updatedAt reveals it, because the drift
// usually predates the build. Scoped to the run's own people, so an unrelated employee's stale split is not
// reported as this run's problem. `skipped` = no split fits that CTC any more; a re-apply cannot fix those.
export async function splitDriftFor(deps: Deps, employeeIds: string[]): Promise<{ stale: string[]; skipped: string[] }> {
  if (!employeeIds.length) return { stale: [], skipped: [] };
  const wanted = new Set(employeeIds);
  const plan = (await splitPlan(deps)).filter((p) => wanted.has(p.employeeId));
  return {
    stale: plan.filter((p) => p.status === "stale").map((p) => p.employeeId),
    skipped: plan.filter((p) => p.status === "skipped").map((p) => p.employeeId),
  };
}

// Dry run: how many current splits are out of date under the live catalog. Drives the "N employees' splits are
// out of date" banner + the post-mutation prompt after a pay-component change. No writes.
export async function splitStatus(deps: Deps): Promise<{ stale: number; unchanged: number; skipped: number }> {
  const plan = await splitPlan(deps);
  return {
    stale: plan.filter((p) => p.status === "stale").length,
    unchanged: plan.filter((p) => p.status === "unchanged").length,
    skipped: plan.filter((p) => p.status === "skipped").length,
  };
}

// Re-derive the split for every CURRENT compensation row (writes the stale ones). A change to the catalog
// (adding an allowance, enabling/disabling gratuity, editing a rate) propagates here - freed/added cost flows
// into the employee's Special Allowance and the CTC breakdown reconciles again. Deliberately explicit (a
// prompt/button), never automatic, because it shifts take-home org-wide. Rows whose CTC no longer fits are
// left unchanged + reported as skipped.
export async function reapplySplitCurrent(deps: Deps, actor: AppUser): Promise<{ updated: number; unchanged: number; skipped: number }> {
  const plan = await splitPlan(deps);
  let updated = 0, unchanged = 0, skipped = 0;
  for (const p of plan) {
    if (p.status === "skipped") { skipped++; continue; }
    if (p.status === "unchanged") { unchanged++; continue; }
    await deps.db.update(schema.compensation).set({ basePay: p.basePay, specialAllowance: p.specialAllowance, updatedAt: new Date() }).where(eq(schema.compensation.uuid, p.uuid));
    updated++;
  }
  await audit(deps, actor, "compensation.reapplySplit", "compensation", undefined, { updated, unchanged, skipped });
  return { updated, unchanged, skipped };
}

// Arrears paid-by-run markers (the next payroll run pays a backdated revision's stored arrears as a taxable
// earning, idempotently). Mirrors the bonus/overtime paid-by-run pattern. Both return UNEXECUTED statements
// so the build can batch them (a direct await still executes).
// Guarded on the arrears still being unclaimed, so two runs building concurrently cannot both pay them.
export function markCompArrearsPaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  return deps.db
    .update(schema.compensation)
    .set({ arrearsPaidRunId: runId, arrearsPaidAt: at })
    .where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
// Arrears paid by a full-and-final settlement rather than a run (arrearsPaidAt set, no run), and the release
// a recomputed settlement uses. The build treats either marker as paid, so this takes them out of the queue.
// Unexecuted statement, so the FnF commits it in the same atomic batch as the settlement (see reimbursements).
export function markCompArrearsSettledStmt(deps: Deps, ids: string[], at: Date) {
  return deps.db.update(schema.compensation).set({ arrearsPaidAt: at }).where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
export function releaseCompArrearsSettledStmt(deps: Deps, ids: string[]) {
  return deps.db.update(schema.compensation).set({ arrearsPaidAt: null }).where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
export function resetCompArrearsPaidByRun(deps: Deps, runId: string) {
  return deps.db.update(schema.compensation).set({ arrearsPaidRunId: null, arrearsPaidAt: null }).where(eq(schema.compensation.arrearsPaidRunId, runId));
}
