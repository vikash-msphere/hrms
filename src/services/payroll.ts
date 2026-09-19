import { allocFlatCode, allocOwnedCode } from "./codeAlloc";
// FSM + LRO resource template. Uses the verified pure domain logic in domain/payroll.ts.
import { and, eq, ne, isNull, inArray, gt, gte, lte, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, removedMeta, stateMeta } from "../lib/audit";
import { notifyMany } from "./notifications";
import { emitEvent } from "./eventBus";
import { notFound, failedPrecondition, aborted } from "../lib/errors";
import { computeRunItem, canTransition, isEditable, applyStructure, overtimePay, employerCostLines, componentLineCode, pfWagesOf, DEFAULT_OVERTIME_CONFIG, DEFAULT_CTC_CONFIG, type Line, type RunState, type OvertimeConfig, type CtcConfig } from "../domain/payroll";
import { round2 } from "../domain/money";
import { decimalsFor, roundMoney, type CurrencyDecimals } from "../domain/currency";
import { loanPerquisiteMonthly, DEFAULT_LOAN_PERQUISITE_CONFIG, type LoanPerquisiteConfig } from "../domain/loans";
import { allStructureLines } from "./salaryStructures";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { tdsComponent, loadTaxConfig, finalizedTotals, fyWindow, monthKey, compAsOf, compGrossPricer, unpaidEarningMonths, projectedGrossForMonths, employedMonthsInFy, collectibleMonths, assembleProjection, readDeclarations, verifiedDeductionsAll, EMPTY_FINALIZED_TOTALS } from "./taxProjection";
import { reimbursementPayoutMode, approvedUnpaidReimbursementsAll, resetReimbursementsPaidByRun, markReimbursementsPaidByRun } from "./reimbursements";
import { approvedUnpaidEncashmentsAll, resetEncashmentsPaidByRun, markEncashmentsPaidByRun } from "./leaveEncashments";
import { unpaidBonusesAll, markBonusesPaidByRun, resetBonusesPaidByRun } from "./bonuses";
import { dueLoanInstallmentsAll, outstandingLoansAll, loanRepaymentWrites, resetLoanRepaymentStmts } from "./loans";
import { runBatch, runBatchChecked, chunk, byIdChunks, insertBatches, groupBy, type BatchStmt, type CheckedStmt } from "../lib/dbBatch";
import { getSettingValue } from "./settings";
import { documentLetterhead, letterheadMark, type OrgWithDocumentLogos } from "./letterheads";
import type { LetterheadSpec } from "../lib/letterPdf";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, type WorkEvent, type LeaveRange, localDay, utcDay, workingDaysInRange, lopDayUnits, lopAmount, employmentFraction, eventCreditByDay, sessionWorkedMinutes } from "../domain/attendance";
import { esiEmployeeContribution, esiContributionPeriod, professionalTax, DEFAULT_PT_CONFIG, type PtConfig } from "../domain/statutory";
import { approvedUnpaidOvertimeAll, markOvertimePaidByRun, resetOvertimePaidByRun } from "./overtimeRequests";
import { resetCompArrearsPaidByRun, markCompArrearsPaidByRun, splitDriftFor } from "./compensation";
import { renderPayslipPdf } from "../lib/pdf";
import { payslipTemplateOrDefault, type PayslipTemplate } from "../domain/payslipTemplate";
import { etagOf } from "../http/serialize";
import { keysetPage } from "./keysetPage";
import { refDepartments, refHolidays, refPayComponents, refPayPeriods } from "../lib/refData";
import { marksForPeriod } from "./attendanceDayMarks";

// Resolve user ids to a display name: the linked employee's full name, else the user's email.
//
// Both reads are BY ID. They used to select the whole `users` table and the whole `employees` table and filter
// in JS - for the two or three ids a run's `submitted_by` / `approved_by` actually name - and the employee
// match was `empIds.includes(e.uuid)` inside the row loop, so the work was rows x ids. That is the pattern the
// D1 read budget is spent on: every payroll-run read, list and verb paid for two full-table scans to put two
// names on a page. Only the columns needed, only the rows named, chunked under the bound-parameter cap.
async function userDisplayNames(deps: Deps, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean) as string[])];
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const users = await byIdChunks(wanted, (group) =>
    deps.db
      .select({ uuid: schema.users.uuid, email: schema.users.email, employeeId: schema.users.employeeId })
      .from(schema.users)
      .where(inArray(schema.users.uuid, group)),
  );
  const empIds = [...new Set(users.map((u) => u.employeeId).filter((e): e is string => !!e))];
  const empName = new Map<string, string>();
  if (empIds.length) {
    for (const e of await byIdChunks(empIds, (group) =>
      deps.db
        .select({ uuid: schema.employees.uuid, firstName: schema.employees.firstName, lastName: schema.employees.lastName })
        .from(schema.employees)
        .where(inArray(schema.employees.uuid, group)),
    )) {
      empName.set(e.uuid, `${e.firstName} ${e.lastName}`);
    }
  }
  for (const u of users) out.set(u.uuid, (u.employeeId && empName.get(u.employeeId)) || u.email);
  return out;
}

// Attach submittedByName/approvedByName for the serializer.
async function withNames<T extends { submittedBy: string | null; approvedBy: string | null }>(deps: Deps, rows: T[]) {
  const names = await userDisplayNames(deps, rows.flatMap((r) => [r.submittedBy, r.approvedBy]));
  return rows.map((r) => ({
    ...r,
    submittedByName: r.submittedBy ? names.get(r.submittedBy) : undefined,
    approvedByName: r.approvedBy ? names.get(r.approvedBy) : undefined,
  }));
}

// A run's staleness rides the ITEM paths only - the detail read and the verbs that answer with a run - because
// it costs a query per input table (see runStaleness). A page of runs deliberately does not carry it, which is
// why this is a helper the item paths call rather than the spec's `decorate`, which the factory also applies to
// a list.
export async function withStaleness<T extends { uuid: string; state: string; payPeriodId: string; itemsBuiltAt: Date | null }>(deps: Deps, run: T) {
  return { ...run, _staleness: await runStaleness(deps, run) };
}

/**
 * Everything that describes ONE build, wiped together.
 *
 * Both reset paths (the rebuild's opening reset, and the rollback when payables drift under a build) put the
 * run back in the clean "never built" state, and every field here has to go with the items or it starts
 * describing a build whose rows are gone: a stale `itemsBuiltAt` reads as "built and up to date" for an EMPTY
 * run, a surviving `unpricedJson` names people against a run that priced nobody, and surviving size figures
 * report last build's money as this run's. One constant so the next field cannot be added to one path only.
 */
const RUN_UNBUILT = { itemsBuiltAt: null, unpricedJson: null, headcount: null, gross: null, net: null } as const;

export async function getRun(deps: Deps, id: string) {
  const r = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, id)).limit(1))[0];
  if (!r) throw notFound("payroll run not found");
  return (await withNames(deps, [r]))[0]!;
}

// Per-employee breakdown of a run (the review surface): each item's computed totals + its earning/deduction
// lines and the employer's own contributions for the period, with the employee's name, ordered by employee code.
// `employer_cost` is the in-CTC part of those contributions and `above_ctc_cost` the part paid over and above CTC
// (each component's own choice), so the reviewer sees total company cost either way.
// Reading rides the run's own access gate.
export async function listRunItems(deps: Deps, runId: string) {
  await getRun(deps, runId); // 404 if the run doesn't exist
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  // By id, and only the three columns this surface renders. A run's items name a bounded set of employees -
  // usually a subset of the org, always at most all of it - so reading the whole `employees` table (every
  // column, including the PII blobs) to label them cost more the larger the org got, on a page that shows a
  // name and a code.
  const emps = new Map(
    (await byIdChunks([...new Set(items.map((it) => it.employeeId))], (group) =>
      deps.db
        .select({ uuid: schema.employees.uuid, code: schema.employees.code, firstName: schema.employees.firstName, lastName: schema.employees.lastName })
        .from(schema.employees)
        .where(inArray(schema.employees.uuid, group)),
    )).map((e) => [e.uuid, e]),
  );
  return items
    .map((it) => {
      const e = emps.get(it.employeeId);
      const lines = JSON.parse(it.linesJson) as Line[];
      const employer = lines.filter((l) => l.kind === "employer_contribution");
      const sum = (ls: Line[]) => round2(ls.reduce((s, l) => s + l.amount, 0));
      return {
        employee: `employees/${it.employeeId}`,
        employee_name: e ? `${e.firstName} ${e.lastName}` : it.employeeId,
        code: e?.code ?? "",
        gross: it.gross,
        taxable_gross: it.taxableGross,
        total_deductions: it.totalDeductions,
        tax: it.tax,
        net: it.net,
        employer_cost: sum(employer.filter((l) => !l.aboveCtc)),
        above_ctc_cost: sum(employer.filter((l) => l.aboveCtc)),
        // Wire lines are snake_case; `aboveCtc` is the stored (internal) spelling.
        lines: lines.map(({ aboveCtc, ...l }) => ({ ...l, ...(aboveCtc ? { above_ctc: true } : {}) })),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code) || a.employee_name.localeCompare(b.employee_name));
}

export async function listRuns(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string) {
  // Paged in SQL (services/keysetPage.ts) rather than by reading every run the scope matches into the isolate
  // and slicing one page out. Runs accrue a row per period forever and are never deleted once published, so
  // the read grew with the org's payroll history on a page that shows twelve of them.
  const { items: slice, nextPageToken } = await keysetPage<typeof schema.payrollRuns.$inferSelect>(deps, schema.payrollRuns, "payroll-runs", applyScope(scope, schema.payrollRuns.code, schema.payrollRuns.code), { dir: "desc", max: maxPageSize, pageToken });
  return { items: await withNames(deps, slice), nextPageToken };
}
function assertEtag(row: { updatedAt: Date }, ifMatch?: string) {
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
}
// The compensation IN FORCE during the pay period - the row effective at the period end - so a run prices the
// period at the salary that applied THEN, not whatever the latest revision happens to be. (Building or
// rebuilding an old period after a raise must not silently apply the new salary.) Falls back to the open row
// when there's no period. A backdated raise's delta for ALREADY-PUBLISHED periods is paid via arrears
// (reviseCompensation); unpublished/future periods pick up the new comp directly here, so nothing double-counts.
// Pure over one employee's (prefetched) compensation rows - the build reads the whole table once and picks
// per employee here, instead of one query per employee. The lookup itself is `compAsOf` (taxProjection.ts), so
// the run and the year's tax projection price a month by exactly the same rule.

// Gather the period's attendance facts once (holidays, approved leave, punches) so the per-employee LOP
// in buildRunItems is pure map lookups. `endYmd` is clamped to today so a mid-period build never charges
// not-yet-arrived days as absences.
async function assembleLop(deps: Deps, period: typeof schema.payPeriods.$inferSelect, att: AttendanceConfig) {
  const tz = att.timezone || "Asia/Kolkata";
  const startMs = +new Date(period.periodStart);
  const endMs = +new Date(period.periodEnd);
  // DATE-ONLY columns, so their days are read in UTC (`utcDay`); `now` is an INSTANT, so its day is read in
  // the org timezone (`localDay`). Mixing the two is what the domain helper's header describes: read through
  // `localDay`, the period's own bounds and every holiday shifted a day earlier west of UTC, so LOP enumerated
  // a window one day off the period - charging the day before it began and never checking the day it ended -
  // while excusing the day before each holiday and docking the holiday itself. The punch days below stay on
  // `localDay`, because a punch IS an instant and the day it belongs to is the org's.
  const startYmd = utcDay(startMs);
  const periodEndYmd = utcDay(endMs);
  const todayYmd = localDay(+deps.clock.now(), tz);
  const endYmd = periodEndYmd < todayYmd ? periodEndYmd : todayYmd;

  const holidays = new Set(
    (await refHolidays(deps))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= startMs && +new Date(h.date) <= endMs)
      .map((h) => utcDay(+new Date(h.date))),
  );
  // EVERY READ BELOW IS BOUND TO THE PERIOD IN SQL. All three used to read their whole table and keep the
  // one month that mattered: approved leave, attendance punches, count-as-work events. Like the ESI probe
  // further down, the cost grew with HISTORY rather than headcount - invisible on a fresh database, and on a
  // real one `attendance_sessions` alone is two rows per employee per working day, all of them read (and
  // billed) on every payroll build. The JS predicates are kept exactly as they were; the SQL windows are the
  // same bounds, only decided by the database. `state` joins them because it is the same one-column filter.
  // The half-day SESSIONS travel with the range. `leaveDays` charges only half a day to the balance for a
  // boundary session, so a range carried here as whole days excused a full day of loss of pay for half a day
  // of leave - see domain/attendance.ts#leaveCover.
  const leaveByEmp = new Map<string, LeaveRange[]>();
  for (const l of await deps.db
    .select()
    .from(schema.leaveRequests)
    .where(and(eq(schema.leaveRequests.state, "APPROVED"), gte(schema.leaveRequests.endDate, new Date(startMs)), lte(schema.leaveRequests.startDate, new Date(endMs))))) {
    if (l.state !== "APPROVED" || +new Date(l.endDate) < startMs || +new Date(l.startDate) > endMs) continue;
    const arr = leaveByEmp.get(l.employeeId) ?? [];
    arr.push({ start: utcDay(+new Date(l.startDate)), end: utcDay(+new Date(l.endDate)), startSession: l.startSession, endSession: l.endSession });
    leaveByEmp.set(l.employeeId, arr);
  }
  const workedByEmp = new Map<string, Map<string, number>>(); // employee -> day -> worked minutes
  // SUPERSEDED PUNCHES ARE NOT PUNCHES. An approved attendance regularization marks the day's existing
  // sessions `superseded_by` and writes the corrected pairs beside them (services/attendanceRegularizations.ts),
  // so the day recomputes from the corrections ALONE - that is the whole contract of a correction. Read
  // unfiltered, this summed the originals AND their replacements into one day's worked minutes, and the error
  // only ever runs one way: extra minutes can only take a day past `half_day_minutes`/`full_day_minutes` and
  // REMOVE loss of pay (domain/attendance.ts lopDayUnits). A correction that shortens a day - a forgotten
  // clock-out recorded as fourteen hours, corrected to three - therefore left seventeen on the day and the
  // absence was never docked. Every other reader of this table already filters it (services/attendance.ts,
  // services/compOff.ts, services/peopleAnalytics.ts, and the regularization's own supersede query).
  for (const s of await deps.db
    .select()
    .from(schema.attendanceSessions)
    .where(and(
      isNull(schema.attendanceSessions.supersededBy),
      gte(schema.attendanceSessions.clockIn, new Date(startMs)),
      lte(schema.attendanceSessions.clockIn, new Date(endMs + 86_400_000)),
    ))) {
    const ms = +new Date(s.clockIn);
    if (ms < startMs || ms > endMs + 86_400_000) continue;
    const day = localDay(ms, tz);
    // An OPEN session is credited, not scored zero - see domain/attendance.ts#sessionWorkedMinutes for why a
    // clock-in was being charged as a full day's absence.
    const minutes = sessionWorkedMinutes(ms, s.clockOut ? +new Date(s.clockOut) : null, +deps.clock.now(), tz);
    let m = workedByEmp.get(s.employeeId);
    if (!m) workedByEmp.set(s.employeeId, (m = new Map<string, number>()));
    m.set(day, (m.get(day) ?? 0) + minutes);
  }
  // count_as_work events credit their attendees' worked minutes, so a day spent off-site isn't docked as an
  // absence. Merged into workedByEmp rather than handled inside lopDayUnits because the credit rules need to
  // know which days the employee actually punched - which is what workedByEmp's keys already record.
  const nowMs = +deps.clock.now();
  const eventsByEmp = new Map<string, WorkEvent[]>();
  for (const e of await deps.db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.countAsWork, true), isNull(schema.events.deleteTime), gte(schema.events.endTime, new Date(startMs - 86_400_000)), lte(schema.events.startTime, new Date(endMs + 86_400_000))))) {
    if (e.deleteTime || !e.countAsWork) continue;
    if (+new Date(e.endTime) < startMs - 86_400_000 || +new Date(e.startTime) > endMs + 86_400_000) continue;
    const ev: WorkEvent = { startMs: +new Date(e.startTime), endMs: +new Date(e.endTime), allDay: !!e.allDay, requiresClockIn: !!e.requiresClockIn };
    let ids: string[];
    try { ids = JSON.parse(e.attendeeIds ?? "[]") as string[]; } catch { continue; }
    for (const id of ids) {
      const arr = eventsByEmp.get(id) ?? [];
      arr.push(ev);
      eventsByEmp.set(id, arr);
    }
  }
  for (const [empId, events] of eventsByEmp) {
    const worked = workedByEmp.get(empId) ?? new Map<string, number>();
    const ranges = leaveByEmp.get(empId) ?? [];
    const credit = eventCreditByDay({
      events,
      tz,
      workDays: att.work_days,
      fullDayMinutes: att.full_day_minutes ?? 480,
      todayYmd,
      nowMs,
      punchedDays: new Set(worked.keys()), // taken before the merge below, so credit never counts as a punch
      onLeave: (d) => ranges.some((r) => r.start <= d && d <= r.end),
    });
    if (!credit.size) continue;
    for (const [day, m] of credit) worked.set(day, (worked.get(day) ?? 0) + m);
    workedByEmp.set(empId, worked);
  }

  // HR's day marks for the period. A mark replaces what the punches say a day was worth, so it is read
  // alongside them rather than folded into `workedByEmp` - the minutes stay the minutes (the payslip's
  // attendance strip and every other reader still want them), and only the VALUE of the day changes.
  const marksByEmp = await marksForPeriod(deps, startMs, endMs);

  const workingDaysInPeriod = workingDaysInRange(startYmd, periodEndYmd, att.work_days, holidays);
  return { startYmd, endYmd, holidays, leaveByEmp, workedByEmp, marksByEmp, workingDaysInPeriod };
}

