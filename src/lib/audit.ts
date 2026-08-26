import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { describeRow } from "../domain/activityLabel";
import { tableFor } from "./authzResolve";
import { insertBatches, runBatch } from "./dbBatch";

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

/** One audit entry, for the batched form below: the same arguments audit() takes, minus the deps/actor. */
export type AuditEntry = { action: string; entity: string; entityId?: string; meta?: unknown; snapshot?: Record<string, unknown> | null };

/**
 * Many audit rows in ONE write, for a create that makes many records in a single act (a box of twenty
 * adapters). Each row is the row audit() would have written, so every asset still carries its own creation in
 * the activity feed - but as one statement group instead of twenty round trips, which is what the free-plan
 * subrequest budget affords (see lib/dbBatch.ts).
 *
 * Labels come from the snapshots the caller already holds; unlike audit() this never reads a label back from
 * the DB, because the batched call sites are creates and always have their rows in hand.
 */
export async function auditMany(deps: Deps, actor: AppUser | string, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return;
  const values = entries.map((e) => auditValues(actor, e.action, e.entity, e.entityId, e.meta, describeRow(e.entity, e.snapshot)));
  await runBatch(deps.db, insertBatches(values, (rows) => deps.db.insert(schema.auditLog).values(rows)));
}

async function writeAudit(deps: Deps, actor: AppUser | string, action: string, entity: string, entityId?: string, meta?: unknown, entityName?: string) {
  await deps.db.insert(schema.auditLog).values(auditValues(actor, action, entity, entityId, meta, entityName));
}

// The audit row itself, built without writing it - shared by the single and batched forms so both record the
// same actor attribution (view-as, API key) and the same meta stamping.
function auditValues(actor: AppUser | string, action: string, entity: string, entityId?: string, meta?: unknown, entityName?: string) {
  // "View as" (lib/viewAs.ts) makes the request principal the SIMULATED subject, so the actor here would name
  // the person being watched. The row must name the human who ran the request: attribute it to the real admin
  // and record whose eyes they were borrowing as `viewing_as`.
  const sim = typeof actor === "string" ? null : actor.simulatedBy ?? null;
  const actorEmail = sim ? sim.email : typeof actor === "string" ? actor : actor.email;
  const actorId = sim ? sim.employeeId : typeof actor === "string" ? null : actor.employeeId ?? null;
  const actorName = sim ? sim.name : typeof actor === "string" ? null : actor.name ?? null;
  const reqMeta = typeof actor === "string" ? undefined : actor.reqMeta;
  if (sim && typeof actor !== "string") meta = { ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : meta === undefined ? {} : { meta }), viewing_as: actor.email };
  // An API key acts AS its owner, so the actor columns correctly name the human - but the trail has to be
  // able to tell "Priya" apart from "Priya's CI key", both for incident response and for knowing which
  // credential to revoke. Same meta-stamping shape as `viewing_as` above.
  const key = typeof actor === "string" ? null : actor.apiKey ?? null;
  if (key) meta = { ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : meta === undefined ? {} : { meta }), via_api_key: { name: key.name, prefix: key.prefix } };
  // Mark the request actor as having logged an activity row, so the authz write backstop doesn't add a
  // duplicate generic one for this request. String actors (system/cron) have no request-scoped flag.
  if (typeof actor !== "string") actor.audited = true;
  return {
    actorEmail,
    actorId,
    actorName,
    apiKeyId: key?.uuid ?? null,
    action,
    entity,
    entityId: entityId ?? null,
    entityName: entityName ?? null,
    meta: meta ? JSON.stringify(meta) : null,
    ip: reqMeta?.ip ?? null,
    userAgent: reqMeta?.ua ?? null,
  };
}
