import { allocOwnedCode } from "./codeAlloc";
// WORKFLOW resource (custom methods :approve/:reject/:cancel; PAID is set by the payroll payout, never by
// hand). HR-driven only: there is no employee self-service create. APPROVED debits the leave balance; the
// next payroll run pays approved-unpaid rows as a TAXABLE earning line (encashment is salary income).
import { eq, and, inArray, isNull, gte, lte, sql } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { getSettingValue } from "./settings";
import { currentComp, monthlyRecurringGross } from "./taxProjection";
import { applyStructure } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import { encashmentRatePerDay, encashmentAmount, encashmentEligibilityError, type RateBasis } from "../domain/encashment";
import { calendarYearWindow, type CarryForwardExcess } from "../domain/carryForward";

// Org-wide leave caps config (data, configurable in Settings). Picks per-type vs cumulative caps for both
// encashment and carry-forward, and what happens to carry-forward excess (auto-encash up to the cap, or
// forfeit). Cumulative caps apply to the SUM across all eligible leave types; per-type uses each type's own.
export type LeaveCapsConfig = {
  carry_forward_excess: CarryForwardExcess;
  carry_forward_mode: "per_type" | "cumulative";
  carry_forward_cumulative_cap_days: number | null;
  encashment_mode: "per_type" | "cumulative";
  encashment_cumulative_cap_days: number | null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export async function leaveCaps(deps: Deps): Promise<LeaveCapsConfig> {
  const v = await getSettingValue<Partial<LeaveCapsConfig>>(deps, "leave_caps", {});
  return {
    carry_forward_excess: v.carry_forward_excess === "forfeit" ? "forfeit" : "encash",
    carry_forward_mode: v.carry_forward_mode === "cumulative" ? "cumulative" : "per_type",
    carry_forward_cumulative_cap_days: num(v.carry_forward_cumulative_cap_days),
    encashment_mode: v.encashment_mode === "cumulative" ? "cumulative" : "per_type",
    encashment_cumulative_cap_days: num(v.encashment_cumulative_cap_days),
  };
}

export type EncashmentInput = {
  employee?: string | null;
  leave_type?: string | null;
  days?: number;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
import { round2 } from "../domain/money";

// Rate config (data, configurable in Settings). basis "base" => basePay / divisor; "gross" => monthly recurring
// gross / divisor. divisor defaults to 30 (per-day rate basis). Exported because the FnF prices exit encashment
// from the SAME config: one concept, one rate - the FnF used to hard-wire basePay/30 and quietly disagree with
// every mid-employment cashout the org had configured.
export type RateConfig = { rate_basis?: RateBasis; per_day_divisor?: number };
export async function encashmentRateConfig(deps: Deps): Promise<{ basis: RateBasis; divisor: number }> {
  const v = await getSettingValue<RateConfig>(deps, "leave_encashment", {});
  return { basis: v.rate_basis === "gross" ? "gross" : "base", divisor: v.per_day_divisor && v.per_day_divisor > 0 ? v.per_day_divisor : 30 };
}

export async function listEncashments(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, employeeId?: string) {
  const conds = [applyScope(scope, schema.leaveEncashments.code, schema.leaveEncashments.employeeId)];
  if (stateFilter) conds.push(eq(schema.leaveEncashments.state, stateFilter as typeof schema.leaveEncashments.$inferSelect.state));
  if (employeeId) conds.push(eq(schema.leaveEncashments.employeeId, employeeId));
  return keysetPage<typeof schema.leaveEncashments.$inferSelect>(deps, schema.leaveEncashments, "leave-encashments", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}

export async function getEncashment(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.leaveEncashments).where(eq(schema.leaveEncashments.uuid, id)).limit(1))[0];
  if (!row) throw notFound("leave encashment not found");
  return row;
}

// Current balance for (employee, leave type); 0 if no balance row yet.
async function balanceOf(deps: Deps, employeeId: string, leaveTypeId: string): Promise<number> {
  const bal = (await deps.db.select().from(schema.leaveBalances)
    .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1))[0];
  return bal?.balanceDays ?? 0;
}

