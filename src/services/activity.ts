import { and, desc, eq, lt, or, like, notLike, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { COLLECTIONS } from "../domain/collections";
import { verbsForTone, MAPPED_VERBS } from "../domain/activity";

// `actor_name` + `entity_name` are STORED columns (snapshotted at write time by audit() → describeRow), so the
// feed needs ZERO extra reads to name a row and shows the record AS IT WAS at the event, not its current state.
type AuditRow = typeof schema.auditLog.$inferSelect;

// Shared free-text + tone filters over the audit rows (used by both the per-entity and the org-wide feed, so
// search spans all history not just loaded pages). `q` LIKEs action/actor/meta; `tone` maps to the verb set.
function textAndToneConds(opts: { q?: string; tone?: string }): SQL[] {
  const conds: SQL[] = [];
  const q = opts.q?.trim();
  if (q) conds.push(or(like(schema.auditLog.action, `%${q}%`), like(schema.auditLog.actorEmail, `%${q}%`), like(schema.auditLog.meta, `%${q}%`))!);
  if (opts.tone && opts.tone !== "all") {
    const verbs = verbsForTone(opts.tone);
    if (verbs === null) {
      for (const v of MAPPED_VERBS) conds.push(notLike(schema.auditLog.action, `%.${v}`)); // "other" = exclude all mapped verbs
    } else if (verbs.length) {
      conds.push(or(...verbs.map((v) => like(schema.auditLog.action, `%.${v}`)))!);
    }
  }
  return conds;
}

async function runPaged(deps: Deps, conds: SQL[], limit: number) {
  const rows = await deps.db
    .select()
    .from(schema.auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.auditLog.at))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items: AuditRow[] = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextBefore: hasMore && last ? +new Date(last.at) : undefined };
}

// List an entity's activity (audit rows), newest-first. Access is ALREADY enforced by the authz middleware,
// which decides READ on the target resource for the /v1/activity request (single-source gate) — this only
// queries. `before` (epoch ms) pages backwards. One indexed query (audit_entity_idx on entity, entity_id).
export async function listActivity(
  deps: Deps,
  entity: string,
  entityId: string,
  opts: { limit?: number; before?: number; q?: string; tone?: string } = {},
) {
  if (!entity || !COLLECTIONS.has(entity)) throw invalidArgument("unknown resource collection");
  if (!entityId) throw invalidArgument("a resource id is required");
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const conds: SQL[] = [eq(schema.auditLog.entity, entity), eq(schema.auditLog.entityId, entityId)];
  if (opts.before) conds.push(lt(schema.auditLog.at, new Date(opts.before)));
  conds.push(...textAndToneConds(opts));
  return runPaged(deps, conds, limit);
}

// Org-wide activity: ALL audit rows across every collection, newest-first. Access is gated in the authz
// middleware (the `audit` capability), not here — this only queries. Same keyset paging as listActivity;
// `entity` narrows to one collection, `actor` matches actor email (LIKE). One indexed scan (audit_at_idx).
export async function listAllActivity(
  deps: Deps,
  opts: { limit?: number; before?: number; q?: string; tone?: string; entity?: string; actor?: string; actorId?: string } = {},
) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const conds: SQL[] = [];
  if (opts.before) conds.push(lt(schema.auditLog.at, new Date(opts.before)));
  if (opts.entity) {
    if (!COLLECTIONS.has(opts.entity)) throw invalidArgument("unknown resource collection");
    conds.push(eq(schema.auditLog.entity, opts.entity));
  }
  if (opts.actorId) conds.push(eq(schema.auditLog.actorId, opts.actorId)); // exact actor (employee id, from a ref filter)
  const actor = opts.actor?.trim();
  if (actor) conds.push(like(schema.auditLog.actorEmail, `%${actor}%`)); // free-text actor-email match
  conds.push(...textAndToneConds(opts));
  return runPaged(deps, conds, limit);
}
