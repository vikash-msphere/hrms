import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describeRow } from "../domain/activityLabel";
import { TABLES, tableFor } from "./authzResolve";
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

/**
 * Columns that never go into an audit entry's meta, whatever table they sit on.
 *
 * SECRETS first, and this is not tidiness: `audit_log` is readable by whoever holds the `audit` capability,
 * which is a WIDER set than the people who may read the record itself. Copying an API-key hash, an asset's tag
 * nonce or a stored signature into it moves a secret somewhere its own access control does not reach. Matched
 * by NAME, because the rule has to hold for tables that do not exist yet - the alternative is remembering, at
 * every new table, that this file exists.
 *
 * Then NOISE. Identity and timestamps are already columns ON the audit row; a JSON blob renders as a shrug in
 * the feed while costing a kilobyte of a D1 row; an R2 object key names a file nobody can open from here. A
 * create that lists twenty of those buries the two fields the reader came for.
 */
const SECRETISH = /secret|token|hash|password|salt|nonce|otp|signature/i;
const STRUCTURAL = new Set(["uuid", "code", "id", "createdAt", "updatedAt", "deleteTime"]);
/** Enough to describe a record; past this it is a dump, not a trail. */
const MAX_AUDIT_FIELDS = 24;
/** A description or a comment is worth recording; the whole of one is not. */
const MAX_AUDIT_LEN = 140;

/**
 * Which of a collection's columns are FOREIGN KEYS, and to which wire collection - `{ employeeId: "employees" }`.
 *
 * Keyed by COLLECTION rather than by table object, because the collection name is the argument every audit()
 * call already carries - so a call site says `createdMeta(row, "leave-requests")` beside the `"leave-requests"`
 * it is already passing, and cannot name a table its audit entry is not about.
 *
 * Read from Drizzle's own FK metadata rather than guessed from the column name, because guessing is wrong
 * exactly where it matters: `categoryId` is an asset category on one table, an expense category on another,
 * and `decidedBy` names no collection at all until you look. Memoized per table; the schema does not change
 * at runtime.
 */
const fkCache = new Map<string, Map<string, string>>();
function fkColumns(collection: string | undefined): Map<string, string> {
  if (!collection) return EMPTY_FKS;
  const hit = fkCache.get(collection);
  if (hit) return hit;
  const table = tableFor(collection) as object | undefined;
  if (!table) return EMPTY_FKS;
  const out = new Map<string, string>();
  try {
    const cfg = getTableConfig(table as SQLiteTable);
    // Drizzle reports columns by their SQL name; the row we are handed is keyed by the JS property.
    const jsKey = new Map(Object.entries(getTableColumns(table as SQLiteTable)).map(([k, c]) => [c.name, k]));
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const target = collectionOfTable(ref.foreignTable as SQLiteTable);
      if (!target) continue;
      for (const col of ref.columns) {
        const key = jsKey.get(col.name);
        if (key) out.set(key, target);
      }
    }
  } catch {
    /* not a Drizzle table (a hand-built row bag); no refs to resolve */
  }
  fkCache.set(collection, out);
  return out;
}
const EMPTY_FKS = new Map<string, string>();

/** SQL table name -> wire collection, inverted from the authz registry so the two can never disagree. */
let byTableName: Map<string, string> | null = null;
function collectionOfTable(table: SQLiteTable): string | undefined {
  if (!byTableName) {
    byTableName = new Map();
    for (const [collection, t] of Object.entries(TABLES)) {
      try {
        byTableName.set(getTableConfig(t).name, collection);
      } catch {
        /* skip anything that is not a table */
      }
    }
  }
  try {
    return byTableName.get(getTableConfig(table).name);
  } catch {
    return undefined;
  }
}

/**
 * Blob columns whose CONTENT is the record rather than an implementation detail.
 *
 * `/(Json|Key)$/` is excluded by default and must stay that way - a payroll run item's `linesJson` is a
 * kilobyte of computed lines with no readable form in a feed, and putting it in `audit_log` on every build is
 * how a trail becomes a storage problem. But for these few, the blob IS the thing that changed: renaming a
 * board column or scoring a review currently audits as a bare `updated` with nothing under it.
 *
 * Opt-in per collection, and deliberately short. A column earns a place here by being something a person
 * edits and would later ask about - not by merely being readable.
 */