export async function createRun(deps: Deps, actor: AppUser, payPeriodPath: string) {
  const payPeriodId = payPeriodPath.split("/").pop()!;
  const row = (await deps.db.insert(schema.payrollRuns).values({ code: await allocFlatCode(deps, schema.payrollRuns), payPeriodId, createdBy: actor.uuid }).returning())[0]!;
  await audit(deps, actor, "payroll.create", "payroll-runs", row.uuid, createdMeta(row, "payroll-runs"), row);
  return row;
}

// Build per-employee line items from current comp + recurring components + one-off inputs (incl. LOP).
export async function buildRunItems(deps: Deps, actor: AppUser, runId: string, oneOffs: Record<string, Line[]> = {}, ifMatch?: string) {
  const run = await getRun(deps, runId);
  assertEtag(run, ifMatch);
  if (!isEditable(run.state as RunState)) throw failedPrecondition("run is not editable");

  // EVERY employee who has not left, and not soft-deleted. Excluding `terminated` rather than including only
  // `active` is the fail-safe direction: the status enum also carries `on_leave`, and paying only "active" would
  // silently drop those people from payroll the day anything starts setting it. deleteEmployee only stamps
  // `deleteTime` (status stays as-is), so filtering on status alone would keep paying a deleted employee -
  // salary, statutory contributions and all. (Leavers are out of runs deliberately: the FnF is their payout.)
  // Filtered in SQL, not read-all-then-filter: D1 bills rows read, and a build on a large org otherwise pays
  // for every leaver and every soft-deleted row it is about to discard.
  const employees = await deps.db
    .select()
    .from(schema.employees)
    .where(and(isNull(schema.employees.deleteTime), ne(schema.employees.status, "terminated")));
  // Apply every component that's enabled (not disabled) and not soft-deleted.
  const components = (await refPayComponents(deps)).filter((c) => !c.disabled && !c.deleteTime);
  // Salary structures (lines by id), loaded once: an employee with an assigned structure gets only that
  // structure's earning components (with its rate overrides); deductions/statutory lines always apply.
  const structById = await allStructureLines(deps);

  // Income-tax (TDS): driven by a configured `income_tax` deduction component (opt-in). Compute each
  // employee's monthly TDS for the run's financial year, with deducted-to-date taken from OTHER finalized
  // runs in that FY (this run excluded), so a salary/bonus change redistributes the balance automatically.
  const tds = tdsComponent(components);
  const period = (await deps.db.select().from(schema.payPeriods).where(eq(schema.payPeriods.uuid, run.payPeriodId)).limit(1))[0];
  const fy = fyWindow(period?.payDate ?? new Date());
  const cfg = tds ? await loadTaxConfig(deps) : null;
  // Employee-side Professional Tax (kind "deduction"); the slab table is settings data. Resolved here rather
  // than beside the other statutory lookups below because an `annual_cap` needs the year's PT already
  // collected, which is the same finalized-run read the TDS projection makes.
  const ptComp = components.find((c) => c.method === "pt" && c.kind === "deduction" && c.recurring);
  const ptCfg = ptComp ? await getSettingValue<PtConfig>(deps, "professional-tax", DEFAULT_PT_CONFIG) : null;
  // The FY's finalized runs: deducted-to-date for TDS, and PT-to-date when the state caps the year. Read once,
  // and only when something actually needs it - it is the app's hottest read path on D1.
  const paidTotals = tds || ptCfg?.annual_cap != null ? await finalizedTotals(deps, fy, runId) : new Map();
  // Prices any compensation row's monthly gross, so the months still to be earned this FY can each be valued
  // at the salary in force in THAT month rather than at this period's rate.
  const grossFor = compGrossPricer(components, structById);
  // The month whose SALARY this run prices (its period), which is what the projection must exclude from the
  // still-to-be-earned months. Distinct from the pay-date month, which is when the tax is collected.
  const runEarnedMonthKey = monthKey(period?.periodStart ?? new Date());

  // A rebuild first releases everything the PREVIOUS build of this run marked paid (idempotency), and drops
  // the old items. All of it goes in ONE atomic batch - one subrequest, and a crash can't leave the run
  // half-reset. After this batch the run is in the clean "never built" state (items gone, nothing stamped
  // paid by it, `itemsBuiltAt` cleared); the second batch at the end of the build commits the new state
  // atomically. (Loan resets need two small reads first - see loans.ts.)
  //
  // EVERY kind is released unconditionally, exactly as releasePaidByRun does, and for the same reason: a
  // reset matches only rows whose paidRunId is this run, so releasing a kind the run never used is a no-op -
  // whereas gating a release on the CURRENT config strands the previous build's payouts when the config
  // changed since (flip reimbursements to "separate", or turn overtime off, and a rebuild would leave those
  // rows marked paid by a run that no longer pays them - the employee is never paid).
  const payViaPayroll = (await reimbursementPayoutMode(deps)) === "payroll";
  const otCfg = await getSettingValue<OvertimeConfig>(deps, "overtime", DEFAULT_OVERTIME_CONFIG);
  // What the PREVIOUS build of this run came to, read before its items are dropped below. It is the "from"
  // half of the audit diff at the end: a rebuild that moves the company's net pay by a lakh and one that
  // changes nothing are the same entry without it.
  const prior = await deps.db.select({ gross: schema.payrollRunItems.gross, net: schema.payrollRunItems.net, tax: schema.payrollRunItems.tax }).from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  const priorTotals = prior.length
    ? { employees: prior.length, gross: round2(prior.reduce((s, r) => s + r.gross, 0)), net: round2(prior.reduce((s, r) => s + r.net, 0)), tax: round2(prior.reduce((s, r) => s + (r.tax ?? 0), 0)) }
    : null;
  await runBatch(deps.db, [
    deps.db.delete(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId)),
    ...(await releasePaidByRun(deps, runId)),
    // Un-stamp the build: until the commit batch below lands, this run has no items, and a `built_time` left
    // pointing at the previous build would read as "built and up to date" for an EMPTY run (runStaleness
    // compares inputs against it) - which an approver could then approve and publish, paying nobody.
    // The unpriced list is cleared with it: it describes ONE build, and a list outliving the items it was
    // written beside would name people against a run that has not priced anybody. So are the size figures,
    // for exactly the same reason - a run with no items reporting last build's gross is the same lie.
    deps.db.update(schema.payrollRuns).set(RUN_UNBUILT).where(eq(schema.payrollRuns.uuid, runId)),
  ]);
  const periodEndMs = period ? +new Date(period.periodEnd) : undefined;
  const now = new Date();

  // Every payout queue + compensation, prefetched in ONE read each and grouped by employee - the per-employee
  // loop below touches the DB not at all, so the build's subrequest count is flat in headcount (the free-plan
  // Workers budget is 50 an invocation).
  // Live revisions only: a revision removed as an entry error is out of the timeline, so it must not be the row
  // compForPeriod finds effective for a period.
  const compByEmp = groupBy(await deps.db.select().from(schema.compensation).where(isNull(schema.compensation.deleteTime)), (r) => r.employeeId);
  const encashByEmp = groupBy(await approvedUnpaidEncashmentsAll(deps), (r) => r.employeeId);
  const bonusByEmp = groupBy(await unpaidBonusesAll(deps), (r) => r.employeeId);
  const otByEmp = otCfg.enabled ? groupBy(await approvedUnpaidOvertimeAll(deps, periodEndMs), (r) => r.employeeId) : new Map<string, never[]>();
  const reimbByEmp = payViaPayroll ? groupBy(await approvedUnpaidReimbursementsAll(deps), (r) => r.employeeId) : new Map<string, never[]>();
  // Loans due IN THIS PERIOD: not started yet, or already collected by another run whose period covers the same
  // month, and nothing is due (see dueLoanInstallmentsAll).
  const dueLoansByEmp = await dueLoanInstallmentsAll(deps, { payDate: period?.payDate, periodEnd: period?.periodEnd, excludeRunId: runId });
  // Interest concession on a cheap employer loan is a taxable perquisite (Rule 3(7)(i)) - opt-in policy data.
  const perqCfg = await getSettingValue<LoanPerquisiteConfig>(deps, "loan-perquisite", DEFAULT_LOAN_PERQUISITE_CONFIG);
  const perqLoansByEmp = perqCfg.enabled ? await outstandingLoansAll(deps) : new Map<string, { principal: number; installments: number; monthlyAmount: number; repaid: number }[]>();
  // Verified Chapter VI-A declarations for the run's financial year, for EVERY employee, in one read. This was
  // the one thing the loop below still went to the DB for (`verifiedDeductions(deps, e.uuid, ...)`), which made
  // the paragraph above false: the build was one subrequest per employee and stopped working at a few dozen
  // people. Read here with the rest of the prefetch so the loop is what it claims to be. Only read when a TDS
  // component is configured, because nothing else consults it.
  const declaredByEmp = tds ? await verifiedDeductionsAll(deps, fy.financialYear) : new Map<string, Record<string, number>>();

  // What the loop decides, collected for the single write batch after it.
  const paidEncashIds: string[] = [];
  const paidBonusIds: string[] = [];
  const paidOtIds: string[] = [];
  const paidArrearIds: string[] = [];
  const paidReimbIds: string[] = [];
  const loanEntries: { loanId: string; amount: number }[] = [];
  const itemRows: (typeof schema.payrollRunItems.$inferInsert)[] = [];
  // Employees the loop below considered and could not price. Recorded on the run so the omission is visible -
  // see `payroll_runs.unpriced_json` in db/schema.ts for why a silent skip is the wrong failure mode here.
  const unpriced: string[] = [];

  // Loss-of-pay for unexcused absences (opt-in via settings/attendance.lop_enabled). Assemble the period's
  // holidays, approved leave and attendance punches ONCE; the per-employee absent-day count + amount follow.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const lop = att.lop_enabled && period ? await assembleLop(deps, period, att) : null;

  // Proration for partial-period employment (mid-period joiners/leavers): a per-employee factor on the regular
  // earnings, by the configured basis. Needs the period ymds + holidays (for the working-days basis); reuse the
  // LOP facts when present, else compute the minimal holiday set once. A full-period employee gets factor 1.
  const prorationBasis = att.proration_basis ?? "calendar_days";
  // DATE-ONLY columns: their day is the UTC one they are anchored at, never the org-local reading of that
  // instant. See domain/attendance.ts#utcDay - through `localDay` the proration window shifted a day earlier
  // west of UTC, which the `working_days` basis turns into a different weekday composition and therefore a
  // different factor on every partial-period employee's pay.
  const periodStartYmd = period ? utcDay(+new Date(period.periodStart)) : "";
  const periodEndYmd = period ? utcDay(+new Date(period.periodEnd)) : "";
  // Half-day and location-scoped holidays are counted here as ordinary company holidays on purpose: this set
  // only ever EXCUSES a day (LOP, and the working-days proration basis), so the lenient reading can never dock
  // someone for a day the office may have been shut. Leave charging, where the distinction changes what an
  // employee spends, is precise about both (services/leaveRequests.ts).
  const holidaySet = !period ? new Set<string>() : lop?.holidays ?? new Set(
    (await refHolidays(deps))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= +new Date(period.periodStart) && +new Date(h.date) <= +new Date(period.periodEnd))
      .map((h) => utcDay(+new Date(h.date))),
  );
  // THE PERIOD'S SCHEDULED WORKING DAYS, WHETHER OR NOT ATTENDANCE-DRIVEN LOP IS ENABLED.
  //
  // This is the divisor `lopAmount` uses under the default `working_days` basis, and it used to be read off
  // `lop?.workingDaysInPeriod ?? 30`. `lop` is null whenever `settings/attendance.lop_enabled` is false -
  // which is the DEFAULT (domain/attendance.ts DEFAULT_ATTENDANCE) - while a manually keyed loss of pay is
  // still accepted in that configuration. So the per-day rate fell back to a 30-day month on an org whose
  // basis says ~22, and the day-units derived from it (`amount / rate`) came out ~35% too high: a ₹5,000
  // manual LOP against a ₹50,000 gross read as 3.0 days instead of 2.2. Those units are not cosmetic - they
  // are what services/statutoryReport.ts sums into `ncpDays`, the non-contributing days on the PF ECR - so a
  // statutory return overstated absence for every manual LOP in a default-configured org.
  //
  // Computed from the same holiday set two lines up, so it costs no query of its own (`refHolidays` is a
  // per-request cached reference read); `assembleLop` derives its own copy from the same helper, so the two
  // cannot disagree. Only the fallback for a run with no period stays 30 - with no period there are no bounds
  // to count, and `days_30` is the honest reading of "a month" there.
  const workingDaysInPeriod = lop?.workingDaysInPeriod ?? (period ? workingDaysInRange(periodStartYmd, periodEndYmd, att.work_days, holidaySet) : 30);

  // The payslip is rendered in the org currency, and every line total is summed as a bare number. The app is
  // single-currency: guard the invariant so an employee's comp - or any payable - in a different currency fails
  // the build loudly instead of silently corrupting the totals (e.g. adding a USD bonus as if it were rupees).
  const orgSettings = await getSettingValue<{ default_currency?: string; currency_decimals?: CurrencyDecimals }>(deps, "organization", {});
  const orgCurrency = orgSettings.default_currency || "INR";
  // The precision the money is actually DISBURSED at (whole rupees for INR by default). Each item's net is
  // settled to it with an explicit rounding line, so the payslip, the ledger and the bank file all state the
  // same figure instead of differing by up to half a rupee per employee with nothing to reconcile the gap.
  const payoutDp = decimalsFor(orgCurrency, orgSettings.currency_decimals);
  // Which wage PF is computed on (basic, or basic + universally-paid allowances) - org policy, settings/ctc.
  const pfBasis = (await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG)).pf_wage_basis ?? "basic";

  // Statutory deductions on the regular monthly gross (computed per employee below, after earnings): ESI (% of
  // gross up to an eligibility ceiling) and Professional Tax (a state slab). Each is an opt-in single component;
  // PT slabs come from settings. Loaded once.
  // Employee-side ESI (kind "deduction"); the employer-contribution ESI row (same method) is costed below.
  // The PT component + its slab table are resolved earlier, with the finalized-run read its annual cap needs.
  const esiComp = components.find((c) => c.method === "esi" && c.kind === "deduction" && c.recurring);


  // ESI is "sticky" within a contribution period (Apr-Sep / Oct-Mar): a worker eligible at the period start
  // keeps contributing to period-end even after a raise past the ceiling. Practical proxy: anyone who already
  // had an ESI line in a FINALIZED run earlier in THIS contribution period keeps contributing now. Built once.
  //
  // NARROWED IN SQL, both halves. This probe used to read the WHOLE of `payroll_runs` and then the WHOLE of
  // `payroll_run_items` and filter both in JS - `JSON.parse`-ing every line array the app has ever stored to
  // look for one code. The `priorRunIds` set that bounds the second read was already being built right here
  // and simply not used in the query. Unlike the per-employee loop below, the cost grew with HISTORY rather
  // than headcount, so it was invisible on a fresh database and unbounded on a real one: D1 bills rows read,
  // and `lines_json` for a full run is the largest text this file parses, so it was also the first thing to
  // spend the invocation's CPU. The pay-date window is applied to the CACHED period list (refPayPeriods) and
  // bound as an id list, so both reads now touch only the contribution period they are about.
  const esiContributing = new Set<string>();
  if (esiComp && period) {
    const cp = esiContributionPeriod(period.payDate);
    const periodIdsInWindow = (await refPayPeriods(deps))
      .filter((p) => +new Date(p.payDate) >= cp.start && +new Date(p.payDate) < cp.end)
      .map((p) => p.uuid);
    const priorRunIds = periodIdsInWindow.length
      ? (
          await byIdChunks(periodIdsInWindow, (group) =>
            deps.db
              .select({ uuid: schema.payrollRuns.uuid })
              .from(schema.payrollRuns)
              .where(and(inArray(schema.payrollRuns.payPeriodId, group), inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"]), ne(schema.payrollRuns.uuid, runId))),
          )
        ).map((r) => r.uuid)
      : [];
    if (priorRunIds.length) {
      // Two columns, not the whole row: the employee and the line array are all the probe reads, and the row
      // also carries every total it computed.
      for (const it of await byIdChunks(priorRunIds, (group) =>
        deps.db
          .select({ employeeId: schema.payrollRunItems.employeeId, linesJson: schema.payrollRunItems.linesJson })
          .from(schema.payrollRunItems)
          .where(inArray(schema.payrollRunItems.runId, group)),
      )) {
        if (esiContributing.has(it.employeeId)) continue;
        if ((JSON.parse(it.linesJson) as Line[]).some((l) => l.code === "ESI")) esiContributing.add(it.employeeId);
      }
    }
  }

  for (const e of employees) {
    const compRows = compByEmp.get(e.uuid) ?? [];
    const comp = compAsOf(compRows, periodEndMs);
    // No salary in force for this period, so there is nothing to price. RECORDED, not merely skipped: this is
    // the state a new joiner whose compensation was never entered is in, and a run that drops them without
    // saying so pays everyone except the one person nobody has checked on.
    //
    // Recorded only for someone who was actually EMPLOYED during the period, though. A future joiner already
    // on the roster has no salary in force yet and is correctly absent from this run - listing them would make
    // the warning fire on every run that has a start date in the diary, which is how a warning stops being
    // read. Same at the other end for a leaver dated out before the period opened. What is left is the case
    // the list exists for: somebody who worked this period and has no compensation on record.
    if (!comp) {
      const startMs = e.startDate ? +new Date(e.startDate) : null;
      const endMs = e.endDate ? +new Date(e.endDate) : null;
      const employedInPeriod =
        !period || ((startMs === null || startMs <= +new Date(period.periodEnd)) && (endMs === null || endMs >= +new Date(period.periodStart)));
      if (employedInPeriod) unpriced.push(e.uuid);
      continue;
    }
    if ((comp.currency || "INR") !== orgCurrency) {
      throw failedPrecondition(`${e.firstName} ${e.lastName}'s compensation is in ${comp.currency || "INR"}, but payroll runs in ${orgCurrency}`);
    }
    // This employee's effective component set (their structure's earnings + all global deductions/statutory).
    const effective = applyStructure(components, comp.structureId ? structById.get(comp.structureId) ?? null : null);
    // Partial-employment proration factor (1.0 for a full-period employee). Applied to the BASIC, Special
    // Allowance and every recurring EARNING (fixed + percent-of-base); EPF rides the prorated base too. Fixed
    // DEDUCTIONS are not prorated. In-window absences are still docked separately by LOP at the full daily rate.
    const empStartYmd = e.startDate ? utcDay(+new Date(e.startDate)) : null;
    const empEndYmd = e.endDate ? utcDay(+new Date(e.endDate)) : null;
    const factor = period
      ? employmentFraction({ periodStartYmd, periodEndYmd, empStartYmd, empEndYmd, workDays: att.work_days, holidays: holidaySet, basis: prorationBasis })
      : 1;
    const base = comp.basePay * factor;
    const special = comp.specialAllowance * factor;
    // Base pay is the contractual BASIC (prorated for partial employment). The employer's PF share is an
    // employer-side cost, costed separately at the end of the item - it is never withheld from this base pay.
    const lines: Line[] = [{ code: "BASIC", name: "Basic", kind: "earning", amount: round2(base) }];
    // Special Allowance: the balancing plug of a top-down (CTC-in) comp row. A taxable fixed earning, so it
    // rides in gross (and thus the ESI/PT statutory base below) and taxable gross. 0 for basic-in rows.
    if (special > 0) lines.push({ code: "SPECIAL", name: "Special Allowance", kind: "earning", amount: round2(special) });
    for (const co of effective) {
      // Base pay comes from compensation (the "BASIC" line above); components are extra earnings/deductions.
      // income_tax is engine-computed below, not a flat/percent line.
      if (co.kind === "employer_contribution") continue; // employer PF/ESI/gratuity: costed separately at the end of the item
      // esi/pt/epf are computed further down, once the period's statutory bases (net of loss of pay, plus
      // arrears and overtime) are known - they cannot be priced off the undocked wage here.
      if (!co.recurring || co.method === "income_tax" || co.method === "esi" || co.method === "pt" || co.method === "epf") continue;
      if (co.method === "edli" || co.method === "pf_admin") continue; // employer-side PF charges, costed at the end
      // A fixed EARNING is prorated for partial employment; a fixed DEDUCTION is charged in full.
      const amount =
        co.method === "fixed" ? (co.rate ?? 0) * (co.kind === "earning" ? factor : 1)
        : co.method === "percent_base" ? base * ((co.rate ?? 0) / 100)
        : 0;
      // The code is derived from the name, never the raw name: it is matched by exact code downstream, so a
      // component HR happens to call "PT" or "LOP" must not land in the statutory register or be re-read as a
      // loss-of-pay line. The displayed `name` is untouched.
      if (amount) lines.push({ code: componentLineCode(co.name), name: co.name, kind: co.kind, amount: round2(amount) });
    }
    // The regular monthly wage (base + recurring earnings), BEFORE loss of pay and before any one-off, bonus or
    // encashment: statutory ELIGIBILITY (the ESI ceiling) and the PT slab key off the steady wage rate, not off a
    // docked month or a one-time spike. The CONTRIBUTION bases are assembled after the docking below.
    const regularGross = round2(lines.filter((l) => l.kind === "earning").reduce((s, l) => s + l.amount, 0));
    // Eligibility and the PT slab use the FULL monthly wage rate, not the prorated partial-month amount - else a
    // high-wage mid-period joiner drops under the ESI ceiling and is wrongly charged ESI, or falls into a lower PT
    // slab. factor is 1 for a full-period employee, so fullMonthlyBase == regularGross then (no-op).
    const fullMonthlyBase = factor > 0 ? round2(regularGross / factor) : regularGross;
    // The per-day rate an absence is priced at, from the same wage + divisor policy the automatic docking below
    // uses. Hoisted because a MANUAL loss of pay arrives as a rupee amount and still has to state its day-units
    // (the PF/ESI registers report non-contributing days, not rupees).
    const lopWage = (att.lop_wage_basis ?? "gross") === "basic" ? comp.basePay : fullMonthlyBase;
    const lopDailyRate = lopAmount(lopWage, 1, att.lop_basis ?? "working_days", workingDaysInPeriod);

    // One-off inputs the caller passed for this employee (manual adjustments, statutory deduction inputs, a
    // manually keyed loss of pay). A manual LOP arrives as a deduction line coded "LOP"; it is normalised to a
    // NEGATIVE EARNING for exactly the reason the automatic one is (below): docked pay must leave gross and every
    // statutory/tax base, not sit beside them as a deduction. Its day-units are derived from the same daily rate
    // so the statutory register can count it as non-contributing days.
    let manualLop = 0;
    for (const l of oneOffs[e.uuid] ?? []) {
      if (l.kind === "deduction" && l.code === "LOP" && l.amount > 0) {
        manualLop = round2(manualLop + l.amount);
        const units = lopDailyRate > 0 ? round2(l.amount / lopDailyRate) : 0;
        lines.push({ ...l, kind: "earning", amount: round2(-l.amount), units });
      } else {
        lines.push(l);
      }
    }

    // Automatic loss-of-pay: per-day base pay x unexcused day-units (absent=1, half day=0.5) in the period.
    let autoLop = 0;
    if (lop) {
      // Clamp the absence window to employment: pre-joining / post-leaving days are handled by proration above,
      // not counted as unauthorised absences here (else a joiner is docked twice).
      const lopStartYmd = empStartYmd && empStartYmd > lop.startYmd ? empStartYmd : lop.startYmd;
      const lopEndYmd = empEndYmd && empEndYmd < lop.endYmd ? empEndYmd : lop.endYmd;
      const dayUnits = lopDayUnits({
        startYmd: lopStartYmd,
        endYmd: lopEndYmd,
        workDays: att.work_days,
        holidays: lop.holidays,
        leaveRanges: lop.leaveByEmp.get(e.uuid) ?? [],
        workedByDay: lop.workedByEmp.get(e.uuid) ?? new Map<string, number>(),
        marksByDay: lop.marksByEmp.get(e.uuid),
        fullDayMinutes: att.full_day_minutes ?? 480,
        halfDayMinutes: att.half_day_minutes ?? 240,
      });
      // Never dock more than the period's regular wage (a full-month absence zeroes the salary, it doesn't turn
      // it negative - which a prorated part-month at the full daily rate could otherwise do). `lopWage` is the
      // FULL monthly regular gross by default (basic + every recurring allowance + the Special Allowance plug),
      // because an unworked day earned none of them. Rounded ONCE from the unrounded per-day rate.
      const amt = Math.min(lopAmount(lopWage, dayUnits, att.lop_basis ?? "working_days", workingDaysInPeriod), Math.max(0, round2(regularGross - manualLop)));
      // Loss of pay is a NEGATIVE EARNING, not a deduction: it is wage the employee never earned, so it has to
      // leave gross, the income-tax base AND the PF/ESI bases together. As a deduction line it left every one of
      // those bases at the undocked wage, so a docked month withheld income tax, ESI and PT on pay that was never
      // made - and the inflated taxableGross then skewed the whole year's projection and Form 16.
      if (amt > 0) {
        autoLop = amt;
        // `units` carries the day count as DATA: the statutory register reports non-contributing (NCP) days and
        // must not have to parse them back out of a display label.
        lines.push({ code: "LOP", name: `Loss of pay (${dayUnits}d)`, kind: "earning", amount: round2(-amt), units: dayUnits });
      }
    }
    const lopTotal = round2(autoLop + manualLop);

    // Leave encashment payouts: TAXABLE earning (encashment is salary income, so it lifts the TDS base below).
    const encashments = encashByEmp.get(e.uuid) ?? [];
    for (const r of encashments) if ((r.currency || "INR") !== orgCurrency) throw failedPrecondition(`a leave encashment for ${e.firstName} ${e.lastName} is in ${r.currency || "INR"}, not ${orgCurrency}`);
    const encashDays = encashments.reduce((s, r) => s + r.days, 0);
    const encashTotal = encashments.reduce((s, r) => s + r.amount, 0);
    if (encashTotal > 0) {
      lines.push({ code: "ENCASH", name: `Leave encashment (${round2(encashDays)} day(s))`, kind: "earning", amount: round2(encashTotal) });
    }
    // Marked paid whenever the QUEUE is non-empty, not only when it comes to money - the same rule the bonus
    // block below already follows. Inside the amount guard, an approved encashment of zero days (or one an
    // encashment rate priced at nothing) was never settled: it stayed in the approved-unpaid queue, was read
    // again by every later build, and quietly widened the staleness surface for a payable nobody could clear.
    paidEncashIds.push(...encashments.map((r) => r.uuid));

    // Bonuses (individual + group awards): each unpaid award is a TAXABLE earning line, so it lifts the TDS
    // base below; then mark them paid by this run. One line per award, labelled by its kind.
    const empBonuses = bonusByEmp.get(e.uuid) ?? [];
    for (const b of empBonuses) {
      if ((b.currency || "INR") !== orgCurrency) throw failedPrecondition(`a bonus for ${e.firstName} ${e.lastName} is in ${b.currency || "INR"}, not ${orgCurrency}`);
      lines.push({ code: "BONUS", name: b.kind || "Bonus", kind: "earning", amount: round2(b.amount) });
    }
    paidBonusIds.push(...empBonuses.map((b) => b.uuid));

    // Overtime pay: approved-unpaid overtime (up to the period end) priced from base pay, as a TAXABLE earning.
    let otAmt = 0;
    if (otCfg.enabled) {
      const ot = otByEmp.get(e.uuid) ?? [];
      const otMinutes = ot.reduce((s, r) => s + Math.max(0, Math.round((+new Date(r.endTime) - +new Date(r.startTime)) / 60000)), 0);
      otAmt = overtimePay(otMinutes, comp.basePay, otCfg);
      if (otAmt > 0) {
        const h = Math.floor(otMinutes / 60), m = otMinutes % 60;
        lines.push({ code: "OT", name: `Overtime (${h}h${m ? ` ${m}m` : ""})`, kind: "earning", amount: otAmt });
      }
      // Settled on the queue, not on the amount - see the encashment note above. Overtime the current config
      // prices at zero (a multiplier of 0, or minutes under the rounding floor) is still overtime this run
      // consumed, and leaving it queued means every future build re-reads it forever.
      paidOtIds.push(...ot.map((r) => r.uuid));
    }

    // Backdated-increment arrears: every UNPAID arrears amount the employee has accrued, paid once as a TAXABLE
    // earning. Scanning all of their comp rows - not just the period-effective one - matters when a second
    // revision lands before the first one's arrears were paid: the first row is closed by then, so keying off
    // the effective row alone would strand that raise's back pay forever.
    // `arrearsPaidAt` with no run = paid by an FnF settlement; either marker means the arrears are settled.
    const unpaidArrears = (compByEmp.get(e.uuid) ?? []).filter((c) => c.arrearsAmount > 0 && !c.arrearsPaidRunId && !c.arrearsPaidAt);
    for (const c of unpaidArrears) if ((c.currency || "INR") !== orgCurrency) throw failedPrecondition(`salary arrears for ${e.firstName} ${e.lastName} are in ${c.currency || "INR"}, not ${orgCurrency}`);
    const arrearsTotal = round2(unpaidArrears.reduce((s, c) => s + c.arrearsAmount, 0));
    // The PF-wage slice of those arrears (the rise in BASIC over the same months): PF is due on arrears of basic
    // wages, ESI on the whole arrears amount.
    const arrearsPfWages = round2(unpaidArrears.reduce((s, c) => s + c.arrearsBaseAmount, 0));
    if (arrearsTotal > 0) {
      lines.push({ code: "ARREARS", name: "Salary arrears", kind: "earning", amount: arrearsTotal });
    }
    // Settled on the QUEUE, not on the amount - the same rule the encashment, overtime and reimbursement
    // blocks above follow. Every row here has `arrearsAmount > 0`, but the total is rounded to the paise, so a
    // set of sub-paise arrears rows priced at 0.00 was left unmarked: still unpaid, re-read by every later
    // build, and never clearable by anything short of a hand edit. Consuming them here closes the queue.
    paidArrearIds.push(...unpaidArrears.map((c) => c.uuid));

    // Reimbursement payouts: non-taxable earning (paid in net, excluded from the income-tax base).
    if (payViaPayroll) {
      const claims = reimbByEmp.get(e.uuid) ?? [];
      const total = claims.reduce((s, r) => s + r.amount, 0);
      if (total > 0) {
        lines.push({ code: "REIMB", name: "Reimbursement", kind: "earning", amount: round2(total), taxable: false });
      }
      // Settled on the queue, not on the amount - see the encashment note above.
      paidReimbIds.push(...claims.map((r) => r.uuid));
    }

    // ---- Statutory contribution bases -------------------------------------------------------------------
    // The two bases are DIFFERENT wages, and each is now the wage actually paid this period:
    //  - ESI wages: the regular wage net of loss of pay, PLUS arrears and overtime (both are wages under the ESI
    //    Act, and remittance on them is due in the month they are paid). Bonus, leave encashment and
    //    reimbursements are excluded - they are not ESI wages.
    //  - PF wages: basic (or basic + the allowances HR flagged, per the configured basis) net of loss of pay, plus
    //    the BASIC slice of any arrears. Overtime and bonus are excluded from basic wages by statute.
    const esiWages = Math.max(0, round2(regularGross - lopTotal + arrearsTotal + otAmt));
    const pfWages = Math.max(0, round2(pfWagesOf(base, special, effective, pfBasis) - lopTotal + arrearsPfWages));
    // EPF employee share: rate% (default 12) of PF wages, capped at the wage ceiling when the component sets one.
    // Opt-in per employee; the employer's mirror share is costed at the end of the item off the same figure.
    const epfComp = effective.find((c) => c.method === "epf" && c.kind === "deduction" && c.recurring);
    if (epfComp && e.epfEnrolled) {
      const epf = round2(Math.min(pfWages, epfComp.cap ?? Infinity) * ((epfComp.rate ?? 12) / 100));
      // The stable "EPF" code is what the statutory report + ECR find the member's contribution by, and `basis`
      // states the PF wages it was priced on - the register must report the wage, not a figure reverse-derived
      // from a rounded contribution (which returns the ceiling instead of the real wage whenever one applies).
      if (epf > 0) lines.push({ code: "EPF", name: epfComp.name, kind: "deduction", amount: epf, basis: pfWages });
    }
    // ESI eligibility for this employee this period. Decided once: the employee's own deduction and the
    // employer's share (below) must never disagree about whether this worker is in ESI.
    let esiEligible: boolean | undefined;
    if (esiComp) {
      const ceiling = esiComp.cap ?? 21000;
      // Eligible if within the ceiling on the full monthly wage, OR already contributing earlier this
      // contribution period (sticky - a mid-period raise past the ceiling doesn't stop ESI till period end).
      esiEligible = (fullMonthlyBase > 0 && fullMonthlyBase <= ceiling) || esiContributing.has(e.uuid);
      const esi = esiEligible && esiWages > 0 ? esiEmployeeContribution(esiWages, esiComp.rate ?? 0.75, Infinity) : 0;
      // ESIC rounds both shares UP to the rupee, so dividing the contribution back out overstates the wage;
      // `basis` carries the wage the contribution was actually computed on.
      if (esi > 0) lines.push({ code: "ESI", name: esiComp.name, kind: "deduction", amount: esi, basis: esiWages });
    }
    if (ptComp && ptCfg) {
      // PT is a monthly slab on the wage BRACKET, and state PT acts levy it on the salary/wage paid for the
      // month - so a bonus, arrears or overtime month can push the employee into a higher slab. The bracket is
      // the full monthly wage rate (unprorated, so a mid-month joiner isn't dropped into a lower slab) plus the
      // extra wage this month actually pays. A month that pays no wage at all attracts nothing.
      const extraWagePaid = round2(arrearsTotal + otAmt + encashTotal + empBonuses.reduce((s, b) => s + b.amount, 0));
      const wagePaid = round2(Math.max(0, regularGross - lopTotal) + extraWagePaid);
      const slabWage = round2(fullMonthlyBase + extraWagePaid);
      // Most state acts cap the year's PT (₹2,500 under Article 276(2)). `annual_cap` is config, and the year's
      // collection so far comes from this FY's finalized runs, so the last months of a high-wage year stop
      // charging instead of over-collecting.
      const cap = ptCfg.annual_cap ?? null;
      const ytd = paidTotals.get(e.uuid)?.pt ?? 0;
      const headroom = cap == null ? Infinity : Math.max(0, round2(cap - ytd));
      const pt = wagePaid > 0 ? Math.min(professionalTax(slabWage, ptCfg), headroom) : 0;
      if (pt > 0) lines.push({ code: "PT", name: ptComp.name, kind: "deduction", amount: round2(pt) });
    }

    // Interest concession on an employer loan: taxable VALUE, never paid in cash (Rule 3(7)(i)). A perquisite
    // line lifts the income-tax base only - gross, deductions and net are untouched.
    const perqLoans = perqLoansByEmp.get(e.uuid) ?? [];
    if (perqLoans.length) {
      const perq = loanPerquisiteMonthly(perqLoans, perqCfg);
      if (perq > 0) lines.push({ code: "PERQ_LOAN", name: "Loan interest concession (perquisite)", kind: "perquisite", amount: perq });
    }

    let tax = 0;
    if (tds && cfg) {
      // TDS is computed on the TAXABLE base: earnings less the non-taxable ones (reimbursements), less loss of
      // pay (a negative earning), plus any perquisite value. computeRunItem is that one definition.
      const taxableEarnings = computeRunItem(lines).taxableGross;
      const decl = await readDeclarations(deps, e.taxDetailsEnc);
      const paid = paidTotals.get(e.uuid) ?? EMPTY_FINALIZED_TOTALS();
      const proj = assembleProjection({
        cfg, fy, regime: tds.regime ?? "new", tdsConfigured: true,
        employedMonths: employedMonthsInFy(e.startDate ?? null, fy, e.endDate ?? null),
        paidGross: paid.taxableGross, paidTax: paid.tax,
        // Spread the balance over the calendar months left from this run's PAY month (inclusive - this run
        // collects the first installment), skipping months another finalized run already collected in.
        // `endDate` closes the window at the leaving month: a leaver's remaining liability has to be collected
        // in the payslips they will actually receive, not spread to a 31 March they are not employed for.
        collectMonths: collectibleMonths(period?.payDate ?? new Date(), e.startDate ?? null, fy, paid.paidMonths, e.endDate ?? null),
        // Every FY month whose salary is neither already priced by a finalized run nor being priced by THIS run,
        // each valued off the employee's compensation timeline - a raise later in the year lifts only the months
        // on or after it, and the months before it stay at the old salary instead of being repainted at the
        // current rate. Keyed on EARNING months (the run's PERIOD), not on pay dates: with a payment lag (April
        // salary paid in May) a pay-date test excludes the wrong month and prices one month at the wrong salary.
        projectedGross: projectedGrossForMonths(
          unpaidEarningMonths(fy, e.startDate ?? null, e.endDate, paid.earnedMonths, runEarnedMonthKey),
          compRows,
          grossFor,
        ),
        currentRunGross: taxableEarnings, decl,
        declaredDeductions: declaredByEmp.get(e.uuid) ?? {},
      });
      tax = proj.monthlyTds;
      if (tax > 0) lines.push({ code: "TDS", name: tds.name, kind: "deduction", amount: tax });
    }

    // Loan / advance repayments: a post-tax DEDUCTION, capped so net never goes negative. Statutory, TDS and
    // LOP are mandatory and take precedence; loan recovery yields to them. It also does NOT garnish a
    // reimbursement payout (a non-taxable earning = repayment of money the employee already spent), so the
    // recoverable base is net MINUS reimbursements. Allocate each due EMI (already capped at its outstanding)
    // against that base, in order; an uncollected shortfall stays outstanding for the next run. Record only what
    // is actually deducted.
    const dueLoans = dueLoansByEmp.get(e.uuid) ?? [];
    if (dueLoans.length) {
      const reimbInNet = lines.filter((l) => l.kind === "earning" && l.taxable === false).reduce((s, l) => s + l.amount, 0);
      let available = Math.max(0, round2(computeRunItem(lines).net - reimbInNet));
      for (const d of dueLoans) {
        const take = round2(Math.min(d.amount, available));
        if (take <= 0.005) continue;
        lines.push({ code: "LOAN", name: d.loan.kind === "advance" ? "Advance recovery" : "Loan repayment", kind: "deduction", amount: take });
        loanEntries.push({ loanId: d.loan.uuid, amount: take });
        available = round2(available - take);
      }
    }

    // The employer's own cost for this period - employer PF/ESI/gratuity, or anything else HR configured as an
    // employer_contribution component. Priced off the PRORATED basic and this period's recurring gross (the same
    // statutory base the employee-side lines used), so a mid-month joiner's cost is prorated too, and carrying
    // the ESI verdict keeps both sides of ESI in step. Appended LAST and never part of gross/deductions/net:
    // computeRunItem ignores the kind, so the payslip's take-home maths is untouched. The lines exist so the
    // payslip, the run review and the statutory report can state the employer cost - and whether employer PF is
    // inside CTC or over and above it - from the run's own frozen figures.
    for (const ec of employerCostLines(base, esiWages, effective, e.epfEnrolled, esiEligible, pfWages)) {
      lines.push({ code: ec.code, name: ec.name, kind: "employer_contribution", amount: ec.monthly, basis: ec.basis, ...(ec.aboveCtc ? { aboveCtc: true } : {}) });
    }

    // Settle the net to the precision the money is actually paid at (whole rupees for INR by default) with an
    // explicit line, so the payslip, this stored item and the bank file all state the SAME figure. Rounding only
    // in the bank file left up to half a rupee per employee per run leaving the account without anything on the
    // ledger to reconcile it against. Non-taxable: rounding is not income.
    const preRound = computeRunItem(lines);
    const adj = round2(roundMoney(preRound.net, payoutDp) - preRound.net);
    if (Math.abs(adj) >= 0.005) {
      lines.push({ code: "ROUND", name: "Rounding adjustment", kind: adj > 0 ? "earning" : "deduction", amount: Math.abs(adj), taxable: false });
    }

    const totals = computeRunItem(lines);
    itemRows.push({ runId, employeeId: e.uuid, linesJson: JSON.stringify(lines), ...totals, tax });
  }

  // Commit the whole build in ONE atomic batch: every paid-by-run marker, the loan ledger + balances, the
  // line items, and the build stamp land together or not at all - a crash mid-build can no longer mark a
  // payout paid without the item that pays it (and it all costs one subrequest). IN-lists and multi-row
  // inserts are chunked under D1's 100-bound-params-per-statement cap; chunks ride in the same batch.
  const loansById = new Map([...dueLoansByEmp.values()].flat().map((d) => [d.loan.uuid, d.loan]));
  // The loan ledger is dated by the PAY PERIOD, not by when someone pressed Build: an installment belongs to the
  // month it was recovered from, which is also what makes "one EMI per calendar month" checkable (a run built
  // late, or an old period rebuilt today, must not read as this month's collection).
  const loanWrites = loanRepaymentWrites(deps, loansById, loanEntries, runId, period?.payDate ?? now);
  // Every paid-by-this-run marker is CHECKED: its guard only matches a payable that is STILL eligible, and the
  // queues above were read at the start of the build, so a payable can have left the queue since (an
  // encashment cancelled and its days credited back, a claim paid separately, another run claiming the same
  // bonus). The guard stops the bad flip; the row count tells us it happened. Without the check, that payable
  // would sit on this run's payslip while remaining queued - and get paid a second time by the next run.
  const marks: CheckedStmt[] = [
    ...chunk(paidEncashIds, 90).map((ids) => ({ stmt: markEncashmentsPaidByRun(deps, ids, runId, now).returning({ uuid: schema.leaveEncashments.uuid }), expect: ids.length, label: "leave encashments" })),
    ...chunk(paidBonusIds, 90).map((ids) => ({ stmt: markBonusesPaidByRun(deps, ids, runId, now).returning({ uuid: schema.bonuses.uuid }), expect: ids.length, label: "bonuses" })),
    ...chunk(paidOtIds, 90).map((ids) => ({ stmt: markOvertimePaidByRun(deps, ids, runId, now).returning({ uuid: schema.overtimeRequests.uuid }), expect: ids.length, label: "overtime" })),
    ...chunk(paidArrearIds, 90).map((ids) => ({ stmt: markCompArrearsPaidByRun(deps, ids, runId, now).returning({ uuid: schema.compensation.uuid }), expect: ids.length, label: "salary arrears" })),
    ...chunk(paidReimbIds, 90).map((ids) => ({ stmt: markReimbursementsPaidByRun(deps, ids, runId, now).returning({ uuid: schema.reimbursements.uuid }), expect: ids.length, label: "reimbursements" })),
  ];
  // The build stamp is taken HERE, once every statement above has been CONSTRUCTED - not from the `now` the
  // build opened with, which is a whole pricing pass earlier.
  //
  // Each of those markers is an update, and an update carries its own `updated_at` stamped by the schema's
  // `$onUpdate` at construction time. Staleness asks "was any income-affecting input touched after the run
  // was built" (see runStaleness), and bonuses, encashments, overtime, arrears, claims and the loan ledger
  // are all on that list - so stamped with the earlier `now`, a run's OWN payment markers post-dated its own
  // build stamp. Every run that paid any of them therefore reported itself stale the moment it finished
  // building, and rebuilding produced the same warning again: a permanent false alarm on the one banner that
  // exists to be believed.
  const builtAt = new Date();
  // What the build PRODUCED, not just how many people it touched. A rebuild is the commonest payroll action
  // and the question asked of its trail is always the same - "did the numbers move, and by how much" - which
  // a headcount cannot answer and a diff against the previous build's totals can. Rounded like every other
  // money figure in this file (see the monetary invariant in db/schema.ts).
  const built = { gross: round2(itemRows.reduce((s, r) => s + r.gross, 0)), net: round2(itemRows.reduce((s, r) => s + r.net, 0)), tax: round2(itemRows.reduce((s, r) => s + (r.tax ?? 0), 0)) };
  const stmts: (BatchStmt | CheckedStmt)[] = [
    ...marks,
    ...loanWrites.stmts,
    ...insertBatches(itemRows, (rows) => deps.db.insert(schema.payrollRunItems).values(rows)),
    // Stamp the build time: any income-affecting input touched after this makes the run stale (see runStaleness).
    // The unpriced list rides the SAME statement, so who the run could not price is written by the same atomic
    // batch as what it did price - the two can never describe different builds.
    //
    // The run's SIZE rides it too, for the same reason and one more. These three figures are what a list of
    // runs shows, and they live on the items - so serving them by summing would read the whole org's items for
    // every run on the page. Here they cost nothing: `itemRows` is already in hand and this update was already
    // happening. `headcount` is what the run PAYS (`itemRows.length`), not everyone it walked - the people it
    // could not price are named separately in `unpricedJson` and are absent from the money above.
    deps.db
      .update(schema.payrollRuns)
      .set({
        itemsBuiltAt: builtAt,
        unpricedJson: unpriced.length ? JSON.stringify(unpriced) : null,
        headcount: itemRows.length,
        gross: built.gross,
        net: built.net,
        updatedAt: builtAt,
      })
      .where(eq(schema.payrollRuns.uuid, runId)),
  ];
  const drifted = await runBatchChecked(deps.db, stmts);
  if (drifted.length) {
    // The build priced payables that moved under it. The items just written would pay them without settling
    // them, so undo the whole build back to the clean "never built" state (the same reset the build opens
    // with) and fail loudly. Nothing is paid, no marker survives, and a rebuild re-reads the queues.
    await runBatch(deps.db, [
      deps.db.delete(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId)),
      ...(await releasePaidByRun(deps, runId)),
      deps.db.update(schema.payrollRuns).set(RUN_UNBUILT).where(eq(schema.payrollRuns.uuid, runId)),
    ]);
    throw failedPrecondition(`payables changed while the run was building (${[...new Set(drifted)].join(", ")}) - nothing was paid; build the run again`);
  }

  // Loan events only announce what the committed batch actually did. Best-effort: the money is already
  // consistent, so an event-pipeline failure must not fail a completed build.
  for (const ev of loanWrites.events) {
    try {
      await emitEvent(deps, null, ev.type, { subject: `loans/${ev.loanId}`, employeeId: ev.employeeId, payload: ev.payload });
    } catch (err) {
      console.error(`[payroll] ${ev.type} emit failed (non-fatal)`, err);
    }
  }
  // COUNTED AS PRICED, not as considered. `employees.length` is everyone the build walked, which includes the
  // people it could not price - so a run that silently dropped someone recorded the headcount it meant to pay
  // rather than the one it did, and the diff against the previous build showed no movement on the very number
  // that had moved. `itemRows.length` is what the run actually pays; the omission is named beside it.
  await audit(deps, actor, "payroll.build", "payroll-runs", runId, {
    employees: itemRows.length,
    ...(unpriced.length ? { unpriced: unpriced.length } : {}),
    diff: {
      employees: { from: priorTotals?.employees ?? null, to: itemRows.length },
      gross: { from: priorTotals?.gross ?? null, to: built.gross },
      totalTax: { from: priorTotals?.tax ?? null, to: built.tax },
      net: { from: priorTotals?.net ?? null, to: built.net },
    },
  });
  return getRun(deps, runId);
}

