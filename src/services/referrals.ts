import { allocOwnedCode } from "./codeAlloc";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { notify } from "./notifications";
import { emitEvent } from "./eventBus";
import { recordBonus } from "./bonuses";
import { invalidArgument, notFound, failedPrecondition, aborted } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { getSettingValue } from "./settings";
import { DEFAULT_REFERRALS_CONFIG, milestoneReached, resolveBonusAmount, type ReferralsConfig } from "../domain/referrals";

export type ReferralInput = {
  referrer?: string | null;
  candidate_name?: string | null;
  candidate_email?: string | null;
  candidate_phone?: string | null;
  position_title?: string | null;
  department?: string | null;
  notes?: string | null;
  status?: string | null;
  hired_employee?: string | null;
  bonus_amount?: number | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const STATUSES = ["submitted", "screening", "interviewing", "hired", "joined", "rejected", "withdrawn"] as const;
type Status = (typeof STATUSES)[number];
const etagOf = (ms: number) => `"${ms}"`;
// A stand-in actor for cron-issued awards (recordBonus/audit only read `email`); HR awards pass the real actor.
const SYSTEM_ACTOR = { email: "system@referrals" } as unknown as AppUser;

const cfgOf = (deps: Deps) => getSettingValue<ReferralsConfig>(deps, "referrals", DEFAULT_REFERRALS_CONFIG);

export async function listReferrals(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, statusFilter?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.referrals.code, schema.referrals.referrerId)];
  if (statusFilter) conds.push(eq(schema.referrals.status, statusFilter as Status));
  if (!showDeleted) conds.push(isNull(schema.referrals.deleteTime));
  return keysetPage(deps, schema.referrals, "referrals", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}

export async function getReferral(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.referrals).where(eq(schema.referrals.uuid, id)).limit(1))[0];
  if (!row) throw notFound("referral not found");
  return row;
}

export async function createReferral(deps: Deps, actor: AppUser, input: ReferralInput, id?: string) {
  const name = (input.candidate_name ?? "").trim();
  if (!name) throw invalidArgument("candidate_name is required");
  // The referrer defaults to the caller (owner-ref gated by the middleware); HR may name another.
  const referrerId = idFromPath(input.referrer) ?? actor.employeeId;
  if (!referrerId) throw invalidArgument("referrer is required");
  const departmentId = input.department ? idFromPath(input.department)! : null;
  const row = (await deps.db
    .insert(schema.referrals)
    .values({
      code: await allocOwnedCode(deps, schema.referrals, schema.referrals.referrerId, referrerId),
      ...(id ? { uuid: id } : {}),
      referrerId,
      candidateName: name,
      candidateEmail: input.candidate_email?.trim() || null,
      candidatePhone: input.candidate_phone?.trim() || null,
      positionTitle: input.position_title?.trim() || null,
      departmentId,
      notes: input.notes?.trim() || null,
      status: "submitted",
    })
    .returning())[0]!;
  await audit(deps, actor, "referral.create", "referrals", row.uuid, undefined, row);
  return row;
}