const DIFFABLE_BLOBS: Record<string, string[]> = {
  boards: ["columnsJson", "swimlanesJson", "labelsJson"],
  reviews: ["ratingsJson", "selfRatingsJson"],
  "review-feedback": ["ratingsJson"],
  "interview-feedback": ["ratingsJson"],
};

/**
 * A blob's contents as flat `column.key` entries - `columns.in_progress`, `ratings.communication`.
 *
 * ONE level deep on purpose: a nested object diff is unreadable in a one-line feed, and the detail view's raw
 * disclosure already shows the whole meta to anyone who needs to go deeper. An ARRAY is keyed by each item's
 * own `key`/`id`, never by its index - a board whose columns are reordered would otherwise read as "every
 * column changed" - and the order itself is recorded as one `.order` entry rather than N.
 */
function flattenBlob(prefix: string, raw: unknown): Record<string, unknown> {
  let v: unknown;
  try {
    v = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {}; // unparseable: nothing honest to say about it
  }
  const out: Record<string, unknown> = {};
  const label = prefix.replace(/Json$/, "");
  if (Array.isArray(v)) {
    const keys: string[] = [];
    for (const item of v) {
      const k = item && typeof item === "object" ? String((item as Record<string, unknown>).key ?? (item as Record<string, unknown>).id ?? "") : String(item);
      if (!k) continue;
      keys.push(k);
      // The item's own summary, for a rename or a limit change. Objects collapse to their label-ish field.
      const summary = item && typeof item === "object"
        ? Object.entries(item as Record<string, unknown>).filter(([ik]) => ik !== "key" && ik !== "id" && !SECRETISH.test(ik)).map(([ik, iv]) => `${ik}=${String(iv)}`).join(" ")
        : String(item);
      out[`${label}.${k}`] = auditableValue(summary);
    }
    out[`${label}.order`] = keys.join(" › ");
  } else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRETISH.test(k)) continue; // the denylist applies INSIDE a blob too, not only to column names
      const av = auditableValue(val);
      if (av !== undefined) out[`${label}.${k}`] = av;
    }
  }
  return out;
}

/** The employee an entry is ABOUT, from the `employee` ref its meta carries. Null when it is about no one. */
function subjectOf(meta: unknown): string | null {
  const ref = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).employee : undefined;
  return typeof ref === "string" && ref.startsWith("employees/") ? ref.slice("employees/".length) || null : null;
}