// Is a built, still-editable run out of date? The run's numbers are a snapshot of the inputs as of its last
// build (`itemsBuiltAt`). Any income-affecting input changed since then means a rebuild would move the money,
// so we surface it (the run page banner + rebuild). Completeness over precision: we bias to catching every
// real change - a rebuild is idempotent, so an occasional false positive (e.g. an unrelated profile edit
// bumping employees.updatedAt) is harmless, whereas a MISSED change would silently ship a wrong payslip.
// Only meaningful while editable (DRAFT/REVIEW); a published run is immutable and self-corrects in the next run.
// `stale`/`changes` = an income input moved SINCE the build (rebuild fixes it). `split_drift` is a different
// failure: the cached basic / Special Allowance the run priced no longer solves the employee's promised CTC, so
// the numbers are wrong even on a freshly built run. It needs a split re-apply and THEN a rebuild, so it is
// reported separately rather than folded into `changes`. Warning only - the run still submits/approves, because
// paying the contracted stored split can be deliberate; the reviewer decides.
/** The employee-id list a run stamped, or [] for an absent/unreadable one - a warning must never be the thing
 *  that fails the read it rides on. */
function parseIdList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Display names for a handful of employees, by id, chunked under D1's bound-parameter cap. */
async function employeeNameMap(deps: Deps, ids: string[]): Promise<Map<string, string>> {
  return new Map(
    (await byIdChunks([...new Set(ids)], (group) =>
      deps.db
        .select({ uuid: schema.employees.uuid, firstName: schema.employees.firstName, lastName: schema.employees.lastName })
        .from(schema.employees)
        .where(inArray(schema.employees.uuid, group)),
    )).map((e) => [e.uuid, `${e.firstName} ${e.lastName}`]),
  );
}

