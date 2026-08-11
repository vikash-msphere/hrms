import { allocOwnedCode } from "./codeAlloc";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { applyScope } from "./listScope";
import { applyStructure, splitCtc, pfWagesOf, DEFAULT_CTC_CONFIG, type CtcConfig } from "../domain/payroll";
import { round2 } from "../domain/money";
import { structureLinesById } from "./salaryStructures";
import { monthlyRecurringGross } from "./taxProjection";
import { getSettingValue } from "./settings";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition, aborted } from "../lib/errors";
import { notify } from "./notifications";

// Effective-dated base pay. A salary revision (increment/appraisal) is a NEW row effective from a chosen date;
// the previously-current row is closed (effective_to set). Payroll prices each period at the row effective
// during it (period-effective), and a backdated raise's delta for already-published periods is paid as arrears.
// There is no in-place edit of pay - history is preserved by design.

// Count the pay periods this employee was ALREADY PAID (in a PUBLISHED run) whose period starts within
// [fromMs, toMs). Drives backdated-increment arrears: only published periods are immutable + priced at the old
// rate, so only they are owed the delta - unpublished/future periods get the new rate from period-effective
// pricing and must NOT be counted here (that would double-pay the raise).
async function publishedPeriodsPaid(deps: Deps, employeeId: string, fromMs: number, toMs: number): Promise<number> {
  const myRunIds = new Set(
    (await deps.db.select({ runId: schema.payrollRunItems.runId }).from(schema.payrollRunItems).where(eq(schema.payrollRunItems.employeeId, employeeId))).map((r) => r.runId),
  );
  if (!myRunIds.size) return 0;
  const periods = new Map((await deps.db.select().from(schema.payPeriods)).map((p) => [p.uuid, p]));
  let n = 0;
  for (const r of await deps.db.select().from(schema.payrollRuns)) {
    if (r.state !== "PUBLISHED" || !myRunIds.has(r.uuid)) continue;
    const p = periods.get(r.payPeriodId);
    if (!p) continue;
    const ps = +new Date(p.periodStart);
    if (ps >= fromMs && ps < toMs) n++;
  }
  return n;
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
  const components = (await deps.db.select().from(schema.payComponents)).filter((c) => !c.disabled && !c.deleteTime);
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
  const paidPeriods = current ? await publishedPeriodsPaid(deps, employeeId, from, nowMs) : 0;
  const newGross = monthlyRecurringGross(basePay, effective, specialAllowance);
  const oldGross = current
    ? monthlyRecurringGross(current.basePay, applyStructure(components, await structureLinesById(deps, current.structureId)), current.specialAllowance)
    : 0;
  const arrears = paidPeriods > 0 ? Math.max(0, round2((newGross - oldGross) * paidPeriods)) : 0;
  // The PF-wage slice of those arrears: the rise in BASIC (plus, under the "basic_plus" wage basis, the same
  // allowances PF counts) over the same months. PF is due on arrears of basic wages while ESI is due on the whole
  // amount, so the run needs the two figures apart - deriving it later from a single lump is guesswork.
  const pfBasis = cfg.pf_wage_basis ?? "basic";
  const newPfWages = pfWagesOf(basePay, specialAllowance, effective, pfBasis);
  const oldPfWages = current
    ? pfWagesOf(current.basePay, current.specialAllowance, applyStructure(components, await structureLinesById(deps, current.structureId)), pfBasis)
    : 0;
  const arrearsBase = paidPeriods > 0 ? Math.max(0, round2((newPfWages - oldPfWages) * paidPeriods)) : 0;
  const row = (await deps.db
    .insert(schema.compensation)
    .values({
      code: await allocOwnedCode(deps, schema.compensation, schema.compensation.employeeId, employeeId),
      employeeId,
      ctcAnnual: annualCtc,
      basePay,
      specialAllowance,
      currency: input.currency_code?.trim() || current?.currency || "INR",
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
  const components = (await deps.db.select().from(schema.payComponents)).filter((c) => !c.disabled && !c.deleteTime);
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
export async function markCompArrearsSettled(deps: Deps, ids: string[], at: Date) {
  if (!ids.length) return;
  await deps.db.update(schema.compensation).set({ arrearsPaidAt: at }).where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
export async function releaseCompArrearsSettled(deps: Deps, ids: string[]) {
  if (!ids.length) return;
  await deps.db.update(schema.compensation).set({ arrearsPaidAt: null }).where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
export function resetCompArrearsPaidByRun(deps: Deps, runId: string) {
  return deps.db.update(schema.compensation).set({ arrearsPaidRunId: null, arrearsPaidAt: null }).where(eq(schema.compensation.arrearsPaidRunId, runId));
}
