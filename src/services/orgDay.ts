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
import { DEFAULT_ATTENDANCE, localDay, type AttendanceConfig } from "../domain/attendance";
import type { Deps } from "../deps";

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
