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

export type PayGradeInput = {
  display_name?: string;
  level?: number;
  band_min?: number | null;
  band_mid?: number | null;
  band_max?: number | null;
  currency_code?: string;
  description?: string | null;
};

// A band is a guardrail, never blocking. We only reject an internally-inconsistent band: a value out of
// min <= mid <= max order. `effective` is the would-be saved state after this write.
function validateBand(effective: { bandMin?: number | null; bandMid?: number | null; bandMax?: number | null }) {
  const { bandMin, bandMid, bandMax } = effective;
  if (bandMin != null && bandMid != null && bandMin > bandMid) throw invalidArgument("band_min must not exceed band_mid");
  if (bandMid != null && bandMax != null && bandMid > bandMax) throw invalidArgument("band_mid must not exceed band_max");
  if (bandMin != null && bandMax != null && bandMin > bandMax) throw invalidArgument("band_min must not exceed band_max");
}

export async function listPayGrades(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.payGrades), showDeleted).sort(
    (a, b) => a.level - b.level || +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
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

export async function getPayGrade(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.payGrades).where(eq(schema.payGrades.uuid, id)).limit(1))[0];
  if (!row) throw notFound("pay grade not found");
  return row;
}

export async function createPayGrade(deps: Deps, actor: AppUser, input: PayGradeInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  validateBand({ bandMin: input.band_min ?? null, bandMid: input.band_mid ?? null, bandMax: input.band_max ?? null });
  const row = (await deps.db
    .insert(schema.payGrades)
    .values({
      ...(id ? { id } : {}),
      code: await allocFlatCode(deps, schema.payGrades),
      name: input.display_name,
      level: input.level ?? 0,
      bandMin: input.band_min ?? null,
      bandMid: input.band_mid ?? null,
      bandMax: input.band_max ?? null,
      currency: input.currency_code?.trim() || "INR",
      description: input.description ?? null,
    })
    .returning())[0]!;
  await audit(deps, actor, "pay_grade.create", "pay-grades", row.uuid, undefined, row);
  return row;
}

export async function updatePayGrade(deps: Deps, actor: AppUser, id: string, patch: PayGradeInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.payGrades).where(eq(schema.payGrades.uuid, id)).limit(1))[0];
  if (!row) throw notFound("pay grade not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof PayGradeInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("level")) set.level = patch.level ?? 0;
  if (has("band_min")) set.bandMin = patch.band_min ?? null;
  if (has("band_mid")) set.bandMid = patch.band_mid ?? null;
  if (has("band_max")) set.bandMax = patch.band_max ?? null;
  if (has("currency_code")) set.currency = patch.currency_code?.trim() || "INR";
  if (has("description")) set.description = patch.description ?? null;
  validateBand({
    bandMin: has("band_min") ? patch.band_min ?? null : row.bandMin,
    bandMid: has("band_mid") ? patch.band_mid ?? null : row.bandMid,
    bandMax: has("band_max") ? patch.band_max ?? null : row.bandMax,
  });
  const updated = (await deps.db.update(schema.payGrades).set(set).where(eq(schema.payGrades.uuid, id)).returning())[0]!;
  await audit(deps, actor, "pay_grade.update", "pay-grades", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deletePayGrade(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.payGrades, "pay_grade", "pay-grades", id, ifMatch);
}

export async function restorePayGrade(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.payGrades, "pay_grade", "pay-grades", id);
}

export async function purgePayGrade(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.payGrades, "pay_grade", "pay-grades", id, ifMatch);
}