// Apply a signed delta to the (employee, leave type) balance, creating the row if absent (mirrors the leave
// consumption path in services/leaveRequests.ts).
async function adjustBalance(deps: Deps, employeeId: string, leaveTypeId: string, delta: number) {
  const bal = (await deps.db.select().from(schema.leaveBalances)
    .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1))[0];
  if (bal) {
    // SQL-side delta (not a JS read-modify-write): can't lose a concurrent reserve/release on the same row.
    await deps.db.update(schema.leaveBalances)
      .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} + ${delta}) * 100) / 100`, updatedAt: new Date() })
      .where(eq(schema.leaveBalances.uuid, bal.uuid));
  } else {
    await deps.db.insert(schema.leaveBalances)
      .values({ code: await allocOwnedCode(deps, schema.leaveBalances, schema.leaveBalances.employeeId, employeeId), employeeId, leaveTypeId, balanceDays: round2(delta) });
  }
}

// Days already committed (APPROVED or PAID) in the current calendar year - the running total the annual cap
// is measured against. Scoped to one leave type (per-type mode) or all types (cumulative mode).
export async function encashedDaysThisYear(deps: Deps, employeeId: string, leaveTypeId?: string): Promise<number> {
  const yr = calendarYearWindow(deps.clock.now());
  const conds = [
    eq(schema.leaveEncashments.employeeId, employeeId),
    inArray(schema.leaveEncashments.state, ["APPROVED", "PAID"] as const),
    gte(schema.leaveEncashments.createdAt, yr.start),
    lte(schema.leaveEncashments.createdAt, yr.end),
  ];
  if (leaveTypeId) conds.push(eq(schema.leaveEncashments.leaveTypeId, leaveTypeId));
  const rows = await deps.db.select().from(schema.leaveEncashments).where(and(...conds));
  return round2(rows.reduce((s, r) => s + r.days, 0));
}

export async function computeAndStoreEncashment(deps: Deps, actor: AppUser, input: EncashmentInput) {
  const days = Number(input.days);
  if (!Number.isFinite(days) || days <= 0) throw invalidArgument("days must be a positive number");
  const employeeId = idFromPath(input.employee);
  if (!employeeId) throw invalidArgument("employee is required");
  const leaveTypeId = idFromPath(input.leave_type);
  if (!leaveTypeId) throw invalidArgument("leave_type is required");

  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");
  const lt = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.uuid, leaveTypeId)).limit(1))[0];
  if (!lt || lt.deleteTime) throw notFound("leave type not found");

  // Eligibility (pure): encashable, balance covers the request, stays above the retained floor, within cap.
  // The cap is per-type (the type's own cap, measured against this type's encashed days) or cumulative (one
  // org cap, measured against ALL types' encashed days this calendar year).
  const caps = await leaveCaps(deps);
  const balance = await balanceOf(deps, employeeId, leaveTypeId);
  const cumulative = caps.encashment_mode === "cumulative";
  const capDays = cumulative ? caps.encashment_cumulative_cap_days : lt.encashmentCapDaysPerYear;
  const alreadyEncashed = capDays != null ? await encashedDaysThisYear(deps, employeeId, cumulative ? undefined : leaveTypeId) : 0;
  const reason = encashmentEligibilityError({
    encashable: lt.encashable,
    disabled: lt.disabled,
    days,
    balance,
    minBalanceRetainedDays: lt.minBalanceRetainedDays,
    capDaysPerYear: capDays,
    alreadyEncashedThisYear: alreadyEncashed,
  });
  if (reason) throw failedPrecondition(reason);

  const comp = await currentComp(deps, employeeId);
  if (!comp) throw invalidArgument("the employee has no compensation on record");
  const { basis, divisor } = await encashmentRateConfig(deps);
  let perBasis = comp.basePay;
  if (basis === "gross") {
    const components = await deps.db.select().from(schema.payComponents);
    const effective = applyStructure(components, await structureLinesById(deps, comp.structureId));
    perBasis = monthlyRecurringGross(comp.basePay, effective, comp.specialAllowance);
  }
  const ratePerDay = encashmentRatePerDay(perBasis, divisor); // stored/displayed per-day figure
  const amount = encashmentAmount(days, perBasis, divisor); // payable, rounded once (not days x rounded-rate)

  const row = (await deps.db
    .insert(schema.leaveEncashments)
    .values({
      code: await allocOwnedCode(deps, schema.leaveEncashments, schema.leaveEncashments.employeeId, employeeId),
      employeeId,
      leaveTypeId,
      days: round2(days),
      ratePerDay,
      amount,
      currency: comp.currency || "INR",
      state: "PENDING",
    })
    .returning())[0]!;
  await audit(deps, actor, "leave_encashment.compute", "leave-encashments", row.uuid, { employee: `employees/${employeeId}` });
  await emitEvent(deps, actor, "leaveEncashment.requested", { subject: `leave-encashments/${row.uuid}`, employeeId, payload: { days: row.days, amount: row.amount } });
  await notifyManager(deps, employeeId, { type: "encashment.requested", noun: "leave encashment request" });
  return row;
}

// System-created encashment for carry-forward excess (year-end rollover). The carry-forward step already
// removed these days from the balance, so this does NOT debit again - it only records the APPROVED payout the
// next payroll run will settle. Returns false (so the caller forfeits instead) when the employee can't be
// priced. Pure-rate logic is shared with computeAndStoreEncashment.
export async function createAutoEncashment(deps: Deps, employeeId: string, leaveTypeId: string, days: number): Promise<boolean> {
  if (!(days > 0)) return false;
  const comp = await currentComp(deps, employeeId);
  if (!comp) return false;
  const { basis, divisor } = await encashmentRateConfig(deps);
  let perBasis = comp.basePay;
  if (basis === "gross") {
    const components = await deps.db.select().from(schema.payComponents);
    const effective = applyStructure(components, await structureLinesById(deps, comp.structureId));
    perBasis = monthlyRecurringGross(comp.basePay, effective, comp.specialAllowance);
  }
  const ratePerDay = encashmentRatePerDay(perBasis, divisor);
  const row = (await deps.db
    .insert(schema.leaveEncashments)
    .values({
      code: await allocOwnedCode(deps, schema.leaveEncashments, schema.leaveEncashments.employeeId, employeeId),
      employeeId,
      leaveTypeId,
      days: round2(days),
      ratePerDay,
      amount: encashmentAmount(days, perBasis, divisor),
      currency: comp.currency || "INR",
      state: "APPROVED",
    })
    .returning())[0]!;
  await audit(deps, "system", "leave_encashment.auto", "leave-encashments", row.uuid, { employee: `employees/${employeeId}` });
  return true;
}

// approve: PENDING -> APPROVED, debits the balance (re-checked against the live balance, since leave may have
// been taken since the request was raised). reject: PENDING -> REJECTED. cancel: PENDING -> CANCELLED (no
// balance move), or APPROVED-and-unpaid -> CANCELLED (credits the days back). PAID rows are immutable.
export async function approveEncashment(deps: Deps, actor: AppUser, id: string) {
  const row = await getEncashment(deps, actor, id);
  if (row.state !== "PENDING") throw failedPrecondition("encashment is not pending");
  const balance = await balanceOf(deps, row.employeeId, row.leaveTypeId);
  if (row.days > balance) throw failedPrecondition(`insufficient leave balance (${balance} day(s) available)`);
  // Re-check the annual cap against LIVE committed (APPROVED+PAID) days: the cap at create time counted only
  // committed rows, so multiple still-PENDING requests could each pass it and, without this gate, all approve
  // past the cap. This row is still PENDING here, so `alreadyEncashed` excludes it - add row.days back in.
  const caps = await leaveCaps(deps);
  const cumulative = caps.encashment_mode === "cumulative";
  let capDays = caps.encashment_cumulative_cap_days;
  if (!cumulative) {
    const lt = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.uuid, row.leaveTypeId)).limit(1))[0];
    capDays = lt?.encashmentCapDaysPerYear ?? null;
  }
  if (capDays != null) {
    const alreadyEncashed = await encashedDaysThisYear(deps, row.employeeId, cumulative ? undefined : row.leaveTypeId);
    if (round2(alreadyEncashed + row.days) > capDays) {
      throw failedPrecondition(`annual encashment cap of ${capDays} day(s) exceeded (${alreadyEncashed} already used)`);
    }
  }
  // Claim the approval EXACTLY ONCE first (guarded PENDING->APPROVED): a double-clicked/concurrent approve of
  // the SAME row would otherwise debit the balance twice - each debit is guarded against over-draw below zero
  // but not against re-running for one request. Only the winner (1 row) proceeds to debit.
  const [updated] = await deps.db.update(schema.leaveEncashments)
    .set({ state: "APPROVED", decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.leaveEncashments.uuid, id), eq(schema.leaveEncashments.state, "PENDING"))).returning();
  if (!updated) throw failedPrecondition("encashment is not pending");
  // Atomic guarded debit: decrement only if the balance still covers it (balanceDays >= days in the WHERE), so
  // two DIFFERENT encashments approved concurrently can't both pass a stale read and over-debit below zero. If
  // the live balance no longer covers it, revert the claim so the row stays actionable instead of approved-unpaid.
  const [debited] = await deps.db.update(schema.leaveBalances)
    .set({ balanceDays: sql`round(${schema.leaveBalances.balanceDays} - ${row.days}, 2)`, updatedAt: new Date() })
    .where(and(eq(schema.leaveBalances.employeeId, row.employeeId), eq(schema.leaveBalances.leaveTypeId, row.leaveTypeId), gte(schema.leaveBalances.balanceDays, row.days)))
    .returning();
  if (!debited) {
    await deps.db.update(schema.leaveEncashments).set({ state: "PENDING", decidedBy: null, updatedAt: new Date() }).where(eq(schema.leaveEncashments.uuid, id));
    throw failedPrecondition(`insufficient leave balance (${await balanceOf(deps, row.employeeId, row.leaveTypeId)} day(s) available)`);
  }
  await audit(deps, actor, "leave_encashment.approve", "leave-encashments", id);
  await notify(deps, { recipient: row.employeeId, type: "encashment.approved", title: "Leave encashment approved", body: `Your encashment of ${row.days} day(s) was approved.`, link: "leave-requests/encashments", subject: `leave-encashments/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "leaveEncashment.approved", { subject: `leave-encashments/${id}`, employeeId: row.employeeId, payload: { days: row.days, amount: row.amount } });
  return updated;
}

