import { allocOwnedCode } from "./codeAlloc";
import { and, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { currentComp, monthlyRecurringGross } from "./taxProjection";
import { approvedUnpaidReimbursements, markReimbursementsSettled, releaseReimbursementsSettled } from "./reimbursements";
import { unpaidBonuses, markBonusesSettled, releaseBonusesSettled } from "./bonuses";
import { approvedUnpaidEncashments, markEncashmentsSettled, releaseEncashmentsSettled } from "./leaveEncashments";
import { approvedUnpaidOvertime, markOvertimeSettled, releaseOvertimeSettled } from "./overtimeRequests";
import { markCompArrearsSettled, releaseCompArrearsSettled } from "./compensation";
import { outstandingLoans, repaidCreditStmt, recomputeRepaidStmt } from "./loans";
import { getSettingValue } from "./settings";
import { applyStructure, overtimePay, DEFAULT_OVERTIME_CONFIG, type OvertimeConfig } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import { computeSettlement } from "../domain/settlement";
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

  // Encashable leave: explicit override, else the sum of the employee's leave balances.
  let leaveDays = input.leave_days;
  if (typeof leaveDays !== "number") {
    const bals = await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, employeeId));
    leaveDays = Math.max(0, sum2(bals.map((b) => b.balanceDays)));
  }
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

  const settlement = computeSettlement({
    monthlyGross,
    basePay: comp.basePay,
    daysWorkedInMonth: settlementDate.getUTCDate(),
    daysInMonth: daysInMonthUTC(settlementDate),
    leaveDays,
    noticeShortfallDays,
    reimbursements,
    extraEarnings,
    extraDeductions,
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
  let toDebit = round2(leaveDays);
  if (toDebit > 0) {
    for (const b of await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, employeeId))) {
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
