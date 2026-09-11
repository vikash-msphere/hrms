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

const MIN_QUERY = 2;
const MAX_MATCHES = 500; // bounds the IN list; a query this broad is a browse, not a search
const MAX_TOKENS = 6;

// Same tokenisation as global search: quoted prefix terms, ANDed. Stripping to letters/digits leaves no FTS5
// operator or quote in the expression, so the query text cannot alter its structure.
function matchExpression(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS);
  return tokens.length === 0 ? null : tokens.map((t) => `"${t}"*`).join(" ");
}

/** A `WHERE` fragment restricting `idCol` to this collection's text matches for `q`, or undefined when there
 *  is nothing to filter by (blank/too-short query). Returns a never-true condition when the query matches
 *  nothing, so an unmatched search yields an empty list rather than the unfiltered one. */
export async function searchFilter(deps: Deps, collection: string, q: string | undefined, idCol: AnySQLiteColumn): Promise<SQL | undefined> {
  const trimmed = (q ?? "").trim();
  if (trimmed.length < MIN_QUERY) return undefined;
  const match = matchExpression(trimmed);
  if (!match) return undefined;
  const rows = await deps.db.all<{ id: string }>(sql`
    select d."record_id" as id
    from "search_fts" f join "search_docs" d on d."rowid" = f."rowid"
    where f."text" match ${match} and d."collection" = ${collection}
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