/** The same, sorted and flattened - an id survives as itself when the row is gone, so a name can never be the
 *  reason the list is short. */
async function employeeNames(deps: Deps, ids: string[]): Promise<string[]> {
  const named = await employeeNameMap(deps, ids);
  return ids.map((id) => named.get(id) ?? id).sort();
}

// `unpriced` is a third, different thing again, and the one that is NOT about the numbers being wrong: these
// are people the build walked and could not price at all, so they are absent from the run rather than wrong in
// it. Read straight off the stamp the build wrote (`payroll_runs.unpriced_json`) - it needs no recomputation,
// which is why it is the one warning here that is reported in EVERY state. Split drift stops at the editable
// runs because re-solving a split under a committed run says nothing actionable; an approved or published run
// that left somebody out is the case where saying so matters most, and by then it is the only trace there is.
export type SplitDrift = { stale: string[]; skipped: string[] }; // employee display names
export type RunStaleness = { built_time: string | null; stale: boolean; changes: string[]; split_drift?: SplitDrift; unpriced?: string[] };
export async function runStaleness(deps: Deps, run: { uuid: string; state: string; payPeriodId: string; itemsBuiltAt: Date | null; unpricedJson?: string | null }): Promise<RunStaleness> {
  const builtAt = run.itemsBuiltAt;
  // Ids only; names are resolved below, in the same read the split-drift names use.
  const unpricedIds = parseIdList(run.unpricedJson);
  if (!isEditable(run.state as RunState) || !builtAt) {
    const built_time = builtAt ? builtAt.toISOString() : null;
    if (!unpricedIds.length) return { built_time, stale: false, changes: [] };
    return { built_time, stale: false, changes: [], unpriced: await employeeNames(deps, unpricedIds) };
  }
  // Split drift for the people this run actually priced, named for the reviewer. Editable runs only: an approved
  // or published run is a historical record, and re-solving splits under it would say nothing actionable.
  const items = await deps.db.select({ employeeId: schema.payrollRunItems.employeeId }).from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, run.uuid));
  const drift = await splitDriftFor(deps, items.map((i) => i.employeeId));
  let split_drift: SplitDrift | undefined;
  // ONE name read for all three lists. They are disjoint by construction (an unpriced employee has no item, so
  // `splitDriftFor` never saw them), but they are named by the same query so a run with both kinds of problem
  // still costs the reviewer one lookup rather than two.
  const toName = [...new Set([...drift.stale, ...drift.skipped, ...unpricedIds])];
  const named = toName.length ? await employeeNameMap(deps, toName) : new Map<string, string>();
  const names = (ids: string[]) => ids.map((id) => named.get(id) ?? id).sort();
  if (drift.stale.length || drift.skipped.length) {
    split_drift = { stale: names(drift.stale), skipped: names(drift.skipped) };
  }
  const unpriced = unpricedIds.length ? names(unpricedIds) : undefined;
  // Each source: does any row's updatedAt post-date the build? `updatedAt` also bumps on create + soft-delete
  // + enable/disable, so joiners, removals and toggles are all covered by the same comparison.
  // `ownRun`: the column by which a row says THIS run paid it. Those rows are the build's own markers, and a
  // build that pays a payable is not an input moving under the run - so they are excluded by WHO WROTE THEM
  // rather than by when. The build stamp is taken after those statements are constructed for the same reason
  // (see buildRunItems), but that only holds while every marker's `updated_at` is stamped at construction:
  // one stamped a millisecond later - a busy machine crossing a millisecond boundary between constructing the
  // statement and the driver stamping it - post-dates the build and the run reports ITSELF stale. Which is
  // the permanent false alarm on the one banner that exists to be believed, and no clock comparison can rule
  // it out. `paid_run_id` can.
  //
  // EVERY PROBE IS NARROWED TO WHAT COULD MOVE *THIS* RUN'S MONEY. Each one used to ask its question of the
  // whole table with no predicate but the timestamp, which was tolerable while this was a banner and is not
  // now that `transition` GATES the approve on it with no override (see below). Org-wide, an editable run
  // could not stay fresh long enough to be reviewed: `employees.updated_at` bumps when anyone uploads a photo,
  // edits a bio or changes their notification preferences; `settings` is one row per key, so toggling the
  // holiday feed or an asset-tag option counted; with LOP on, a single clock-in anywhere in the org counted.
  // Payroll became unapprovable in any org with people in it, and the documented remedy (rebuild, then
  // approve) raced exactly the same way.
  //
  // Two narrowings, both fail-SAFE - they can only remove rows that provably do not price this run:
  //   - `employee`: the column naming who a row is about, correlated against this run's OWN items. A change to
  //     somebody this run did not pay cannot change what it pays. One bound parameter (the run id) however
  //     many people are in the run, which is why it is a sub-select and not an `IN` list of ids.
  //   - `window`: for the date-shaped inputs, the run's pay period. A holiday next year, or a punch from
  //     another month, is not an input to this period.
  // A source with neither (the org-wide catalogs: pay components, salary structures) genuinely applies to
  // everyone and stays unnarrowed - they are also the ones nobody edits mid-run.
  //
  // What this deliberately does NOT do is try to decide WHICH COLUMN moved. `updated_at` is one stamp for the
  // whole row, so a profile edit to somebody who IS in the run still reports stale. That is the conservative
  // direction and it stays: a rebuild is idempotent and cheap, and the alternative - a second "payroll inputs"
  // timestamp that every relevant writer must remember to stamp - fails OPEN the first time one forgets, which
  // is a wrong payslip instead of an extra rebuild.
  type Source = {
    label: string;
    table: { updatedAt: unknown };
    /** The column by which a row says THIS run paid it (the build's own markers). */
    ownRun?: unknown;
    /** The column naming the employee a row is about, correlated against this run's items. */
    employee?: unknown;
    /** Narrows a date-shaped input to the run's pay period. */
    window?: SQL;
  };
  const period = (await deps.db
    .select({ periodStart: schema.payPeriods.periodStart, periodEnd: schema.payPeriods.periodEnd, payDate: schema.payPeriods.payDate })
    .from(schema.payPeriods)
    .where(eq(schema.payPeriods.uuid, run.payPeriodId))
    .limit(1))[0];
  // No period row (it was purged out from under the run) means no window to narrow by, so the date-shaped
  // probes stay org-wide rather than silently matching nothing - the fail-safe direction.
  const from = period ? +new Date(period.periodStart) : null;
  const to = period ? +new Date(period.periodEnd) : null;
  const inPeriod = (col: unknown): SQL | undefined =>
    from === null || to === null ? undefined : sql`${col as never} >= ${from} and ${col as never} <= ${to}`;
  // A leave request counts when it OVERLAPS the period, not when it starts in it: a leave spanning the month
  // boundary docks days on both sides of it.
  const overlapsPeriod = (start: unknown, end: unknown): SQL | undefined =>
    from === null || to === null ? undefined : sql`${start as never} <= ${to} and ${end as never} >= ${from}`;
  // A loan is only collectible by this run once recovery has STARTED by the period end - the same test the
  // build itself applies (`startedBy` in services/loans.ts). A loan agreed to start next quarter cannot move
  // this month's money, exactly as a holiday next year cannot, and without this the probe was org-wide in
  // time: any new loan for anybody the run pays flagged it, including loans for periods years apart.
  // A null start date collects as before, so it stays in.
  const startedByPeriodEnd = (col: unknown): SQL | undefined =>
    to === null ? undefined : sql`(${col as never} is null or ${col as never} <= ${to})`;
  // Declarations are filed PER FINANCIAL YEAR and the build reads exactly one year's - `fyWindow` on the pay
  // date, mirrored here from services/payroll.ts's own `fy`. A declaration for a different year is not an
  // input to this run, and treating it as one made every run stale as soon as anyone filed for any year.
  const runFy = fyWindow(period?.payDate ?? new Date()).financialYear;

  const sources: Source[] = [
    { label: "Employee records (joiners, tax verifications, EPF, status)", table: schema.employees, employee: schema.employees.uuid },
    { label: "Compensation revisions", table: schema.compensation, ownRun: schema.compensation.arrearsPaidRunId, employee: schema.compensation.employeeId },
    { label: "Pay components", table: schema.payComponents },
    { label: "Salary structures", table: schema.salaryStructures },
    { label: "Bonuses", table: schema.bonuses, ownRun: schema.bonuses.paidRunId, employee: schema.bonuses.employeeId },
    { label: "Leave encashments", table: schema.leaveEncashments, ownRun: schema.leaveEncashments.paidRunId, employee: schema.leaveEncashments.employeeId },
    { label: "Reimbursements", table: schema.reimbursements, ownRun: schema.reimbursements.paidRunId, employee: schema.reimbursements.employeeId },
    { label: "Overtime requests", table: schema.overtimeRequests, ownRun: schema.overtimeRequests.paidRunId, employee: schema.overtimeRequests.employeeId },
    { label: "Loans", table: schema.loans, employee: schema.loans.employeeId, window: startedByPeriodEnd(schema.loans.startDate) },
    // A verified investment declaration reduces withholding, so it moves the TDS on an already-built run -
    // but only one filed for the year this run withholds for (see `runFy`).
    {
      label: "Investment / tax declarations",
      table: schema.taxDeclarations,
      employee: schema.taxDeclarations.employeeId,
      window: sql`${schema.taxDeclarations.financialYear} = ${runFy}`,
    },
    // The `settings` table is one row per KEY, so an unnarrowed probe made every unrelated org preference - the
    // holiday feed, an asset-tag option, a board default - an input to payroll. These are the keys the build
    // actually reads (directly, and through loadTaxConfig / orgToday).
    {
      label: "Pay-run settings (CTC / tax / overtime / PT)",
      table: schema.settings,
      window: sql`${schema.settings.key} in ('attendance', 'ctc', 'loan-perquisite', 'organization', 'overtime', 'payslip', 'professional-tax', 'tax-config')`,
    },
    // Holidays shift the working-days denominator that prorates mid-period joiners/leavers, so they move the
    // money even with LOP off - but only the ones falling INSIDE the period do.
    { label: "Holidays", table: schema.holidays, window: inPeriod(schema.holidays.date) },
  ];
  // Loss-of-pay inputs only affect the run when LOP is enabled: approved leave (excuses an absence) and
  // attendance punches (worked minutes decide the absent day-units). Gate them on the setting so a routine
  // clock-in doesn't flag every run stale in an org that doesn't dock unauthorised absence.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  if (att.lop_enabled) {
    sources.push({
      label: "Approved leave (loss-of-pay)",
      table: schema.leaveRequests,
      employee: schema.leaveRequests.employeeId,
      window: overlapsPeriod(schema.leaveRequests.startDate, schema.leaveRequests.endDate),
    });
    sources.push({
      label: "Attendance punches (loss-of-pay)",
      table: schema.attendanceSessions,
      employee: schema.attendanceSessions.employeeId,
      window: inPeriod(schema.attendanceSessions.clockIn),
    });
  }
  // All fourteen questions in ONE statement, as fourteen correlated EXISTS columns. Asked one at a time this was
  // a dozen-plus round trips on every read of an editable run - i.e. on the run page's own refresh - for what is
  // a single row of booleans. Each subquery still stops at its first newer row (the LIMIT rides inside EXISTS).
  // Bound as epoch millis, not as a Date: these columns are `timestamp_ms`, and outside a column-aware
  // comparison there is nothing to tell the driver which encoding this parameter wants.
  const since = +builtAt;
  const probes = sources.map((s, i) => {
    // A row this very run marked paid is the build's own write, whatever its stamp says.
    const notOurs = s.ownRun ? sql` and (${s.ownRun as never} is null or ${s.ownRun as never} <> ${run.uuid})` : sql``;
    // One bound parameter (the run id), whatever the headcount - an `IN` list of the run's employee ids would
    // be past D1's bound-parameter cap on any real payroll, and this statement carries fourteen of these.
    const mine = s.employee
      ? sql` and ${s.employee as never} in (select ${schema.payrollRunItems.employeeId} from ${schema.payrollRunItems} where ${schema.payrollRunItems.runId} = ${run.uuid})`
      : sql``;
    const win = s.window ? sql` and (${s.window})` : sql``;
    return sql`exists (select 1 from ${s.table as never} where ${(s.table as { updatedAt: never }).updatedAt} > ${since}${notOurs}${mine}${win} limit 1) as "c${sql.raw(String(i))}"`;
  });
  const [row] = await deps.db.all<Record<string, number>>(sql`select ${sql.join(probes, sql`, `)}`);
  const changes = sources.filter((_, i) => !!row?.[`c${i}`]).map((s) => s.label);
  return { built_time: builtAt.toISOString(), stale: changes.length > 0, changes, ...(split_drift ? { split_drift } : {}), ...(unpriced ? { unpriced } : {}) };
}

