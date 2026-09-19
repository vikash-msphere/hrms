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
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { SEARCH_INDEX, type SearchEntry } from "../domain/searchIndex";
import type { RedactionGate } from "../http/fieldAccess";

export type SearchHit = {
  collection: string;
  id: string; // internal record id; the route renders it as `<collection>/<id>` and the wire edge tokenizes it
  title: string | null;
  subtitle: string | null;
};

/** A drizzle property as `policy.redacted_fields` spells it (`baseComp` -> `base_comp`). */
const wireOf = (prop: string) => prop.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** The tokens a match expression is built from - the same split, so the re-check below judges the same words. */
const tokensOf = (raw: string) =>
  raw.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0).slice(0, MAX_TOKENS);

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
export async function globalSearch(
  deps: Deps,
  user: AppUser,
  scopes: Map<string, ListScope>,
  rawQuery: string,
  // The per-row field gate (`http/fieldAccess.ts redactionGateFor`), supplied by the route because deciding is
  // not this file's job. Absent = no field-level narrowing, which is what every caller did before it existed.
  gate?: RedactionGate,
): Promise<SearchHit[]> {
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

  const rows = await deps.db.all<SearchHit & { code: string | null }>(sql`
    select ${docs.collection} as collection, ${docs.recordId} as id, ${docs.code} as code, ${docs.title} as title, ${docs.subtitle} as subtitle
    from "search_fts" f join ${docs} on ${docs}."rowid" = f."rowid"
    where f."text" match ${match} and ${eq(docs.deleted, false)} and (${or(...branches)})
    order by f."rank"
    limit ${sql.raw(String(TOTAL))}
  `);
  const hits = rows.map((r) => ({ collection: r.collection, id: r.id, code: r.code, title: r.title, subtitle: r.subtitle }));
  return gate ? await narrowRedacted(deps, hits, tokensOf(q), gate) : hits.map(({ code: _code, ...hit }) => hit);
}

/**
 * The field-level half, applied to the page of hits.
 *
 * The index copies row text into `search_docs` / `search_fts`, which is the one read path in the app that does
 * not pass through a serializer - so `policy.redacted_fields`, the gate `withAccess` applies everywhere else,
 * reached none of it. A deny on `leave-requests.*.reason` therefore hid the reason on the request, in its list
 * and in every export, and left it rendering as the TITLE of the search result; `tickets.description` and a
 * candidate's `phone` / `notes` were not displayed but were still MATCHED, which is the same probe a hidden
 * filter was on the grid - type a guess, see whether the record comes back, repeat.
 *
 * Two answers, and both are needed:
 *   - what it SHOWS: a title or subtitle built from a denied field is dropped, per row, on the row's own code.
 *   - what it MATCHED: a hit is kept only if the caller's own SAFE columns still contain every token. One read
 *     per affected collection, over the ids already in hand, and only for a caller who is actually denied
 *     something - a caller with no field denies never reaches this branch at all.
 *
 * Substring rather than FTS prefix semantics on the re-check, deliberately: it is the permissive side, so the
 * only hits it keeps are ones whose visible text explains them anyway.
 */
async function narrowRedacted(
  deps: Deps,
  hits: (SearchHit & { code: string | null })[],
  tokens: string[],
  gate: RedactionGate,
): Promise<SearchHit[]> {
  const entryOf = new Map(SEARCH_INDEX.map((e) => [e.collection, e]));
  // Hits whose match has to be re-explained from the columns the caller may read, grouped by collection.
  const recheck = new Map<string, { entry: SearchEntry; ids: string[]; safe: string[] }>();
  const out: (SearchHit & { code: string | null; id: string })[] = [];

  for (const hit of hits) {
    const denied = gate(hit.collection, hit.code);
    const entry = entryOf.get(hit.collection);
    if (!denied.length || !entry) {
      out.push(hit);
      continue;
    }
    const hidden = (cols: string[] | undefined) => (cols ?? []).some((c) => denied.includes(wireOf(c)));
    const next = { ...hit, title: hidden(entry.title) ? null : hit.title, subtitle: hidden(entry.subtitle) ? null : hit.subtitle };
    out.push(next);
    if (!hidden(entry.match)) continue; // nothing denied was matchable, so the hit needs no explaining
    const safe = entry.match.filter((c) => !denied.includes(wireOf(c)));
    // Keyed by the VERDICT, not just the collection: a deny can name a code (`tickets.04-002-*.description`),
    // so two rows of one collection can differ in what they withhold, and a batch keyed by collection alone
    // would re-check the stricter row against the laxer row's readable columns.
    const key = `${hit.collection}|${[...denied].sort().join(",")}`;
    const group = recheck.get(key) ?? { entry, ids: [], safe };
    group.ids.push(hit.id);
    recheck.set(key, group);
  }
  if (!recheck.size) return out.map(({ code: _code, ...hit }) => hit);

  // Which of those rows the SAFE columns alone still explain.
  const explained = new Set<string>();
  for (const [, group] of recheck) {
    if (!group.safe.length) continue; // every matchable column was denied: nothing can explain the hit
    const table = group.entry.table as Record<string, any>;
    const cols = group.safe.map((c) => table[c]).filter(Boolean);
    if (!cols.length) continue;
    const rows = await byIdChunks(group.ids, (ids) =>
      deps.db
        .select({ uuid: table.uuid, text: sql<string>`lower(coalesce(${sql.join(cols.map((c) => sql`coalesce(${c}, '')`), sql` || ' ' || `)}, ''))` })
        .from(group.entry.table)
        .where(inArray(table.uuid, ids)) as PromiseLike<{ uuid: string; text: string }[]>,
    );
    for (const row of rows) if (tokens.every((t) => (row.text ?? "").includes(t))) explained.add(`${group.entry.collection}|${row.uuid}`);
  }
  const needed = new Set([...recheck.values()].flatMap((g) => g.ids.map((id) => `${g.entry.collection}|${id}`)));
  return out
    .filter((hit) => !needed.has(`${hit.collection}|${hit.id}`) || explained.has(`${hit.collection}|${hit.id}`))
    .map(({ code: _code, ...hit }) => hit);
}
