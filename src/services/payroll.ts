import { allocFlatCode, allocOwnedCode } from "./codeAlloc";
// FSM + LRO resource template. Uses the verified pure domain logic in domain/payroll.ts.
import { and, eq, inArray, gt, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notifyMany } from "./notifications";
import { emitEvent } from "./eventBus";
import { notFound, failedPrecondition, aborted } from "../lib/errors";
import { computeRunItem, canTransition, isEditable, applyStructure, overtimePay, DEFAULT_OVERTIME_CONFIG, type Line, type RunState, type OvertimeConfig } from "../domain/payroll";
import { round2 } from "../domain/money";
import { decimalsFor, type CurrencyDecimals } from "../domain/currency";
import { allStructureLines } from "./salaryStructures";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { tdsComponent, loadTaxConfig, finalizedTotals, fyWindow, monthlyRecurringGross, employedMonthsInFy, collectibleMonths, assembleProjection, readDeclarations } from "./taxProjection";
import { reimbursementPayoutMode, approvedUnpaidReimbursementsAll, resetReimbursementsPaidByRun, markReimbursementsPaidByRun } from "./reimbursements";
import { approvedUnpaidEncashmentsAll, resetEncashmentsPaidByRun, markEncashmentsPaidByRun } from "./leaveEncashments";
import { unpaidBonusesAll, markBonusesPaidByRun, resetBonusesPaidByRun } from "./bonuses";
import { dueLoanInstallmentsAll, loanRepaymentWrites, resetLoanRepaymentStmts } from "./loans";
import { runBatch, runBatchChecked, chunk, groupBy, type BatchStmt, type CheckedStmt } from "../lib/dbBatch";
import { getSettingValue } from "./settings";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, localDay, workingDaysInRange, lopDayUnits, lopAmount, employmentFraction } from "../domain/attendance";
import { esiEmployeeContribution, esiContributionPeriod, professionalTax, DEFAULT_PT_CONFIG, type PtConfig } from "../domain/statutory";
import { approvedUnpaidOvertimeAll, markOvertimePaidByRun, resetOvertimePaidByRun } from "./overtimeRequests";
import { resetCompArrearsPaidByRun, markCompArrearsPaidByRun } from "./compensation";
import { renderPayslipPdf } from "../lib/pdf";
import { payslipTemplateOrDefault, type PayslipTemplate } from "../domain/payslipTemplate";
import { etagOf } from "../http/serialize";
import { encodeCursor, decodeCursor } from "../http/pagination";