/** One column's value, in the shape the feed can render - or undefined for "not worth recording". */
function auditableValue(v: unknown, refCollection?: string): unknown {
  if (v === null || v === undefined) return undefined; // an unset field states nothing
  if (v instanceof Date) return v.toISOString(); // same normalization fieldDiff uses
  if (typeof v === "string") {
    // A foreign key is written as a RESOURCE REF, never as the bare id it is in the column. Two reasons, and
    // the first is not cosmetic: an internal id must never reach the wire (docs/archive/plan.md), and
    // middleware/encodeWireIds only tokenizes strings shaped `<collection>/<id>` - a bare id would be
    // published raw. The second is that `employees/<id>` is a thing the reader's client can resolve to a
    // NAME, where `aa11bb22cc33d` is a thing nobody can do anything with.
    if (refCollection) return `${refCollection}/${v}`;
    return v.length > MAX_AUDIT_LEN ? `${v.slice(0, MAX_AUDIT_LEN)}…` : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return v;
  return undefined; // objects and arrays have no readable form in a one-line feed
}

/**
 * The values of a row worth recording: what a create made, or what a delete destroyed.
 *
 * Column order is the schema's, and that is deliberate - a table declares its identifying columns first, so
 * the feed's three-chip preview lands on them without this file needing to know anything about any table.
 */
export function rowValues(row: Record<string, unknown> | null | undefined, collection?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row || typeof row !== "object") return out;
  const fks = fkColumns(collection);
  const blobs = (collection && DIFFABLE_BLOBS[collection]) ?? [];
  for (const [k, raw] of Object.entries(row)) {
    if (Object.keys(out).length >= MAX_AUDIT_FIELDS) break;
    if (STRUCTURAL.has(k) || SECRETISH.test(k)) continue;
    // An opted-in blob contributes its CONTENTS; every other one stays out (see DIFFABLE_BLOBS).
    if (blobs.includes(k)) {
      for (const [bk, bv] of Object.entries(flattenBlob(k, raw))) {
        if (Object.keys(out).length >= MAX_AUDIT_FIELDS) break;
        if (bv !== undefined) out[bk] = bv;
      }
      continue;
    }
    if (/(Json|Key)$/.test(k)) continue;
    const v = auditableValue(raw, fks.get(k));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * A create, as a diff FROM nothing - and a delete, as a diff TO nothing.
 *
 * Both go out in the same `{ field: { from, to } }` shape an update diff uses, so the whole trail renders
 * through ONE renderer instead of three, and "what was this row made as" is answered the same way as "what did
 * that patch change". Undefined when there is nothing to say, so a caller can spread it unconditionally.
 */
export function createdMeta(row: Record<string, unknown> | null | undefined, collection?: string) {
  const values = rowValues(row, collection);
  if (!Object.keys(values).length) return undefined;
  return { diff: Object.fromEntries(Object.entries(values).map(([k, to]) => [k, { from: null, to }])) };
}
export function removedMeta(row: Record<string, unknown> | null | undefined, collection?: string) {
  const values = rowValues(row, collection);
  if (!Object.keys(values).length) return undefined;
  return { diff: Object.fromEntries(Object.entries(values).map(([k, from]) => [k, { from, to: null }])) };
}

/**
 * A state transition (approve, reject, submit, pay). The verb is already in the action, so what the entry owes
 * the reader is which state it moved FROM - "rejected" without it cannot be told from a second rejection of an
 * already-rejected row - plus whatever the decision carried (a reason, an amount).
 */
export function stateMeta(from: unknown, to: unknown, extra?: Record<string, unknown>) {
  return { ...(from === to ? {} : { diff: { status: { from, to } } }), ...(extra ?? {}) };
}

/**
 * The names of the fields a write touched, WITHOUT their values - for the sub-resources whose values must not
 * be copied anywhere (a bank account, a PAN, a passport number, a photo). "Priya changed her account number"
 * is the whole of what the trail is owed; the number itself belongs only on the record, behind the
 * sensitive-read audit that guards it.
 */
export function fieldsMeta(patch: Record<string, unknown> | null | undefined) {
  const fields = Object.entries(patch ?? {}).filter(([, v]) => v !== undefined).map(([k]) => k);
  return fields.length ? { fields: fields.slice(0, MAX_AUDIT_FIELDS) } : undefined;
}

// Shallow before→after field diff for update audits: { field: {from, to} } over `keys`, only where the value
// changed. Dates are compared/emitted as ISO; `updatedAt` is skipped (always changes, never interesting).
export function fieldDiff(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[], collection?: string): Record<string, { from: unknown; to: unknown }> {
  const fks = fkColumns(collection);
  const blobs = (collection && DIFFABLE_BLOBS[collection]) ?? [];
  // Same rule as rowValues: a foreign key is a REF on the way out, never the raw internal id.
  const norm = (v: unknown, ref?: string) => (v instanceof Date ? v.toISOString() : ref && typeof v === "string" ? `${ref}/${v}` : v);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (k === "updatedAt") continue;
    // A blob this collection opted in for is expanded into its own keys, so a board column rename reads as
    // `columns.in_progress: "label=Doing" -> "label=In progress"` instead of vanishing.
    // Everything rowValues excludes, excluded here too. `fieldDiff` never applied this rule, so any service
    // that passed a blob column in its `set` put the whole of it - a payroll item's computed lines, a job
    // payload - into the audit meta. Only an opted-in blob survives, and as expanded keys.
    if (SECRETISH.test(k)) continue;
    if (/(Json|Key)$/.test(k) && !blobs.includes(k)) continue;
    if (blobs.includes(k)) {
      const b = flattenBlob(k, before[k]);
      const a = flattenBlob(k, after[k]);
      for (const bk of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (Object.keys(out).length >= MAX_AUDIT_FIELDS) break;
        if (JSON.stringify(b[bk] ?? null) !== JSON.stringify(a[bk] ?? null)) out[bk] = { from: b[bk] ?? null, to: a[bk] ?? null };
      }
      continue;
    }
    const ref = fks.get(k);
    const from = norm(before[k], ref);
    const to = norm(after[k], ref);
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) out[k] = { from, to };
  }
  return out;
}

