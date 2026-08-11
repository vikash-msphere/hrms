import { allocOwnedCode } from "./codeAlloc";
import { and, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import {
  currentComp, monthlyRecurringGross, tdsComponent, loadTaxConfig, fyWindow, finalizedTotals,
  assembleProjection, readDeclarations, verifiedDeductions, employedMonthsInFy, EMPTY_FINALIZED_TOTALS,
} from "./taxProjection";
import { encashmentRateConfig } from "./leaveEncashments";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, type WorkEvent, localDay, lopDayUnits, eventCreditByDay } from "../domain/attendance";
import { esiEmployeeContribution, professionalTax, DEFAULT_PT_CONFIG, type PtConfig } from "../domain/statutory";
import { approvedUnpaidReimbursements, markReimbursementsSettled, releaseReimbursementsSettled } from "./reimbursements";
import { unpaidBonuses, markBonusesSettled, releaseBonusesSettled } from "./bonuses";
import { approvedUnpaidEncashments, markEncashmentsSettled, releaseEncashmentsSettled } from "./leaveEncashments";
import { approvedUnpaidOvertime, markOvertimeSettled, releaseOvertimeSettled } from "./overtimeRequests";
import { markCompArrearsSettled, releaseCompArrearsSettled } from "./compensation";
import { outstandingLoans, repaidCreditStmt, recomputeRepaidStmt } from "./loans";
import { getSettingValue } from "./settings";
import { applyStructure, overtimePay, DEFAULT_OVERTIME_CONFIG, type OvertimeConfig } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import {
  computeSettlement, completedYearsOfService, gratuityAmount, gratuityExemption, leaveEncashmentExemption,
  DEFAULT_GRATUITY_CONFIG, type GratuityConfig, type SettlementLine,
} from "../domain/settlement";
import { round2, sum2 } from "../domain/money";
import { notify } from "./notifications";

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

export async function listSettlements(deps: Deps, scope: ListScope, employeeId?: string) {
  const conds = [applyScope(scope, schema.settlements.code, schema.settlements.employeeId)];
  if (employeeId) conds.push(eq(schema.settlements.employeeId, employeeId));
  const rows = await deps.db.select().from(schema.settlements).where(conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as any)) : undefined);
  return rows.sort((a, b) => +new Date(b.settlementDate) - +new Date(a.settlementDate) || b.uuid.localeCompare(a.uuid));
}

export async function getSettlement(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.settlements).where(eq(schema.settlements.uuid, id)).limit(1))[0];
  if (!row) throw notFound("settlement not found");
  return row;
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
// the payroll run's releasePaidByRun - same contract, keyed to a settlement instead of a run.
async function releaseSettlement(deps: Deps, row: typeof schema.settlements.$inferSelect): Promise<void> {
  const refs = parseRefs(row.settledJson);
  await releaseReimbursementsSettled(deps, refs.reimbursements);
  await releaseBonusesSettled(deps, refs.bonuses);
  await releaseEncashmentsSettled(deps, refs.encashments);
  await releaseOvertimeSettled(deps, refs.overtime);
  await releaseCompArrearsSettled(deps, refs.arrears);
  if (refs.loans.length) {
    await deps.db.delete(schema.loanRepayments).where(inArray(schema.loanRepayments.uuid, refs.loans.map((l) => l.repaymentId)));
    const at = new Date();
    for (const loanId of new Set(refs.loans.map((l) => l.loanId))) await recomputeRepaidStmt(deps, loanId, at);
  }
  for (const d of refs.leaveDebits) {
    if (!(d.days > 0)) continue;
    await deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: sql`round(${schema.leaveBalances.balanceDays} + ${d.days}, 2)`, updatedAt: new Date() })
      .where(eq(schema.leaveBalances.uuid, d.balanceId));
  }
}

