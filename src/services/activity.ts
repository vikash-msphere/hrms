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
// search spans all history not just loaded pages). `q` LIKEs the action, the ACTOR (name + email) and the
// touched OBJECT (its snapshotted name, its collection and its id); `tone` maps to a verb set. Object names are
// covered because they're stored columns — searching "Asha Rao" or "leaves" finds the rows about that record
// without any extra reads.
//
// THE META BLOB IS NOT SEARCHED, and that is a deliberate removal rather than an oversight.
//
// `meta` carries the from/to VALUES of whatever columns the global audit filters do not exclude - a nominee's
// decline reason, a comment, whatever a new table's `fieldDiff` lets through. `audit_log` is already readable
// by a wider set than the records it describes (lib/audit.ts says so at length, and AUDIT_DENY is what keeps
// the narrowest material out of it); a substring search ACROSS that column turns "stored somewhere wider" into
// "greppable by anyone holding `activity` on a collection" - find the phrase, and the row names the record it
// came from. Whatever is in meta is still shown on the entry it belongs to; it is no longer a haystack to
// search. It was also the widest column in the row, so the scan below got cheaper by dropping it.
const MIN_Q = 2; // a one-character contains-match is a table scan that matches nearly everything

function textAndToneConds(opts: { q?: string; tone?: string }): SQL[] {
  const conds: SQL[] = [];
  const q = opts.q?.trim();
  if (q && q.length >= MIN_Q) {
    conds.push(
      or(
        like(schema.auditLog.action, `%${q}%`),
        like(schema.auditLog.actorEmail, `%${q}%`),
        like(schema.auditLog.actorName, `%${q}%`),
        like(schema.auditLog.entityName, `%${q}%`),
        like(schema.auditLog.entity, `%${q}%`),
        like(schema.auditLog.entityId, `%${q}%`),
      )!,
    );
  }
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

/**
 * (entity, id) pairs per statement when a CASE filter is in play.
 *
 * Each pair spends TWO bound parameters (`entity = ? and entity_id = ?`), against D1's hard ceiling of 100 per
 * statement (lib/dbBatch.ts PARAM_CAP). `activityCase.ts` bounds a case at MAX_CASE_RECORDS members "because
 * the audit query it feeds turns each member into an OR term" - but the bound counted TERMS while the ceiling
 * counts PARAMETERS, so at 60 members the statement bound 120 and threw `too many SQL variables`. Worse, the
 * failure arrived exactly when the cap did its job: a small case worked, and a payroll run settling two hundred
 * payables - which that file names as the routine case - answered 500.
 *
 * 25 pairs is 50 parameters, leaving the other half for everything that rides alongside: `q` binds seven, a
 * `tone` one per mapped verb, `before`/`entity`/`actor` one each. The list is chunked and the pages merged
 * (`runPaged`), so the member cap no longer has to be a parameter budget in disguise.
 */
const ENTITY_PAIR_CHUNK = 25;

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

/**
 * The same page, over an OR-list too large for one statement: run the shared conditions once per chunk and
 * merge the results.
 *
 * A merge is exact here rather than approximate, because every chunk is the same query ordered the same way:
 * each returns ITS OWN newest `limit + 1` rows, so the newest `limit` of the union is the newest `limit`
 * overall - the standard merge of sorted lists. `hasMore` is true if the union held more than a page, which is
 * also true whenever any single chunk was truncated.
 */
async function runPagedOverChunks(deps: Deps, shared: SQL[], groups: { entity: string; id: string }[][], limit: number) {
  const seen = new Set<string>();
  const merged: AuditRow[] = [];
  // A chunk that filled its own page has rows this call did not see. Tracked explicitly rather than inferred
  // from the merged length: one truncated chunk with every sibling empty yields exactly `limit` rows, which
  // would otherwise read as "that was all of it" and lose the rest of the case's history.
  let anyTruncated = false;
  for (const group of groups) {
    const conds = [...shared, or(...group.map((e) => and(eq(schema.auditLog.entity, e.entity), eq(schema.auditLog.entityId, e.id))!))!];
    const page = await runPaged(deps, conds, limit);
    if (page.nextBefore !== undefined) anyTruncated = true;
    // Chunks are disjoint by construction (each names its own (entity, id) pairs), but the dedupe costs
    // nothing and keeps the merge correct if a caller ever passes a duplicated pair.
    for (const row of page.items) if (!seen.has(row.uuid)) { seen.add(row.uuid); merged.push(row); }
  }
  merged.sort((a, b) => +new Date(b.at) - +new Date(a.at));
  const hasMore = merged.length > limit || anyTruncated;
  const items = merged.slice(0, limit);
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
  opts: { limit?: number; before?: number; q?: string; tone?: string; entity?: string; actor?: string; actorId?: string; apiKeyId?: string; correlationId?: string; subjectId?: string; sessionId?: string; entityIds?: { entity: string; id: string }[] } = {},
) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const conds: SQL[] = [];
  if (opts.before) conds.push(lt(schema.auditLog.at, new Date(opts.before)));
  if (opts.entity) {
    if (!COLLECTIONS.has(opts.entity)) throw invalidArgument("unknown resource collection");
    conds.push(eq(schema.auditLog.entity, opts.entity));
  }
  if (opts.actorId) conds.push(eq(schema.auditLog.actorId, opts.actorId)); // exact actor (employee id, from a ref filter)
  // Everything one credential did. Not an actor filter: a key acts AS a human, so its rows are attributed to
  // that person and are indistinguishable from what they did at a keyboard without this.
  if (opts.apiKeyId) conds.push(eq(schema.auditLog.apiKeyId, opts.apiKeyId));
  // One ACT, whole: every entry the same request or cron tick wrote. Indexed (audit_corr_idx), so this is a
  // seek rather than a scan even against a long history.
  if (opts.correlationId) conds.push(eq(schema.auditLog.correlationId, opts.correlationId));
  // Everything that happened TO one person, across every collection - their leave, their pay, their assets,
  // their tickets. Distinct from `actorId`, which is who DID it; the two differ exactly where it matters (a
  // manager approving someone else's leave). Indexed (audit_subject_idx).
  if (opts.subjectId) conds.push(eq(schema.auditLog.subjectId, opts.subjectId));
  // One SITTING: every act of one login. Indexed (audit_session_idx).
  if (opts.sessionId) conds.push(eq(schema.auditLog.sessionId, opts.sessionId));
  const actor = opts.actor?.trim();
  // PREFIX match, not a leading-wildcard one. `%asha%` can use no index at all, so the actor filter was a full
  // scan of the fastest-growing table in the app, sitting one line below three filters that each carry a note
  // saying they are indexed seeks. An email filter is asked as a prefix in practice ("asha", "asha@") and
  // `audit_actor_email_idx` makes that a seek.
  if (actor) conds.push(like(schema.auditLog.actorEmail, `${actor}%`));
  conds.push(...textAndToneConds(opts));
  // A CASE: the records that make up one long-running story (a hire, an onboarding), assembled by walking the
  // links between them - see services/activityCase.ts. Each member costs TWO bound parameters, so the list is
  // chunked and the pages merged rather than pushed into one statement (see ENTITY_PAIR_CHUNK).
  if (opts.entityIds?.length) {
    const groups: { entity: string; id: string }[][] = [];
    for (let i = 0; i < opts.entityIds.length; i += ENTITY_PAIR_CHUNK) groups.push(opts.entityIds.slice(i, i + ENTITY_PAIR_CHUNK));
    return runPagedOverChunks(deps, conds, groups, limit);
  }
  return runPaged(deps, conds, limit);
}
