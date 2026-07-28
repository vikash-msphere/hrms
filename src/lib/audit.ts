import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { describeRow } from "../domain/activityLabel";
import { tableFor } from "./authzResolve";

// Append-only audit trail. Never store secrets in `meta`. `actor` is the AppUser (preferred — records the
// actor's employee id + name for clean feed rendering) or a bare email string (system/legacy call sites, no
// employee id). INSERT-only: this row is never updated or deleted.
//
// `snapshot` is the touched record (raw DB row OR serialized resource) — audit() derives a point-in-time
// `entity_name` label from it via describeRow, stored on the row so the feed needs NO read to name the record
// (and shows what it WAS at the event, not its current/edited/deleted state). Omit when there's no record in hand.
export async function audit(
  deps: Deps,
  actor: AppUser | string,
  action: string,
  entity: string,
  entityId?: string,
  meta?: unknown,
  snapshot?: Record<string, unknown> | null,
) {
  // Prefer the label from the row the caller already holds (creates / shared helpers / the write-backstop's
  // response body) — no read. When no row was passed (inline updates/verbs anchored on a bare id), fetch the
  // record ONCE by uuid to snapshot its label. Either way the label is stored, so the feed reads nothing.
  let entityName = describeRow(entity, snapshot);
  if (entityName === undefined && entityId && snapshot == null) entityName = await labelFromDb(deps, entity, entityId);
  return writeAudit(deps, actor, action, entity, entityId, meta, entityName);
}

// One indexed uuid lookup → the record's point-in-time label. Best-effort: a virtual/unknown collection or an
// already-purged row yields no row (undefined label); a failed read is swallowed (auditing is never fatal).
async function labelFromDb(deps: Deps, entity: string, entityId: string): Promise<string | undefined> {
  const t = tableFor(entity);
  if (!t) return undefined;
  try {
    const row = (await deps.db.select().from(t).where(eq(t.uuid, entityId)).limit(1))[0] as Record<string, unknown> | undefined;
    return describeRow(entity, row);
  } catch {
    return undefined;
  }
}

// Shallow before→after field diff for update audits: { field: {from, to} } over `keys`, only where the value
// changed. Dates are compared/emitted as ISO; `updatedAt` is skipped (always changes, never interesting).
export function fieldDiff(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): Record<string, { from: unknown; to: unknown }> {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (k === "updatedAt") continue;
    const from = norm(before[k]);
    const to = norm(after[k]);
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) out[k] = { from, to };
  }
  return out;
}

// Convenience for update audits: the `{ diff }` meta from before→after over the `set` object's keys, or
// undefined when nothing meaningful changed. `set` is the Drizzle update object (its keys = touched columns).
export function diffMeta(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, set: Record<string, unknown>) {
  if (!before || !after) return undefined;
  const diff = fieldDiff(before, after, Object.keys(set));
  return Object.keys(diff).length ? { diff } : undefined;
}

async function writeAudit(deps: Deps, actor: AppUser | string, action: string, entity: string, entityId?: string, meta?: unknown, entityName?: string) {
  const actorEmail = typeof actor === "string" ? actor : actor.email;
  const actorId = typeof actor === "string" ? null : actor.employeeId ?? null;
  const actorName = typeof actor === "string" ? null : actor.name ?? null;
  const reqMeta = typeof actor === "string" ? undefined : actor.reqMeta;
  // Mark the request actor as having logged an activity row, so the authz write backstop doesn't add a
  // duplicate generic one for this request. String actors (system/cron) have no request-scoped flag.
  if (typeof actor !== "string") actor.audited = true;
  await deps.db.insert(schema.auditLog).values({
    actorEmail,
    actorId,
    actorName,
    action,
    entity,
    entityId: entityId ?? null,
    entityName: entityName ?? null,
    meta: meta ? JSON.stringify(meta) : null,
    ip: reqMeta?.ip ?? null,
    userAgent: reqMeta?.ua ?? null,
  });
}
