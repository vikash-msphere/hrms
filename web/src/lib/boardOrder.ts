import type { Announcement } from "@/types";

// The board's reading order, client side. This is the MIRROR of `boardOrderSql`/`boardOrderValue` in
// src/domain/board.ts, which is the order the server pages the collection in: the feed sorts its loaded rows
// itself (a `:pin` toggle or a post that was just written must reorder without a refetch), and if the two
// keys ever disagreed, following "Load older posts" would drop a page's worth of posts at the top of the
// board instead of the bottom. Change one, change the other.

// How far ahead of the feed a pinned post sits - see the server constant of the same name.
export const PIN_OFFSET = 1_000_000_000_000_000;

/** When a post went live: its publish time when it has one, else when it was written. What the card prints. */
export const boardTime = (a: Announcement): number => +new Date(a.publish_time ?? a.create_time ?? 0);

/** The feed's sort key: pinned posts first (most recently pinned leading), then by when the post went live. */
export const boardKey = (a: Announcement): number => (a.pin_time ? +new Date(a.pin_time) + PIN_OFFSET : boardTime(a));

/** Newest-first comparator over `boardKey`, for `.sort()`. */
export const byBoardOrder = (x: Announcement, y: Announcement): number => boardKey(y) - boardKey(x);
