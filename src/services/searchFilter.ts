// Server-side text filter for a single collection's LIST, backed by the same FTS index global search uses.
//
// NOT an access control. This only NARROWS: the caller's list scope is applied by the service exactly as it
// always was (applyScope), and this AND-s an extra "id is one of the text matches" condition on top. It can
// never widen a result set, so it makes no access decision - which is why it may live in a service at all
// (test/singleSource.test.ts).
//
// Why it exists: a list page caps at 100 rows and the client filters what it holds, so filtering a large
// collection client-side searches a window. Pushing the text match to the server searches the whole
// collection - and via FTS rather than a LIKE scan, so it costs an index lookup instead of a table scan.
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Deps } from "../deps";
import { matchExpression } from "../domain/searchQuery";
import { orgSynonymGroups } from "./searchSynonyms";

const MIN_QUERY = 2;
const MAX_MATCHES = 500; // bounds the IN list; a query this broad is a browse, not a search

// The expression is global search's own (domain/searchQuery.ts), synonyms included, so a list page's search
// box and ⌘K agree on what "pto" means.

/** A `WHERE` fragment restricting `idCol` to this collection's text matches for `q`, or undefined when there
 *  is nothing to filter by (blank/too-short query). Returns a never-true condition when the query matches
 *  nothing, so an unmatched search yields an empty list rather than the unfiltered one. */
export async function searchFilter(deps: Deps, collection: string, q: string | undefined, idCol: AnySQLiteColumn): Promise<SQL | undefined> {
  const trimmed = (q ?? "").trim();
  if (trimmed.length < MIN_QUERY) return undefined;
  const match = matchExpression(trimmed, await orgSynonymGroups(deps));
  if (!match) return undefined;
  // ORDERED BY RANK, AND DELETED ROWS EXCLUDED - the two things services/globalSearch.ts already does and this
  // sibling did not.
  //
  // Without the ordering, `LIMIT 500` takes whatever rows the scan reaches first, which for an FTS join is
  // rowid order: on any collection with more than 500 text matches the list's search box answered with the
  // OLDEST matches, every time, and the record somebody was actually looking for was simply absent with
  // nothing saying the result had been truncated. Ranked, the cap keeps the 500 best instead of the 500
  // eldest.
  //
  // The `deleted` filter is not about leaking - the caller's own list re-applies its soft-delete filter, so a
  // deleted id in this list matches nothing. It is about the BUDGET: every deleted row in the 500 is a slot a
  // live row needed, so a collection with a lot of trash quietly lost search coverage.
  const rows = await deps.db.all<{ id: string }>(sql`
    select d."record_id" as id
    from "search_fts" join "search_docs" d on d."rowid" = "search_fts"."rowid"
    where "search_fts" match ${match} and d."collection" = ${collection} and d."deleted" = 0
    order by bm25("search_fts")
    limit ${sql.raw(String(MAX_MATCHES))}
  `);
  // The id list goes in as LITERALS, not as bound parameters. D1 binds at most 100 per statement (see
  // lib/dbBatch.ts PARAM_CAP) and `inArray` binds one per id, so a query matching more than ~90 rows blew the
  // cap and the whole list failed with `D1_ERROR: too many SQL variables` - on the collections where a text
  // search is most worth having, and on nothing smaller, so it only ever showed up once real data was in.
  // The caller's own scope and pagination predicates spend from the same budget, which is what makes even
  // MAX_MATCHES on its own too many. Ids are server-generated Crockford base32 (see domain/codes.ts), so
  // there is no quote to escape; anything not of that shape is dropped rather than interpolated.
  const ids = rows.map((r) => r.id).filter((id) => /^[0-9a-hjkmnp-tv-z]+$/.test(id));
  if (ids.length === 0) return sql`1 = 0`;
  return sql`${idCol} in (${sql.raw(ids.map((id) => `'${id}'`).join(", "))})`;
}