// Segregation of duties on the payroll commit, opt-in per org via the `payroll-approval` settings blob. Turned
// on, the person who SUBMITTED a run for review may not be the one who approves it - the same four-eyes rule
// services/accessRules.ts applies to a permission change, on the step that actually moves money.
//
// OFF by default, and the reason is the same one that file gives: an org with one payroll admin has nobody
// else to approve, and a rule with no way out brings payroll to a stop. The escape is this setting, not an
// override on the request - an override a caller can pass is not a control.
//
// Role-level separation is a different, already-enforced thing (the seeded grant denies `payroll-runs.*.approve`
// to payroll_admin, so approving needs super). That says which ROLE may approve; this says which PERSON may not.
async function separateApproverRequired(deps: Deps): Promise<boolean> {
  const cfg = await getSettingValue<{ enabled?: boolean }>(deps, "payroll-approval", {});
  return cfg.enabled === true;
}

// :submit / :approve / :lock map here.
export async function transition(deps: Deps, actor: AppUser, runId: string, to: RunState, ifMatch?: string) {
  const run = await getRun(deps, runId);
  assertEtag(run, ifMatch);
  if (!canTransition(run.state as RunState, to)) throw failedPrecondition(`cannot ${to} from ${run.state}`);

  // One committed run per pay period: base salary + recurring earnings + statutory have no per-period paid
  // marker (only one-offs do), so a second APPROVED/PUBLISHED run for the same period would pay the monthly
  // salary twice. Drafts are unrestricted; the money commits at APPROVE, and APPROVED never rolls back.
  if (to === "APPROVED") {
    // Approving commits the period: it consumes the one-run-per-period slot below and makes the bank file
    // downloadable. A run that was never built (or built and left empty) pays nobody while still locking the
    // period, so the real run for it can't be approved until someone works out why and deletes this one.
    if (!run.itemsBuiltAt) throw failedPrecondition("build the run before approving it");
    const [anyItem] = await deps.db.select({ uuid: schema.payrollRunItems.uuid }).from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId)).limit(1);
    if (!anyItem) throw failedPrecondition("this run has no payslip items - build it before approving");
    // Four-eyes, when the org has asked for it. `submittedBy` is stamped on the DRAFT -> REVIEW step below, so
    // it names the maker; a run with none (submitted before the setting existed) is not blocked by a rule it
    // was never subject to.
    if (run.submittedBy && run.submittedBy === actor.uuid && (await separateApproverRequired(deps))) {
      throw failedPrecondition("a payroll run must be approved by someone other than the person who submitted it");
    }
    const committed = await deps.db
      .select({ uuid: schema.payrollRuns.uuid })
      .from(schema.payrollRuns)
      .where(and(eq(schema.payrollRuns.payPeriodId, run.payPeriodId), inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"])));
    if (committed.some((o) => o.uuid !== runId)) {
      throw failedPrecondition("another run for this pay period is already approved; delete it before approving this one");
    }
    // STALENESS IS A GATE HERE, not a banner. `runStaleness` has always been computed and surfaced on the run
    // page, and approve ignored it: an input that moved after the build (a compensation revision, a leave
    // approval, a new loan) left the items priced from superseded data, and approving shipped those figures.
    // Approve is the commit point - it consumes the period slot above, unlocks the bank file, and APPROVED
    // never rolls back, so the only way out is deleting the run. Every other irreversible step in this file is
    // guarded server-side (the `bankFileAt` refusal on delete); a warning the caller can simply not read is
    // not a guard, and an API caller never saw it at all.
    //
    // There is no override, because the remedy is always the same and always correct: rebuild, then approve.
    // A rebuild is idempotent (it releases and re-marks the payables it had claimed), so nothing is lost by
    // being made to do it.
    //
    // ONLY `stale`, deliberately - never `split_drift`. The two are different failures: `stale` means the
    // inputs moved since the build and a rebuild fixes it, while split drift means the stored basic / Special
    // Allowance no longer solves the promised CTC, which a rebuild does NOT fix (it needs a split re-apply
    // first) and which can be a deliberate choice to pay the contracted stored split. Gating on that would
    // deadlock the approve with no action that clears it; it stays the reviewer's call, as documented on
    // `runStaleness`.
    //
    // `unpriced` is not gated on either, for that same reason rather than by oversight. It names people the
    // build could not price, and while the usual remedy (enter their compensation, rebuild) is the right one,
    // it is not the ONLY correct reading: an employee genuinely owed nothing for the period - on unpaid leave
    // for all of it, or hired into a period their compensation deliberately starts after - is unpriced and
    // should be. Blocking on it would stop a correct payroll with no action that clears it. It is a banner.
    const freshness = await runStaleness(deps, run);
    if (freshness.stale) {
      throw failedPrecondition(
        `this run was built before its inputs changed (${freshness.changes.join(", ")}); rebuild it before approving`,
      );
    }
  }

  const set: SetOf<typeof schema.payrollRuns> = { state: to, updatedAt: new Date() };
  if (to === "REVIEW") set.submittedBy = actor.uuid;
  // Approve is super-only, enforced centrally by the grant (deny payroll-runs.*.approve for payroll_admin).
  if (to === "APPROVED") set.approvedBy = actor.uuid;
  // The `run_period_committed_idx` partial unique index is the race backstop for the check above: if a
  // concurrent approve committed another run for this period between the check and here, this write hits the
  // constraint. Translate it to the same clean precondition error instead of a raw 500.
  let updated;
  try {
    // Guarded on the state that was READ, so the transition is exactly-once: two people approving the same run
    // at once produce one decision and one audit row, instead of both writing `approvedBy` over each other.
    [updated] = await deps.db
      .update(schema.payrollRuns)
      .set(set)
      .where(and(eq(schema.payrollRuns.uuid, runId), eq(schema.payrollRuns.state, run.state)))
      .returning();
  } catch (e) {
    if (to === "APPROVED" && String((e as Error)?.message ?? "").toLowerCase().includes("unique"))
      throw failedPrecondition("another run for this pay period is already approved; delete it before approving this one");
    throw e;
  }
  // Zero rows means the state moved between the read above and this write, so somebody else's decision won.
  if (!updated) throw failedPrecondition(`this run is no longer ${run.state} - reload it and try again`);
  await audit(deps, actor, `payroll.${to.toLowerCase()}`, "payroll-runs", runId, stateMeta(run.state, to), updated);
  return (await withNames(deps, [updated]))[0]!;
}