// Resolve user ids to a display name: the linked employee's full name, else the user's email.
async function userDisplayNames(deps: Deps, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = new Set(ids.filter(Boolean) as string[]);
  const out = new Map<string, string>();
  if (!wanted.size) return out;
  const users = (await deps.db.select().from(schema.users)).filter((u) => wanted.has(u.uuid));
  const empIds = users.map((u) => u.employeeId).filter(Boolean) as string[];
  const empName = new Map<string, string>();
  if (empIds.length) {
    for (const e of await deps.db.select().from(schema.employees)) {
      if (empIds.includes(e.uuid)) empName.set(e.uuid, `${e.firstName} ${e.lastName}`);
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

export async function getRun(deps: Deps, id: string) {
  const r = (await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, id)).limit(1))[0];
  if (!r) throw notFound("payroll run not found");
  return (await withNames(deps, [r]))[0]!;
}

// Per-employee breakdown of a run (the review surface): each item's computed totals + its earning/deduction
// lines, with the employee's name, ordered by employee code. Reading rides the run's own access gate.
export async function listRunItems(deps: Deps, runId: string) {
  await getRun(deps, runId); // 404 if the run doesn't exist
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  const emps = new Map((await deps.db.select().from(schema.employees)).map((e) => [e.uuid, e]));
  return items
    .map((it) => {
      const e = emps.get(it.employeeId);
      return {
        employee: `employees/${it.employeeId}`,
        employee_name: e ? `${e.firstName} ${e.lastName}` : it.employeeId,
        code: e?.code ?? "",
        gross: it.gross,
        taxable_gross: it.taxableGross,
        total_deductions: it.totalDeductions,
        tax: it.tax,
        net: it.net,
        lines: JSON.parse(it.linesJson) as Line[],
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code) || a.employee_name.localeCompare(b.employee_name));
}

export async function listRuns(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string) {
  const all = (await deps.db.select().from(schema.payrollRuns).where(applyScope(scope, schema.payrollRuns.code, schema.payrollRuns.code))).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
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
// per employee here, instead of one query per employee.
function compForPeriodFrom(rows: (typeof schema.compensation.$inferSelect)[], asOfMs: number | undefined) {
  if (asOfMs === undefined) return rows.find((r) => r.effectiveTo === null);
  return rows
    .filter((r) => +new Date(r.effectiveFrom) <= asOfMs && (r.effectiveTo === null || +new Date(r.effectiveTo) > asOfMs))
    .sort((a, b) => +new Date(b.effectiveFrom) - +new Date(a.effectiveFrom))[0];
}

// Gather the period's attendance facts once (holidays, approved leave, punches) so the per-employee LOP
// in buildRunItems is pure map lookups. `endYmd` is clamped to today so a mid-period build never charges
// not-yet-arrived days as absences.
async function assembleLop(deps: Deps, period: typeof schema.payPeriods.$inferSelect, att: AttendanceConfig) {
  const tz = att.timezone || "Asia/Kolkata";
  const startMs = +new Date(period.periodStart);
  const endMs = +new Date(period.periodEnd);
  const startYmd = localDay(startMs, tz);
  const periodEndYmd = localDay(endMs, tz);
  const todayYmd = localDay(+deps.clock.now(), tz);
  const endYmd = periodEndYmd < todayYmd ? periodEndYmd : todayYmd;

  const holidays = new Set(
    (await deps.db.select().from(schema.holidays))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= startMs && +new Date(h.date) <= endMs)
      .map((h) => localDay(+new Date(h.date), tz)),
  );
  const leaveByEmp = new Map<string, { start: string; end: string }[]>();
  for (const l of await deps.db.select().from(schema.leaveRequests)) {
    if (l.state !== "APPROVED" || +new Date(l.endDate) < startMs || +new Date(l.startDate) > endMs) continue;
    const arr = leaveByEmp.get(l.employeeId) ?? [];
    arr.push({ start: localDay(+new Date(l.startDate), tz), end: localDay(+new Date(l.endDate), tz) });
    leaveByEmp.set(l.employeeId, arr);
  }
  const workedByEmp = new Map<string, Map<string, number>>(); // employee -> day -> worked minutes
  for (const s of await deps.db.select().from(schema.attendanceSessions)) {
    const ms = +new Date(s.clockIn);
    if (ms < startMs || ms > endMs + 86_400_000) continue;
    const day = localDay(ms, tz);
    const minutes = s.clockOut ? Math.max(0, Math.round((+new Date(s.clockOut) - ms) / 60000)) : 0;
    let m = workedByEmp.get(s.employeeId);
    if (!m) workedByEmp.set(s.employeeId, (m = new Map<string, number>()));
    m.set(day, (m.get(day) ?? 0) + minutes);
  }
  const workingDaysInPeriod = workingDaysInRange(startYmd, periodEndYmd, att.work_days, holidays);
  return { startYmd, endYmd, holidays, leaveByEmp, workedByEmp, workingDaysInPeriod };
}

export async function createRun(deps: Deps, actor: AppUser, payPeriodPath: string) {
  const payPeriodId = payPeriodPath.split("/").pop()!;
  const row = (await deps.db.insert(schema.payrollRuns).values({ code: await allocFlatCode(deps, schema.payrollRuns), payPeriodId, createdBy: actor.uuid }).returning())[0]!;
  await audit(deps, actor, "payroll.create", "payroll-runs", row.uuid, undefined, row);
  return row;
}

// Build per-employee line items from current comp + recurring components + one-off inputs (incl. LOP).
export async function buildRunItems(deps: Deps, actor: AppUser, runId: string, oneOffs: Record<string, Line[]> = {}, ifMatch?: string) {
  const run = await getRun(deps, runId);
  assertEtag(run, ifMatch);
  if (!isEditable(run.state as RunState)) throw failedPrecondition("run is not editable");

  // Active AND not soft-deleted: deleteEmployee only stamps `deleteTime` (status stays "active"), so filtering
  // on status alone would keep paying a deleted employee - salary, statutory contributions and all.
  const employees = (await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"))).filter((e) => !e.deleteTime);
  // Apply every component that's enabled (not disabled) and not soft-deleted.
  const components = (await deps.db.select().from(schema.payComponents)).filter((c) => !c.disabled && !c.deleteTime);
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
  const paidTotals = tds ? await finalizedTotals(deps, fy, runId) : new Map();

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
  await runBatch(deps.db, [
    deps.db.delete(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId)),
    ...(await releasePaidByRun(deps, runId)),
    // Un-stamp the build: until the commit batch below lands, this run has no items, and a `built_time` left
    // pointing at the previous build would read as "built and up to date" for an EMPTY run (runStaleness
    // compares inputs against it) - which an approver could then approve and publish, paying nobody.
    deps.db.update(schema.payrollRuns).set({ itemsBuiltAt: null }).where(eq(schema.payrollRuns.uuid, runId)),
  ]);
  const periodEndMs = period ? +new Date(period.periodEnd) : undefined;
  const now = new Date();

  // Every payout queue + compensation, prefetched in ONE read each and grouped by employee - the per-employee
  // loop below touches the DB not at all, so the build's subrequest count is flat in headcount (the free-plan
  // Workers budget is 50 an invocation).
  const compByEmp = groupBy(await deps.db.select().from(schema.compensation), (r) => r.employeeId);
  const encashByEmp = groupBy(await approvedUnpaidEncashmentsAll(deps), (r) => r.employeeId);
  const bonusByEmp = groupBy(await unpaidBonusesAll(deps), (r) => r.employeeId);
  const otByEmp = otCfg.enabled ? groupBy(await approvedUnpaidOvertimeAll(deps, periodEndMs), (r) => r.employeeId) : new Map<string, never[]>();
  const reimbByEmp = payViaPayroll ? groupBy(await approvedUnpaidReimbursementsAll(deps), (r) => r.employeeId) : new Map<string, never[]>();
  const dueLoansByEmp = await dueLoanInstallmentsAll(deps);

  // What the loop decides, collected for the single write batch after it.
  const paidEncashIds: string[] = [];
  const paidBonusIds: string[] = [];
  const paidOtIds: string[] = [];
  const paidArrearIds: string[] = [];
  const paidReimbIds: string[] = [];
  const loanEntries: { loanId: string; amount: number }[] = [];
  const itemRows: (typeof schema.payrollRunItems.$inferInsert)[] = [];

  // Loss-of-pay for unexcused absences (opt-in via settings/attendance.lop_enabled). Assemble the period's
  // holidays, approved leave and attendance punches ONCE; the per-employee absent-day count + amount follow.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const lop = att.lop_enabled && period ? await assembleLop(deps, period, att) : null;

  // Proration for partial-period employment (mid-period joiners/leavers): a per-employee factor on the regular
  // earnings, by the configured basis. Needs the period ymds + holidays (for the working-days basis); reuse the
  // LOP facts when present, else compute the minimal holiday set once. A full-period employee gets factor 1.
  const tz = att.timezone || "Asia/Kolkata";
  const prorationBasis = att.proration_basis ?? "calendar_days";
  const periodStartYmd = period ? localDay(+new Date(period.periodStart), tz) : "";
  const periodEndYmd = period ? localDay(+new Date(period.periodEnd), tz) : "";
  const holidaySet = !period ? new Set<string>() : lop?.holidays ?? new Set(
    (await deps.db.select().from(schema.holidays))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= +new Date(period.periodStart) && +new Date(h.date) <= +new Date(period.periodEnd))
      .map((h) => localDay(+new Date(h.date), tz)),
  );

  // The payslip is rendered in the org currency, and every line total is summed as a bare number. The app is
  // single-currency: guard the invariant so an employee's comp - or any payable - in a different currency fails
  // the build loudly instead of silently corrupting the totals (e.g. adding a USD bonus as if it were rupees).
  const orgCurrency = (await getSettingValue<{ default_currency?: string }>(deps, "organization", {})).default_currency || "INR";

  // Statutory deductions on the regular monthly gross (computed per employee below, after earnings): ESI (% of
  // gross up to an eligibility ceiling) and Professional Tax (a state slab). Each is an opt-in single component;
  // PT slabs come from settings. Loaded once.
  // Employee-side ESI/PT (kind "deduction"); the employer-contribution ESI row (same method) is CTC-only.
  const esiComp = components.find((c) => c.method === "esi" && c.kind === "deduction" && c.recurring);
  const ptComp = components.find((c) => c.method === "pt" && c.kind === "deduction" && c.recurring);
  const ptCfg = ptComp ? await getSettingValue<PtConfig>(deps, "professional-tax", DEFAULT_PT_CONFIG) : null;

  // ESI is "sticky" within a contribution period (Apr-Sep / Oct-Mar): a worker eligible at the period start
  // keeps contributing to period-end even after a raise past the ceiling. Practical proxy: anyone who already
  // had an ESI line in a FINALIZED run earlier in THIS contribution period keeps contributing now. Built once.
  const esiContributing = new Set<string>();
  if (esiComp && period) {
    const cp = esiContributionPeriod(period.payDate);
    const periodsById = new Map((await deps.db.select().from(schema.payPeriods)).map((p) => [p.uuid, p]));
    const priorRunIds = new Set(
      (await deps.db.select().from(schema.payrollRuns))
        .filter((r) => (r.state === "APPROVED" || r.state === "PUBLISHED") && r.uuid !== runId)
        .filter((r) => { const p = periodsById.get(r.payPeriodId); return !!p && +new Date(p.payDate) >= cp.start && +new Date(p.payDate) < cp.end; })
        .map((r) => r.uuid),
    );
    if (priorRunIds.size) {
      for (const it of await deps.db.select().from(schema.payrollRunItems)) {
        if (!priorRunIds.has(it.runId) || esiContributing.has(it.employeeId)) continue;
        if ((JSON.parse(it.linesJson) as Line[]).some((l) => l.code === "ESI")) esiContributing.add(it.employeeId);
      }
    }
  }

  for (const e of employees) {
    const comp = compForPeriodFrom(compByEmp.get(e.uuid) ?? [], periodEndMs);
    if (!comp) continue;
    if ((comp.currency || "INR") !== orgCurrency) {
      throw failedPrecondition(`${e.firstName} ${e.lastName}'s compensation is in ${comp.currency || "INR"}, but payroll runs in ${orgCurrency}`);
    }
    // This employee's effective component set (their structure's earnings + all global deductions/statutory).
    const effective = applyStructure(components, comp.structureId ? structById.get(comp.structureId) ?? null : null);
    // Partial-employment proration factor (1.0 for a full-period employee). Applied to the BASIC, Special
    // Allowance and every recurring EARNING (fixed + percent-of-base); EPF rides the prorated base too. Fixed
    // DEDUCTIONS are not prorated. In-window absences are still docked separately by LOP at the full daily rate.
    const empStartYmd = e.startDate ? localDay(+new Date(e.startDate), tz) : null;
    const empEndYmd = e.endDate ? localDay(+new Date(e.endDate), tz) : null;
    const factor = period
      ? employmentFraction({ periodStartYmd, periodEndYmd, empStartYmd, empEndYmd, workDays: att.work_days, holidays: holidaySet, basis: prorationBasis })
      : 1;
    const base = comp.basePay * factor;
    const special = comp.specialAllowance * factor;
    // Base pay is the contractual BASIC (prorated for partial employment). The employer's PF share is an
    // employer-side cost that lives only in CTC views (letters, comp tab) - never on the payslip.
    const lines: Line[] = [{ code: "BASIC", name: "Basic", kind: "earning", amount: round2(base) }];
    // Special Allowance: the balancing plug of a top-down (CTC-in) comp row. A taxable fixed earning, so it
    // rides in gross (and thus the ESI/PT statutory base below) and taxable gross. 0 for basic-in rows.
    if (special > 0) lines.push({ code: "SPECIAL", name: "Special Allowance", kind: "earning", amount: round2(special) });
    for (const co of effective) {
      // Base pay comes from compensation (the "BASIC" line above); components are extra earnings/deductions.
      // income_tax is engine-computed below, not a flat/percent line.
      if (co.kind === "employer_contribution") continue; // employer PF/ESI/gratuity are CTC-only, never on the payslip
      if (!co.recurring || co.method === "income_tax" || co.method === "esi" || co.method === "pt") continue; // esi/pt computed from gross below
      if (co.method === "epf" && !e.epfEnrolled) continue; // EPF is opt-in; skip unless this employee is enrolled
      // EPF: employee contribution = rate% (default 12) of the (prorated) base, capped at the wage ceiling if set.
      // A fixed EARNING is prorated for partial employment; a fixed DEDUCTION is charged in full.
      const amount =
        co.method === "fixed" ? (co.rate ?? 0) * (co.kind === "earning" ? factor : 1)
        : co.method === "percent_base" ? base * ((co.rate ?? 0) / 100)
        : co.method === "epf" ? Math.min(base, co.cap ?? Infinity) * ((co.rate ?? 12) / 100)
        : 0;
      // Payslip line label is the component name; EPF carries a stable code so statutory reports can find it.
      if (amount) lines.push({ code: co.method === "epf" ? "EPF" : co.name, name: co.name, kind: co.kind, amount: round2(amount) });
    }
    // Regular monthly gross (base + recurring earnings) is the base for statutory deductions. Snapshot it
    // BEFORE one-offs/bonuses/encashment so ESI eligibility + PT slab key off the steady wage, not a one-time spike.
    const statutoryBase = round2(lines.filter((l) => l.kind === "earning").reduce((s, l) => s + l.amount, 0));
    // Statutory ELIGIBILITY (ESI ceiling) and the PT slab key off the FULL monthly wage rate, not the prorated
    // partial-month amount - else a high-wage mid-period joiner drops under the ESI ceiling and is wrongly
    // charged ESI, or falls into a lower PT slab. The ESI CONTRIBUTION is on the wage actually paid this period
    // (prorated). factor is 1 for a full-period employee, so fullMonthlyBase == statutoryBase then (no-op).
    const fullMonthlyBase = factor > 0 ? round2(statutoryBase / factor) : statutoryBase;
    if (esiComp) {
      const ceiling = esiComp.cap ?? 21000;
      // Eligible if within the ceiling on the full monthly wage, OR already contributing earlier this
      // contribution period (sticky - a mid-period raise past the ceiling doesn't stop ESI till period end).
      const eligible = (fullMonthlyBase > 0 && fullMonthlyBase <= ceiling) || esiContributing.has(e.uuid);
      const esi = eligible && statutoryBase > 0 ? esiEmployeeContribution(statutoryBase, esiComp.rate ?? 0.75, Infinity) : 0;
      if (esi > 0) lines.push({ code: "ESI", name: esiComp.name, kind: "deduction", amount: esi });
    }
    if (ptComp && ptCfg) {
      const pt = professionalTax(fullMonthlyBase, ptCfg); // PT is a monthly slab on the full wage bracket
      if (pt > 0) lines.push({ code: "PT", name: ptComp.name, kind: "deduction", amount: pt });
    }

    lines.push(...(oneOffs[e.uuid] ?? [])); // bonuses, OT, statutory deduction inputs, manual LOP

    // Automatic loss-of-pay: per-day base pay x unexcused day-units (absent=1, half day=0.5) in the period.
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
        fullDayMinutes: att.full_day_minutes ?? 480,
        halfDayMinutes: att.half_day_minutes ?? 240,
      });
      const amt = lopAmount(comp.basePay, dayUnits, att.lop_basis ?? "working_days", lop.workingDaysInPeriod);
      if (amt > 0) lines.push({ code: "LOP", name: `Loss of pay (${dayUnits}d)`, kind: "deduction", amount: amt });
    }

    // Leave encashment payouts: TAXABLE earning (encashment is salary income, so it lifts the TDS base below).
    const encashments = encashByEmp.get(e.uuid) ?? [];
    for (const r of encashments) if ((r.currency || "INR") !== orgCurrency) throw failedPrecondition(`a leave encashment for ${e.firstName} ${e.lastName} is in ${r.currency || "INR"}, not ${orgCurrency}`);
    const encashDays = encashments.reduce((s, r) => s + r.days, 0);
    const encashTotal = encashments.reduce((s, r) => s + r.amount, 0);
    if (encashTotal > 0) {
      lines.push({ code: "ENCASH", name: `Leave encashment (${round2(encashDays)} day(s))`, kind: "earning", amount: round2(encashTotal) });
      paidEncashIds.push(...encashments.map((r) => r.uuid));
    }

    // Bonuses (individual + group awards): each unpaid award is a TAXABLE earning line, so it lifts the TDS
    // base below; then mark them paid by this run. One line per award, labelled by its kind.
    const empBonuses = bonusByEmp.get(e.uuid) ?? [];
    for (const b of empBonuses) {
      if ((b.currency || "INR") !== orgCurrency) throw failedPrecondition(`a bonus for ${e.firstName} ${e.lastName} is in ${b.currency || "INR"}, not ${orgCurrency}`);
      lines.push({ code: "BONUS", name: b.kind || "Bonus", kind: "earning", amount: round2(b.amount) });
    }
    paidBonusIds.push(...empBonuses.map((b) => b.uuid));

    // Overtime pay: approved-unpaid overtime (up to the period end) priced from base pay, as a TAXABLE earning.
    if (otCfg.enabled) {
      const ot = otByEmp.get(e.uuid) ?? [];
      const otMinutes = ot.reduce((s, r) => s + Math.max(0, Math.round((+new Date(r.endTime) - +new Date(r.startTime)) / 60000)), 0);
      const otAmt = overtimePay(otMinutes, comp.basePay, otCfg);
      if (otAmt > 0) {
        const h = Math.floor(otMinutes / 60), m = otMinutes % 60;
        lines.push({ code: "OT", name: `Overtime (${h}h${m ? ` ${m}m` : ""})`, kind: "earning", amount: otAmt });
        paidOtIds.push(...ot.map((r) => r.uuid));
      }
    }

    // Backdated-increment arrears: every UNPAID arrears amount the employee has accrued, paid once as a TAXABLE
    // earning. Scanning all of their comp rows - not just the period-effective one - matters when a second
    // revision lands before the first one's arrears were paid: the first row is closed by then, so keying off
    // the effective row alone would strand that raise's back pay forever.
    // `arrearsPaidAt` with no run = paid by an FnF settlement; either marker means the arrears are settled.
    const unpaidArrears = (compByEmp.get(e.uuid) ?? []).filter((c) => c.arrearsAmount > 0 && !c.arrearsPaidRunId && !c.arrearsPaidAt);
    for (const c of unpaidArrears) if ((c.currency || "INR") !== orgCurrency) throw failedPrecondition(`salary arrears for ${e.firstName} ${e.lastName} are in ${c.currency || "INR"}, not ${orgCurrency}`);
    const arrearsTotal = round2(unpaidArrears.reduce((s, c) => s + c.arrearsAmount, 0));
    if (arrearsTotal > 0) {
      lines.push({ code: "ARREARS", name: "Salary arrears", kind: "earning", amount: arrearsTotal });
      paidArrearIds.push(...unpaidArrears.map((c) => c.uuid));
    }

    // Reimbursement payouts: non-taxable earning (paid in net, excluded from the income-tax base).
    if (payViaPayroll) {
      const claims = reimbByEmp.get(e.uuid) ?? [];
      const total = claims.reduce((s, r) => s + r.amount, 0);
      if (total > 0) {
        lines.push({ code: "REIMB", name: "Reimbursement", kind: "earning", amount: round2(total), taxable: false });
        paidReimbIds.push(...claims.map((r) => r.uuid));
      }
    }

    let tax = 0;
    if (tds && cfg) {
      // TDS is computed on the TAXABLE gross only - reimbursement (taxable:false) lines never lift it.
      const taxableEarnings = lines.filter((l) => l.kind === "earning" && l.taxable !== false).reduce((s, l) => s + l.amount, 0);
      const decl = await readDeclarations(deps, e.taxDetailsEnc);
      const paid = paidTotals.get(e.uuid) ?? { gross: 0, taxableGross: 0, tax: 0, months: 0, paidMonths: new Set<string>() };
      const proj = assembleProjection({
        cfg, regime: tds.regime ?? "new", tdsConfigured: true,
        employedMonths: employedMonthsInFy(e.startDate ?? null, fy, e.endDate ?? null),
        paidGross: paid.taxableGross, paidTax: paid.tax, paidMonths: paid.months,
        // Spread the balance over the calendar months left from this run's pay month (inclusive - this run
        // collects the first installment), skipping months another finalized run already covered.
        collectMonths: collectibleMonths(period?.payDate ?? new Date(), e.startDate ?? null, fy, paid.paidMonths),
        recurringMonthly: monthlyRecurringGross(comp.basePay, effective, comp.specialAllowance),
        currentRunGross: taxableEarnings, decl,
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

    const totals = computeRunItem(lines);
    itemRows.push({ runId, employeeId: e.uuid, linesJson: JSON.stringify(lines), ...totals, tax });
  }

  // Commit the whole build in ONE atomic batch: every paid-by-run marker, the loan ledger + balances, the
  // line items, and the build stamp land together or not at all - a crash mid-build can no longer mark a
  // payout paid without the item that pays it (and it all costs one subrequest). IN-lists and multi-row
  // inserts are chunked under D1's 100-bound-params-per-statement cap; chunks ride in the same batch.
  const loansById = new Map([...dueLoansByEmp.values()].flat().map((d) => [d.loan.uuid, d.loan]));
  const loanWrites = loanRepaymentWrites(deps, loansById, loanEntries, runId, now);
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
  const stmts: (BatchStmt | CheckedStmt)[] = [
    ...marks,
    ...loanWrites.stmts,
    ...chunk(itemRows, 8).map((rows) => deps.db.insert(schema.payrollRunItems).values(rows)),
    // Stamp the build time: any income-affecting input touched after this makes the run stale (see runStaleness).
    deps.db.update(schema.payrollRuns).set({ itemsBuiltAt: now, updatedAt: now }).where(eq(schema.payrollRuns.uuid, runId)),
  ];
  const drifted = await runBatchChecked(deps.db, stmts);
  if (drifted.length) {
    // The build priced payables that moved under it. The items just written would pay them without settling
    // them, so undo the whole build back to the clean "never built" state (the same reset the build opens
    // with) and fail loudly. Nothing is paid, no marker survives, and a rebuild re-reads the queues.
    await runBatch(deps.db, [
      deps.db.delete(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId)),
      ...(await releasePaidByRun(deps, runId)),
      deps.db.update(schema.payrollRuns).set({ itemsBuiltAt: null }).where(eq(schema.payrollRuns.uuid, runId)),
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
  await audit(deps, actor, "payroll.build", "payroll-runs", runId, { employees: employees.length });
  return getRun(deps, runId);
}

// Is a built, still-editable run out of date? The run's numbers are a snapshot of the inputs as of its last
// build (`itemsBuiltAt`). Any income-affecting input changed since then means a rebuild would move the money,
// so we surface it (the run page banner + rebuild). Completeness over precision: we bias to catching every
// real change - a rebuild is idempotent, so an occasional false positive (e.g. an unrelated profile edit
// bumping employees.updatedAt) is harmless, whereas a MISSED change would silently ship a wrong payslip.
// Only meaningful while editable (DRAFT/REVIEW); a published run is immutable and self-corrects in the next run.
export type RunStaleness = { built_time: string | null; stale: boolean; changes: string[] };
export async function runStaleness(deps: Deps, run: { uuid: string; state: string; itemsBuiltAt: Date | null }): Promise<RunStaleness> {
  const builtAt = run.itemsBuiltAt;
  if (!isEditable(run.state as RunState) || !builtAt) return { built_time: builtAt ? builtAt.toISOString() : null, stale: false, changes: [] };
  // Each source: does any row's updatedAt post-date the build? `updatedAt` also bumps on create + soft-delete
  // + enable/disable, so joiners, removals and toggles are all covered by the same comparison.
  const changedSince = async (table: { updatedAt: unknown }): Promise<boolean> =>
    (await deps.db.select({ x: sql`1` }).from(table as never).where(gt(table.updatedAt as never, builtAt)).limit(1)).length > 0;
  const sources: { label: string; table: { updatedAt: unknown } }[] = [
    { label: "Employee records (joiners, tax verifications, EPF, status)", table: schema.employees },
    { label: "Compensation revisions", table: schema.compensation },
    { label: "Pay components", table: schema.payComponents },
    { label: "Salary structures", table: schema.salaryStructures },
    { label: "Bonuses", table: schema.bonuses },
    { label: "Leave encashments", table: schema.leaveEncashments },
    { label: "Reimbursements", table: schema.reimbursements },
    { label: "Overtime requests", table: schema.overtimeRequests },
    { label: "Loans", table: schema.loans },
    { label: "Pay-run settings (CTC / tax / overtime / PT)", table: schema.settings },
    // Holidays shift the working-days denominator that prorates mid-period joiners/leavers, so they move the
    // money even with LOP off.
    { label: "Holidays", table: schema.holidays },
  ];
  // Loss-of-pay inputs only affect the run when LOP is enabled: approved leave (excuses an absence) and
  // attendance punches (worked minutes decide the absent day-units). Gate them on the setting so a routine
  // clock-in doesn't flag every run stale in an org that doesn't dock unauthorised absence.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  if (att.lop_enabled) {
    sources.push({ label: "Approved leave (loss-of-pay)", table: schema.leaveRequests });
    sources.push({ label: "Attendance punches (loss-of-pay)", table: schema.attendanceSessions });
  }
  const changes: string[] = [];
  for (const s of sources) if (await changedSince(s.table)) changes.push(s.label);
  return { built_time: builtAt.toISOString(), stale: changes.length > 0, changes };
}

// :submit / :approve / :lock map here. Maker-checker enforced on approve.
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
    const committed = await deps.db
      .select({ uuid: schema.payrollRuns.uuid })
      .from(schema.payrollRuns)
      .where(and(eq(schema.payrollRuns.payPeriodId, run.payPeriodId), inArray(schema.payrollRuns.state, ["APPROVED", "PUBLISHED"])));
    if (committed.some((o) => o.uuid !== runId)) {
      throw failedPrecondition("another run for this pay period is already approved; delete it before approving this one");
    }
  }

  const set: Record<string, unknown> = { state: to, updatedAt: new Date() };
  if (to === "REVIEW") set.submittedBy = actor.uuid;
  // Approve is super-only, enforced centrally by the grant (deny payroll-runs.*.approve for payroll_admin).
  if (to === "APPROVED") set.approvedBy = actor.uuid;
  // The `run_period_committed_idx` partial unique index is the race backstop for the check above: if a
  // concurrent approve committed another run for this period between the check and here, this write hits the
  // constraint. Translate it to the same clean precondition error instead of a raw 500.
  let updated;
  try {
    [updated] = await deps.db.update(schema.payrollRuns).set(set).where(eq(schema.payrollRuns.uuid, runId)).returning();
  } catch (e) {
    if (to === "APPROVED" && String((e as Error)?.message ?? "").toLowerCase().includes("unique"))
      throw failedPrecondition("another run for this pay period is already approved; delete it before approving this one");
    throw e;
  }
  await audit(deps, actor, `payroll.${to.toLowerCase()}`, "payroll-runs", runId);
  return (await withNames(deps, [updated!]))[0]!;
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
  await audit(deps, actor, "payroll.delete", "payroll-runs", runId);
}

