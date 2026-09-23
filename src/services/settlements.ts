import { allocOwnedCode } from "./codeAlloc";
import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { failedPrecondition, invalidArgument, notFound } from "../lib/errors";
import {
  currentComp, compAsOf, monthlyRecurringGross, tdsComponent, loadTaxConfig, fyWindow, finalizedTotals,
  assembleProjection, readDeclarations, verifiedDeductions, employedMonthsInFy, EMPTY_FINALIZED_TOTALS,
} from "./taxProjection";
import { encashmentRateConfig } from "./leaveEncashments";
import { orgToday, dayStartMs } from "./orgDay";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, type WorkEvent, localDay, utcDay, lopDayUnits, eventCreditByDay, sessionWorkedMinutes, unpaidLeaveDayUnits } from "../domain/attendance";
import { marksForPeriod } from "./attendanceDayMarks";
import { esiEmployeeContribution, esiContributionPeriod, professionalTax, DEFAULT_PT_CONFIG, type PtConfig } from "../domain/statutory";
import { approvedUnpaidReimbursements, markReimbursementsSettledStmt, releaseReimbursementsSettledStmt } from "./reimbursements";
import { unpaidBonuses, markBonusesSettledStmt, releaseBonusesSettledStmt } from "./bonuses";
import { approvedUnpaidEncashments, markEncashmentsSettledStmt, releaseEncashmentsSettledStmt } from "./leaveEncashments";
import { approvedUnpaidOvertime, markOvertimeSettledStmt, releaseOvertimeSettledStmt } from "./overtimeRequests";
import { markCompArrearsSettledStmt, releaseCompArrearsSettledStmt } from "./compensation";
import { outstandingLoans, repaidCreditStmt, recomputeRepaidStmt } from "./loans";
import { getSettingValue } from "./settings";
import { applyStructure, overtimePay, DEFAULT_OVERTIME_CONFIG, type OvertimeConfig } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import {
  computeSettlement, completedYearsOfService, yearsOfService, gratuityAmount, gratuityExemption, leaveEncashmentExemption,
  DEFAULT_GRATUITY_CONFIG, type GratuityConfig, type SettlementLine,
} from "../domain/settlement";
import { round2, sum2 } from "../domain/money";
import { runBatch, runBatchChecked, chunk, byIdChunks, type BatchStmt, type CheckedStmt } from "../lib/dbBatch";
import { genId } from "../lib/idCodec";
import { notify } from "./notifications";
import { refHolidays, refLeaveTypes, refPayComponents, refPayPeriods } from "../lib/refData";

// Full-and-final settlement (FnF). POST computes a snapshot from the employee's compensation, leave balance,
// pending reimbursements and the exit inputs (settlement date, encashable leave days, notice shortfall), and
// stores it; the FnF letter renders the most recent snapshot.
export type SettlementInput = {
  employee?: string | null;
  settlement_date?: string; // YYYY-MM-DD; defaults to the employee's end date, else today
  leave_days?: number; // encashable days; defaults to the employee's total leave balance
  notice_shortfall_days?: number; // notice not served (recovery); default 0
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const daysInMonthUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

// PAGED IN SQL, on `settlement_date`. One leaver has one or two snapshots, but the unfiltered list is every
// exit the org has ever settled and was returned whole, with `nextPageToken: undefined` - no cursor to follow
// however long the list got. `settlement_date` is `notNull`, so it is a valid keyset key for every matching row.
export async function listSettlements(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employeeId?: string) {
  const conds = [applyScope(scope, schema.settlements.code, schema.settlements.employeeId)];
  if (employeeId) conds.push(eq(schema.settlements.employeeId, employeeId));
  const where = conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as SQL[])) : undefined;
  return keysetPage<typeof schema.settlements.$inferSelect>(deps, schema.settlements, "settlements", where, {
    max: maxPageSize,
    pageToken,
    order: { expr: sql`${schema.settlements.settlementDate}`, value: (r) => +new Date(r.settlementDate) },
  });
}

// What one settlement consumed, stored on the row (settledJson) so a recompute can release it first.
type SettledRefs = {
  reimbursements: string[];
  bonuses: string[];
  encashments: string[];
  overtime: string[];
  arrears: string[];
  loans: { repaymentId: string; loanId: string; amount: number }[];
  leaveDebits: { balanceId: string; days: number }[];
};
const EMPTY_REFS: SettledRefs = { reimbursements: [], bonuses: [], encashments: [], overtime: [], arrears: [], loans: [], leaveDebits: [] };
function parseRefs(json: string | null): SettledRefs {
  if (!json) return EMPTY_REFS;
  try {
    return { ...EMPTY_REFS, ...(JSON.parse(json) as Partial<SettledRefs>) };
  } catch {
    return EMPTY_REFS;
  }
}

// Undo everything a previous settlement for this employee consumed, so recomputing one is safe: the payables
// go back on the queue, the encashed leave days go back on the balance, and the loan repayments it recorded
// are removed from the ledger (each affected loan's `repaid` is then re-derived from what remains). Mirrors
// the payroll run's releasePaidByRun - same contract, keyed to a settlement instead of a run. Returns the
// UNEXECUTED statements so the caller commits the release and the row's deletion in one atomic batch: a
// half-applied release leaves payables both consumed and unpayable.
function releaseSettlementStmts(deps: Deps, refs: SettledRefs, at: Date): BatchStmt[] {
  const stmts: BatchStmt[] = [];
  for (const ids of chunk(refs.reimbursements, 90)) stmts.push(releaseReimbursementsSettledStmt(deps, ids));
  for (const ids of chunk(refs.bonuses, 90)) stmts.push(releaseBonusesSettledStmt(deps, ids));
  for (const ids of chunk(refs.encashments, 90)) stmts.push(releaseEncashmentsSettledStmt(deps, ids));
  for (const ids of chunk(refs.overtime, 90)) stmts.push(releaseOvertimeSettledStmt(deps, ids));
  for (const ids of chunk(refs.arrears, 90)) stmts.push(releaseCompArrearsSettledStmt(deps, ids));
  if (refs.loans.length) {
    for (const ids of chunk(refs.loans.map((l) => l.repaymentId), 90)) {
      stmts.push(deps.db.delete(schema.loanRepayments).where(inArray(schema.loanRepayments.uuid, ids)));
    }
    // Re-derive each affected loan's running total from the ledger rows that SURVIVE the delete above, in the
    // same batch: an absolute total computed here in JS would discard any repayment committed in between.
    for (const loanId of new Set(refs.loans.map((l) => l.loanId))) stmts.push(recomputeRepaidStmt(deps, loanId, at));
  }
  for (const d of refs.leaveDebits) {
    if (!(d.days > 0)) continue;
    stmts.push(deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: sql`round(${schema.leaveBalances.balanceDays} + ${d.days}, 2)`, updatedAt: at })
      .where(eq(schema.leaveBalances.uuid, d.balanceId)));
  }
  return stmts;
}