export async function rejectEncashment(deps: Deps, actor: AppUser, id: string) {
  const row = await getEncashment(deps, actor, id);
  if (row.state !== "PENDING") throw failedPrecondition("encashment is not pending");
  const [updated] = await deps.db.update(schema.leaveEncashments)
    .set({ state: "REJECTED", decidedBy: actor.uuid, updatedAt: new Date() }).where(eq(schema.leaveEncashments.uuid, id)).returning();
  await audit(deps, actor, "leave_encashment.reject", "leave-encashments", id);
  await notify(deps, { recipient: row.employeeId, type: "encashment.rejected", title: "Leave encashment rejected", body: `Your encashment of ${row.days} day(s) was rejected.`, link: "leave-requests/encashments", subject: `leave-encashments/${id}`, actorId: actor.employeeId });
  return updated;
}

export async function cancelEncashment(deps: Deps, actor: AppUser, id: string) {
  const row = await getEncashment(deps, actor, id);
  if (row.state !== "PENDING" && row.state !== "APPROVED") throw failedPrecondition("only pending or unpaid approved encashments can be cancelled");
  // Guard the flip on the state we read so cancel is EXACTLY-ONCE: a double-clicked cancel of an APPROVED row
  // would otherwise credit the days back twice (balance inflation). Only the winner credits.
  const from = row.state;
  const [updated] = await deps.db.update(schema.leaveEncashments)
    .set({ state: "CANCELLED", decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.leaveEncashments.uuid, id), eq(schema.leaveEncashments.state, from))).returning();
  if (!updated) throw failedPrecondition("encashment is no longer cancellable");
  if (from === "APPROVED") await adjustBalance(deps, row.employeeId, row.leaveTypeId, row.days); // credit the days back
  await audit(deps, actor, "leave_encashment.cancel", "leave-encashments", id);
  return updated;
}

