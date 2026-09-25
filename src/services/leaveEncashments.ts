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
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { assertNotSubject, assertReviewedVersion } from "./decisionGuard";
import { getSettingValue } from "./settings";
import { currentComp, monthlyRecurringGross } from "./taxProjection";
import { applyStructure } from "../domain/payroll";
import { structureLinesById } from "./salaryStructures";
import { encashmentRatePerDay, encashmentAmount, encashmentEligibilityError, type RateBasis } from "../domain/encashment";
import { type CarryForwardExcess } from "../domain/carryForward";
import { orgYear, type OrgYear } from "./orgDay";
import { openingEncashments } from "./leaveAdjustments";

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
import { refPayComponents } from "../lib/refData";

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
  return keysetPage<typeof schema.leaveEncashments.$inferSelect>(deps, schema.leaveEncashments, "leave-encashments", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
}

// The row the workflow verbs act on. The read side of the collection is the factory's generic get (same
// select, same 404); this stays internal because approve/reject/cancel all need the stored row first.
async function getEncashment(deps: Deps, _actor: AppUser, id: string) {
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

// Days already committed (APPROVED or PAID) in a calendar year - the running total the annual cap is measured
// against. Scoped to one leave type (per-type mode) or all types (cumulative mode).
//
// The year is the ORG's (services/orgDay `orgYear`), and it is passed IN rather than derived here. Two reasons,
// both load-bearing:
//   - `created_at` is an instant, not a date-only column, so the window has to be the org's year and not UTC's.
//     Bounded in UTC it counted an encashment raised at 02:00 on 1 January IST - 20:30 on 31 December UTC -
//     against the PREVIOUS year's cap, which both under-counted this year's usage (letting an employee encash
//     past the annual cap) and over-counted last year's.
//   - the year-end rollover calls this once per employee per leave type, on a cron tick with no per-request
//     settings memo. Resolving it here would be a D1 read every time; resolved once by the caller it is one.
// `from`/`to` only NARROW the read (they are deliberately loose); `covers` is what actually decides.
export async function encashedDaysThisYear(deps: Deps, employeeId: string, year: OrgYear, leaveTypeId?: string): Promise<number> {
  const conds = [
    eq(schema.leaveEncashments.employeeId, employeeId),
    inArray(schema.leaveEncashments.state, ["APPROVED", "PAID"] as const),
    gte(schema.leaveEncashments.createdAt, year.from),
    lte(schema.leaveEncashments.createdAt, year.to),
  ];
  if (leaveTypeId) conds.push(eq(schema.leaveEncashments.leaveTypeId, leaveTypeId));
  const rows = await deps.db.select().from(schema.leaveEncashments).where(and(...conds));
  const here = rows.filter((r) => r.createdAt && year.covers(r.createdAt)).reduce((s, r) => s + r.days, 0);
  // Plus what the system before HRMS paid out this year, from the opening balance (services/leaveAdjustments.ts).
  let before = 0;
  for (const [k, days] of await openingEncashments(deps, year, employeeId)) if (!leaveTypeId || k.endsWith(`|${leaveTypeId}`)) before += days;
  return round2(here + before);
}

/**
 * The SAME figure for the whole org, in one read.
 *
 * The comment above says the rollover calls the single-employee reader "once per employee per leave type", and
 * that is exactly the problem: on the one night of the year carry-forward runs, that is a D1 round-trip per
 * employee (cumulative mode) or per employee per leave type (per-type mode), on a tick that shares one
 * invocation's subrequest budget with twenty-one other subtasks. The rollover both forfeits leave and creates
 * real encashment payouts, so running out of budget half-way through is the worst place in the app to do it.
 *
 * The year's window is the same loose bound with the same `covers` decision, so this returns what a per-
 * employee call would have. `total` is the cumulative-mode figure; `perType` the per-type-mode one.
 */
export async function encashedDaysThisYearAll(
  deps: Deps,
  year: OrgYear,
): Promise<{ total: (employeeId: string) => number; perType: (employeeId: string, leaveTypeId: string) => number }> {
  const rows = await deps.db
    .select()
    .from(schema.leaveEncashments)
    .where(
      and(
        inArray(schema.leaveEncashments.state, ["APPROVED", "PAID"] as const),
        gte(schema.leaveEncashments.createdAt, year.from),
        lte(schema.leaveEncashments.createdAt, year.to),
      ),
    );
  const byEmp = new Map<string, number>();
  const byEmpType = new Map<string, number>();
  for (const r of rows) {
    if (!r.createdAt || !year.covers(r.createdAt)) continue;
    byEmp.set(r.employeeId, (byEmp.get(r.employeeId) ?? 0) + r.days);
    const k = `${r.employeeId}${r.leaveTypeId}`;
    byEmpType.set(k, (byEmpType.get(k) ?? 0) + r.days);
  }
  // And what the system before HRMS paid out this year, as the single reader counts it. Keyed with the same
  // unit separator as the loop above.
  for (const [key, days] of await openingEncashments(deps, year)) {
    const [employeeId, leaveTypeId] = key.split("|") as [string, string];
    byEmp.set(employeeId, (byEmp.get(employeeId) ?? 0) + days);
    const k = `${employeeId}${String.fromCharCode(31)}${leaveTypeId}`;
    byEmpType.set(k, (byEmpType.get(k) ?? 0) + days);
  }
  return {
    total: (employeeId) => round2(byEmp.get(employeeId) ?? 0),
    perType: (employeeId, leaveTypeId) => round2(byEmpType.get(`${employeeId}${leaveTypeId}`) ?? 0),
  };
}

// Per-day rate + payable for `days`, from the employee's CURRENT compensation and the org's encashment rate
// settings (basis base/gross, per-day divisor). Returns null when the employee has no compensation on record.
// One definition, used when the request is raised AND again when it is approved, so the two can never disagree
// about the rate for a reason other than the salary actually changing.
async function priceEncashment(deps: Deps, employeeId: string, days: number): Promise<{ ratePerDay: number; amount: number } | null> {
  const comp = await currentComp(deps, employeeId);
  if (!comp) return null;
  const { basis, divisor } = await encashmentRateConfig(deps);
  let perBasis = comp.basePay;
  if (basis === "gross") {
    const components = await refPayComponents(deps);
    const effective = applyStructure(components, await structureLinesById(deps, comp.structureId));
    perBasis = monthlyRecurringGross(comp.basePay, effective, comp.specialAllowance);
  }
  return { ratePerDay: encashmentRatePerDay(perBasis, divisor), amount: encashmentAmount(days, perBasis, divisor) };
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
  const alreadyEncashed = capDays != null ? await encashedDaysThisYear(deps, employeeId, await orgYear(deps), cumulative ? undefined : leaveTypeId) : 0;
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
  // Priced now for the requester to see; re-priced at approval, which is when the payout is committed.
  const priced = (await priceEncashment(deps, employeeId, days))!;
  const { ratePerDay, amount } = priced;

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
  const priced = await priceEncashment(deps, employeeId, days);
  if (!priced) return false;
  const row = (await deps.db
    .insert(schema.leaveEncashments)
    .values({
      code: await allocOwnedCode(deps, schema.leaveEncashments, schema.leaveEncashments.employeeId, employeeId),
      employeeId,
      leaveTypeId,
      days: round2(days),
      ratePerDay: priced.ratePerDay,
      amount: priced.amount,
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
export async function approveEncashment(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = await getEncashment(deps, actor, id);
  if (row.state !== "PENDING") throw failedPrecondition("encashment is not pending");
  assertReviewedVersion(row, ifMatch);
  await assertNotSubject(deps, actor, row.employeeId, "approve", "leave encashment");
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
    const alreadyEncashed = await encashedDaysThisYear(deps, row.employeeId, await orgYear(deps), cumulative ? undefined : row.leaveTypeId);
    if (round2(alreadyEncashed + row.days) > capDays) {
      throw failedPrecondition(`annual encashment cap of ${capDays} day(s) exceeded (${alreadyEncashed} already used)`);
    }
  }
  // RE-PRICE at approval. The amount stored when the request was raised is an estimate: approval is the moment
  // the payout is committed, and a compensation revision (or a change to the rate basis/divisor in settings)
  // between the two would otherwise pay days at a salary the employee no longer earns. A request for someone
  // whose compensation has since been removed keeps its original figure rather than dropping to zero.
  const priced = await priceEncashment(deps, row.employeeId, row.days);

  // Claim the approval EXACTLY ONCE first (guarded PENDING->APPROVED): a double-clicked/concurrent approve of
  // the SAME row would otherwise debit the balance twice - each debit is guarded against over-draw below zero
  // but not against re-running for one request. Only the winner (1 row) proceeds to debit.
  const [updated] = await deps.db.update(schema.leaveEncashments)
    .set({ state: "APPROVED", decidedBy: actor.uuid, updatedAt: new Date(), ...(priced ?? {}) })
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
  await audit(deps, actor, "leave_encashment.approve", "leave-encashments", id, stateMeta("PENDING", "APPROVED", { employee: `employees/${row.employeeId}` }), updated);
  await notify(deps, { recipient: row.employeeId, type: "encashment.approved", title: "Leave encashment approved", body: `Your encashment of ${row.days} day(s) was approved.`, link: "leave-requests/encashments", subject: `leave-encashments/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "leaveEncashment.approved", { subject: `leave-encashments/${id}`, employeeId: row.employeeId, payload: { days: row.days, amount: row.amount } });
  return updated;
}

export async function rejectEncashment(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = await getEncashment(deps, actor, id);
  if (row.state !== "PENDING") throw failedPrecondition("encashment is not pending");
  assertReviewedVersion(row, ifMatch);
  // Guard the flip on PENDING, like the approve and cancel beside it - and here it is the balance that pays
  // for its absence. The check above is a read, so a concurrent `:approve` can win its own guarded flip and
  // DEBIT the employee's leave days in between; an unguarded write then stamped REJECTED over the approval
  // and the days stayed debited. Nothing gives them back: `cancelEncashment` only credits when it moves an
  // APPROVED row, and it refuses a REJECTED one outright. So the request reads as cleanly declined while the
  // leave - which is encashable, i.e. money - is simply gone, with an audit trail that says nothing happened.
  //
  // The other ordering was always safe (a reject that lands first leaves approve's guard matching no rows, and
  // it 409s), which is exactly why this only ever went wrong in one direction and never in a test.
  const [updated] = await deps.db.update(schema.leaveEncashments)
    .set({ state: "REJECTED", decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.leaveEncashments.uuid, id), eq(schema.leaveEncashments.state, "PENDING"))).returning();
  if (!updated) throw failedPrecondition("encashment is no longer pending");
  await audit(deps, actor, "leave_encashment.reject", "leave-encashments", id, stateMeta(row.state, "REJECTED", { employee: `employees/${row.employeeId}` }), updated);
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
  await audit(deps, actor, "leave_encashment.cancel", "leave-encashments", id, stateMeta(from, "CANCELLED", { employee: `employees/${row.employeeId}` }), updated);
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
// Unexecuted statement, so the FnF commits it in the same atomic batch as the settlement (see reimbursements).
export function markEncashmentsSettledStmt(deps: Deps, ids: string[], at: Date) {
  return deps.db
    .update(schema.leaveEncashments)
    .set({ state: "PAID", paidAt: at, updatedAt: at })
    .where(and(inArray(schema.leaveEncashments.uuid, ids), eq(schema.leaveEncashments.state, "APPROVED"), isNull(schema.leaveEncashments.paidRunId)));
}
export function releaseEncashmentsSettledStmt(deps: Deps, ids: string[]) {
  return deps.db
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