// Release EVERY payout kind a build may have marked paid by this run, back to approved-unpaid. Each reset
// matches only rows whose paidRunId is this run, so resetting a kind the run never used is a harmless no-op -
// which is why this can run unconditionally (config may have changed since the build). resetLoanRepaymentStmts
// also DELETEs the loan_repayments ledger rows, clearing their NOT-NULL FK to payroll_runs before the run row
// is deleted. Shared by build (idempotent rebuild) and deleteRun (release-on-delete).
async function releasePaidByRun(deps: Deps, runId: string): Promise<BatchStmt[]> {
  return [
    resetReimbursementsPaidByRun(deps, runId),
    resetEncashmentsPaidByRun(deps, runId),
    resetBonusesPaidByRun(deps, runId),
    ...(await resetLoanRepaymentStmts(deps, runId)),
    resetOvertimePaidByRun(deps, runId),
    resetCompArrearsPaidByRun(deps, runId),
  ];
}

// Delete an UNPUBLISHED run (DRAFT/REVIEW/APPROVED). A published run has payslips and is immutable, so it
// is never deletable. Runs have no soft-delete columns, so this is a hard delete of the run + its computed
// items. First release ALL payout kinds the build marked paid by this run (encashments, bonuses, loans,
// overtime, comp arrears, reimbursements) back to approved-unpaid - otherwise those rows keep a paidRunId
// pointing at the deleted run and are never repaid (employee underpaid; encashed leave already debited and
// lost), and the loan_repayments FK to the run would orphan/block the delete.
export async function deleteRun(deps: Deps, actor: AppUser, runId: string, ifMatch?: string) {
  const run = await getRun(deps, runId);
  assertEtag(run, ifMatch);
  if (run.state === "PUBLISHED") throw failedPrecondition("a published run cannot be deleted");
  // Deleting releases every payable this run paid back into the queue, so the next run pays them again. That
  // is only safe while no money has gone out - and the bank payout file is the moment it does.
  if (run.bankFileAt) throw failedPrecondition("a bank payout file was already generated for this run, so it may already have been paid; it cannot be deleted");
  // One atomic batch: the releases, the items and the run go together - a crash can't strand payouts
  // stamped with a run that no longer exists.
  await runBatch(deps.db, [
    ...(await releasePaidByRun(deps, runId)),
    deps.db.delete(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId)),
    deps.db.delete(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)),
  ]);
  // The run and its items are hard-deleted above, so this entry is the only surviving record of it.
  await audit(deps, actor, "payroll.delete", "payroll-runs", runId, removedMeta(run, "payroll-runs"), run);
}

