// The org's calendar day, for every decision that turns on "today".
//
// WHY THIS EXISTS. Payroll, attendance, comp-off and the regularization flow all read the org timezone out of
// `settings/attendance` and derive a day with `localDay` (domain/attendance.ts). Everything else derived it as
// `new Date().toISOString().slice(0, 10)`, which is the day in UTC. Those two agree for about eighteen and a
// half hours out of every twenty-four in IST, and disagree for the rest - so the bugs this shape produces are
// the ones that only appear early in the morning, only on some days, and never in a test.
//
// They are not cosmetic. The back-dating gate on a leave request compares the requested start against "today":
// in a timezone WEST of UTC, an employee asking for leave starting today after about 19:00 local was refused
// with "pick today or a future date", because UTC had already rolled over. East of UTC the same comparison is
// too generous instead, waving through genuinely back-dated requests for the first hours of the local day. The
// nightly tick has the same shape for probation endings, anniversaries and document expiry: 02:00 UTC is the
// same date in IST, but is the PREVIOUS evening in the Americas, so those fire a day early.
//
// The timezone is org configuration (`settings/attendance`, IANA, defaulting to Asia/Kolkata) and the settings
// read is memoized per request by lib/refData, so calling this is free wherever settings are already read and
// one cached read otherwise.
import { getSettingValue } from "./settings";
import { DEFAULT_ATTENDANCE, localDay, type AttendanceConfig, type WithOrgToday } from "../domain/attendance";
import type { Deps } from "../deps";

// Re-exported so the pair reads as one concept from here (the stamp) as well as from the leaf that holds the
// reader. See stampOrgToday for why the reader cannot live in this module.
export { todayMsOf, type WithOrgToday } from "../domain/attendance";

/** The org's IANA timezone, from `settings/attendance`. Never empty - falls back to the schedule default. */
export async function orgTimezone(deps: Deps): Promise<string> {
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  return att.timezone || DEFAULT_ATTENDANCE.timezone;
}

/** Today's calendar day as "YYYY-MM-DD", read in the org timezone. */
export async function orgToday(deps: Deps): Promise<string> {
  return localDay(+deps.clock.now(), await orgTimezone(deps));
}

/** The org-local calendar day `offsetDays` from today, as "YYYY-MM-DD". Negative looks back. */
export async function orgDayFromToday(deps: Deps, offsetDays: number): Promise<string> {
  return localDay(+deps.clock.now() + offsetDays * 86_400_000, await orgTimezone(deps));
}

/**
 * The epoch ms a "YYYY-MM-DD" is stored at.
 *
 * Date-only columns are anchored at UTC midnight throughout the schema (see the `dayMs` helper repeated across
 * the services), so this is how an org-local day is compared against one of them. It is NOT the instant that
 * day begins in the org timezone, and must not be used as one.
 */
export function dayStartMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`);
}

/**
 * Stamp the org's calendar day on each row of a page, for a serializer that has to compare a date-only column
 * against "today".
 *
 * WHY A STAMP AND NOT A CLOCK IN THE SERIALIZER. src/http/serialize.ts is a pure row -> wire module with no
 * `Deps` and a signature the collection factory fixes, so a serializer that needs "today" had no way to ask
 * for the ORG's one and derived it from `new Date()` in UTC instead. That is the same shape this file exists
 * to end, and it reached the wire: a compliance filing's `overdue` flag and a notice period's
 * `days_remaining` both compare a date-only column (UTC midnight) against it, so for the hours each day when
 * UTC and the org disagree a statutory deadline was painted red on the morning it was still due, and a
 * leaver's remaining notice was a day out.
 *
 * `decorate` is the one hook that runs on EVERY response path the factory serves - item reads, list pages and
 * the lifecycle verbs alike (http/collectionRoute.ts applies it before `serialize`) - and it does receive
 * `Deps`. So the day is resolved once per response here, and read back by `todayMsOf`.
 *
 * The READER lives in domain/attendance.ts, not here, and the split is not cosmetic: `services/settings.ts`
 * imports `http/serialize` for `etagOf`, so a serializer importing this module would close a cycle
 * (serialize -> orgDay -> settings -> serialize) whose correctness would rest on evaluation order. The reader
 * is pure, so it sits in the leaf that already owns `localDay`/`utcDay` and the date-only rule.
 *
 * One settings read per response (memoized by lib/refData for the rest of the request), never one per row.
 */
export async function stampOrgToday<T extends object>(deps: Deps, rows: T[]): Promise<(T & WithOrgToday)[]> {
  if (!rows.length) return rows as (T & WithOrgToday)[];
  const todayMs = dayStartMs(await orgToday(deps));
  return rows.map((r) => ({ ...r, _todayMs: todayMs }));
}

/**
 * The org's calendar YEAR, as a value that can also decide which year a stored INSTANT fell in.
 *
 * `dayStartMs` above answers the other half of this problem - a DATE-ONLY column, anchored at UTC midnight.
 * This is for the columns that hold a real moment (`created_at`, a clock punch, an audit stamp): "was this
 * encashed in the current calendar year" is a question about the ORG's year, and the row records an instant,
 * so the two are not the same comparison.
 *
 * WHY IT DOES NOT COMPUTE THE YEAR'S BOUNDARIES. The obvious shape is "the UTC instant at which 1 January
 * began locally", and it is a trap: inverting a timezone is ambiguous by construction. A local wall-clock time
 * can name two instants (the hour a DST fold repeats) or none (the hour a spring-forward skips), so the
 * inverse needs an offset guess, a re-read and a rule for the ambiguous cases - new time math, in a codebase
 * that already has exactly one trusted timezone function and would then have two.
 *
 * So it never inverts. `from`/`to` are LOOSE bounds - a whole day of slack at each end - which are safe to
 * bind in SQL because no timezone is more than 14 hours from UTC: an instant whose LOCAL day falls in year
 * `year` cannot lie outside them. They narrow the read and decide nothing. `covers` then makes the exact call
 * on the rows that came back, using `localDay` - the same forward conversion every other org-local decision in
 * the app goes through. Widen in SQL, decide in JS: no offset arithmetic anywhere, and no second definition of
 * what a local day is.
 *
 * RESOLVE IT ONCE AND PASS IT DOWN. It reads the org timezone out of settings, and `lib/refData` memoizes that
 * read PER REQUEST - which a cron tick does not have, so on that path every call is a fresh D1 read. Callers
 * therefore take a resolved `OrgYear` rather than deriving their own: the rollover tick resolves one for the
 * whole night, which costs one read instead of one per employee per leave type, and makes it impossible for
 * the year a balance is stamped with to disagree with the year its encashment cap was measured over.
 */
export type OrgYear = {
  /** The org-local calendar year, e.g. "2026". */
  year: string;
  /** Loose UTC bounds for binding in SQL. Wider than the year; never narrower. */
  from: Date;
  to: Date;
  /** The exact test, for the rows the loose bounds returned. */
  covers: (at: Date | number) => boolean;
};

export async function orgYear(deps: Deps, at: number = +deps.clock.now()): Promise<OrgYear> {
  const tz = await orgTimezone(deps);
  const year = localDay(at, tz).slice(0, 4);
  const y = Number(year);
  return {
    year,
    from: new Date(Date.UTC(y - 1, 11, 31)),
    to: new Date(Date.UTC(y + 1, 0, 1, 23, 59, 59, 999)),
    covers: (when) => localDay(+new Date(when), tz).slice(0, 4) === year,
  };
}
