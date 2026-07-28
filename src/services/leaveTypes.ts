import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { assertNotLocked } from "./lifecycle";
import { accrueLeave } from "./leaveAccrual";

export type LeaveTypeInput = {
  display_name?: string;
  accrual_days_per_year?: number;
  accrual_frequency?: string;
  paid?: boolean;
  color?: string | null;
  available_during_probation?: boolean;
  probation_accrual_days_per_year?: number;
  probation_cap_days?: number | null;
  encashable?: boolean;
  encashment_cap_days_per_year?: number | null;
  min_balance_retained_days?: number;
  carry_forward?: boolean;
  carry_forward_cap_days?: number | null;
};

export async function listLeaveTypes(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.leaveTypes), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getLeaveType(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.uuid, id)).limit(1))[0];
  if (!row) throw notFound("leave type not found");
  return row;
}

export async function createLeaveType(deps: Deps, actor: AppUser, input: LeaveTypeInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  const row = (await deps.db
    .insert(schema.leaveTypes)
    .values({
      code: await allocFlatCode(deps, schema.leaveTypes),
      ...(id ? { id } : {}),
      name: input.display_name,
      accrualDaysPerYear: input.accrual_days_per_year ?? 0,
      accrualFrequency: input.accrual_frequency === "semi_monthly" ? "semi_monthly" : "monthly",
      paid: input.paid ?? true,
      color: input.color ?? null,
      availableDuringProbation: input.available_during_probation ?? true,
      probationAccrualDaysPerYear: input.probation_accrual_days_per_year ?? 0,
      probationCapDays: input.probation_cap_days ?? null,
      encashable: input.encashable ?? false,
      encashmentCapDaysPerYear: input.encashment_cap_days_per_year ?? null,
      minBalanceRetainedDays: input.min_balance_retained_days ?? 0,
      carryForward: input.carry_forward ?? false,
      carryForwardCapDays: input.carry_forward_cap_days ?? null,
    })
    .returning())[0]!;
  await audit(deps, actor, "leave_type.create", "leave-types", row.uuid, undefined, row);
  return row;
}

export async function updateLeaveType(deps: Deps, actor: AppUser, id: string, patch: LeaveTypeInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.uuid, id)).limit(1))[0];
  if (!row) throw notFound("leave type not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof LeaveTypeInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("accrual_days_per_year")) set.accrualDaysPerYear = patch.accrual_days_per_year;
  if (has("accrual_frequency")) set.accrualFrequency = patch.accrual_frequency === "semi_monthly" ? "semi_monthly" : "monthly";
  if (has("paid")) set.paid = patch.paid;
  if (has("color")) set.color = patch.color;
  if (has("available_during_probation")) set.availableDuringProbation = patch.available_during_probation;
  if (has("probation_accrual_days_per_year")) set.probationAccrualDaysPerYear = patch.probation_accrual_days_per_year;
  if (has("probation_cap_days")) set.probationCapDays = patch.probation_cap_days;
  if (has("encashable")) set.encashable = patch.encashable;
  if (has("encashment_cap_days_per_year")) set.encashmentCapDaysPerYear = patch.encashment_cap_days_per_year;
  if (has("min_balance_retained_days")) set.minBalanceRetainedDays = patch.min_balance_retained_days;
  if (has("carry_forward")) set.carryForward = patch.carry_forward;
  if (has("carry_forward_cap_days")) set.carryForwardCapDays = patch.carry_forward_cap_days;
  const updated = (await deps.db.update(schema.leaveTypes).set(set).where(eq(schema.leaveTypes.uuid, id)).returning())[0]!;
  // Accrual rate changed -> re-accrue this type now so balances update immediately (otherwise the change
  // wouldn't take effect until the next daily cron). Idempotent: only credits months not already recorded.
  if (has("accrual_days_per_year") || has("probation_accrual_days_per_year") || has("accrual_frequency")) await accrueLeave(deps, id);
  await audit(deps, actor, "leave_type.update", "leave-types", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteLeaveType(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.leaveTypes, "leave_type", "leave-types", id, ifMatch);
}

export async function restoreLeaveType(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.leaveTypes, "leave_type", "leave-types", id);
}

export async function purgeLeaveType(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.leaveTypes, "leave_type", "leave-types", id, ifMatch);
}