/**
 * Which pay periods a committed run has already paid this employee for, around their exit.
 *
 * `finalPaid`: the period containing the settlement date has an APPROVED or PUBLISHED run item for them, so its
 * salary is paid and the settlement must not price those days again. `unpaid`: the periods that ended inside
 * their employment, before the exit month, with no committed item - paid by neither path, and reported rather
 * than priced, since whether a month was paid off-system is not something this can know. Three reads: runs for
 * the candidate periods, then this employee's items in them (pay periods come off the per-request snapshot).
 */
async function runCoverage(deps: Deps, employeeId: string, startedMs: number | null, settleMs: number): Promise<{ finalPaid: boolean; finalPeriodName: string | null; unpaid: string[] }> {
  const periods = (await refPayPeriods(deps)).filter((p) => +new Date(p.periodStart) <= settleMs && (startedMs == null || +new Date(p.periodEnd) >= startedMs));
  if (!periods.length) return { finalPaid: false, finalPeriodName: null, unpaid: [] };
  const runs = await byIdChunks(periods.map((p) => p.uuid), (group) =>
    deps.db
      .select({ uuid: schema.payrollRuns.uuid, payPeriodId: schema.payrollRuns.payPeriodId })
      .from(schema.payrollRuns)
      .where(and(inArray(schema.payrollRuns.payPeriodId, group), inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"]))));
  const periodOfRun = new Map(runs.map((r) => [r.uuid, r.payPeriodId]));
  const paidPeriods = new Set<string>();
  if (runs.length) {
    const items = await byIdChunks(runs.map((r) => r.uuid), (group) =>
      deps.db.select({ runId: schema.payrollRunItems.runId }).from(schema.payrollRunItems).where(and(eq(schema.payrollRunItems.employeeId, employeeId), inArray(schema.payrollRunItems.runId, group))));
    for (const it of items) {
      const p = periodOfRun.get(it.runId);
      if (p) paidPeriods.add(p);
    }
  }
  const final = periods.find((p) => +new Date(p.periodStart) <= settleMs && settleMs <= +new Date(p.periodEnd)) ?? null;
  const unpaid = periods
    .filter((p) => p !== final && +new Date(p.periodEnd) < settleMs && !paidPeriods.has(p.uuid))
    .sort((a, b) => +new Date(a.periodStart) - +new Date(b.periodStart))
    .map((p) => `pay-periods/${p.uuid}`);
  return { finalPaid: !!final && paidPeriods.has(final.uuid), finalPeriodName: final?.label ?? null, unpaid };
}

/**
 * Approved UNPAID leave day-units in the final month's employed window - what the exit month docks when
 * automatic loss of pay is off, matching the run build (services/payroll.ts). Two reads: holidays come off the
 * per-request snapshot, leave is bound to the month in SQL.
 */
async function finalMonthUnpaidLeaveDays(deps: Deps, employeeId: string, fromMs: number, untilMs: number, endYmd: string, att: AttendanceConfig): Promise<number> {
  const toMs = Math.max(untilMs, Date.parse(`${endYmd}T00:00:00Z`));
  const unpaidTypes = new Set((await refLeaveTypes(deps)).filter((t) => t.paid === false).map((t) => t.uuid));
  if (!unpaidTypes.size) return 0;
  const holidays = new Set(
    (await refHolidays(deps))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= fromMs && +new Date(h.date) <= toMs)
      .map((h) => utcDay(+new Date(h.date))),
  );
  const ranges = (await deps.db
    .select()
    .from(schema.leaveRequests)
    .where(and(
      eq(schema.leaveRequests.employeeId, employeeId),
      eq(schema.leaveRequests.state, "APPROVED"),
      gte(schema.leaveRequests.endDate, new Date(fromMs - 86_400_000)),
      lte(schema.leaveRequests.startDate, new Date(toMs + 2 * 86_400_000)),
    )))
    .filter((l) => +new Date(l.endDate) >= fromMs && +new Date(l.startDate) <= toMs)
    .map((l) => ({ start: utcDay(+new Date(l.startDate)), end: utcDay(+new Date(l.endDate)), startSession: l.startSession, endSession: l.endSession, ...(unpaidTypes.has(l.leaveTypeId) ? { paid: false } : {}) }));
  return unpaidLeaveDayUnits(utcDay(fromMs), endYmd, att.work_days, holidays, ranges);
}

// Unexcused absence day-units inside the final month's employed window, from exactly the facts a payroll run
// uses (holidays, approved leave, attendance punches) so the exit month is docked the same way every other
// month is. Scoped to one employee and one month, so it stays a handful of reads.
async function finalMonthLopDays(deps: Deps, employeeId: string, fromMs: number, untilMs: number, endYmd: string, att: AttendanceConfig): Promise<number> {
  const tz = att.timezone || "Asia/Kolkata";
  // THE DATA WINDOW HAS TO COVER EVERY DAY THE WALK ENUMERATES, and `untilMs` on its own does not.
  //
  // `untilMs` is an INSTANT (the caller clamps it at the clock so a settlement computed early does not dock
  // days that have not happened), while `endYmd` is the last DAY `lopDayUnits` judges. East of UTC the org's
  // day rolls over first, so the two disagree by up to a day: the walk reached 14 September while the holiday
  // and leave predicates below still cut off at the 13th's evening. A holiday or an approved leave day landing
  // on that last day was then invisible to them and the day read as an unexcused absence - money, docked at
  // the full daily rate, on the one payout a leaver has no later run to correct.
  //
  // Widening is safe in the other direction: the walk is bounded by `endYmd`, not by this, so a row a day past
  // it is simply never consulted.
  const toMs = Math.max(untilMs, Date.parse(`${endYmd}T00:00:00Z`));
  // `fromMs` is a DATE-ONLY anchor (the month start, or the employee's start_date), so its day is the UTC one
  // it is stored at; `endYmd` was resolved and clamped by the caller, which is the only place that knows which
  // source named it. Holidays and leave ranges below are date-only too. The punch days further down stay on
  // `localDay`, because a punch is an instant. See domain/attendance.ts#utcDay for what reading a date-only
  // column through `localDay` cost: every one of these days shifted a day earlier west of UTC, so the exit
  // month docked the day before it began, never checked its last day, and excused the day before each holiday
  // while docking the holiday itself.
  const startYmd = utcDay(fromMs);
  const holidays = new Set(
    (await refHolidays(deps))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= fromMs && +new Date(h.date) <= toMs)
      .map((h) => utcDay(+new Date(h.date))),
  );
  // Both reads below are BOUND TO THE FINAL MONTH IN SQL, with a UTC day of slack at each end (no timezone is
  // more than 14 hours from UTC, so nothing whose org-local day falls in the window can lie outside them) and
  // the exact call left to `localDay` in JS - the same "widen in SQL, decide in JS" rule services/orgDay.ts
  // states. They were scoped to the EMPLOYEE only, so this function's own comment ("a handful of reads") held
  // for a new joiner and quietly stopped holding for anyone with tenure: a ten-year leaver's settlement read
  // every leave request and every punch of those ten years to use one month of them. The `events` read below
  // was narrowed for exactly this reason; these are the two it left behind.
  const windowFrom = new Date(fromMs - 86_400_000);
  const windowTo = new Date(toMs + 2 * 86_400_000);
  const unpaidTypes = new Set((await refLeaveTypes(deps)).filter((t) => t.paid === false).map((t) => t.uuid));
  const leaveRanges = (await deps.db
    .select()
    .from(schema.leaveRequests)
    .where(and(
      eq(schema.leaveRequests.employeeId, employeeId),
      eq(schema.leaveRequests.state, "APPROVED"),
      gte(schema.leaveRequests.endDate, windowFrom),
      lte(schema.leaveRequests.startDate, windowTo),
    )))
    .filter((l) => l.state === "APPROVED" && +new Date(l.endDate) >= fromMs && +new Date(l.startDate) <= toMs)
    // The half-day SESSIONS travel with the range, for the reason domain/attendance.ts#leaveCover gives: a
    // boundary session costs half a day of balance, so excusing the whole day from loss of pay pays for the
    // half the leaver neither worked nor took. And whether the leave is PAID travels too: an unpaid range
    // excuses nothing (domain/attendance.ts LeaveRange), exactly as the run build reads it.
    .map((l) => ({ start: utcDay(+new Date(l.startDate)), end: utcDay(+new Date(l.endDate)), startSession: l.startSession, endSession: l.endSession, ...(unpaidTypes.has(l.leaveTypeId) ? { paid: false } : {}) }));
  const workedByDay = new Map<string, number>();
  for (const s of await deps.db
    .select()
    .from(schema.attendanceSessions)
    .where(and(
      eq(schema.attendanceSessions.employeeId, employeeId),
      // Superseded punches are not punches - see the same filter (and the reason for it) in the payroll
      // build's assembleLop. The exit month is docked by exactly the rule every other month is docked by, so
      // it must read the corrected sessions alone rather than them plus the originals they replaced.
      isNull(schema.attendanceSessions.supersededBy),
      gte(schema.attendanceSessions.clockIn, windowFrom),
      lte(schema.attendanceSessions.clockIn, windowTo),
    ))) {
    const ms = +new Date(s.clockIn);
    if (ms < fromMs || ms > toMs + 86_400_000) continue;
    const day = localDay(ms, tz);
    // Same reading as the payroll build's - one implementation, because this payout has no later run to
    // correct it (domain/attendance.ts#sessionWorkedMinutes).
    const minutes = sessionWorkedMinutes(ms, s.clockOut ? +new Date(s.clockOut) : null, +deps.clock.now(), tz);
    workedByDay.set(day, (workedByDay.get(day) ?? 0) + minutes);
  }
  // Same event credit the payroll build applies, so a leaver's final settlement doesn't dock days they spent
  // at a count_as_work event (see assembleLop in services/payroll.ts).
  const nowMs = +deps.clock.now();
  const events: WorkEvent[] = [];
  // Bound to the final month in SQL, like the two reads above it and like assembleLop: the leave and
  // attendance reads were already narrowed to one employee, and this one - the only whole-table read left in
  // a function whose comment claims "a handful of reads" - grew with every event the org had ever held.
  for (const e of await deps.db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.countAsWork, true), isNull(schema.events.deleteTime), gte(schema.events.endTime, new Date(fromMs - 86_400_000)), lte(schema.events.startTime, new Date(toMs + 86_400_000))))) {
    if (e.deleteTime || !e.countAsWork) continue;
    if (+new Date(e.endTime) < fromMs - 86_400_000 || +new Date(e.startTime) > toMs + 86_400_000) continue;
    try {
      if (!(JSON.parse(e.attendeeIds ?? "[]") as string[]).includes(employeeId)) continue;
    } catch { continue; }
    events.push({ startMs: +new Date(e.startTime), endMs: +new Date(e.endTime), allDay: !!e.allDay, requiresClockIn: !!e.requiresClockIn });
  }
  const credit = eventCreditByDay({
    events, tz, workDays: att.work_days,
    fullDayMinutes: att.full_day_minutes ?? 480,
    todayYmd: localDay(nowMs, tz),
    nowMs,
    punchedDays: new Set(workedByDay.keys()), // before the merge, so credit never counts as a punch
    onLeave: (d) => leaveRanges.some((r) => r.start <= d && d <= r.end),
  });
  for (const [day, m] of credit) workedByDay.set(day, (workedByDay.get(day) ?? 0) + m);

  // HR's day marks over the same window, for the same reason payroll reads them: a marked day is settled on
  // the mark rather than on the minutes. A leaver's final month is exactly where an agreed short day is most
  // likely to be sitting, so leaving them out here would have the settlement and the payslip disagree.
  const marksByDay = (await marksForPeriod(deps, fromMs, toMs)).get(employeeId);

  return lopDayUnits({
    startYmd, endYmd, workDays: att.work_days, holidays, leaveRanges, workedByDay, marksByDay,
    fullDayMinutes: att.full_day_minutes ?? 480,
    halfDayMinutes: att.half_day_minutes ?? 240,
  });
}