// ---- Payroll payout (mirrors reimbursements) -----------------------------------------------------------
// Approved, not-yet-paid encashments for an employee - the payroll payout queue.
export async function approvedUnpaidEncashments(deps: Deps, employeeId: string) {
  return deps.db
    .select()
    .from(schema.leaveEncashments)
    .where(and(eq(schema.leaveEncashments.employeeId, employeeId), eq(schema.leaveEncashments.state, "APPROVED"), isNull(schema.leaveEncashments.paidRunId)));
}

// The whole payout queue in one read, for the run build (which walks every employee): one select instead of
// one per employee, to stay inside the per-invocation subrequest budget.
export async function approvedUnpaidEncashmentsAll(deps: Deps) {
  return deps.db
    .select()
    .from(schema.leaveEncashments)
    .where(and(eq(schema.leaveEncashments.state, "APPROVED"), isNull(schema.leaveEncashments.paidRunId)));
}

// Settled by a full-and-final settlement rather than a run: PAID with paidRunId left null, exactly like a
// separately-paid reimbursement, so it drops out of the payroll queue (state APPROVED + no run). The release
// puts it back when a corrected settlement is recomputed; it only ever touches rows with no run.
export async function markEncashmentsSettled(deps: Deps, ids: string[], at: Date) {
  if (!ids.length) return;
  await deps.db
    .update(schema.leaveEncashments)
    .set({ state: "PAID", paidAt: at, updatedAt: at })
    .where(and(inArray(schema.leaveEncashments.uuid, ids), eq(schema.leaveEncashments.state, "APPROVED"), isNull(schema.leaveEncashments.paidRunId)));
}
export async function releaseEncashmentsSettled(deps: Deps, ids: string[]) {
  if (!ids.length) return;
  await deps.db
    .update(schema.leaveEncashments)
    .set({ state: "APPROVED", paidAt: null, updatedAt: new Date() })
    .where(and(inArray(schema.leaveEncashments.uuid, ids), eq(schema.leaveEncashments.state, "PAID"), isNull(schema.leaveEncashments.paidRunId)));
}