// Unexcused absence day-units inside the final month's employed window, from exactly the facts a payroll run
// uses (holidays, approved leave, attendance punches) so the exit month is docked the same way every other
// month is. Scoped to one employee and one month, so it stays a handful of reads.
async function finalMonthLopDays(deps: Deps, employeeId: string, fromMs: number, toMs: number, att: AttendanceConfig): Promise<number> {
  const tz = att.timezone || "Asia/Kolkata";
  const startYmd = localDay(fromMs, tz);
  const endYmd = localDay(toMs, tz);
  const holidays = new Set(
    (await deps.db.select().from(schema.holidays))
      .filter((h) => !h.deleteTime && !h.disabled && +new Date(h.date) >= fromMs && +new Date(h.date) <= toMs)
      .map((h) => localDay(+new Date(h.date), tz)),
  );
  const leaveRanges = (await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.employeeId, employeeId)))
    .filter((l) => l.state === "APPROVED" && +new Date(l.endDate) >= fromMs && +new Date(l.startDate) <= toMs)
    .map((l) => ({ start: localDay(+new Date(l.startDate), tz), end: localDay(+new Date(l.endDate), tz) }));
  const workedByDay = new Map<string, number>();
  for (const s of await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.employeeId, employeeId))) {
    const ms = +new Date(s.clockIn);
    if (ms < fromMs || ms > toMs + 86_400_000) continue;
    const day = localDay(ms, tz);
    const minutes = s.clockOut ? Math.max(0, Math.round((+new Date(s.clockOut) - ms) / 60000)) : 0;
    workedByDay.set(day, (workedByDay.get(day) ?? 0) + minutes);
  }
  // Same event credit the payroll build applies, so a leaver's final settlement doesn't dock days they spent
  // at a count_as_work event (see assembleLop in services/payroll.ts).
  const nowMs = +deps.clock.now();
  const events: WorkEvent[] = [];
  for (const e of await deps.db.select().from(schema.events)) {
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

  return lopDayUnits({
    startYmd, endYmd, workDays: att.work_days, holidays, leaveRanges, workedByDay,
    fullDayMinutes: att.full_day_minutes ?? 480,
    halfDayMinutes: att.half_day_minutes ?? 240,
  });
}

