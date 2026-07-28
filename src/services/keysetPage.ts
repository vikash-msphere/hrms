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
// Pass scope/filter/soft-delete conditions in `where`. `dir` is the createdAt order: "asc" (oldest-first) or
// "desc" (newest-first).
export async function keysetPage<T = any>(
  deps: Deps,
  table: any,
  collection: string,
  where: SQL | undefined,
  opts: { dir?: "asc" | "desc"; max: number; pageToken?: string },
): Promise<{ items: T[]; nextPageToken?: string }> {
  const dir = opts.dir ?? "asc";
  const cmp = dir === "asc" ? gt : lt;
  const cur = decodeCursor(opts.pageToken);
  // The cursor carries the wire TOKEN; decode it back to the internal id for the keyset compare.
  const curUid = cur ? await deps.idCodec.decode(collection, cur.uid) : null;
  const conds: (SQL | undefined)[] = [where];
  if (cur) {
    const at = new Date(cur.createTimeMs);
    // Strictly after the cursor in (createdAt, uuid) order. If the token didn't decode (forged/garbage), fall
    // back to the timestamp-only bound rather than leaking or erroring.
    conds.push(
      curUid !== null
        ? or(cmp(table.createdAt, at), and(eq(table.createdAt, at), cmp(table.uuid, curUid)))
        : cmp(table.createdAt, at),
    );
  }
  const ord = dir === "asc" ? asc : desc;
  const rows = (await deps.db
    .select()
    .from(table)
    .where(and(...(conds.filter(Boolean) as SQL[])))
    .orderBy(ord(table.createdAt), ord(table.uuid))
    .limit(opts.max + 1)) as T[];
  const hasMore = rows.length > opts.max;
  const items = hasMore ? rows.slice(0, opts.max) : rows;
  const last = items[items.length - 1] as { createdAt: Date | number; uuid: string } | undefined;
  const nextPageToken =
    hasMore && last ? encodeCursor(+new Date(last.createdAt), await deps.idCodec.encode(collection, last.uuid)) : undefined;
  return { items, nextPageToken };
}
