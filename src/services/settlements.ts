import { allocOwnedCode } from "./codeAlloc";
import { and, eq } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { currentComp, monthlyRecurringGross } from "./taxProjection";
import { approvedUnpaidReimbursements, markReimbursementsSettled } from "./reimbursements";
import { applyStructure } from "../domain/payroll";
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

export async function computeAndStoreSettlement(deps: Deps, actor: AppUser, input: SettlementInput) {
  const employeeId = idFromPath(input.employee);
  if (!employeeId) throw invalidArgument("employee is required");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");

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

  const settlement = computeSettlement({
    monthlyGross,
    basePay: comp.basePay,
    daysWorkedInMonth: settlementDate.getUTCDate(),
    daysInMonth: daysInMonthUTC(settlementDate),
    leaveDays,
    noticeShortfallDays,
    reimbursements,
  });

  const row = (await deps.db
    .insert(schema.settlements)
    .values({
      code: await allocOwnedCode(deps, schema.settlements, schema.settlements.employeeId, employeeId),
      employeeId,
      settlementDate,
      currency: comp.currency || "INR",
      leaveDays,
      noticeShortfallDays,
      linesJson: JSON.stringify(settlement.lines),
      totalEarnings: settlement.totalEarnings,
      totalDeductions: settlement.totalDeductions,
      net: settlement.net,
    })
    .returning())[0]!;
  // FnF is the terminal payout for the leaver: the claims it just settled must leave the payroll payout queue,
  // else a run for a still-active employee would pay them again. Reuses the PAID marker (no payroll run).
  await markReimbursementsSettled(deps, reimbClaims.map((r) => r.uuid), new Date());
  await audit(deps, actor, "settlement.compute", "settlements", row.uuid, { employee: `employees/${employeeId}` });
  // Let the leaver know their full & final settlement has been prepared (visible on their profile).
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "settlement.ready", title: "Full & final settlement ready", body: `Your final settlement has been computed (net ${settlement.net}).`, link: "profile", subject: `settlements/${row.uuid}`, actorId: actor.employeeId });
  return row;
}