// :publish - transition to PUBLISHED and start the payslip-generation Operation. Returns the job row.
export async function publishRun(deps: Deps, actor: AppUser, runId: string, ifMatch?: string) {
  const run = await getRun(deps, runId);
  assertEtag(run, ifMatch);
  if (!canTransition(run.state as RunState, "PUBLISHED")) throw failedPrecondition("run must be APPROVED before publish");
  // GUARDED FLIP, the same shape `transition` leans on the partial unique index for. Two concurrent publishes
  // both read APPROVED and both pass the check above; without the state predicate both then proceed to notify
  // every employee in the run, emit `payroll.published` (so every rule on it fires twice) and enqueue a second
  // payslip job. Whoever's UPDATE reports a row owns the publish; the loser is told it already happened.
  // `If-Match` would also catch this, but the header is optional on the route - this does not depend on it.
  const flipped = await deps.db
    .update(schema.payrollRuns)
    .set({ state: "PUBLISHED", updatedAt: new Date() })
    .where(and(eq(schema.payrollRuns.uuid, runId), eq(schema.payrollRuns.state, "APPROVED")))
    .returning({ uuid: schema.payrollRuns.uuid });
  if (!flipped.length) throw failedPrecondition("this run has already been published");
  // Tell each employee in the run their payslip is available (payslips generate async right after).
  const runEmps = await deps.db.select({ employeeId: schema.payrollRunItems.employeeId }).from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  await notifyMany(deps, runEmps.map((r) => r.employeeId).filter(Boolean) as string[], { type: "payslip.published", title: "Payslip available", body: "Your payslip for this period is ready.", link: "payslips" });
  // Operations are employee-owned (like leave-requests): owner-embedded code under the creator's employee
  // so the middleware scopes them via `me`/`my-dept`. A creator with no employee record gets a flat code +
  // null owner -> the operation is admin-only visible (fail-closed).
  const code = actor.employeeId
    ? await allocOwnedCode(deps, schema.jobs, schema.jobs.employeeId, actor.employeeId)
    : await allocFlatCode(deps, schema.jobs);
  const job = (await deps.db.insert(schema.jobs).values({ code, employeeId: actor.employeeId, kind: "payslip.generateRun", payload: JSON.stringify({ runId, correlationId: deps.trace }), createdBy: actor.uuid }).returning())[0]!;
  await audit(deps, actor, "payroll.published", "payroll-runs", runId, { operation: `operations/${job.uuid}` });
  await emitEvent(deps, actor, "payroll.published", { subject: `payroll-runs/${runId}`, payload: { payPeriodId: run.payPeriodId, employeeCount: runEmps.length } });
  return job;
}