// Average monthly basic over the ten months ending with the exit month, priced off the compensation timeline
// (each month at the row in force at its end, exactly as payroll and the projection price a month). This is
// what s.10(10AA) means by "average salary"; the last-drawn figure over-exempts after a final-year raise.
// Months before the employee had any compensation on record are skipped rather than counted as zero.
async function averageMonthlyBasic(deps: Deps, employeeId: string, asOf: Date): Promise<number> {
  const rows = await deps.db.select().from(schema.compensation).where(and(eq(schema.compensation.employeeId, employeeId), isNull(schema.compensation.deleteTime)));
  if (!rows.length) return 0;
  const values: number[] = [];
  for (let back = 0; back < 10; back++) {
    const monthEnd = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - back + 1, 0, 23, 59, 59, 999);
    const row = compAsOf(rows, monthEnd);
    if (row) values.push(row.basePay);
  }
  return values.length ? round2(sum2(values) / values.length) : 0;
}

// Was this employee already contributing to ESI earlier in the contribution period the exit falls in? Same
// stickiness the payroll build applies (domain/statutory.ts): eligibility is fixed at the period start, so a
// mid-period raise past the ceiling does not stop the contribution until the period ends. Without this the FnF
// re-tested the bare ceiling and silently stopped withholding in the leaver's final month.
async function esiContributingAtExit(deps: Deps, employeeId: string, exitDate: Date): Promise<boolean> {
  const cp = esiContributionPeriod(exitDate);
  const periods = new Map((await refPayPeriods(deps)).map((p) => [p.uuid, p]));
  // COMMITTED runs only, in SQL. This read the whole `payroll_runs` table and threw away the drafts in JS,
  // which is every run the org has ever built to answer a question about one contribution period.
  const runIds = new Set(
    (await deps.db.select({ uuid: schema.payrollRuns.uuid, payPeriodId: schema.payrollRuns.payPeriodId })
      .from(schema.payrollRuns)
      .where(inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"])))
      // The period window stays in JS: `pay_periods` is already memoized per request by lib/refData, so
      // joining it here would cost a read to avoid one that has already happened.
      .filter((r) => { const p = periods.get(r.payPeriodId); return !!p && +new Date(p.payDate) >= cp.start && +new Date(p.payDate) < cp.end; })
      .map((r) => r.uuid),
  );
  if (!runIds.size) return false;
  // And the items narrowed to THOSE runs, chunked for the D1 parameter cap - not every payslip line this
  // employee has ever been paid, filtered down to a couple of them afterwards.
  const items = await byIdChunks([...runIds], (group) =>
    deps.db.select().from(schema.payrollRunItems).where(and(eq(schema.payrollRunItems.employeeId, employeeId), inArray(schema.payrollRunItems.runId, group))));
  return items.some((it) => {
    try {
      return (JSON.parse(it.linesJson) as { code?: string }[]).some((l) => l.code === "ESI");
    } catch {
      return false;
    }
  });
}

// PF / ESI / PT withheld on the exit payout, from the org's own pay components - the same opt-in components and
// the same pure statutory maths the payroll build uses, so the two never disagree about a rate or a ceiling.
async function settlementStatutoryLines(
  deps: Deps,
  f: { components: typeof schema.payComponents.$inferSelect[]; epfEnrolled: boolean; monthlyGross: number; pfWages: number; esiWages: number; esiSticky: boolean; ptWagePaid: number; ptSlabWage: number; ptYtd: number },
): Promise<SettlementLine[]> {
  const out: SettlementLine[] = [];
  const live = f.components.filter((c) => !c.disabled && !c.deleteTime && c.recurring);
  const epfComp = live.find((c) => c.method === "epf" && c.kind === "deduction");
  if (epfComp && f.epfEnrolled && f.pfWages > 0) {
    const epf = round2(Math.min(f.pfWages, epfComp.cap ?? Infinity) * ((epfComp.rate ?? 12) / 100));
    if (epf > 0) out.push({ code: "EPF", name: epfComp.name, kind: "deduction", amount: epf });
  }
  const esiComp = live.find((c) => c.method === "esi" && c.kind === "deduction");
  if (esiComp && f.esiWages > 0) {
    // Eligibility on the monthly wage rate (the ceiling test) OR sticky membership from earlier in the
    // contribution period, exactly as the payroll build decides it; contribution on the wages actually paid.
    const eligible = (f.monthlyGross > 0 && f.monthlyGross <= (esiComp.cap ?? 21000)) || f.esiSticky;
    const esi = eligible ? esiEmployeeContribution(f.esiWages, esiComp.rate ?? 0.75, Infinity) : 0;
    if (esi > 0) out.push({ code: "ESI", name: esiComp.name, kind: "deduction", amount: esi });
  }
  const ptComp = live.find((c) => c.method === "pt" && c.kind === "deduction");
  if (ptComp && f.ptWagePaid > 0) {
    // Same slab rule the run applies: the bracket is the monthly wage rate plus the extra wage this payout
    // carries, and the year's collection is capped where the state act caps it.
    const cfg = await getSettingValue<PtConfig>(deps, "professional-tax", DEFAULT_PT_CONFIG);
    const headroom = cfg.annual_cap == null ? Infinity : Math.max(0, round2(cfg.annual_cap - f.ptYtd));
    const pt = round2(Math.min(professionalTax(f.ptSlabWage, cfg), headroom));
    if (pt > 0) out.push({ code: "PT", name: ptComp.name, kind: "deduction", amount: pt });
  }
  return out;
}

// Income tax to withhold on the exit payout: the year's whole liability (salary already paid + this payout,
// less the tax already deducted and any verified prior-employer credit), collected NOW because there is no later
// month to spread it over. Nothing is withheld when the org hasn't configured a TDS component.
async function settlementTds(
  deps: Deps,
  emp: typeof schema.employees.$inferSelect,
  settlementDate: Date,
  taxableEarnings: number,
  components: typeof schema.payComponents.$inferSelect[],
): Promise<number> {
  const tdsComp = tdsComponent(components);
  if (!tdsComp || taxableEarnings <= 0) return 0;
  const fy = fyWindow(settlementDate);
  const paid = (await finalizedTotals(deps, fy, undefined, emp.uuid)).get(emp.uuid) ?? EMPTY_FINALIZED_TOTALS();
  const proj = assembleProjection({
    cfg: await loadTaxConfig(deps),
    fy,
    regime: tdsComp.regime ?? "new",
    tdsConfigured: true,
    employedMonths: employedMonthsInFy(emp.startDate ?? null, fy, emp.endDate ?? settlementDate),
    paidGross: paid.taxableGross,
    paidTax: paid.tax,
    // One collection month: the exit payout carries the entire remaining balance, there is no later payroll.
    collectMonths: 1,
    projectedGross: 0, // the employee earns nothing further this year from this employer
    currentRunGross: taxableEarnings,
    decl: await readDeclarations(deps, emp.taxDetailsEnc),
    declaredDeductions: await verifiedDeductions(deps, emp.uuid, fy.financialYear),
  });
  return proj.monthlyTds;
}

export async function computeAndStoreSettlement(deps: Deps, actor: AppUser, input: SettlementInput) {
  const employeeId = idFromPath(input.employee);
  if (!employeeId) throw invalidArgument("employee is required");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");

  // A settlement is terminal, so recomputing one SUPERSEDES the previous: release what it consumed and drop
  // it, then price the exit from scratch. Without this a second compute would read empty queues (the first
  // one took them) and understate the payout by everything the first settlement already covered.
  const prior = await deps.db.select().from(schema.settlements).where(eq(schema.settlements.employeeId, employeeId));
  if (prior.length) {
    const releaseAt = new Date();
    await runBatch(deps.db, [
      ...prior.flatMap((p) => releaseSettlementStmts(deps, parseRefs(p.settledJson), releaseAt)),
      deps.db.delete(schema.settlements).where(inArray(schema.settlements.uuid, prior.map((p) => p.uuid))),
    ]);
  }

  const comp = await currentComp(deps, employeeId);
  if (!comp) throw invalidArgument("the employee has no compensation on record");
  const components = await refPayComponents(deps);
  // Apply the employee's salary structure (their earning set + rate overrides) before pricing gross, so a
  // structured employee's FnF matches payroll/encashment/tax - unstructured earnings must not inflate it.
  const effective = applyStructure(components, await structureLinesById(deps, comp.structureId));
  const monthlyGross = monthlyRecurringGross(comp.basePay, effective, comp.specialAllowance);

  // The day this settlement is FOR, derived PER SOURCE rather than by reading one source through the other's
  // rule. `settlement_date` and `employees.end_date` are DATE-ONLY columns anchored at UTC midnight, so the day
  // they name is the UTC one; the clock fallback is an INSTANT, so its day is the org's. Read uniformly through
  // `localDay`, every explicit date shifted a day earlier west of UTC - see domain/attendance.ts#utcDay.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const tz = att.timezone || DEFAULT_ATTENDANCE.timezone;
  const datedMs = !Number.isNaN(dayMs(input.settlement_date)) ? dayMs(input.settlement_date) : emp.endDate ? +new Date(emp.endDate) : null;
  // THE CLOCK FALLBACK IS ANCHORED TO A DAY, not left as the instant the request happened to arrive.
  //
  // Every other consumer of `settleMs` below reads it as a DATE: `daysWorkedInMonth` subtracts it from UTC
  // midnight of the month start, and the month itself comes off `settlementDate`'s UTC getters. An instant is
  // not a date, and `Math.round` turns the difference into money: at 18:00 IST on the 13th the subtraction is
  // 12.52 days, rounds to 13, and the +1 pays a FOURTEENTH day of a month the leaver worked thirteen of.
  // Past 18:30 IST it is worse - the org-local day has rolled over while the UTC month has not, so a
  // settlement run on the evening of 30 September computed 31 days against a 30-day month and paid more than
  // a whole month's gross, with `lopEndYmd` naming a day outside the window `finalMonthLopDays` enumerates.
  //
  // `dayStartMs(orgToday())` is the same anchor `settleYmd` already used (services/orgDay.ts): the org's
  // calendar day, at the UTC midnight every date-only column in the schema stores a day at. The subtraction is
  // then exact, and the two halves cannot name different days or different months.
  const settleMs = datedMs ?? dayStartMs(await orgToday(deps));
  const settleYmd = utcDay(settleMs);
  const settlementDate = new Date(settleMs);

  // Encashable leave: explicit override, else the balance of the ENCASHABLE leave types only. The same
  // `encashable` / `disabled` flags a mid-employment cashout enforces apply at exit - summing every balance row
  // cashed out sick and casual leave that the policy says is not encashable at all.
  const encashableTypes = new Set(
    (await refLeaveTypes(deps)).filter((t) => t.encashable && !t.disabled && !t.deleteTime).map((t) => t.uuid),
  );
  const encashableBalances = (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, employeeId)))
    .filter((b) => encashableTypes.has(b.leaveTypeId));
  let leaveDays = input.leave_days;
  if (typeof leaveDays !== "number") leaveDays = Math.max(0, sum2(encashableBalances.map((b) => b.balanceDays)));
  const noticeShortfallDays = Math.max(0, input.notice_shortfall_days ?? 0);
  const reimbClaims = await approvedUnpaidReimbursements(deps, employeeId);
  // Net of anything already set against an advance, for the same reason the payroll payout is (see
  // services/payroll.ts) - a leaver's final settlement is the last place a double payout could still slip out.
  const reimbursements = sum2(reimbClaims.map((r) => Math.max(0, round2(r.amount - (r.advanceSettled ?? 0)))));

  // Everything else still queued for this employee. A payroll run only pays ACTIVE employees, so once the exit
  // transition flips them to `terminated` these payables can never be paid by a run - the FnF is their last
  // chance, and an outstanding loan is the company's last chance to recover.
  const currency = comp.currency || "INR";
  const bonuses = await unpaidBonuses(deps, employeeId);
  const encashments = await approvedUnpaidEncashments(deps, employeeId);
  const otCfg = await getSettingValue<OvertimeConfig>(deps, "overtime", DEFAULT_OVERTIME_CONFIG);
  const overtime = otCfg.enabled ? await approvedUnpaidOvertime(deps, employeeId) : [];
  const arrearsRows = (await deps.db.select().from(schema.compensation).where(and(eq(schema.compensation.employeeId, employeeId), isNull(schema.compensation.deleteTime))))
    .filter((c) => c.arrearsAmount > 0 && !c.arrearsPaidRunId && !c.arrearsPaidAt);
  const loans = await outstandingLoans(deps, employeeId);
  // Single-currency invariant, same as the payroll build: every line is summed as a bare number, so a payable
  // in another currency would silently corrupt the net instead of failing.
  for (const b of bonuses) if ((b.currency || "INR") !== currency) throw invalidArgument(`a bonus for this employee is in ${b.currency || "INR"}, not ${currency}`);
  for (const e2 of encashments) if ((e2.currency || "INR") !== currency) throw invalidArgument(`a leave encashment for this employee is in ${e2.currency || "INR"}, not ${currency}`);
  for (const c of arrearsRows) if ((c.currency || "INR") !== currency) throw invalidArgument(`salary arrears for this employee are in ${c.currency || "INR"}, not ${currency}`);

  const otMinutes = overtime.reduce((s, r) => s + Math.max(0, Math.round((+new Date(r.endTime) - +new Date(r.startTime)) / 60000)), 0);
  const otAmount = overtimePay(otMinutes, comp.basePay, otCfg);
  const extraEarnings = [
    ...bonuses.map((b) => ({ name: b.kind || "Bonus", kind: "earning" as const, amount: b.amount })),
    ...(encashments.length ? [{ name: `Approved leave encashment (${round2(encashments.reduce((s, r) => s + r.days, 0))} day(s))`, kind: "earning" as const, amount: sum2(encashments.map((r) => r.amount)) }] : []),
    ...(otAmount > 0 ? [{ name: `Overtime (${Math.floor(otMinutes / 60)}h${otMinutes % 60 ? ` ${otMinutes % 60}m` : ""})`, kind: "earning" as const, amount: otAmount }] : []),
    ...(arrearsRows.length ? [{ name: "Salary arrears", kind: "earning" as const, amount: sum2(arrearsRows.map((c) => c.arrearsAmount)) }] : []),
  ];
  const extraDeductions = loans.map((l) => ({
    name: `${l.kind === "advance" ? "Advance" : "Loan"} recovery (outstanding)`,
    kind: "deduction" as const,
    amount: l.outstanding,
  }));

  // ---- Final month: days actually worked, and the absences inside them -------------------------------------
  // Not simply "the day of the month": a mid-month JOINER never earned the days before their start date, and
  // unexcused absences in the exit month are loss of pay exactly as they are in a payroll run. Both would
  // otherwise be paid in full on the way out.
  const daysInMonth = daysInMonthUTC(settlementDate);
  const monthStartMs = Date.UTC(settlementDate.getUTCFullYear(), settlementDate.getUTCMonth(), 1);
  const startedThisMonth = emp.startDate && +new Date(emp.startDate) > monthStartMs ? +new Date(emp.startDate) : monthStartMs;
  // WHO ALREADY PAID WHICH MONTH. A run prices everybody not yet `terminated`, and this settlement is routinely
  // computed before the exit transition flips the status - so a committed run for the exit month has ALREADY
  // paid that month's salary, and pricing its days here again paid it twice. The run build skips a leaver
  // whose settlement is dated inside its period (services/payroll.ts `settledOut`); this is the other order.
  // Earlier months with no committed run item while employed are the opposite gap - paid by neither path - and
  // are named on the audit record for payroll to settle by hand rather than guessed at here.
  const coverage = await runCoverage(deps, employeeId, emp.startDate ? +new Date(emp.startDate) : null, settleMs);
  const daysWorkedInMonth = coverage.finalPaid ? 0 : Math.max(0, Math.round((settleMs - startedThisMonth) / 86_400_000) + 1);
  // Absences are only countable up to today: a settlement computed BEFORE the last working day must not dock days
  // that haven't happened yet (the same clamp the payroll build applies to a mid-period build).
  const lopUntilMs = Math.min(settleMs, +deps.clock.now());
  // Clamped by DAY as well as by instant, the same way assembleLop clamps a mid-period build: `settleYmd` was
  // resolved from whichever source named it, and today's day comes from the clock.
  const todayYmd = localDay(+deps.clock.now(), tz);
  const lopEndYmd = settleYmd < todayYmd ? settleYmd : todayYmd;
  // With automatic loss of pay off, approved UNPAID leave in the exit month is still docked - the same rule the
  // run build applies (services/payroll.ts), and the leaver has no later run to correct a disagreement.
  const lopDaysInFinalMonth = coverage.finalPaid || lopUntilMs < startedThisMonth
    ? 0
    : att.lop_enabled
      ? await finalMonthLopDays(deps, employeeId, startedThisMonth, lopUntilMs, lopEndYmd, att)
      : await finalMonthUnpaidLeaveDays(deps, employeeId, startedThisMonth, lopUntilMs, lopEndYmd, att);

  // ---- Exit benefits --------------------------------------------------------------------------------------
  // Statutory gratuity, and the s.10(10AA) exemption on the leave being encashed, both need completed service.
  // TWO service figures, and they are not interchangeable: `servedYears` is the raw elapsed service the
  // five-year QUALIFYING test is applied to, while `serviceYears` is the s.4(2)-rounded count that sizes the
  // payout. Gating on the rounded figure paid full gratuity to anyone past four years and six months.
  const serviceStartMs = +(emp.startDate ?? settlementDate);
  const servedYears = yearsOfService(serviceStartMs, settleMs);
  const serviceYears = completedYearsOfService(serviceStartMs, settleMs);
  const gratuityCfg = await getSettingValue<GratuityConfig>(deps, "gratuity", DEFAULT_GRATUITY_CONFIG);
  const gratuityPay = gratuityAmount(comp.basePay, serviceYears, gratuityCfg, servedYears);
  // Leave encashment at exit is priced from the SAME settings a mid-employment cashout uses (basis base/gross,
  // per-day divisor), so one concept has exactly one rate. Its exempt slice is s.10(10AA).
  const { basis: encashBasisKind, divisor: encashDivisor } = await encashmentRateConfig(deps);
  const encashBasis = encashBasisKind === "gross" ? monthlyGross : comp.basePay;
  const encashGross = round2((leaveDays * encashBasis) / (encashDivisor > 0 ? encashDivisor : 30));

  const facts = {
    monthlyGross,
    basePay: comp.basePay,
    daysWorkedInMonth,
    daysInMonth,
    lopDaysInFinalMonth,
    leaveDays,
    encashBasis,
    encashDivisor,
    // s.10(10AA) limbs (c) and (d) are measured on AVERAGE salary of the last ten months, not the last-drawn
    // figure - a final-year raise would otherwise over-exempt the payout.
    encashExempt: leaveEncashmentExemption(encashGross, comp.basePay, leaveDays, serviceYears, undefined, await averageMonthlyBasic(deps, employeeId, settlementDate)),
    noticeShortfallDays,
    reimbursements,
    gratuity: gratuityPay > 0 ? { amount: gratuityPay, exempt: gratuityExemption(gratuityPay, comp.basePay, serviceYears, gratuityCfg) } : undefined,
    extraEarnings,
    extraDeductions,
  };

  // ---- Withholding on the exit payout -------------------------------------------------------------------
  // The FnF is salary income - and usually the year's largest single payment - so it withholds like a run does:
  // PF and ESI on the wages it pays, PT for the month, and income tax on the chargeable part. Priced in two
  // passes because the tax base is what the first pass computes.
  const pass1 = computeSettlement(facts);
  // The month fraction the final-month salary was actually paid on, clamped to the month the same way
  // computeSettlement clamps it. The PF wage below rides on it, so the two can never disagree.
  const paidMonthDays = Math.max(0, round2(Math.min(daysWorkedInMonth, daysInMonth) - lopDaysInFinalMonth));
  // Match the final-month salary by its stable CODE. `name` starts with "Salary" for the arrears line the
  // caller contributes too, so a label match picked that up whenever the final month itself paid nothing - and
  // then added the arrears into the ESI base a second time below.
  const salaryEarned = pass1.lines.find((l) => l.code === "SALARY")?.amount ?? 0;
  const arrearsTotal = sum2(arrearsRows.map((c) => c.arrearsAmount));
  const arrearsPfWages = sum2(arrearsRows.map((c) => c.arrearsBaseAmount));
  // Wage this payout carries on top of the month's salary. It lifts the PT slab (state acts levy PT on the
  // salary paid for the month) without being ESI wages, which is why the two bases are assembled separately.
  const ptExtraWage = sum2([
    arrearsTotal,
    otAmount,
    ...bonuses.map((b) => b.amount),
    ...encashments.map((r) => r.amount),
    pass1.lines.find((l) => l.code === "ENCASH")?.amount ?? 0,
  ]);
  // PT already withheld this financial year, so the annual cap is measured against the whole year, not just
  // this payout. The leaver's own finalized runs are the only source - they are in no other.
  const ptPaidThisFy = (await finalizedTotals(deps, fyWindow(settlementDate), undefined, employeeId)).get(employeeId)?.pt ?? 0;
  const statutory = await settlementStatutoryLines(deps, {
    components: effective,
    epfEnrolled: emp.epfEnrolled,
    monthlyGross,
    // PF wages for the final month: the basic actually earned (the same day fraction the salary was paid on),
    // plus the basic slice of any arrears the FnF pays.
    // The SAME day fraction the salary line was paid on - `paidMonthDays` is clamped to the month exactly as
    // computeSettlement clamps it, so the PF wage and the wage it is due on can never describe different months.
    pfWages: round2((comp.basePay * (daysInMonth > 0 ? paidMonthDays / daysInMonth : 0)) + arrearsPfWages),
    // ESI wages: the wage actually paid for the month plus arrears and overtime. Leave encashment, gratuity,
    // bonus and reimbursements are not ESI wages.
    esiWages: round2(salaryEarned + arrearsTotal + otAmount),
    esiSticky: await esiContributingAtExit(deps, employeeId, settlementDate),
    // PT: charged when the payout carries wage at all, on the monthly bracket lifted by the extra wage it
    // pays (bonus, arrears, overtime, encashment), and capped at the year's remaining headroom.
    ptWagePaid: round2(salaryEarned + ptExtraWage),
    ptSlabWage: round2(monthlyGross + ptExtraWage),
    ptYtd: ptPaidThisFy,
  });
  const tds = await settlementTds(deps, emp, settlementDate, pass1.totalTaxableEarnings, effective);
  const settlement = computeSettlement({
    ...facts,
    // Statutory and tax first, then the recoveries: the deduction order the payslip uses.
    extraDeductions: [...statutory, ...(tds > 0 ? [{ name: "Income tax (TDS)", kind: "deduction" as const, amount: tds }] : []), ...extraDeductions],
  });

  // ---- Commit -----------------------------------------------------------------------------------------
  // The FnF is the terminal payout: everything it just priced must LEAVE its source queue, or a later run (or a
  // recomputed settlement) pays it a second time. Every id it consumes is recorded on the settlement itself
  // (settledJson) so releaseSettlementStmts can undo exactly this set.
  //
  // All of it commits in ONE atomic batch, for the reason the payroll build does: as a sequence of independent
  // writes, a failure part-way left payables marked settled and leave days debited under a settlement whose
  // `settledJson` was never written - so the release path had nothing to undo, and the money was both consumed
  // and unpayable. Ids are generated up front (the settlement row and each loan ledger row) so the refs are
  // complete before the first statement runs.
  const at = new Date();
  const settlementId = genId();
  const loanWrites = loans.map((l) => ({ repaymentId: genId(), loanId: l.uuid, amount: l.outstanding }));
  // Encashing the leave balance CONSUMES it: without this the days stay on the books, so a recomputed
  // settlement (or a rehire) would encash the same days again. Only ENCASHABLE types are debited - they are the
  // only ones being paid out. An explicit `leave_days` override larger than those balances pays the days HR
  // asked for but can debit no more than the employee holds.
  const leaveDebits: { balanceId: string; days: number }[] = [];
  let toDebit = round2(leaveDays);
  for (const b of encashableBalances) {
    if (toDebit <= 0.005 || b.balanceDays <= 0) continue;
    const take = round2(Math.min(b.balanceDays, toDebit));
    leaveDebits.push({ balanceId: b.uuid, days: take });
    toDebit = round2(toDebit - take);
  }
  const refs: SettledRefs = {
    reimbursements: reimbClaims.map((r) => r.uuid),
    bonuses: bonuses.map((b) => b.uuid),
    encashments: encashments.map((e2) => e2.uuid),
    overtime: otAmount > 0 ? overtime.map((o) => o.uuid) : [],
    arrears: arrearsRows.map((c) => c.uuid),
    loans: loanWrites,
    leaveDebits,
  };

  const stmts: (BatchStmt | CheckedStmt)[] = [
    deps.db.insert(schema.settlements).values({
      uuid: settlementId,
      code: await allocOwnedCode(deps, schema.settlements, schema.settlements.employeeId, employeeId),
      employeeId,
      settlementDate,
      currency,
      leaveDays,
      noticeShortfallDays,
      linesJson: JSON.stringify(settlement.lines),
      totalEarnings: settlement.totalEarnings,
      totalDeductions: settlement.totalDeductions,
      net: settlement.net,
      // The chargeable slice + the tax withheld on it: Form 16 and the year's projection read the exit payout
      // from here, since a leaver appears in no payroll run.
      taxableEarnings: settlement.totalTaxableEarnings,
      tds,
      settledJson: JSON.stringify(refs),
    }),
  ];
  // Every settled-marker is CHECKED, for the same reason the payroll build checks its paid-by-run markers
  // (services/payroll.ts): the queues above were read at the top of this compute, and a payable can have left
  // one since. A payroll run prices EVERY employee who is not yet `terminated` (payroll.ts roster), and an FnF
  // is routinely computed before the exit transition flips that status - so the run and this settlement are
  // reading the same queue at the same time, for the same person.
  //
  // Each marker's guard stops the wrong flip; without the row count nothing NOTICES. The payable's amount is
  // already summed into `settlement.net` above, so a silently-refused marker is precisely a double payout: paid
  // on the run's payslip and again in the FnF net, with the settlement reporting success. The short count is
  // what turns that into the undo below.
  for (const ids of chunk(refs.reimbursements, 90)) {
    stmts.push({ stmt: markReimbursementsSettledStmt(deps, ids, at).returning({ uuid: schema.reimbursements.uuid }), expect: ids.length, label: "reimbursements" });
  }
  for (const ids of chunk(refs.bonuses, 90)) {
    stmts.push({ stmt: markBonusesSettledStmt(deps, ids, at).returning({ uuid: schema.bonuses.uuid }), expect: ids.length, label: "bonuses" });
  }
  for (const ids of chunk(refs.encashments, 90)) {
    stmts.push({ stmt: markEncashmentsSettledStmt(deps, ids, at).returning({ uuid: schema.leaveEncashments.uuid }), expect: ids.length, label: "leave encashments" });
  }
  for (const ids of chunk(refs.overtime, 90)) {
    stmts.push({ stmt: markOvertimeSettledStmt(deps, ids, at).returning({ uuid: schema.overtimeRequests.uuid }), expect: ids.length, label: "overtime" });
  }
  for (const ids of chunk(refs.arrears, 90)) {
    stmts.push({ stmt: markCompArrearsSettledStmt(deps, ids, at).returning({ uuid: schema.compensation.uuid }), expect: ids.length, label: "salary arrears" });
  }
  // Loan recovery: the same ledger row a repayment always writes (run-less, like a manual repayment) plus a
  // RELATIVE credit to `repaid`, so the loan closes and nothing can collect it twice.
  for (const w of loanWrites) {
    stmts.push(deps.db.insert(schema.loanRepayments).values({ uuid: w.repaymentId, loanId: w.loanId, runId: null, amount: w.amount, at }));
    stmts.push(repaidCreditStmt(deps, w.loanId, w.amount, at));
  }
  for (const d of leaveDebits) {
    stmts.push(deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: sql`max(0, round(${schema.leaveBalances.balanceDays} - ${d.days}, 2))`, updatedAt: at })
      .where(eq(schema.leaveBalances.uuid, d.balanceId)));
  }
  const drifted = await runBatchChecked(deps.db, stmts);
  if (drifted.length) {
    // A payable this settlement priced moved under it. The row just written would pay it without having
    // settled it, so undo the whole settlement back to "never computed" and fail loudly - the same contract
    // the payroll build's drift path keeps. `releaseSettlementStmts` is guarded the same way the markers are
    // (it will not re-queue a claim a RUN paid), so the payable that drifted stays with whoever took it.
    await runBatch(deps.db, [
      ...releaseSettlementStmts(deps, refs, new Date()),
      deps.db.delete(schema.settlements).where(eq(schema.settlements.uuid, settlementId)),
    ]);
    throw failedPrecondition(`payables changed while the settlement was being computed (${[...new Set(drifted)].join(", ")}) - nothing was settled; compute it again`);
  }
  const row = (await deps.db.select().from(schema.settlements).where(eq(schema.settlements.uuid, settlementId)).limit(1))[0]!;

  await audit(deps, actor, "settlement.compute", "settlements", row.uuid, {
    employee: `employees/${employeeId}`,
    ...(coverage.finalPaid ? { final_month: `paid by the committed run for ${coverage.finalPeriodName}` } : {}),
    ...(coverage.unpaid.length ? { unpaid_periods: coverage.unpaid } : {}),
  });
  // Let the leaver know their full & final settlement has been prepared (visible on their profile).
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "settlement.ready", title: "Full & final settlement ready", body: `Your final settlement has been computed (net ${settlement.net}).`, link: "profile", subject: `settlements/${row.uuid}`, actorId: actor.employeeId });
  return row;
}
