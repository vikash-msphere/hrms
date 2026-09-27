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
import { getTableConfig } from "drizzle-orm/sqlite-core";
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
import { MODELS } from "../domain/aiPolicy";
import { SEMANTIC_MAX, SEMANTIC_MIN_SCORE, SEMANTIC_WINDOW, meaningful } from "../domain/semanticSearch";
import { explains, matchExpression, queryTerms, type QueryTerm } from "../domain/searchQuery";
import { orgSynonymGroups } from "./searchSynonyms";

export type SearchHit = {
  collection: string;
  id: string; // internal record id; the route renders it as `<collection>/<id>` and the wire edge tokenizes it
  title: string | null;
  subtitle: string | null;
  // Found by meaning only, not by the typed words. The palette shows these apart, under "Related", after
  // every keyword hit - they are a suggestion, and presenting one as a match is what made them read as wrong.
  related?: true;
};

/**
 * A hit while it is still being decided on, carrying the two things the final resource does not: the row's
 * `code` (what a per-code field deny is judged against) and HOW it was found.
 *
 * `semantic` is not a ranking detail - it changes which question the field gate has to ask of the row. See
 * the note in `narrowRedacted`.
 */
// `exact`: found by its human key ("MS-12", `cardsByKey`), not by text - so there is no matched text to re-explain.
type ScoredHit = SearchHit & { code: string | null; semantic?: boolean; exact?: boolean };

/** The hit as the route returns it: the decision-time fields dropped, and HOW it was found kept as `related`. */
const toHit = ({ code: _code, semantic, exact: _exact, ...hit }: ScoredHit): SearchHit => (semantic ? { ...hit, related: true } : hit);

/** A drizzle property as `policy.redacted_fields` spells it (`baseComp` -> `base_comp`). */
const wireOf = (prop: string) => prop.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

const MIN_QUERY = 2;
const TOTAL = 60;

// RANKING. bm25 over the indexed text, then three multipliers on it (bm25 is negative-is-better, so a factor
// above 1 pushes a row up without ever lifting a weak match far over a strong one):
//   - TITLE: the share of the query's terms, by any spelling, that appear in the row's TITLE. The index has one
//     text column, so a word in a ticket's subject and the same word deep in its description ranked alike; the
//     rendered title is already on the joined `search_docs` row, so asking it costs no read and no migration.
//   - OWN: the row belongs to the caller (their leave, their ticket, their own profile).
//   - RECENT: created in the last month.
const TITLE_BOOST = 1;
const OWN_BOOST = 0.5;
const RECENT_BOOST = 0.25;
const RECENT_MS = 30 * 86_400_000;
// Neighbours asked of the vector index before the SQL re-check. Generous on purpose: the re-check is the real
// filter, and a caller with narrow breadth will have most of these thrown away, so asking for too few would
// leave them with nothing to keep.
const SEMANTIC_TOP_K = 100;
// Run the semantic half only when the keyword half returned fewer than this. Chosen so a full-looking result
// list (the top of a ⌘K panel is about this many rows) costs nothing extra, while a thin or empty one gets
// the second opinion it needs.
const SEMANTIC_WHEN_KEYWORD_UNDER = 8;
// Which neighbours count as related (the floor, the window, the cap) and which queries are worth embedding
// at all live in domain/semanticSearch.ts, with the measurements behind them.

const docs = schema.searchDocs;

// A board task's human key: the board's prefix, a dash, the task's number on that board (serialize.ts renders
// it the same way). The index holds the prefix but not the number, so "MS-12" could not be found by its words.
const CARD_KEY = /^([a-z][a-z0-9]{0,9})-(\d{1,7})$/i;

/**
 * The task(s) a whole-query card key names, as hits the caller may see. Three small reads: the boards with
 * that prefix (a flat catalogue of a handful of rows), the card by (board, number) on its unique index, and
 * that card's search doc under `branch` - the caller's own cards predicate, which is what decides visibility.
 */
