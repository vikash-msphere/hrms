import { sql, type SQL } from "drizzle-orm";

// Pure board-post rules shared by the service and the lifecycle verb, so a post that goes live announces itself
// the same way whichever route published it.

// How far ahead of the feed a pinned post sits. Any offset bigger than a real timestamp works; 1e15 ms is the
// year 33658, so a pinned post outranks every unpinned one while the pinned group still orders among itself by
// WHEN it was pinned (most recent first).
export const PIN_OFFSET = 1_000_000_000_000_000;

/**
 * The board's reading order, as one number per post: pinned posts first (newest pin leading), then everyone
 * else by when the post went LIVE - `publish_time` when it has one, `created_at` otherwise (an immediately
 * published post never gets a publish_time, so its board time is when it was written).
 *
 * There is exactly one order and three places compute it: here in SQL (what the list pages by), here in JS
 * (what the cursor carries), and `web/src/lib/boardOrder.ts` (what the feed sorts the loaded rows by, so a
 * local pin toggle reorders without a refetch). They must stay identical - the feed used to page by
 * `created_at` and sort by `publish_time`, which is how a freshly loaded older page could put a post at the
 * TOP of the board and why placement looked random.
 *
 * Ordering by "when it went live" only holds still because `publish_time` is a DRAFT's schedule and nothing
 * else: the service refuses it on a live post and refuses a schedule in the past, so a post cannot be moved
 * around the board after the fact (see createAnnouncement/updateAnnouncement).
 */
export function boardOrderSql(t: { pinnedAt: unknown; publishTime: unknown; createdAt: unknown }): SQL {
  return sql`case when ${t.pinnedAt} is not null then ${t.pinnedAt} + ${PIN_OFFSET} else coalesce(${t.publishTime}, ${t.createdAt}) end`;
}

/** The JS mirror of `boardOrderSql`, over a selected row. */
export function boardOrderValue(row: { pinnedAt?: Date | number | null; publishTime?: Date | number | null; createdAt: Date | number }): number {
  if (row.pinnedAt) return +new Date(row.pinnedAt) + PIN_OFFSET;
  return +new Date(row.publishTime ?? row.createdAt);
}

/** Bell title for a board post going live: the kind it actually is, not "announcement" for all of them. */
export function postedTitle(kind: string): string {
  return kind === "poll" ? "New poll" : kind === "post" ? "New post" : "New announcement";
}

/**
 * Where a bell about one post lands: that post alone, on its own page - not the board it sits on. A
 * notification is about a specific post, so the click has to arrive AT it; dropping someone on the feed
 * makes them hunt for what they were told about. The `/view` tail is the pop-out route the web app already
 * serves (`#/announcements/<id>/view`), and the leading `<collection>/<id>` is what the outbound wire-id
 * encoder rewrites, so the stored internal id never reaches a client.
 */
export function boardPostLink(id: string): string {
  return `announcements/${id}/view`;
}
