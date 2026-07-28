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

export type PayPeriodInput = {
  display_name?: string;
  period_start?: string;
  period_end?: string;
  pay_date?: string;
};

const parseDate = (s?: string) => {
  if (!s) return undefined;
  const ms = Date.parse(s + "T00:00:00Z");
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms);
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Reject a reversed range and any overlap with a live (non-deleted) period. Overlapping periods would each get
// their own run, and the one-committed-run-per-period guard is keyed on the period id (not the date range), so
// two approved runs over the overlap would pay salary twice for those days.
async function assertValidRange(deps: Deps, start: Date, end: Date, selfId?: string) {
  if (+end < +start) throw invalidArgument("period_end must be on or after period_start");
  const rows = (await deps.db.select().from(schema.payPeriods)).filter((p) => !p.deleteTime && p.uuid !== selfId);
  for (const p of rows) {
    const s = +new Date(p.periodStart), e = +new Date(p.periodEnd);
    if (+start <= e && +end >= s) throw invalidArgument(`this period overlaps "${p.label}" (${ymd(new Date(p.periodStart))} to ${ymd(new Date(p.periodEnd))})`);
  }
}

export async function listPayPeriods(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.payPeriods), showDeleted).sort(
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

export async function getPayPeriod(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.payPeriods).where(eq(schema.payPeriods.uuid, id)).limit(1))[0];
  if (!row) throw notFound("pay period not found");
  return row;
}

export async function createPayPeriod(deps: Deps, actor: AppUser, input: PayPeriodInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  const periodStart = parseDate(input.period_start);
  const periodEnd = parseDate(input.period_end);
  const payDate = parseDate(input.pay_date);
  if (!periodStart) throw invalidArgument("period_start is required (YYYY-MM-DD)");
  if (!periodEnd) throw invalidArgument("period_end is required (YYYY-MM-DD)");
  if (!payDate) throw invalidArgument("pay_date is required (YYYY-MM-DD)");
  await assertValidRange(deps, periodStart, periodEnd);
  const row = (await deps.db
    .insert(schema.payPeriods)
    .values({ code: await allocFlatCode(deps, schema.payPeriods), ...(id ? { id } : {}), label: input.display_name, periodStart, periodEnd, payDate })
    .returning())[0]!;
  await audit(deps, actor, "pay_period.create", "pay-periods", row.uuid, undefined, row);
  return row;
}

export async function updatePayPeriod(deps: Deps, actor: AppUser, id: string, patch: PayPeriodInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.payPeriods).where(eq(schema.payPeriods.uuid, id)).limit(1))[0];
  if (!row) throw notFound("pay period not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof PayPeriodInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.label = patch.display_name;
  if (has("period_start") && patch.period_start) set.periodStart = parseDate(patch.period_start);
  if (has("period_end") && patch.period_end) set.periodEnd = parseDate(patch.period_end);
  if (has("pay_date") && patch.pay_date) set.payDate = parseDate(patch.pay_date);
  const effStart = (set.periodStart as Date | undefined) ?? new Date(row.periodStart);
  const effEnd = (set.periodEnd as Date | undefined) ?? new Date(row.periodEnd);
  await assertValidRange(deps, effStart, effEnd, id);
  const updated = (await deps.db.update(schema.payPeriods).set(set).where(eq(schema.payPeriods.uuid, id)).returning())[0]!;
  await audit(deps, actor, "pay_period.update", "pay-periods", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deletePayPeriod(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.payPeriods, "pay_period", "pay-periods", id, ifMatch);
}

export async function restorePayPeriod(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.payPeriods, "pay_period", "pay-periods", id);
}

export async function purgePayPeriod(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.payPeriods, "pay_period", "pay-periods", id, ifMatch);
}