export async function updateReferral(deps: Deps, actor: AppUser, id: string, patch: ReferralInput, ifMatch?: string) {
  const row = await getReferral(deps, actor, id);
  if (row.deleteTime) throw notFound("referral not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.candidate_name !== undefined) { const n = (patch.candidate_name ?? "").trim(); if (!n) throw invalidArgument("candidate_name cannot be blank"); set.candidateName = n; }
  if (patch.candidate_email !== undefined) set.candidateEmail = patch.candidate_email?.trim() || null;
  if (patch.candidate_phone !== undefined) set.candidatePhone = patch.candidate_phone?.trim() || null;
  if (patch.position_title !== undefined) set.positionTitle = patch.position_title?.trim() || null;
  if (patch.department !== undefined) set.departmentId = patch.department ? idFromPath(patch.department)! : null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status as Status)) throw invalidArgument("invalid status");
    set.status = patch.status;
  }
  if (patch.hired_employee !== undefined) set.hiredEmployeeId = patch.hired_employee ? idFromPath(patch.hired_employee)! : null;
  if (patch.bonus_amount !== undefined) {
    if (patch.bonus_amount != null && !(patch.bonus_amount > 0)) throw invalidArgument("bonus_amount must be greater than 0");
    set.bonusAmount = patch.bonus_amount ?? null;
  }
  const updated = (await deps.db.update(schema.referrals).set(set).where(eq(schema.referrals.uuid, id)).returning())[0]!;
  await audit(deps, actor, "referral.update", "referrals", id, diffMeta(row, updated, set), updated);
  // Keep the referrer in the loop as recruiting moves their candidate along (skip a no-op or self-update).
  if (patch.status !== undefined && updated.status !== row.status && row.referrerId !== actor.employeeId)
    await notify(deps, { recipient: row.referrerId, type: "referral.status", title: "Referral update", body: `${updated.candidateName} is now ${updated.status.replace(/_/g, " ")}.`, link: "referrals", subject: `referrals/${id}`, actorId: actor.employeeId });
  return updated;
}

export async function deleteReferral(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  return softDeleteRow(deps, actor, schema.referrals, "referral", "referrals", id, ifMatch);
}
export async function restoreReferral(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.referrals, "referral", "referrals", id);
}
export async function purgeReferral(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  return purgeRow(deps, actor, schema.referrals, "referral", "referrals", id, ifMatch);
}

// ---- Bonus award ---------------------------------------------------------------------------------------------

// Award the referral bonus: create a `bonuses` row for the referrer (paid as a taxable earning on their next
// payroll run) and flip the referral to `eligible`. Shared by the HR "award now" verb and the milestone cron.
async function awardOne(deps: Deps, actor: AppUser, row: typeof schema.referrals.$inferSelect, cfg: ReferralsConfig) {
  // Resolve the amount: explicit per-referral override > a time tier (by the offer->join window, looked up from
  // the ATS offer that produced this hire) > the flat default. The offer is the one whose accept created the
  // linked employee; absent (e.g. a manual hire link), the window is unknown and the default applies.
  let window: { offeredDate: Date | number | null; joinedDate: Date | number | null } = { offeredDate: null, joinedDate: null };
  if (row.hiredEmployeeId) {
    const offer = (await deps.db.select({ offerDate: schema.offers.offerDate, joinDate: schema.offers.joinDate }).from(schema.offers).where(eq(schema.offers.createdEmployeeId, row.hiredEmployeeId)).limit(1))[0];
    if (offer) window = { offeredDate: offer.offerDate, joinedDate: offer.joinDate };
  }
  const amount = resolveBonusAmount(cfg, row, window);
  if (!(amount > 0)) throw failedPrecondition("no bonus amount configured");
  // Claim the referral idempotently BEFORE creating the bonus: flip pending->eligible with a conditional
  // update guarded on bonusStatus='pending'. If a concurrent or prior run already claimed it (0 rows), stop
  // without inserting a bonus - the daily milestone cron is retried, and inserting here would DOUBLE-PAY.
  // Winning the claim first (rather than inserting the bonus first, then flipping) means a crash mid-award can
  // at worst leave an eligible referral with a null bonusId - a visible, safe, recoverable state - instead of
  // a duplicate bonus paid out.
  const claimed = await deps.db
    .update(schema.referrals)
    .set({ bonusStatus: "eligible", bonusAmount: amount, bonusEligibleDate: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.referrals.uuid, row.uuid), eq(schema.referrals.bonusStatus, "pending")))
    .returning();
  if (!claimed.length) return (await deps.db.select().from(schema.referrals).where(eq(schema.referrals.uuid, row.uuid)).limit(1))[0]!;
  const bonus = await recordBonus(deps, actor, {
    employee: `employees/${row.referrerId}`,
    amount,
    kind: "Referral Bonus",
    reason: `Referral: ${row.candidateName}`,
    award_date: new Date().toISOString().slice(0, 10),
  });
  const [updated] = await deps.db
    .update(schema.referrals)
    .set({ bonusId: bonus.uuid, updatedAt: new Date() })
    .where(eq(schema.referrals.uuid, row.uuid))
    .returning();
  await audit(deps, actor, "referral.award", "referrals", row.uuid, { bonus: `bonuses/${bonus.uuid}` });
  await notify(deps, { recipient: row.referrerId, type: "referral.awarded", title: "Referral bonus awarded", body: `Your referral bonus for ${row.candidateName} will be paid in your next payroll run.`, link: "referrals", subject: `referrals/${row.uuid}` });
  await emitEvent(deps, actor, "referral.awarded", { subject: `referrals/${row.uuid}`, employeeId: row.referrerId, payload: { amount } });
  return updated;
}

