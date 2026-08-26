import { gt } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";

// "Has anything changed since I last looked?" - one tiny read that lets a client keep its stored copies instead
// of re-reading them.
//
// WHY. The SPA persists what it has loaded (lib/resourceStore.ts), but a stored copy is only worth having if
// "nothing changed" can be TRUSTED: before this, every collection whose freshness window had lapsed was
// re-read on the next page load, which is most of them, because a page load usually comes minutes or hours
// later. So a reload cost a read per collection on screen to discover that almost nothing had changed. This
// answers that question once, for everything at once.
//
// WHY NOT THE AUDIT LOG. It was the obvious source and it is the wrong one: the accrual cron, the automation
// engine, the code cascade and the notification writer all write rows without an audit entry, so "no audit
// entry" does not mean "no change" - and a missed write here is not a stale badge, it is a client serving
// yesterday's rows and never finding out. The stamps come from triggers instead (src/db/changeDdl.ts), which
// see every write from every service, cron, seed and hand-run statement.
//
// COST. `collection_versions` holds one row per collection - about seventy - indexed on `at`. The question
// costs the same handful of rows whether the org is a week or a decade old, and it replaces a page of rows per
// collection.
export type ChangesAnswer = {
  /** Wire collections written to since `since`, or null when there is no reference point to compare against. */
  collections: string[] | null;
  /** The server's clock at the moment of the answer - what the client should send as `since` next time. */
  now: number;
};

/** Collections whose stamp is newer than `sinceMs`. Unfiltered: the route drops the ones the caller may not
 *  list, so nothing is named that they could not have read for themselves. */
export async function changedSince(deps: Deps, sinceMs: number, now = Date.now()): Promise<ChangesAnswer> {
  // No reference point (a first visit, or storage that has been cleared): there is nothing stored to keep, so
  // say so rather than answering "nothing changed" for copies this cannot speak for.
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return { collections: null, now };
  // Deliberately NO maximum age. The stamps are current state, not history, so a copy from last week is
  // answered as exactly as one from a minute ago - which is the point: a client that has been away can still
  // keep everything nobody touched while it was gone.
  const rows = (await deps.db
    .select({ collection: schema.collectionVersions.collection })
    .from(schema.collectionVersions)
    .where(gt(schema.collectionVersions.at, new Date(sinceMs)))) as { collection: string }[];
  return { collections: rows.map((r) => r.collection), now };
}
