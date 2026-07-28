// Global search: one query string, every collection the caller may list, ONE indexed query.
//
// NO ACCESS CONTROL HERE. The middleware has already decided, per collection, whether this caller may list it
// and with what breadth, and handed the answers over as `searchScopes` - a map of collection -> ListScope,
// built by the exact decide()/scopeFor() pair a real `GET /v1/<collection>` gets. A collection absent from the
// map is one the caller may not list, and contributes no rows. This file only BINDS those verdicts, with the
// same `applyScope` every list service uses, so a search hit is always a row the caller's list of that
// collection would already have returned.
//
// COST. Matching runs against the FTS5 index (`search_fts`, kept in sync with `search_docs` by triggers - see
// src/db/searchDdl.ts), never against the source tables. That matters because D1 bills rows READ: a `LIKE
// '%q%'` fan-out would scan every searchable table on every keystroke and get more expensive as the database
// grows, whereas an FTS hit reads the matching rows and a miss reads none.
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { SEARCH_INDEX } from "../domain/searchIndex";

export type SearchHit = {
  collection: string;
  id: string; // internal record id; the route renders it as `<collection>/<id>` and the wire edge tokenizes it
  title: string | null;
  subtitle: string | null;
};

const MIN_QUERY = 2;
const MAX_TOKENS = 6; // a search box query; more terms than this is a paste, not a search
const TOTAL = 60;

const docs = schema.searchDocs;

// Turn the raw box input into an FTS5 MATCH expression. Every token becomes a quoted prefix term, and terms
// are ANDed (FTS5's default), so "ali kap" finds "Alice Kapoor". Stripping everything but letters and digits
// leaves no FTS5 operator or quote in the string, so the expression cannot be subverted by the query text.
function matchExpression(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

// `collection IN (...)` as a literal - the names come from the registry, never from the caller, so they cost
// no bound parameters. That matters: D1 caps a statement's parameters, and the scope predicates need them.
const collectionIn = (collections: string[]): SQL =>
  sql.raw(`"search_docs"."collection" in (${collections.map((c) => `'${c}'`).join(", ")})`);

// The row filter for one collection, or null when it provably matches nothing. Mirrors what that collection's
// own list service binds: "scoped" -> applyScope on the copied (code, owner) columns, "flat" -> nothing beyond
// the read grant, "self" -> hard-pinned to the caller.
function scopePredicate(user: AppUser, collection: string, scope: ListScope): SQL | null | undefined {
  const entry = SEARCH_INDEX.find((e) => e.collection === collection);
  if (!entry) return null;
  if (entry.scoping.kind === "flat") return undefined; // no row filter
  if (entry.scoping.kind === "self") return user.employeeId ? eq(docs.ownerId, user.employeeId) : null;
  return applyScope(scope, docs.code, docs.ownerId) ?? undefined;
}

/** Run the search over the collections the middleware said this caller may list. Returns [] for a query under
 *  two characters, or when the caller may list nothing. */
export async function globalSearch(deps: Deps, user: AppUser, scopes: Map<string, ListScope>, rawQuery: string): Promise<SearchHit[]> {
  const q = rawQuery.trim();
  if (q.length < MIN_QUERY || scopes.size === 0) return [];
  const match = matchExpression(q);
  if (!match) return [];

  // Collections whose filter is identical share one OR-branch, so the statement stays small: for most callers
  // every own-scoped collection collapses into a single predicate, rather than one per collection.
  const groups = new Map<string, { collections: string[]; pred: SQL | undefined }>();
  for (const entry of SEARCH_INDEX) {
    const scope = scopes.get(entry.collection);
    if (!scope) continue; // not listable by this caller
    const pred = scopePredicate(user, entry.collection, scope);
    if (pred === null) continue; // provably empty
    // Non-public rows (an unpublished announcement) are indexed but hidden unless the caller holds the
    // manifest's editing level - the same `seeRestricted` the middleware resolved.
    const publicOnly = !scope.seeRestricted;
    const key = `${publicOnly}|${pred ? JSON.stringify([scope.breadth, scope.deptCode, scope.ownerId, scope.shares, scope.denies, SEARCH_INDEX.find((e) => e.collection === entry.collection)!.scoping.kind]) : "flat"}`;
    const existing = groups.get(key);
    if (existing) existing.collections.push(entry.collection);
    else groups.set(key, { collections: [entry.collection], pred: publicOnly ? and(pred, eq(docs.restricted, false)) : pred });
  }
  if (groups.size === 0) return [];

  const branches = [...groups.values()].map((g) => {
    const inList = collectionIn(g.collections);
    return g.pred ? and(inList, g.pred)! : inList;
  });

  const rows = await deps.db.all<SearchHit>(sql`
    select ${docs.collection} as collection, ${docs.recordId} as id, ${docs.title} as title, ${docs.subtitle} as subtitle
    from "search_fts" f join ${docs} on ${docs}."rowid" = f."rowid"
    where f."text" match ${match} and ${eq(docs.deleted, false)} and (${or(...branches)})
    order by f."rank"
    limit ${sql.raw(String(TOTAL))}
  `);
  return rows.map((r) => ({ collection: r.collection, id: r.id, title: r.title, subtitle: r.subtitle }));
}