// HR override: award immediately, skipping the milestone check (must be linked to a hire and still pending).
export async function awardReferralBonusNow(deps: Deps, actor: AppUser, id: string) {
  const row = await getReferral(deps, actor, id);
  if (row.deleteTime) throw notFound("referral not found");
  if (row.bonusStatus !== "pending") throw failedPrecondition("bonus is not pending");
  if (!row.hiredEmployeeId) throw failedPrecondition("link the hired employee before awarding");
  return awardOne(deps, actor, row, await cfgOf(deps));
}

// Daily cron: (1) award pending referrals whose linked hire reached the configured milestone; (2) reconcile
// eligible referrals whose bonus a payroll run has since paid. Returns the number of state changes made.
export async function awardReferralBonuses(deps: Deps): Promise<number> {
  const cfg = await cfgOf(deps);
  let changed = 0;

  // (1) Eligibility.
  const pending = await deps.db
    .select()
    .from(schema.referrals)
    .where(and(eq(schema.referrals.bonusStatus, "pending"), isNull(schema.referrals.deleteTime), inArray(schema.referrals.status, ["hired", "joined"])));
  for (const row of pending) {
    if (!row.hiredEmployeeId) continue;
    const hire = (await deps.db.select({ startDate: schema.employees.startDate, probationEndDate: schema.employees.probationEndDate }).from(schema.employees).where(eq(schema.employees.uuid, row.hiredEmployeeId)).limit(1))[0];
    if (!hire) continue;
    if (!milestoneReached(cfg, hire)) continue;
    try { await awardOne(deps, SYSTEM_ACTOR, row, cfg); changed++; } catch { /* best-effort per row */ }
  }

  // (2) Reconcile paid: an eligible referral whose linked bonus has been paid by a payroll run.
  const eligible = await deps.db
    .select()
    .from(schema.referrals)
    .where(and(eq(schema.referrals.bonusStatus, "eligible"), isNull(schema.referrals.deleteTime)));
  for (const row of eligible) {
    if (!row.bonusId) continue;
    const bonus = (await deps.db.select({ paidAt: schema.bonuses.paidAt }).from(schema.bonuses).where(eq(schema.bonuses.uuid, row.bonusId)).limit(1))[0];
    if (!bonus?.paidAt) continue;
    await deps.db.update(schema.referrals).set({ bonusStatus: "paid", bonusPaidDate: bonus.paidAt, updatedAt: new Date() }).where(eq(schema.referrals.uuid, row.uuid));
    await notify(deps, { recipient: row.referrerId, type: "referral.paid", title: "Referral bonus paid", body: `Your referral bonus for ${row.candidateName} has been paid.`, link: "referrals", subject: `referrals/${row.uuid}` });
    await emitEvent(deps, SYSTEM_ACTOR, "referral.paid", { subject: `referrals/${row.uuid}`, employeeId: row.referrerId, payload: { amount: row.bonusAmount ?? 0 } });
    changed++;
  }
  return changed;
}