async function cardsByKey(deps: Deps, q: string, branch: SQL): Promise<ScoredHit[]> {
  const m = CARD_KEY.exec(q.trim());
  if (!m) return [];
  const boards = await deps.db
    .select({ uuid: schema.boards.uuid })
    .from(schema.boards)
    .where(sql`lower(${schema.boards.taskPrefix}) = ${m[1]!.toLowerCase()}`);
  if (!boards.length) return [];
  const cards = await deps.db
    .select({ uuid: schema.cards.uuid })
    .from(schema.cards)
    .where(and(inArray(schema.cards.boardId, boards.map((b) => b.uuid)), eq(schema.cards.seq, Number(m[2]))));
  if (!cards.length) return [];
  const found = await deps.db
    .select({ collection: docs.collection, id: docs.recordId, code: docs.code, title: docs.title, subtitle: docs.subtitle })
    .from(docs)
    .where(and(eq(docs.collection, "cards"), inArray(docs.recordId, cards.map((c) => c.uuid)), eq(docs.deleted, false), branch));
  return found.map((r) => ({ ...r, exact: true }));
}

/**
 * The share (0..1) of the query's terms found in the row's title, by any of their spellings, as SQL.
 *
 * LITERALS, not bound parameters: a query of six terms with their synonyms is dozens of spellings, and D1 binds
 * at most 100 per statement, which the scope predicates also spend from. A spelling is letters, digits and
 * spaces by construction (domain/searchQuery.ts splits on everything else) and anything else is dropped here
 * rather than trusted, so no quote can reach the statement. `instr` is a substring test, so a half-typed
 * word ("moni") counts as found in "Monitor", which is what type-ahead wants.
 */
function titleShare(terms: QueryTerm[]): SQL {
  const title = `lower(coalesce("search_docs"."title", ''))`;
  const parts = terms.map((t) => {
    const spellings = [t.typed, ...t.alternatives].map((s) => s.join(" ")).filter((s) => /^[\p{L}\p{N} ]+$/u.test(s));
    return spellings.length ? `(${spellings.map((s) => `instr(${title}, '${s}') > 0`).join(" OR ")})` : "0";
  });
  return parts.length ? sql.raw(`((${parts.join(" + ")}) * 1.0 / ${parts.length})`) : sql.raw("0");
}

/**
 * The searchable collections an `in:` word names. Forgiving on purpose, because people type what they call
 * the thing: the exact name (`tickets`), its singular (`ticket`), or the start of it (`leave` names leave
 * requests, leave types and leave encashments; `asset` names assets, asset categories and asset requests).
 * A start needs three letters, so `in:a` names nothing rather than half the app.
 */
function collectionsNamed(words: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of words) {
    const w = raw.toLowerCase().replace(/[^a-z-]/g, "");
    if (!w) continue;
    for (const { collection: c } of SEARCH_INDEX) {
      if (c === w || c === `${w}s` || c === `${w}es` || (w.length >= 3 && (c.startsWith(w) || c.replace(/-/g, "").startsWith(w.replace(/-/g, ""))))) out.add(c);
    }
  }
  return out;
}

/**
 * Narrowing the caller asked for - `in:tickets`, `@priya`, `is:mine` in the palette. ONLY EVER NARROWS: each
 * is an extra AND on a query already bound to the caller's own scopes, so none of them can reach a row the
 * caller's lists would not return.
 *   - `collections` keeps only the collections these words name (`collectionsNamed`); one the caller may not
 *     list still contributes nothing, and words that name nothing searchable answer nothing.
 *   - `ownerId` keeps only rows whose owner column is this employee (see `SearchScoping.owner` - the person a
 *     leave request, ticket or asset belongs to). Flat catalogues have no owner and drop out.
 *   - `after` / `before` (epoch ms) keep rows created in that window, off `search_docs.created_at` (indexed).
 *   - `status` keeps rows whose own state/status column holds that value. Collections with no such column drop
 *     out, and a value that is not status-shaped answers nothing rather than being ignored.
 */
export type SearchNarrowing = { collections?: string[]; ownerId?: string; after?: number; before?: number; status?: string };

