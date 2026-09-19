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
import { aiEmbed, aiFeatureOn } from "./ai";
import { parseVectorId } from "../lib/vector";

export type SearchHit = {
  collection: string;
  id: string; // internal record id; the route renders it as `<collection>/<id>` and the wire edge tokenizes it
  title: string | null;
  subtitle: string | null;
};

/**
 * A hit while it is still being decided on, carrying the two things the final resource does not: the row's
 * `code` (what a per-code field deny is judged against) and HOW it was found.
 *
 * `semantic` is not a ranking detail - it changes which question the field gate has to ask of the row. See
 * the note in `narrowRedacted`.
 */
type ScoredHit = SearchHit & { code: string | null; semantic?: boolean };

/** A drizzle property as `policy.redacted_fields` spells it (`baseComp` -> `base_comp`). */
const wireOf = (prop: string) => prop.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

/** The tokens a match expression is built from - the same split, so the re-check below judges the same words. */
const tokensOf = (raw: string) =>
  raw.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0).slice(0, MAX_TOKENS);

const MIN_QUERY = 2;
const MAX_TOKENS = 6; // a search box query; more terms than this is a paste, not a search
const TOTAL = 60;
// Neighbours asked of the vector index before the SQL re-check. Generous on purpose: the re-check is the real
// filter, and a caller with narrow breadth will have most of these thrown away, so asking for too few would
// leave them with nothing to fuse.
const SEMANTIC_TOP_K = 100;
// Run the semantic half only when the keyword half returned fewer than this. Chosen so a full-looking result
// list (the top of a ⌘K panel is about this many rows) costs nothing extra, while a thin or empty one gets
// the second opinion it needs.
const SEMANTIC_WHEN_KEYWORD_UNDER = 8;
// Reciprocal rank fusion's damping constant. 60 is the value from the original RRF paper and the usual
// default; it keeps any single list from dominating on the strength of one top-ranked row.
const RRF_K = 60;

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
  const keyword = rows.map((r) => ({ collection: r.collection, id: r.id, code: r.code, title: r.title, subtitle: r.subtitle }));

  // The semantic half, when this deployment has a model and an index. Everything below is additive: a refusal
  // at any step leaves `keyword` exactly as it was, which is the search this app had before any of this.
  //
  // SKIPPED WHEN THE KEYWORD HALF ALREADY ANSWERED WELL. Every semantic search embeds the query, so on a
  // search box that fires as you type, "laptop" is six embeds. The free allocation is 10,000 neurons a DAY
  // for the whole org, and spending it on queries that exact matching already answered is the fastest way to
  // have none left for the ones it cannot. Semantic retrieval exists to catch what the keyword index misses,
  // so it runs when the keyword index has in fact missed: few hits, or none.
  const semantic = keyword.length >= SEMANTIC_WHEN_KEYWORD_UNDER
    ? []
    : await semanticHits(deps, q, [...groups.values()].flatMap((g) => g.collections), branches);
  const hits = semantic.length ? fuse(keyword, semantic) : keyword;
  return gate ? await narrowRedacted(deps, hits, tokensOf(q), gate) : hits.map(({ code: _code, ...hit }) => hit);
}

/**
 * Nearest neighbours for the query, filtered by the SAME predicate the keyword path just used.
 *
 * The two-step is the load-bearing part. Vectorize is asked only to narrow by COLLECTION, which is all its
 * metadata carries; it is never asked to decide who may see a row, because `applyScope`'s department
 * prefixes, owner columns and per-object shares cannot be expressed as metadata equality, and an access rule
 * that is approximated is an access rule that is wrong. The ids come back, and the rows are then read from
 * `search_docs` under `or(...branches)` - the identical WHERE clause the FTS query above runs under. So a
 * semantic hit is exactly a row the caller's list of that collection would have returned, by construction
 * rather than by a second implementation that has to be kept in agreement.
 *
 * Returns [] for every failure mode: no binding, no budget, a model error, an empty index. The caller keeps
 * its keyword results, which is the whole degradation story for this feature.
 */