// Mask an account number to its last 4 digits for display (never the full number on a payslip).
function maskAccount(n?: string): string | undefined {
  if (!n) return undefined;
  return n.length <= 4 ? "••••" : `•••• ${n.slice(-4)}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Run-wide payslip context, gathered once per run: the pay period (banner), org branding (name/logo/address
// from the organization settings row), departments, and the attendance facts used for the per-employee
// attendance strip. Nothing is hardcoded - it all comes from configured data. Shared by the publish-time
// generator and the pre-publish preview so a previewed slip is the same document that will be issued.
type PayslipRunContext = {
  org: { name?: string; logo?: string; address?: string };
  att: AttendanceConfig;
  depts: Map<string, string>;
  lop: Awaited<ReturnType<typeof assembleLop>> | null;
  currencyCode: string;
  dp: number;
  periodLabel: string;
  template: PayslipTemplate; // the configured payslip design (settings/payslip), or the stock one
  /** Set only when the design says payslips print ON the letterhead; the page then comes from here. */
  letterhead?: LetterheadSpec;
};

async function payslipRunContext(deps: Deps, run: typeof schema.payrollRuns.$inferSelect): Promise<PayslipRunContext> {
  const period = (await deps.db.select().from(schema.payPeriods).where(eq(schema.payPeriods.uuid, run.payPeriodId)).limit(1))[0];
  const org = await getSettingValue<{ name?: string; logo?: string; address?: string; default_currency?: string; currency_decimals?: CurrencyDecimals } & OrgWithDocumentLogos>(deps, "organization", {});
  // The letterhead payslips are set to, resolved once per run rather than per slip (it is an R2 read).
  const chosen = await documentLetterhead(deps, org, "payslip");
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const depts = new Map((await refDepartments(deps)).map((d) => [d.uuid, d.name] as const));
  const lop = period ? await assembleLop(deps, period, att) : null;
  const currencyCode = org.default_currency || "INR";
  // The design is org config. A blob that fails validation falls back to the stock layout rather than failing
  // the run - payslips must still go out if someone saved a broken template.
  const template = payslipTemplateOrDefault(await getSettingValue<unknown>(deps, "payslip", null));
  // Two ways to print a payslip, and HR picks which in the payslip designer. "own" (the default) keeps the
  // payslip's own sheet and borrows only the letterhead's MARK for its header block. "letterhead" prints the
  // same figures on the letterhead itself - its margins, stationery, header band, footer, watermark - which
  // is what an org whose payslips should look like the rest of its stationery wants.
  const onLetterhead = template.options?.page === "letterhead" && !!chosen;
  return {
    org: { name: org.name, logo: (onLetterhead ? undefined : letterheadMark(chosen)) ?? org.logo, address: org.address },
    letterhead: onLetterhead ? chosen : undefined,
    att,
    depts,
    lop,
    currencyCode,
    template,
    dp: decimalsFor(currencyCode, org.currency_decimals), // display precision for payslip figures
    periodLabel: period?.label || (period ? `${MONTHS[new Date(period.periodStart).getUTCMonth()]} ${new Date(period.periodStart).getUTCFullYear()}` : ""),
  };
}

// The rendered-payslip input for one run item. Null when the employee row is gone (the generator skips it).
async function payslipDataForItem(deps: Deps, ctx: PayslipRunContext, it: typeof schema.payrollRunItems.$inferSelect) {
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, it.employeeId)).limit(1))[0];
  if (!emp) return null;
  const lines: Line[] = JSON.parse(it.linesJson);
  const { att, lop } = ctx;

  // Employee bank details (decrypt the PII blob; degrade gracefully if absent/unreadable). Account is masked.
  let bank: { bank_name?: string; ifsc_code?: string; account_number?: string } = {};
  if (emp.bankDetailsEnc) {
    try { bank = JSON.parse(await deps.encryptor.decrypt(emp.bankDetailsEnc)); } catch { bank = {}; }
  }
  const onFile = Boolean(bank.bank_name || bank.account_number || bank.ifsc_code);

  // Attendance strip from the same facts the build used: working days in the period and this employee's
  // unexcused day-units (absent=1, half day=0.5); present/payable days follow.
  let attendance: { actualDays: number; workingDays: number; lopDays: number; daysPayable: number } | undefined;
  if (lop) {
    // Clamp the window to employment so a mid-period joiner/leaver's strip matches what the build charged:
    // pre-join / post-leave days are covered by proration, not shown as absences. workingDays reflects the
    // days actually employed in the period, so daysPayable lines up with the (prorated) pay.
    const empStartYmd = emp.startDate ? utcDay(+new Date(emp.startDate)) : null;
    const empEndYmd = emp.endDate ? utcDay(+new Date(emp.endDate)) : null;
    const wStart = empStartYmd && empStartYmd > lop.startYmd ? empStartYmd : lop.startYmd;
    const wEnd = empEndYmd && empEndYmd < lop.endYmd ? empEndYmd : lop.endYmd;
    const lopDays = lopDayUnits({
      startYmd: wStart, endYmd: wEnd, workDays: att.work_days, holidays: lop.holidays,
      leaveRanges: lop.leaveByEmp.get(emp.uuid) ?? [], workedByDay: lop.workedByEmp.get(emp.uuid) ?? new Map<string, number>(),
      marksByDay: lop.marksByEmp.get(emp.uuid),
      fullDayMinutes: att.full_day_minutes ?? 480, halfDayMinutes: att.half_day_minutes ?? 240,
    });
    const workingDays = workingDaysInRange(wStart, wEnd, att.work_days, lop.holidays);
    const payable = round2(workingDays - lopDays);
    attendance = { workingDays, lopDays, actualDays: payable, daysPayable: payable };
  }

  return {
    org: { name: ctx.org.name || "", logo: ctx.org.logo, address: ctx.org.address },
    periodLabel: ctx.periodLabel,
    currencyCode: ctx.currencyCode,
    employee: { name: `${emp.firstName} ${emp.lastName}`, designation: emp.jobTitle ?? undefined, empNo: emp.code ?? undefined, department: emp.departmentId ? ctx.depts.get(emp.departmentId) : undefined },
    payment: { mode: onFile ? "Bank Transfer" : undefined, bankName: bank.bank_name, ifsc: bank.ifsc_code, accountMasked: maskAccount(bank.account_number) },
    attendance,
    // Employee-side money columns: earnings + deductions only. The employer's own contributions are their own
    // block (they are not paid to the employee, so they must never sit in Earnings), and a perquisite is taxable
    // value rather than money paid, so it belongs in neither column. All from the item's frozen lines.
    lines: lines.filter((l) => l.kind === "earning" || l.kind === "deduction") as { name: string; kind: "earning" | "deduction"; amount: number }[],
    employerLines: lines.filter((l) => l.kind === "employer_contribution").map((l) => ({ name: l.name, amount: l.amount, ...(l.aboveCtc ? { aboveCtc: true } : {}) })),
    gross: it.gross,
    totalDeductions: it.totalDeductions,
    net: it.net,
    decimals: ctx.dp,
  };
}

// `payroll-runs/<id>:previewPayslip` - render ONE employee's payslip for a run that is not published yet, so
// the figures can be checked before :publish (the point of no return: it notifies everyone and issues slips).
// Nothing is persisted (no payslip row, no R2 object) and the same context/data path as the generator is used,
// so what you preview is what will be issued. Reading rides the RUN's own access gate (the authz middleware
// resolves the per-object custom key `payroll-runs.<code>.previewPayslip`); the run must be built.
export async function previewRunItemPayslip(deps: Deps, runId: string, employeeId: string) {
  const run = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId)).limit(1))[0];
  if (!run) throw notFound("payroll run not found");
  const item = (
    await deps.db
      .select()
      .from(schema.payrollRunItems)
      .where(and(eq(schema.payrollRunItems.runId, runId), eq(schema.payrollRunItems.employeeId, employeeId)))
      .limit(1)
  )[0];
  if (!item) throw notFound("this run has no item for that employee - build the run first");
  const ctx = await payslipRunContext(deps, run);
  const data = await payslipDataForItem(deps, ctx, item);
  if (!data) throw notFound("employee not found");
  return { bytes: await renderPayslipPdf(data, ctx.template, ctx.letterhead), fileName: `payslip-preview-${item.uuid}.pdf` };
}

// Called by the cron drainer. Resumable + idempotent: bounded batch, skips already-generated payslips.
export async function processPayslipRunJob(deps: Deps, jobId: string, payload: { runId: string }, batch = 25) {
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, payload.runId));
  const slips = await deps.db.select().from(schema.payslips).where(eq(schema.payslips.runId, payload.runId));
  const existing = new Set(slips.map((p) => p.runItemId));
  const todo = items.filter((it) => !existing.has(it.uuid)).slice(0, batch);

  const run = await getRun(deps, payload.runId);
  const ctx = await payslipRunContext(deps, run);

  let written = 0;
  for (const it of todo) {
    const data = await payslipDataForItem(deps, ctx, it);
    if (!data) {
      // Employee row gone - nothing to render. NAMED, not silently skipped: this item will never produce a
      // payslip, and the only surviving trace of that is this line plus the shortfall reported on the job
      // result below. A run item whose employee was hard-deleted between the build and the publish is the one
      // way an approved payroll ships fewer documents than it priced, and somebody has to be able to find out.
      console.warn(`[payroll] run item ${it.uuid} has no employee row; no payslip generated`);
      continue;
    }
    const pdf = await renderPayslipPdf(data, ctx.template, ctx.letterhead);
    const key = `payslips/${it.employeeId}/${it.uuid}.pdf`;
    await deps.docs.put(key, pdf, "application/pdf");
    const [slip] = await deps.db.insert(schema.payslips).values({ code: await allocOwnedCode(deps, schema.payslips, schema.payslips.employeeId, it.employeeId), runId: payload.runId, runItemId: it.uuid, employeeId: it.employeeId, r2Key: key, gross: it.gross, taxableGross: it.taxableGross, totalDeductions: it.totalDeductions, tax: it.tax, net: it.net }).returning({ uuid: schema.payslips.uuid });
    // Per-employee milestone: fires the workflow engine once per payslip (e.g. an "email me my payslip" rule can
    // attach payslips/<id>). Best-effort - a failed emit must not abort payslip generation (the batch is resumable
    // and skips already-generated slips, so this one wouldn't re-fire on retry).
    try {
      await emitEvent(deps, null, "payslip.published", { subject: `payslips/${slip!.uuid}`, employeeId: it.employeeId, payload: { netPay: it.net } });
    } catch (e) {
      console.error("[payroll] payslip.published emit failed (non-fatal)", e);
    }
    written++;
  }

  const remaining = items.length - (existing.size + todo.length);
  if (remaining > 0) {
    await deps.db.update(schema.jobs).set({ status: "queued" }).where(eq(schema.jobs.uuid, jobId)); // resume next tick
    return { done: false };
  }
  // WHAT WAS ACTUALLY WRITTEN, not how many items the run had. `items.length` counts run items, and an item
  // the loop skipped (employee row gone) produces no payslip - so the Operations page reported a clean full
  // run for a payroll that shipped fewer documents than it priced, with nothing anywhere saying so. Exact
  // without carrying state between passes: every earlier pass's slips are already in `existing`, and this
  // pass's are `written`, so the two together are every payslip this run has. `skipped` is the shortfall, and
  // it is only ever non-zero in the case above.
  const generated = existing.size + written;
  const skipped = items.length - generated;
  await deps.db
    .update(schema.jobs)
    .set({
      resultJson: JSON.stringify({
        payslips_generated: generated,
        ...(skipped > 0 ? { payslips_skipped: skipped } : {}),
        run: `payroll-runs/${payload.runId}`,
      }),
    })
    .where(eq(schema.jobs.uuid, jobId));
  return { done: true };
}
