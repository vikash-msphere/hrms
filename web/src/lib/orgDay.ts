// The org's calendar day, on the client. The browser half of src/services/orgDay.ts, and it exists for the
// same reason.
//
// WHY. Twenty-odd files each defined `const todayStr = () => new Date().toISOString().slice(0, 10)`, which is
// the day in UTC - not the viewer's day and not the org's. In IST the two disagree between midnight and 05:30
// local, so a date input defaulted to yesterday and "starts today" read as "upcoming" for the first five and
// a half hours of every day. West of UTC it goes the other way and is worse: after about 19:00 local the SPA
// offers TOMORROW as today, and the server - which decides in the org's timezone (services/orgDay.ts) -
// refuses the request the client's own `min` had just permitted. The server was moved off UTC deliberately;
// this is the half that was left behind.
//
// SYNCHRONOUS BY DESIGN. The call sites are module-level helpers and default values inside render, so they
// cannot await and cannot be hooks. The timezone is therefore cached in a module variable, hydrated once at
// bootstrap, with the same default the server falls back to. A render before hydration is correct for any org
// on that default and self-corrects on the next render for the rest, which is the right trade for not turning
// every date default in the app into an async read.
//
// FREE TO HYDRATE. `settings/attendance` is one key of the settings SNAPSHOT the SPA already loads once
// (lib/settingsStore.ts), so this adds no request.
import { DEFAULT_SCHEDULE, localDay, weekdayOf } from "./attendance";
import { readSetting } from "./settingsStore";

let orgTz: string = DEFAULT_SCHEDULE.timezone;
let hydrating: Promise<void> | null = null;

/** The org's IANA timezone as currently known. Never empty. */
export const orgTimezone = (): string => orgTz;

/**
 * Adopt a timezone already read from `settings/attendance` elsewhere (the clock provider holds one), so the
 * two cannot disagree and neither pays for the other's read. Ignores an empty value rather than clearing the
 * default: "not configured" means the default, not "no timezone".
 */
export function setOrgTimezone(tz: string | undefined | null): void {
  if (tz) orgTz = tz;
}

/**
 * Read the org timezone into this module. Idempotent and memoized - call it wherever, it runs once.
 *
 * Never rejects: an org that has not configured attendance, or a settings read that fails, keeps the default,
 * which is exactly what the server does with the same key.
 */
export function hydrateOrgTimezone(): Promise<void> {
  hydrating ??= readSetting<{ timezone?: string }>("attendance")
    .then((cfg) => setOrgTimezone(cfg?.timezone))
    .catch(() => { /* not configured, or the snapshot failed: the default stands */ });
  return hydrating;
}

/** Today, as "YYYY-MM-DD", in the ORG's timezone. The one `todayStr` for the whole SPA. */
export const todayStr = (): string => localDay(new Date().toISOString(), orgTz);

/** The org-local calendar day of an instant, as "YYYY-MM-DD". */
export const orgDayOf = (at: Date | number | string): string =>
  localDay(typeof at === "string" ? at : new Date(at).toISOString(), orgTz);

/** The org-local day `offsetDays` from today. Negative looks back. */
export const orgDayFromToday = (offsetDays: number): string =>
  localDay(new Date(Date.now() + offsetDays * 86_400_000).toISOString(), orgTz);

/** The current org-local month, as "YYYY-MM". */
export const thisMonthStr = (): string => todayStr().slice(0, 7);

/** The current org-local year, as "YYYY". */
export const thisYearStr = (): string => todayStr().slice(0, 4);

// ---- Calendar arithmetic on "YYYY-MM-DD" ------------------------------------------------------------------
//
// Everything below takes a day and returns a day. There is no timezone in any of it, and that is the point: a
// calendar day already names itself, so stepping from one to the next is arithmetic on the label, not on an
// instant. Anchoring at UTC midnight is how a date-only value is stored across the schema (the `dayMs` helper
// repeated through the services, and src/services/orgDay.ts#dayStartMs), so these agree with the server by
// construction.
//
// WHAT THEY REPLACE, and why each page-local copy was wrong. The pages each grew a pair of helpers that mixed
// the two clocks: build a Date from LOCAL parts (or from `new Date()`), then serialize it with
// `toISOString()`, which is UTC. Those disagree by a day for the part of every day the local offset covers -
// the whole IST morning up to 05:30 - so `addDays(start, 13)` returned start+12, a "Today" preset wrote
// yesterday's date, and a week grid started on Sunday. The other shape - staying in local Date objects and
// stepping by `+ 86_400_000` - reads correctly until a DST boundary lands inside the step, and then the hour
// it shifts by drags the calendar day with it.
//
// Neither failure is reachable here: a day string never carries an offset to lose, and a UTC day is exactly
// 86,400,000 ms with no DST to cross.

/** The calendar day `n` days from `ymd` ("YYYY-MM-DD" in, "YYYY-MM-DD" out). Negative looks back. */
export const addDaysYmd = (ymd: string, n: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The weekday `ymd` falls on, 0 = Sunday, read off the date itself rather than off any clock.
 *  Re-exported from lib/attendance, which already owned it - two identical copies of a calendar rule is one
 *  copy too many, whichever of them a caller happens to reach for. */
export { weekdayOf };

/** The Monday of the week `ymd` falls in. Weeks run Mon-Sun throughout the app. */
export const weekStartYmd = (ymd: string): string => addDaysYmd(ymd, -((weekdayOf(ymd) + 6) % 7));

/** Whole days from `from` to `to`, `to` exclusive of neither end - i.e. the signed difference in days. */
export const daysBetweenYmd = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