// PF / ESI / PT withheld on the exit payout, from the org's own pay components - the same opt-in components and
// the same pure statutory maths the payroll build uses, so the two never disagree about a rate or a ceiling.
async function settlementStatutoryLines(
  deps: Deps,
  f: { components: typeof schema.payComponents.$inferSelect[]; epfEnrolled: boolean; monthlyGross: number; pfWages: number; esiWages: number },
): Promise<SettlementLine[]> {
  const out: SettlementLine[] = [];
  const live = f.components.filter((c) => !c.disabled && !c.deleteTime && c.recurring);
  const epfComp = live.find((c) => c.method === "epf" && c.kind === "deduction");
  if (epfComp && f.epfEnrolled && f.pfWages > 0) {
    const epf = round2(Math.min(f.pfWages, epfComp.cap ?? Infinity) * ((epfComp.rate ?? 12) / 100));
    if (epf > 0) out.push({ name: epfComp.name, kind: "deduction", amount: epf });
  }
  const esiComp = live.find((c) => c.method === "esi" && c.kind === "deduction");
  if (esiComp && f.esiWages > 0) {
    // Eligibility on the monthly wage rate (the ceiling test), contribution on the wages actually paid.
    const eligible = f.monthlyGross > 0 && f.monthlyGross <= (esiComp.cap ?? 21000);
    const esi = eligible ? esiEmployeeContribution(f.esiWages, esiComp.rate ?? 0.75, Infinity) : 0;
    if (esi > 0) out.push({ name: esiComp.name, kind: "deduction", amount: esi });
  }
  const ptComp = live.find((c) => c.method === "pt" && c.kind === "deduction");
  if (ptComp && f.esiWages > 0) {
    const pt = professionalTax(f.monthlyGross, await getSettingValue<PtConfig>(deps, "professional-tax", DEFAULT_PT_CONFIG));
    if (pt > 0) out.push({ name: ptComp.name, kind: "deduction", amount: pt });
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
  for (const p of prior) {
    await releaseSettlement(deps, p);
    await deps.db.delete(schema.settlements).where(eq(schema.settlements.uuid, p.uuid));
  }

  const comp = await currentComp(deps, employeeId);
  if (!comp) throw invalidArgument("the employee has no compensation on record");
  const components = await deps.db.select().from(schema.payComponents);
  // Apply the employee's salary structure (their earning set + rate overrides) before pricing gross, so a
  // structured employee's FnF matches payroll/encashment/tax - unstructured earnings must not inflate it.
  const effective = applyStructure(components, await structureLinesById(deps, comp.structureId));
  const monthlyGross = monthlyRecurringGross(comp.basePay, effective, comp.specialAllowance);

  const settleMs = !Number.isNaN(dayMs(input.settlement_date)) ? dayMs(input.settlement_date) : +(emp.endDate ?? deps.clock.now());
  const settlementDate = new Date(settleMs);

  // Encashable leave: explicit override, else the balance of the ENCASHABLE leave types only. The same
  // `encashable` / `disabled` flags a mid-employment cashout enforces apply at exit - summing every balance row
  // cashed out sick and casual leave that the policy says is not encashable at all.
  const encashableTypes = new Set(
    (await deps.db.select().from(schema.leaveTypes)).filter((t) => t.encashable && !t.disabled && !t.deleteTime).map((t) => t.uuid),
  );
  const encashableBalances = (await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, employeeId)))
    .filter((b) => encashableTypes.has(b.leaveTypeId));
  let leaveDays = input.leave_days;
  if (typeof leaveDays !== "number") leaveDays = Math.max(0, sum2(encashableBalances.map((b) => b.balanceDays)));
  const noticeShortfallDays = Math.max(0, input.notice_shortfall_days ?? 0);
  const reimbClaims = await approvedUnpaidReimbursements(deps, employeeId);
  const reimbursements = sum2(reimbClaims.map((r) => r.amount));

  // Everything else still queued for this employee. A payroll run only pays ACTIVE employees, so once the exit
  // transition flips them to `terminated` these payables can never be paid by a run - the FnF is their last
  // chance, and an outstanding loan is the company's last chance to recover.
  const currency = comp.currency || "INR";
  const bonuses = await unpaidBonuses(deps, employeeId);
  const encashments = await approvedUnpaidEncashments(deps, employeeId);
  const otCfg = await getSettingValue<OvertimeConfig>(deps, "overtime", DEFAULT_OVERTIME_CONFIG);
  const overtime = otCfg.enabled ? await approvedUnpaidOvertime(deps, employeeId) : [];
  const arrearsRows = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, employeeId)))
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
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const daysInMonth = daysInMonthUTC(settlementDate);
  const monthStartMs = Date.UTC(settlementDate.getUTCFullYear(), settlementDate.getUTCMonth(), 1);
  const startedThisMonth = emp.startDate && +new Date(emp.startDate) > monthStartMs ? +new Date(emp.startDate) : monthStartMs;
  const daysWorkedInMonth = Math.max(0, Math.round((settleMs - startedThisMonth) / 86_400_000) + 1);
  // Absences are only countable up to today: a settlement computed BEFORE the last working day must not dock days
  // that haven't happened yet (the same clamp the payroll build applies to a mid-period build).
  const lopUntilMs = Math.min(settleMs, +deps.clock.now());
  const lopDaysInFinalMonth = att.lop_enabled && lopUntilMs >= startedThisMonth
    ? await finalMonthLopDays(deps, employeeId, startedThisMonth, lopUntilMs, att)
    : 0;

  // ---- Exit benefits --------------------------------------------------------------------------------------
  // Statutory gratuity, and the s.10(10AA) exemption on the leave being encashed, both need completed service.
  const serviceYears = completedYearsOfService(+(emp.startDate ?? settlementDate), settleMs);
  const gratuityCfg = await getSettingValue<GratuityConfig>(deps, "gratuity", DEFAULT_GRATUITY_CONFIG);
  const gratuityPay = gratuityAmount(comp.basePay, serviceYears, gratuityCfg);
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
    encashExempt: leaveEncashmentExemption(encashGross, comp.basePay, leaveDays, serviceYears),
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
  const salaryEarned = pass1.lines.find((l) => l.name.startsWith("Salary"))?.amount ?? 0;
  const arrearsTotal = sum2(arrearsRows.map((c) => c.arrearsAmount));
  const arrearsPfWages = sum2(arrearsRows.map((c) => c.arrearsBaseAmount));
  const statutory = await settlementStatutoryLines(deps, {
    components: effective,
    epfEnrolled: emp.epfEnrolled,
    monthlyGross,
    // PF wages for the final month: the basic actually earned (the same day fraction the salary was paid on),
    // plus the basic slice of any arrears the FnF pays.
    pfWages: round2((comp.basePay * (daysInMonth > 0 ? Math.max(0, daysWorkedInMonth - lopDaysInFinalMonth) / daysInMonth : 0)) + arrearsPfWages),
    // ESI wages: the wage actually paid for the month plus arrears and overtime. Leave encashment, gratuity,
    // bonus and reimbursements are not ESI wages.
    esiWages: round2(salaryEarned + arrearsTotal + otAmount),
  });
  const tds = await settlementTds(deps, emp, settlementDate, pass1.totalTaxableEarnings, effective);
  const settlement = computeSettlement({
    ...facts,
    // Statutory and tax first, then the recoveries: the deduction order the payslip uses.
    extraDeductions: [...statutory, ...(tds > 0 ? [{ name: "Income tax (TDS)", kind: "deduction" as const, amount: tds }] : []), ...extraDeductions],
  });

  const row = (await deps.db
    .insert(schema.settlements)
    .values({
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
    })
    .returning())[0]!;

  // The FnF is the terminal payout: everything it just priced must LEAVE its source queue, or a later run (or
  // a recomputed settlement) pays it a second time. Each marker is the no-run variant - paid, but by a
  // settlement rather than a payroll run - and every id is recorded on the settlement so releaseSettlement can
  // undo exactly this set.
  const at = new Date();
  const refs: SettledRefs = {
    reimbursements: reimbClaims.map((r) => r.uuid),
    bonuses: bonuses.map((b) => b.uuid),
    encashments: encashments.map((e2) => e2.uuid),
    overtime: otAmount > 0 ? overtime.map((o) => o.uuid) : [],
    arrears: arrearsRows.map((c) => c.uuid),
    loans: [],
    leaveDebits: [],
  };
  await markReimbursementsSettled(deps, refs.reimbursements, at);
  await markBonusesSettled(deps, refs.bonuses, at);
  await markEncashmentsSettled(deps, refs.encashments, at);
  await markOvertimeSettled(deps, refs.overtime, at);
  await markCompArrearsSettled(deps, refs.arrears, at);
  // Loan recovery: write the same ledger row a repayment always writes (run-less, like a manual repayment) and
  // advance `repaid` relatively, so the loan closes and nothing can collect it twice.
  for (const l of loans) {
    const [rep] = await deps.db.insert(schema.loanRepayments).values({ loanId: l.uuid, runId: null, amount: l.outstanding, at }).returning({ uuid: schema.loanRepayments.uuid });
    await repaidCreditStmt(deps, l.uuid, l.outstanding, at);
    refs.loans.push({ repaymentId: rep!.uuid, loanId: l.uuid, amount: l.outstanding });
  }
  // Encashing the leave balance CONSUMES it: without this the days stay on the books, so a recomputed
  // settlement (or a rehire) would encash the same days again.
  // Only ENCASHABLE types are debited - they are the only ones being paid out. An explicit `leave_days` override
  // larger than those balances pays the days HR asked for but can debit no more than the employee holds.
  let toDebit = round2(leaveDays);
  if (toDebit > 0) {
    for (const b of encashableBalances) {
      if (toDebit <= 0.005 || b.balanceDays <= 0) continue;
      const take = round2(Math.min(b.balanceDays, toDebit));
      await deps.db
        .update(schema.leaveBalances)
        .set({ balanceDays: sql`max(0, round(${schema.leaveBalances.balanceDays} - ${take}, 2))`, updatedAt: at })
        .where(eq(schema.leaveBalances.uuid, b.uuid));
      refs.leaveDebits.push({ balanceId: b.uuid, days: take });
      toDebit = round2(toDebit - take);
    }
  }
  await deps.db.update(schema.settlements).set({ settledJson: JSON.stringify(refs) }).where(eq(schema.settlements.uuid, row.uuid));
  await audit(deps, actor, "settlement.compute", "settlements", row.uuid, { employee: `employees/${employeeId}` });
  // Let the leaver know their full & final settlement has been prepared (visible on their profile).
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "settlement.ready", title: "Full & final settlement ready", body: `Your final settlement has been computed (net ${settlement.net}).`, link: "profile", subject: `settlements/${row.uuid}`, actorId: actor.employeeId });
  return row;
}
