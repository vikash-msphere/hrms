// Opaque cursor over a stable (createTime, uid) sort. Keep page sizes bounded.

export const encodeCursor = (createTimeMs: number, uid: string) =>
  Buffer.from(`${createTimeMs}|${uid}`).toString("base64url");

export const decodeCursor = (t?: string) => {
  if (!t) return null;
  const [ms, uid] = Buffer.from(t, "base64url").toString().split("|");
  return { createTimeMs: Number(ms), uid: uid ?? "" };
};

export const clampPageSize = (n?: number) => Math.min(Math.max(n ?? 50, 1), 100);

// Generic cursor pagination over an in-memory row set: sort by (when, uid) ascending, then page. `when`
// returns the sort timestamp (ms) and `uid` a stable tiebreaker (the row's id/key). Returns the page slice
// plus the next cursor (undefined when exhausted). Mirrors the inline logic the scoped list services use.
export function paginate<T>(
  rows: T[],
  maxPageSize: number,
  pageToken: string | undefined,
  when: (r: T) => number,
  uid: (r: T) => string,
): { items: T[]; nextPageToken?: string } {
  const sorted = [...rows].sort((a, b) => when(a) - when(b) || uid(a).localeCompare(uid(b)));
  const cur = decodeCursor(pageToken);
  const start = cur ? sorted.findIndex((e) => when(e) > cur.createTimeMs || (when(e) === cur.createTimeMs && uid(e) > cur.uid)) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < sorted.length && last ? encodeCursor(when(last), uid(last)) : undefined;
  return { items: slice, nextPageToken };
}