/** A collection's state/status column, as `{ prop, table, column, idColumn }`, or null when it has none. Every
 *  entry that has one lists it among its `match` columns, so it is found there rather than listed twice. */
function statusColumnOf(entry: SearchEntry): { prop: string; table: string; column: string; id: string } | null {
  const prop = entry.match.find((p) => p === "state" || p === "status");
  const column = prop ? (entry.table as Record<string, { name?: string }>)[prop]?.name : undefined;
  const id = (entry.table as Record<string, { name?: string }>).uuid?.name;
  return prop && column && id ? { prop, table: getTableConfig(entry.table).name, column, id } : null;
}

// A status value as a SQL literal: lower-case letters, digits, space, `_` and `-` only, so it can be inlined
// (no bound parameter spent per branch) with no quote able to reach the statement. Null = not a status.
const statusLiteral = (raw: string): string | null => {
  const v = raw.trim().toLowerCase();
  return /^[a-z0-9_ -]{1,30}$/.test(v) ? v : null;
};

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
  narrowing: SearchNarrowing = {},
): Promise<SearchHit[]> {
  const q = rawQuery.trim();
  if (q.length < MIN_QUERY || scopes.size === 0) return [];
  // The org's own synonym groups ride beside the built-in ones (services/searchSynonyms.ts).
  const synonyms = await orgSynonymGroups(deps);
  const match = matchExpression(q, synonyms);
  if (!match) return [];
  const only = narrowing.collections?.length ? collectionsNamed(narrowing.collections) : null;
  if (only && only.size === 0) return []; // `in:` named nothing searchable
  const owner = narrowing.ownerId;
  const status = narrowing.status !== undefined ? statusLiteral(narrowing.status) : undefined;
  if (status === null) return []; // `status:` named something that is not a status

  // Collections whose filter is identical share one OR-branch, so the statement stays small: for most callers
  // every own-scoped collection collapses into a single predicate, rather than one per collection.
  const groups = new Map<string, { collections: string[]; pred: SQL | undefined }>();
  for (const entry of SEARCH_INDEX) {
    const scope = scopes.get(entry.collection);
    if (!scope) continue; // not listable by this caller
    if (only && !only.has(entry.collection)) continue; // `in:` asked for other collections
    if (owner && entry.scoping.kind === "flat") continue; // a catalogue row belongs to nobody
    if (status && !statusColumnOf(entry)) continue; // a collection with no status has no row in that status
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

  // The owner narrowing rides INSIDE each branch, so the semantic half's re-read (which reuses `branches`)
  // is narrowed by it too.
  // So do the date window and the status, as LITERALS: a bound parameter per branch per filter would spend the
  // statement's 100-parameter budget the scope predicates need.
  const after = Number.isFinite(narrowing.after) ? sql.raw(`"search_docs"."created_at" >= ${Math.floor(narrowing.after!)}`) : undefined;
  const before = Number.isFinite(narrowing.before) ? sql.raw(`"search_docs"."created_at" < ${Math.floor(narrowing.before!)}`) : undefined;
  const statusIn = (collections: string[]): SQL | undefined => {
    if (!status) return undefined;
    const parts = collections.flatMap((c) => {
      const s = statusColumnOf(SEARCH_INDEX.find((e) => e.collection === c)!);
      return s ? [`("search_docs"."collection" = '${c}' AND exists (select 1 from "${s.table}" t where t."${s.id}" = "search_docs"."record_id" and lower(t."${s.column}") = '${status}'))`] : [];
    });
    return sql.raw(parts.length ? `(${parts.join(" OR ")})` : "0");
  };
  const branches = [...groups.values()].map((g) => {
    const inList = collectionIn(g.collections);
    return and(inList, g.pred, owner ? eq(docs.ownerId, owner) : undefined, after, before, statusIn(g.collections))!;
  });

  // The boosts, as 0/1 terms. `coalesce` because a row with no owner compares NULL, and a NULL factor would
  // make the whole score NULL - which sorts FIRST in an ascending order.
  const mine = user.employeeId ? sql`coalesce(${docs.ownerId} = ${user.employeeId}, 0)` : sql`0`;
  const recent = sql`coalesce(${docs.createdAt} > ${deps.clock.now().getTime() - RECENT_MS}, 0)`;
  const inTitle = titleShare(queryTerms(q, synonyms));
  // The FTS table is named, not aliased: bm25() takes the table itself as its first argument.
  const rows = await deps.db.all<SearchHit & { code: string | null }>(sql`
    select ${docs.collection} as collection, ${docs.recordId} as id, ${docs.code} as code, ${docs.title} as title, ${docs.subtitle} as subtitle
    from "search_fts" join ${docs} on ${docs}."rowid" = "search_fts"."rowid"
    where "search_fts" match ${match} and ${eq(docs.deleted, false)} and (${or(...branches)})
    order by bm25("search_fts") * (1.0 + ${sql.raw(String(TITLE_BOOST))} * ${inTitle} + ${sql.raw(String(OWN_BOOST))} * ${mine} + ${sql.raw(String(RECENT_BOOST))} * ${recent})
    limit ${sql.raw(String(TOTAL))}
  `);
  const matched = rows.map((r) => ({ collection: r.collection, id: r.id, code: r.code, title: r.title, subtitle: r.subtitle }));
  // A board task's key ("MS-12") first, when that is what was typed. Read under the SAME branch predicate the
  // cards rows above were, so a card the caller cannot list is not found this way either.
  const cardsAt = [...groups.values()].findIndex((g) => g.collections.includes("cards"));
  const exact = cardsAt >= 0 ? await cardsByKey(deps, q, branches[cardsAt]!) : [];
  const keyword = exact.length ? [...exact, ...matched.filter((h) => !exact.some((e) => e.id === h.id && e.collection === h.collection))] : matched;

  // The semantic half, when this deployment has a model and an index. Everything below is additive: a refusal
  // at any step leaves `keyword` exactly as it was, which is the search this app had before any of this.
  //
  // SKIPPED WHEN THE KEYWORD HALF ALREADY ANSWERED WELL. Every semantic search embeds the query, so on a
  // search box that fires as you type, "laptop" is six embeds. The free allocation is 10,000 neurons a DAY
  // for the whole org, and spending it on queries that exact matching already answered is the fastest way to
  // have none left for the ones it cannot. Semantic retrieval exists to catch what the keyword index misses,
  // so it runs when the keyword index has in fact missed: few hits, or none - and only for a query that has
  // a meaning yet.
  const semantic = keyword.length >= SEMANTIC_WHEN_KEYWORD_UNDER || !meaningful(q)
    ? []
    : await semanticHits(deps, q, [...groups.values()].flatMap((g) => g.collections), branches);
  const hits = semantic.length ? appendRelated(keyword, semantic) : keyword;
  // An owner narrowing is a question about the owner COLUMN. A caller denied that column on a row may still
  // list the row, but must not learn whose it is by asking `@name` and watching it come back.
  // A status narrowing is the same kind of question about the status column.
  const probed = (owner || status) && gate
    ? hits.filter((h) => {
        const entry = SEARCH_INDEX.find((e) => e.collection === h.collection);
        if (!entry) return true;
        const denied = gate(h.collection, h.code);
        if (owner && entry.scoping.kind !== "flat" && denied.includes(wireOf(entry.scoping.owner))) return false;
        const s = status ? statusColumnOf(entry) : null;
        return !(s && denied.includes(wireOf(s.prop)));
      })
    : hits;
  return gate ? await narrowRedacted(deps, probed, queryTerms(q, synonyms), gate) : probed.map(toHit);
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
 * its keyword results, which is the whole degradation story for this feature. And [] when nothing is close
 * enough (see SEMANTIC_MIN_SCORE), which is the right answer far more often than the index would suggest.
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

  // `reads: "none"`: what is embedded is the caller's own search box, not a record. The rows the index
  // answers with are re-read under the caller's own scope below, which is where that question is settled.
  const embedded = await aiEmbed(deps, { feature: "search.query", reads: "none" }, [query]);
  if (!embedded.ok) return [];

  let matches: { id: string; score: number }[];
  try {
    matches = await deps.vectors.query(embedded.value[0]!, { topK: SEMANTIC_TOP_K, collections });
  } catch (e) {
    // An index outage must not fail a search that the keyword half can already answer.
    console.error("semantic search query failed", e);
    return [];
  }
  // The absolute floor goes first, before any read: a neighbour that is too far away is not worth the D1 row
  // it would cost to re-check. Only for the model it was tuned on - see SEMANTIC_MIN_SCORE.
  const floor = deps.ai.embedModel === MODELS.embed ? SEMANTIC_MIN_SCORE : -Infinity;

  // Ids are opaque to Vectorize, so a stale or foreign entry is possible; anything that does not parse, or
  // names a collection this caller is not searching, is dropped before it reaches a query.
  const wanted = new Map<string, number>(); // "<collection>|<recordId>" -> score
  const ids: string[] = [];
  const cols = new Set(collections);
  for (const m of matches) {
    if (m.score < floor) continue;
    const parsed = parseVectorId(m.id);
    if (!parsed || !cols.has(parsed.collection)) continue;
    wanted.set(`${parsed.collection}|${parsed.recordId}`, m.score);
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

  const scoreOf = (r: { collection: string; id: string }) => wanted.get(`${r.collection}|${r.id}`)!;
  const visible = found.filter((r) => wanted.has(`${r.collection}|${r.id}`)).sort((a, b) => scoreOf(b) - scoreOf(a));
  if (visible.length === 0) return [];
  // The window is measured from the best row THIS CALLER may see, not from the index's best: a closer row the
  // re-check just removed says nothing about how related the remaining ones are.
  const best = scoreOf(visible[0]!);
  return visible
    .filter((r) => scoreOf(r) >= best - SEMANTIC_WINDOW)
    .slice(0, SEMANTIC_MAX)
    .map((r) => ({ ...r, semantic: true }));
}

/**
 * The keyword hits in their own order, then the related ones after them.
 *
 * APPENDED, not fused. Rank fusion interleaved the two lists, so a row that merely sat near the query in
 * vector space could outrank a row containing the typed words, and nothing on screen said which was which.
 * The keyword half answers what was typed; the semantic half only suggests what might have been meant, and
 * is shown as that.
 *
 * A row found by BOTH paths is a keyword hit and not a related one: it genuinely matched text, so it keeps
 * its place, and `narrowRedacted` asks it the stricter of the two questions.
 */
function appendRelated(keyword: ScoredHit[], semantic: ScoredHit[]): ScoredHit[] {
  const seen = new Set(keyword.map((h) => `${h.collection}|${h.id}`));
  return [...keyword, ...semantic.filter((h) => !seen.has(`${h.collection}|${h.id}`))];
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
  terms: QueryTerm[],
  gate: RedactionGate,
): Promise<SearchHit[]> {
  const entryOf = new Map(SEARCH_INDEX.map((e) => [e.collection, e]));
  // Hits whose match has to be re-explained from the columns the caller may read, grouped by collection.
  const recheck = new Map<string, { entry: SearchEntry; ids: string[]; safe: string[] }>();
  const out: ScoredHit[] = [];

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
    // A task found by its key was matched on the board prefix and the task's number - neither a redactable
    // field - so there is no withheld text to re-explain it from. It still shows only what the caller may read.
    if (hit.exact) {
      out.push(next);
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
  if (!recheck.size) return out.map(toHit);

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
    // By any spelling of each term: a hit found through a synonym ("pto" matching "Earned Leave") is explained
    // by the synonym, and asking for the typed word would drop every such hit for a caller with a field deny.
    for (const row of rows) if (explains(row.text ?? "", terms)) explained.add(`${group.entry.collection}|${row.uuid}`);
  }
  const needed = new Set([...recheck.values()].flatMap((g) => g.ids.map((id) => `${g.entry.collection}|${id}`)));
  return out
    .filter((hit) => !needed.has(`${hit.collection}|${hit.id}`) || explained.has(`${hit.collection}|${hit.id}`))
    .map(toHit);
}