// The write helpers below return UNEXECUTED statements so the run build can fold them into one atomic
// db.batch (see lib/dbBatch.ts). Awaiting the return value still executes it (drizzle builders are
// thenable), so a direct caller behaves as before.

// Idempotent rebuild: un-pay any rows previously paid by THIS run (back to APPROVED) before re-picking.
export function resetEncashmentsPaidByRun(deps: Deps, runId: string) {
  return deps.db
    .update(schema.leaveEncashments)
    .set({ state: "APPROVED", paidRunId: null, paidAt: null, updatedAt: new Date() })
    .where(eq(schema.leaveEncashments.paidRunId, runId));
}

// Mark a set of encashments paid by a payroll run (called during the build). ids must already be chunked
// under the D1 param cap by the caller when large.
// The eligibility predicate is repeated in the WHERE: the build reads the queue up front and flips it at the
// end, so a row can leave the queue in between (cancelEncashment credits the days back, another run claims
// it). Matching only rows that are STILL approved-and-unpaid means such a row can never be flipped to PAID
// after its days were returned - the employee would otherwise be paid for leave they still hold. A row that
// loses the race stays queued while the run's item still carries the line; reconcileRunPayouts (payroll.ts)
// blocks the approve that would ship that mismatch, and a rebuild resolves it.
export function markEncashmentsPaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  return deps.db
    .update(schema.leaveEncashments)
    .set({ state: "PAID", paidRunId: runId, paidAt: at, updatedAt: at })
    .where(and(inArray(schema.leaveEncashments.uuid, ids), eq(schema.leaveEncashments.state, "APPROVED"), isNull(schema.leaveEncashments.paidRunId)));
}
