// Opaque cursor over a stable (createTime, uid) sort. Keep page sizes bounded.

export const encodeCursor = (createTimeMs: number, uid: string) =>
  Buffer.from(`${createTimeMs}|${uid}`).toString("base64url");

// VALIDATED, not just parsed: a forged or truncated token used to yield `{ createTimeMs: NaN, uid: "" }`, and
// keysetPage bound `new Date(NaN)` straight into the keyset comparison. The wire-id half of the cursor was
// always careful about this (an undecodable id falls back to a timestamp-only bound rather than erroring); the
// timestamp half was not. `null` here means "no cursor", so a junk token reads as the first page.
export const decodeCursor = (t?: string) => {
  if (!t) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(t, "base64url").toString();
  } catch {
    return null;
  }
  const [ms, uid] = decoded.split("|");
  const createTimeMs = Number(ms);
  if (!ms || !Number.isFinite(createTimeMs) || !uid) return null;
  return { createTimeMs, uid };
};

export const clampPageSize = (n?: number) => Math.min(Math.max(n ?? 50, 1), 100);

// Generic cursor pagination over an in-memory row set: sort by (when, uid), then page. `when` returns the sort
// timestamp (ms) and `uid` a stable tiebreaker (the row's id/key). `dir` is which end the first page is a window
// on - "desc" (newest first, the default, matching keysetPage) or "asc". Returns the page slice plus the next
// cursor (undefined when exhausted).
//
// The ONE thing a caller must not do is sort the row set on a different key than it pages on: the seek below
// compares `when`, so a caller that pre-sorted by some other field and then paged would seek into an order that
// does not exist and drop whole rows between pages. Page here, and sort a RETURNED PAGE for presentation.
export function paginate<T>(
  rows: T[],
  maxPageSize: number,
  pageToken: string | undefined,
  when: (r: T) => number,
  uid: (r: T) => string,
  dir: "asc" | "desc" = "desc",
): { items: T[]; nextPageToken?: string } {
  // ONE comparator, shared by the sort and the seek below. It used to tiebreak with `localeCompare` while the
  // seek asked `uid(e) > cur.uid`, which are two different orderings: ICU collation is case-insensitive at the
  // primary level and reorders around punctuation, byte comparison does neither. Wherever they disagreed and
  // `when` tied, findIndex seeked PAST rows that had never been returned and they vanished from the listing
  // entirely - e.g. roles ["employee", "HR Admin", "manager"] written in one seed (so all sharing `createdAt`)
  // paged out as ["employee", "manager"]. Same hazard for the hyphenated setting/policy keys, whose rows are
  // also written in one batch. Byte order here matches the `>` in the seek, and matches keysetPage, which
  // orders in SQL under SQLite's default BINARY collation.
  const byUid = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Only the TIMESTAMP flips with `dir`. The tiebreaker stays ascending in both directions, so the seek below
  // asks the same `uid(e) > cur.uid` either way and the two comparisons cannot drift apart.
  const byWhen = dir === "asc" ? (a: T, b: T) => when(a) - when(b) : (a: T, b: T) => when(b) - when(a);
  const sorted = [...rows].sort((a, b) => byWhen(a, b) || byUid(uid(a), uid(b)));
  const cur = decodeCursor(pageToken);
  const past = (e: T) =>
    (dir === "asc" ? when(e) > cur!.createTimeMs : when(e) < cur!.createTimeMs) ||
    (when(e) === cur!.createTimeMs && uid(e) > cur!.uid);
  const start = cur ? sorted.findIndex(past) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < sorted.length && last ? encodeCursor(when(last), uid(last)) : undefined;
  return { items: slice, nextPageToken };
}
