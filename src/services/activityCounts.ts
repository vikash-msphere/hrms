// "What arrived since I last looked", as COUNTS. One request, one indexed query, numbers only.
//
// WHY THIS EXISTS. The workspace tab bar badges each sibling tab with how many rows appeared since the caller
// last opened it. The client used to answer that by FETCHING each sibling collection and counting rows newer
// than its stored timestamp - so opening one page of a six-tab workspace read six pages of rows to render six
// small numbers, on every navigation. That is the single most expensive habit in the SPA: the badge is a
// number, and a number should cost a count.
//
// NO ACCESS CONTROL HERE. The middleware has already decided, per collection, whether this caller may list it
// and with what breadth, and handed the verdicts over as `searchScopes` - the same map global search gets,
// built by the exact decide()/scopeFor() pair a real `GET /v1/<collection>` gets. A collection absent from the
// map counts nothing. This file only BINDS those verdicts, with the same applyScope every list service uses,
// so a counted row is always a row the caller's own list would have returned.
//
// COST. The count runs over `search_docs` - the denormalised index that already mirrors every searchable
// collection's code, owner and soft-delete state - keyed by an index on `created_at`. So a count reads the rows
// that are actually new rather than scanning the source table, which is the difference between a badge that is
// free and one that gets more expensive as the database grows. (Counting the source tables would scan them:
// `count(*) where created_at > ?` has no index to stand on there, and D1 bills rows READ.)
import { and, eq, gt, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { SEARCH_INDEX } from "../domain/searchIndex";

const docs = schema.searchDocs;

// A tab bar's worth of collections. Well above any workspace (the widest is Hiring at six) and low enough that
// one caller cannot turn a badge request into a wide fan-out.
const MAX_TABS = 24;

/**
 * One badge's question. `key` is the token as asked (`goals` or `goals@others`) and is what the answer is keyed
 * by, so two tabs over one collection get two numbers. `others` leaves out the caller's own rows: the Team goals
 * tab (every team the caller can see) sits beside Goals over the same collection, and a goal the caller filed
 * themselves is not news on it. Without the token both badges were one count, measured from whichever tab was
 * asked about first.
 */
export type ActivityAsk = { key: string; collection: string; others: boolean; since: number };

const OTHERS = "@others";

/** Parse the `tabs` query: `<collection>[@others]:<sinceEpochMs>` pairs, comma-separated. Anything malformed,
 *  unknown or negative is dropped rather than failing the request - a badge is not worth a 400, and a dropped
 *  entry simply reports no new items. */
export function parseTabs(raw: string | undefined): ActivityAsk[] {
  const out: ActivityAsk[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const at = part.lastIndexOf(":");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const since = Number(part.slice(at + 1));
    if (!Number.isFinite(since) || since < 0) continue;
    const others = key.endsWith(OTHERS);
    const collection = others ? key.slice(0, -OTHERS.length) : key;
    if (seen.has(key)) continue; // one ask per token; the first wins
    if (!SEARCH_INDEX.some((e) => e.collection === collection)) continue;
    seen.add(key);
    out.push({ key, collection, others, since });
    if (out.length >= MAX_TABS) break;
  }
  return out;
}

// Rows somebody other than the caller owns (an ownerless row counts: it is nobody's own). A self-only collection
// holds nothing but the caller's own rows, so it has no others to count; a caller with no employee record owns
// nothing, so every row is somebody else's.
function othersPredicate(user: AppUser, collection: string): SQL | null | undefined {
  const entry = SEARCH_INDEX.find((e) => e.collection === collection);
  if (!entry || entry.scoping.kind === "self") return null;
  if (!user.employeeId) return undefined;
  return or(isNull(docs.ownerId), ne(docs.ownerId, user.employeeId));
}

// The row filter for one collection, mirroring what its own list service binds - the same three cases global
// search handles: "scoped" -> applyScope over the copied (code, owner) columns, "flat" -> nothing beyond the
// read grant, "self" -> hard-pinned to the caller. `null` means "provably matches nothing".
function scopePredicate(user: AppUser, collection: string, scope: ListScope): SQL | null | undefined {
  const entry = SEARCH_INDEX.find((e) => e.collection === collection);
  if (!entry) return null;
  if (entry.scoping.kind === "flat") return undefined;
  if (entry.scoping.kind === "self") return user.employeeId ? eq(docs.ownerId, user.employeeId) : null;
  return applyScope(scope, docs.code, docs.ownerId) ?? undefined;
}

/** New-item counts per ask token, for the collections the middleware said this caller may list. Absent keys
 *  mean nothing new (or nothing listable); the client renders no badge either way. */
export async function activityCounts(
  deps: Deps,
  user: AppUser,
  scopes: Map<string, ListScope>,
  asks: ActivityAsk[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!asks.length || scopes.size === 0) return out;

  const stmts: { key: string; sql: unknown }[] = [];
  for (const ask of asks) {
    const scope = scopes.get(ask.collection);
    if (!scope) continue; // not listable by this caller
    const pred = scopePredicate(user, ask.collection, scope);
    if (pred === null) continue; // provably empty
    // A narrowing of the list scope above, never a widening: both predicates apply.
    const others = ask.others ? othersPredicate(user, ask.collection) : undefined;
    if (others === null) continue;
    const where = [
      eq(docs.collection, ask.collection),
      gt(docs.createdAt, new Date(ask.since)),
      eq(docs.deleted, false),
      // A row the caller can't see the non-public state of isn't news to them (an unpublished announcement,
      // a draft), exactly as global search hides it.
      scope.seeRestricted ? undefined : eq(docs.restricted, false),
      pred,
      others,
    ].filter(Boolean) as SQL[];
    stmts.push({
      key: ask.key,
      sql: deps.db.select({ value: sql<number>`count(*)` }).from(docs).where(and(...where)),
    });
  }
  if (!stmts.length) return out;

  // One D1 batch: a tab bar costs a single round trip no matter how many tabs it has.
  const rows =
    stmts.length === 1
      ? [await (stmts[0]!.sql as PromiseLike<unknown>)]
      : await deps.db.batch(stmts.map((s) => s.sql) as unknown as Parameters<typeof deps.db.batch>[0]);
  stmts.forEach((s, i) => {
    const row = (rows[i] as { value?: number }[])[0];
    out[s.key] = Number(row?.value ?? 0);
  });
  return out;
}