// :publish - transition to PUBLISHED and start the payslip-generation Operation. Returns the job row.
export async function publishRun(deps: Deps, actor: AppUser, runId: string, ifMatch?: string) {
  const run = await getRun(deps, runId);
  assertEtag(run, ifMatch);
  if (!canTransition(run.state as RunState, "PUBLISHED")) throw failedPrecondition("run must be APPROVED before publish");
  await deps.db.update(schema.payrollRuns).set({ state: "PUBLISHED", updatedAt: new Date() }).where(eq(schema.payrollRuns.uuid, runId));
  // Tell each employee in the run their payslip is available (payslips generate async right after).
  const runEmps = await deps.db.select({ employeeId: schema.payrollRunItems.employeeId }).from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, runId));
  await notifyMany(deps, runEmps.map((r) => r.employeeId).filter(Boolean) as string[], { type: "payslip.published", title: "Payslip available", body: "Your payslip for this period is ready.", link: "payslips" });
  // Operations are employee-owned (like leave-requests): owner-embedded code under the creator's employee
  // so the middleware scopes them via `me`/`my-dept`. A creator with no employee record gets a flat code +
  // null owner -> the operation is admin-only visible (fail-closed).
  const code = actor.employeeId
    ? await allocOwnedCode(deps, schema.jobs, schema.jobs.employeeId, actor.employeeId)
    : await allocFlatCode(deps, schema.jobs);
  const job = (await deps.db.insert(schema.jobs).values({ code, employeeId: actor.employeeId, kind: "payslip.generateRun", payload: JSON.stringify({ runId }), createdBy: actor.uuid }).returning())[0]!;
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
};

