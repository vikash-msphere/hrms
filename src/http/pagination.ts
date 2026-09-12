// Opaque cursor over a stable (createTime, uid) sort. Keep page sizes bounded.
//
// THE UID HALF IS A WIRE TOKEN, NEVER AN INTERNAL ID. A cursor is a response field, so whatever goes in it is
// on the wire - and `base64url` is an encoding, not a wrapper: `1789015590970|0abc1def2ghj3` reads straight
// back out of one. services/keysetPage.ts always encoded its half through the codec; this one did not, so the
// 22 collections paged in memory published their internal primary keys in `next_page_token`. That is the id
// the whole codec exists to keep off the wire (lib/idCodec.ts) - and the inbound edge leaves a non-token id
// segment alone (middleware/decodeWireIds.ts), so a harvested one addresses its row directly. Authz still
// gates by code, so this was never an access bypass; what it cost is the non-enumerability the token scheme
// is for, and the symmetry that lets the edge be the only place ids cross.
//
// So the `wire` parameter below is not optional bookkeeping: pass it for every collection whose rows are
// addressed by an internal id. The natural-key listings (roles by name, settings/policy by key) pass nothing,
// because their uid is already the public identifier.
import type { IdCodec } from "../lib/idCodec";

/** How a cursor's uid half crosses the wire: encoded under its collection, exactly as keysetPage does. */
export type CursorWire = { codec: IdCodec; collection: string };

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
// SQL-SIDE PAGING (services/keysetPage.ts) IS THE DEFAULT, AND THIS IS THE EXCEPTION.
//
// Reading a whole table to hand back fifty rows is not a style choice on this platform: D1 bills the rows a
// query READS, the isolate holds all of them while it sorts, and both costs grow with the table while the
// answer stays one page. Every collection whose rows accumulate - time entries, check-ins, documents,
// enrolments, declarations, payroll runs - pages in SQL for that reason, and a new list should too.
//
// What is left here is the set where SQL paging buys nothing or cannot apply, and each one is here on purpose:
//
//   - `roles`, `policy`, `settings`, `preferences` are keyed by a NATURAL identifier (a role name, a settings
//     key), not by `uuid`. keysetPage seeks on (createdAt, uuid) and tokenizes the uuid half through the wire
//     codec; these collections have no internal id on the wire to seek or encode, and their row counts are
//     bounded by configuration rather than by use. `settings` additionally reads off the per-request snapshot
//     in lib/refData.ts, so its rows are already in memory and a second query would be the more expensive
//     shape.
//   - `expenseBudgets` computes phase counts and a spend summary ACROSS every matching budget before it pages.
//     Those totals are the answer, not a decoration of the page, so the whole set genuinely has to be read;
//     paging it in SQL would mean querying twice and would save nothing.
//
// Anything else that reaches for this is almost certainly a list that should be using keysetPage.
//
// The ONE thing a caller must not do is sort the row set on a different key than it pages on: the seek below
// compares `when`, so a caller that pre-sorted by some other field and then paged would seek into an order that
// does not exist and drop whole rows between pages. Page here, and sort a RETURNED PAGE for presentation.
//
// ASYNC because the cursor's uid half is encoded through the codec (see the header). Deliberately async even
// for the natural-key callers that pass no `wire`: one signature means a new listing cannot quietly take the
// synchronous path and ship an internal id, and TypeScript flags every caller that forgets to await.
export async function paginate<T>(
  rows: T[],
  maxPageSize: number,
  pageToken: string | undefined,
  when: (r: T) => number,
  uid: (r: T) => string,
  dir: "asc" | "desc" = "desc",
  wire?: CursorWire,
): Promise<{ items: T[]; nextPageToken?: string }> {
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
  // The cursor carries the wire TOKEN; decode it back to the internal uid the seek compares against. Same
  // shape as keysetPage: a token that does not decode (forged, foreign, from another collection, or minted
  // before this collection was wired) falls back to a TIMESTAMP-ONLY bound rather than erroring or leaking.
  // That bound can only re-show rows at the boundary instant, never skip them, so the fallback is the safe
  // direction of wrong.
  const curUid = cur && wire ? await wire.codec.decode(wire.collection, cur.uid) : cur?.uid ?? null;
  const past = (e: T) =>
    (dir === "asc" ? when(e) > cur!.createTimeMs : when(e) < cur!.createTimeMs) ||
    (curUid !== null && when(e) === cur!.createTimeMs && uid(e) > curUid);
  const start = cur ? sorted.findIndex(past) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  if (!(start >= 0 && start + maxPageSize < sorted.length && last)) return { items: slice };
  const lastUid = uid(last);
  return { items: slice, nextPageToken: encodeCursor(when(last), wire ? await wire.codec.encode(wire.collection, lastUid) : lastUid) };
}