/**
 * Which BLOB columns changed, by name, for the ones this collection has not opted into expanding.
 *
 * The alternative to naming them is silence, and silence is the worse answer: an automation is a trigger plus
 * a condition plus a list of actions, all of them JSON, so editing what a rule DOES would audit as a bare
 * "updated" with nothing under it. "The actions changed" is not the whole story, but it is a true one, and it
 * is the story the feed already knows how to render (`meta.changed`).
 */
function blobsChanged(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[], collection?: string): string[] {
  const opted = (collection && DIFFABLE_BLOBS[collection]) ?? [];
  return keys.filter(
    (k) =>
      /(Json|Key)$/.test(k) &&
      !opted.includes(k) &&
      !SECRETISH.test(k) &&
      JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
}

// Convenience for update audits: the `{ diff }` meta from before→after over the `set` object's keys, plus the
// names of any blob columns that moved but are not expanded (see blobsChanged). Undefined when nothing
// meaningful changed. `set` is the Drizzle update object (its keys = touched columns).
export function diffMeta(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, set: Record<string, unknown>, collection?: string) {
  if (!before || !after) return undefined;
  const keys = Object.keys(set);
  const diff = fieldDiff(before, after, keys, collection);
  const changed = blobsChanged(before, after, keys, collection);
  if (!Object.keys(diff).length && !changed.length) return undefined;
  return { ...(Object.keys(diff).length ? { diff } : {}), ...(changed.length ? { changed } : {}) };
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
  const values = entries.map((e) => auditValues(actor, e.action, e.entity, e.entityId, e.meta, describeRow(e.entity, e.snapshot), deps));
  await runBatch(deps.db, insertBatches(values, (rows) => deps.db.insert(schema.auditLog).values(rows)));
}

async function writeAudit(deps: Deps, actor: AppUser | string, action: string, entity: string, entityId?: string, meta?: unknown, entityName?: string) {
  await deps.db.insert(schema.auditLog).values(auditValues(actor, action, entity, entityId, meta, entityName, deps));
}

// The audit row itself, built without writing it - shared by the single and batched forms so both record the
// same actor attribution (view-as, API key) and the same meta stamping.
function auditValues(actor: AppUser | string, action: string, entity: string, entityId?: string, meta?: unknown, entityName?: string, deps?: Deps) {
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
  // WHAT acted, when nobody did. An automation action and a cron tick both run as the system principal, so the
  // actor columns can only ever say "System" - true, and no answer at all to the person asking why their leave
  // was approved at 03:00 by nobody. Same meta-stamping shape as `viewing_as` and `via_api_key` above.
  // WHAT authorized this. A denial has always explained itself; a permission explained nothing, so "which
  // grant let them do that" - the question an access review exists to ask - had an answer on only one side.
  // Recorded to the PATTERN, which narrows it to a handful of rules rather than naming one (see Decision.via).
  const authorizedBy = sim ? undefined : typeof actor === "string" ? undefined : actor.authorizedBy;
  if (authorizedBy) meta = { ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : meta === undefined ? {} : { meta }), authorized_by: authorizedBy };
  const acting = deps?.actingAs;
  if (acting) meta = { ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : meta === undefined ? {} : { meta }), [`via_${acting.kind}`]: { name: acting.name, ...(acting.ref ? { ref: acting.ref } : {}) } };
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
    // Point-in-time, like `actorName`: a role is data and it moves, so the role recorded here is the authority
    // the act was performed under, not whatever the actor holds when somebody reads this back.
    actorRole: sim ? null : typeof actor === "string" ? null : actor.role ?? null,
    correlationId: deps?.trace ?? null,
    // Read off the `employee` ref the meta already carries at ~40 call sites, rather than added as an argument
    // to every one of them. It is an INTERNAL id here (the outbound edge tokenizes refs later), which is what
    // makes `?subject=employees/<token>` decode for free on the way in, exactly as `?actor` does.
    subjectId: subjectOf(meta),
    // The REAL human's sitting, like every other actor column: a "view as" writes under the admin driving it.
    sessionId: (sim ? sim.sessionId : typeof actor === "string" ? null : actor.sessionId) ?? null,
    ip: reqMeta?.ip ?? null,
    userAgent: reqMeta?.ua ?? null,
  };
}