async function semanticHits(
  deps: Deps,
  query: string,
  collections: string[],
  branches: SQL[],
): Promise<ScoredHit[]> {
  if (!deps.ai || !deps.vectors || collections.length === 0) return [];
  // The org's switch, checked before the query is embedded rather than after: a feature that is off must cost
  // nothing, not merely produce nothing.
  if (!(await aiFeatureOn(deps, "search.semantic"))) return [];

  const embedded = await aiEmbed(deps, { feature: "search.query" }, [query]);
  if (!embedded.ok) return [];

  let matches: { id: string; score: number }[];
  try {
    matches = await deps.vectors.query(embedded.value[0]!, { topK: SEMANTIC_TOP_K, collections });
  } catch (e) {
    // An index outage must not fail a search that the keyword half can already answer.
    console.error("semantic search query failed", e);
    return [];
  }
  if (matches.length === 0) return [];

  // Ids are opaque to Vectorize, so a stale or foreign entry is possible; anything that does not parse, or
  // names a collection this caller is not searching, is dropped before it reaches a query.
  const wanted = new Map<string, number>(); // "<collection>|<recordId>" -> rank
  const ids: string[] = [];
  const cols = new Set(collections);
  for (const [rank, m] of matches.entries()) {
    const parsed = parseVectorId(m.id);
    if (!parsed || !cols.has(parsed.collection)) continue;
    wanted.set(`${parsed.collection}|${parsed.recordId}`, rank);
    ids.push(parsed.recordId);
  }
  if (ids.length === 0) return [];

  // Filtered by record id AND collection, then paired up exactly in memory. Two `in` lists rather than a row-
  // value `in` because the superset they admit is a handful of rows, and the exact pairing below is what
  // decides membership either way.
  const found = await byIdChunks(ids, (chunk) =>
    deps.db
      .select({ collection: docs.collection, id: docs.recordId, code: docs.code, title: docs.title, subtitle: docs.subtitle })
      .from(docs)
      .where(and(inArray(docs.recordId, chunk), collectionIn(collections), eq(docs.deleted, false), or(...branches))) as PromiseLike<
      (SearchHit & { code: string | null })[]
    >,
  );

  return found
    .filter((r) => wanted.has(`${r.collection}|${r.id}`))
    .sort((a, b) => wanted.get(`${a.collection}|${a.id}`)! - wanted.get(`${b.collection}|${b.id}`)!)
    .map((r) => ({ ...r, semantic: true }));
}

/**
 * Reciprocal rank fusion of the keyword and semantic lists.
 *
 * Ranks rather than scores, because the two are not commensurable: FTS5's `rank` is a BM25 variant and
 * Vectorize returns a cosine similarity, and normalising one onto the other would be inventing a relationship
 * that does not exist. RRF only asks where a row placed in each list, which is a fair question to ask of both.
 *
 * A row found by BOTH paths outranks a row found by one, which is the behaviour worth having: an exact
 * keyword match that is also semantically close is the best answer a search box can give.
 */
function fuse(keyword: ScoredHit[], semantic: ScoredHit[]): ScoredHit[] {
  const scored = new Map<string, { hit: ScoredHit; score: number }>();
  const add = (list: ScoredHit[], weight: number) => {
    for (const [rank, hit] of list.entries()) {
      const key = `${hit.collection}|${hit.id}`;
      const entry = scored.get(key) ?? { hit, score: 0 };
      // A row found by BOTH paths keeps the keyword hit's identity, so it is re-checked as the keyword hit it
      // also is: it genuinely matched text, so the stricter of the two questions is the right one to ask.
      if (hit.semantic !== true) entry.hit = { ...entry.hit, semantic: false };
      entry.score += weight / (RRF_K + rank + 1);
      scored.set(key, entry);
    }
  };
  // The keyword half is weighted higher. Someone typing into a search box usually means the characters they
  // typed, and the semantic half is here to catch what exact matching misses rather than to overrule it.
  add(keyword, 1);
  add(semantic, 0.7);
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, TOTAL).map((e) => e.hit);
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
  hits: ScoredHit[],
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

    // A SEMANTIC hit is asked a different question, because it was matched by a different thing.
    //
    // The token re-check below exists for FTS: the index matched text, possibly text the caller may not read,
    // so the hit has to be re-explained from the columns they may. A semantic hit was not matched on text at
    // all - it was matched on an embedding built from the title and subtitle ONLY (services/searchEmbed.ts),
    // never from `match` columns like `tickets.description`. So asking whether the caller's readable columns
    // contain the query tokens asks the wrong question of it, and gets the wrong answer: a semantic hit
    // usually does NOT contain the typed words, which is the entire point. Sent through the FTS re-check,
    // every semantic hit was dropped for any caller denied a matchable field - and the default policy denies
    // `tickets.description` and `leave-requests.reason`, so that was most callers, silently.
    //
    // The right question is whether the caller may read the text the embedding was built FROM. If the title
    // or subtitle is denied, the hit's whole basis is hidden and it is dropped; otherwise it stands on text
    // the caller can see in front of them.
    if (hit.semantic) {
      if (!hidden(entry.title) && !hidden(entry.subtitle)) out.push(next);
      continue;
    }

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