async function payslipRunContext(deps: Deps, run: typeof schema.payrollRuns.$inferSelect): Promise<PayslipRunContext> {
  const period = (await deps.db.select().from(schema.payPeriods).where(eq(schema.payPeriods.uuid, run.payPeriodId)).limit(1))[0];
  const org = await getSettingValue<{ name?: string; logo?: string; address?: string; default_currency?: string; currency_decimals?: CurrencyDecimals }>(deps, "organization", {});
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const depts = new Map((await deps.db.select().from(schema.departments)).map((d) => [d.uuid, d.name] as const));
  const lop = period ? await assembleLop(deps, period, att) : null;
  const currencyCode = org.default_currency || "INR";
  // The design is org config. A blob that fails validation falls back to the stock layout rather than failing
  // the run - payslips must still go out if someone saved a broken template.
  const template = payslipTemplateOrDefault(await getSettingValue<unknown>(deps, "payslip", null));
  return {
    org: { name: org.name, logo: org.logo, address: org.address },
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
    const tz = att.timezone || "Asia/Kolkata";
    const empStartYmd = emp.startDate ? localDay(+new Date(emp.startDate), tz) : null;
    const empEndYmd = emp.endDate ? localDay(+new Date(emp.endDate), tz) : null;
    const wStart = empStartYmd && empStartYmd > lop.startYmd ? empStartYmd : lop.startYmd;
    const wEnd = empEndYmd && empEndYmd < lop.endYmd ? empEndYmd : lop.endYmd;
    const lopDays = lopDayUnits({
      startYmd: wStart, endYmd: wEnd, workDays: att.work_days, holidays: lop.holidays,
      leaveRanges: lop.leaveByEmp.get(emp.uuid) ?? [], workedByDay: lop.workedByEmp.get(emp.uuid) ?? new Map<string, number>(),
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
    lines,
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
  return { bytes: await renderPayslipPdf(data, ctx.template), fileName: `payslip-preview-${item.uuid}.pdf` };
}

// Called by the cron drainer. Resumable + idempotent: bounded batch, skips already-generated payslips.
export async function processPayslipRunJob(deps: Deps, jobId: string, payload: { runId: string }, batch = 25) {
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.runId, payload.runId));
  const slips = await deps.db.select().from(schema.payslips).where(eq(schema.payslips.runId, payload.runId));
  const existing = new Set(slips.map((p) => p.runItemId));
  const todo = items.filter((it) => !existing.has(it.uuid)).slice(0, batch);

  const run = await getRun(deps, payload.runId);
  const ctx = await payslipRunContext(deps, run);

  for (const it of todo) {
    const data = await payslipDataForItem(deps, ctx, it);
    if (!data) continue; // employee row gone - nothing to render
    const pdf = await renderPayslipPdf(data, ctx.template);
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
  }

  const remaining = items.length - (existing.size + todo.length);
  if (remaining > 0) {
    await deps.db.update(schema.jobs).set({ status: "queued" }).where(eq(schema.jobs.uuid, jobId)); // resume next tick
    return { done: false };
  }
  await deps.db.update(schema.jobs).set({ resultJson: JSON.stringify({ payslips_generated: items.length, run: `payroll-runs/${payload.runId}` }) }).where(eq(schema.jobs.uuid, jobId));
  return { done: true };
}
