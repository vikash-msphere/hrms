import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import type { Deps } from "../deps";
import { encodeCursor, decodeCursor } from "../http/pagination";

// SQL-side keyset pagination over the standard (createdAt, uuid) order. Replaces the "select the whole scoped
// table, sort in JS, slice" pattern that loaded an entire table into the Worker on every all-scope list (a
// memory/CPU/D1-cost DoS that grows with the table). Here the DB does the ordering, the keyset WHERE seeks to
// the cursor, and LIMIT fetches only one page (+1 to detect a next page).
//
// The page token tokenizes the row uuid via the wire-id codec, so an INTERNAL id is never exposed in a cursor
// (the prior inline cursors base64'd the raw uuid into the token). `collection` is the wire collection name
// used for that encode/decode. `table` must have the standard `createdAt` (timestamp_ms) + `uuid` columns.
// Pass scope/filter/soft-delete conditions in `where`. `dir` is the createdAt order: "desc" (newest-first,
// the DEFAULT) or "asc" (oldest-first).
//
// Newest-first is the default because a page is a WINDOW, not the collection: the web caches the first page and
// filters/sorts/exports it client-side (useCollection), and a feed only ever asks for one page before the
// reader scrolls. Under oldest-first that window held the rows nobody was looking for - a board with more posts
// than a page opened on its very first post and the newest one could only be reached by following the cursor to
// the end. Only pass "asc" where a caller genuinely reads a list forwards through time.
//
// `order` replaces `createdAt` as the sort key for a list whose reading order is not "when the row was
// written" - the board feed, where a pinned post leads and a scheduled one is placed by when it went live
// (see domain/board.ts). It is a pair on purpose: `expr` is the key in SQL (ordered by, and seeked against),
// `value` is the SAME key computed over a returned row so the next cursor can carry it. The two MUST agree -
// a `value` that disagrees with `expr` seeks into an order that does not exist and drops whole pages, which
// is exactly the class of bug this replaces. The key must be a non-null integer (ms) for every row the
// `where` can match: SQL sorts NULL apart from the comparisons below, so a nullable key loses rows after
// the first page.
export async function keysetPage<T = any>(
  deps: Deps,
  table: any,
  collection: string,
  where: SQL | undefined,
  opts: { dir?: "asc" | "desc"; max: number; pageToken?: string; order?: { expr: SQL; value: (row: any) => number } },
): Promise<{ items: T[]; nextPageToken?: string }> {
  const dir = opts.dir ?? "desc";
  const cmp = dir === "asc" ? gt : lt;
  const cur = decodeCursor(opts.pageToken);
  // The cursor carries the wire TOKEN; decode it back to the internal id for the keyset compare.
  const curUid = cur ? await deps.idCodec.decode(collection, cur.uid) : null;
  const conds: (SQL | undefined)[] = [where];
  // The sort key: the row's own createdAt by default, whatever `order` says otherwise. `bound` is what the
  // cursor's numeric half is compared AS - a Date against the timestamp column, a raw ms integer against an
  // expression, which is how it is stored either way.
  const key: SQL = opts.order?.expr ?? table.createdAt;
  const keyValue: (row: any) => number = opts.order?.value ?? ((row) => +new Date(row.createdAt));
  if (cur) {
    const at = opts.order ? cur.createTimeMs : new Date(cur.createTimeMs);
    // Strictly after the cursor in (key, uuid) order. If the token didn't decode (forged/garbage), fall
    // back to the timestamp-only bound rather than leaking or erroring.
    conds.push(
      curUid !== null
        ? or(cmp(key, at), and(eq(key, at), cmp(table.uuid, curUid)))
        : cmp(key, at),
    );
  }
  const ord = dir === "asc" ? asc : desc;
  const rows = (await deps.db
    .select()
    .from(table)
    .where(and(...(conds.filter(Boolean) as SQL[])))
    .orderBy(ord(key), ord(table.uuid))
    .limit(opts.max + 1)) as T[];
  const hasMore = rows.length > opts.max;
  const items = hasMore ? rows.slice(0, opts.max) : rows;
  const last = items[items.length - 1] as { uuid: string } | undefined;
  const nextPageToken =
    hasMore && last ? encodeCursor(keyValue(last), await deps.idCodec.encode(collection, last.uuid)) : undefined;
  return { items, nextPageToken };
}
