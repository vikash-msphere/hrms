import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { dateFormat, numberFormat } from "./intl";
import { daysBetweenYmd, todayStr } from "./orgDay";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Extract the trailing id from an AEP `path` like "employees/abc123" → "abc123". */
export function idOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The name of the person a resource ref points at, given whatever slice of the directory the caller can read.
 *
 * The FALLBACK is the point of this helper. Every page that shows "whose request is this" reads `employees`
 * under its own access, so a ref to somebody outside that slice resolves to nothing - an ordinary employee
 * cannot read their own manager's row, for one. Six pages each open-coded this and each fell back to the raw
 * internal id, which put a 26-character uuid on screen in place of a name ("Goes to 5q5an4xdav8t… for
 * approval"): meaningless to the reader, and an internal identifier leaked into the UI.
 *
 * So an unresolvable ref reads as `unknown` - which callers set to whatever their sentence needs ("your
 * manager", "-") - and an absent ref is empty, because there is no person to name at all.
 *
 * TAKES A PREPARED MAP TOO, and six pages hand it one. This is used as a DataTable column accessor, and an
 * accessor is called per row per compare during a sort and again for every value in a `filter: "select"`
 * popover - so a linear `find` over an `{ all: true }` employees read (ALL_CAP is 1000) turned sorting a
 * hundred-row table in a 500-person org into hundreds of thousands of scanned entries. `personIndex` builds
 * the lookup once, in a `useMemo`, the way `RequestLeaveDialog` and `Expenses` already did by hand.
 */
export type PersonRef = { path: string; first_name?: string | null; last_name?: string | null };
export type PersonIndex = Map<string, PersonRef>;

/** The lookup `personName` prefers: build it once per directory read, not once per accessor call. */
export function personIndex(people: PersonRef[]): PersonIndex {
  return new Map(people.map((p) => [idOf(p.path), p]));
}

export function personName(people: PersonRef[] | PersonIndex, ref?: string | null, unknown = "Someone"): string {
  if (!ref) return "";
  const id = idOf(ref);
  const person = people instanceof Map ? people.get(id) : people.find((p) => idOf(p.path) === id);
  if (!person) return unknown;
  return [person.first_name, person.last_name].filter(Boolean).join(" ") || unknown;
}

/**
 * Everyone who reports to `subjectId`, directly or through someone else.
 *
 * WHAT IT IS FOR: a manager picker must not offer somebody's own report as their manager, because that closes
 * the reporting line into a loop. `services/employees.ts#assertNoManagerCycle` refuses the write, and that is
 * the check that actually holds - this one exists so the UI stops offering a move the server will refuse, which
 * is a better answer than a red toast after the fact.
 *
 * BEST EFFORT, deliberately. It sees only the rows the caller has loaded (pages read `employees` with
 * `{ all: true }`, whose `ALL_CAP` is 1000), so past that the tree is partial and a descendant can be missed.
 * That is why the authority is the server: this narrows the list, it does not decide anything.
 *
 * Walked breadth-first from a parent→children index rather than by re-scanning the array per level, and the
 * visited set doubles as the cycle guard - existing data may already hold a loop the guard above now refuses.
 */
export function reportsUnder(
  people: { path: string; manager?: string | null }[],
  subjectId: string | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!subjectId) return out;
  const byManager = new Map<string, string[]>();
  for (const p of people) {
    if (!p.manager) continue;
    const mgr = idOf(p.manager);
    (byManager.get(mgr) ?? byManager.set(mgr, []).get(mgr)!).push(idOf(p.path));
  }
  const queue = [subjectId];
  while (queue.length) {
    for (const child of byManager.get(queue.shift()!) ?? []) {
      if (out.has(child) || child === subjectId) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** Title-case a SCREAMING_SNAKE or kebab/snake token for display. */
export function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const INITIALS_RE = /\b(\w)/g;
export function initials(name: string): string {
  const matches = name.match(INITIALS_RE);
  if (!matches) return "?";
  return matches.slice(0, 2).join("").toUpperCase();
}

// `dateFormat(...).format(d)` rather than `d.toLocaleDateString(...)`: the two produce identical output for
// the same options, but the method builds a formatter per call. This is the most-called formatter in the app
// (207 call sites), and a table re-renders all of them on every keystroke in a column filter.
const DATE_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
// Pinned, not the viewer's locale. The SERVER renders the same dates day-first ("4 Aug 2026" - see
// domain/activityLabel.ts and the PDF engines), and those strings arrive already formatted: with the browser
// left to its own locale, a US-configured reader saw "Aug 4, 2026" in the table and "4 Aug 2026" in the
// letter, activity line and payslip beside it. One organization reads one date format.
const DATE_LOCALE = "en-GB";
// A DATE-ONLY value is a calendar day, not an instant. `new Date("2026-12-25")` is UTC midnight by spec, so
// formatting it in the viewer's zone renders the day before for everyone west of UTC - "Fri, 24 Dec 2026" for a
// holiday stored as 2026-12-25, beside a weekday label that pins UTC and disagrees with it. Parse and format
// date-only values both in UTC so the calendar day survives; a full timestamp is a real instant and keeps the
// viewer's zone, which is the right one for it.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OPTS_UTC: Intl.DateTimeFormatOptions = { ...DATE_OPTS, timeZone: "UTC" };

export function formatDate(value?: string | null): string {
  if (!value) return "-";
  const dateOnly = DATE_ONLY_RE.test(value);
  const d = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (isNaN(d.getTime())) return value;
  return dateFormat(DATE_LOCALE, dateOnly ? DATE_OPTS_UTC : DATE_OPTS).format(d);
}

/** A file size a person can read: "812 B", "44 KB", "2.1 MB". Null for nothing/zero, so callers can skip it. */
export function formatBytes(n?: number): string | null {
  if (!n) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Compact phrase for a moment still to come: "in 20m", "in 3h", "in 5d", then "on 4 Aug 2026". */
export function relativeFuture(iso: string): string {
  const min = Math.round((+new Date(iso) - Date.now()) / 60000);
  if (min < 1) return "any moment";
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `in ${day}d`;
  return `on ${formatDate(iso)}`;
}

// Same pinned locale and cached-formatter rule as `formatDate`: "One organization reads one date format", and a
// per-call `toLocaleDateString` both builds a formatter every time and follows the VIEWER's locale, which put
// "Mar 2023" on the profile header beside "4 Aug 2026" everywhere else.
const MONTH_YEAR_OPTS: Intl.DateTimeFormatOptions = { month: "short", year: "numeric", timeZone: "UTC" };

/** "Mar 2023" - the joining month, for a labelled "Joined" cell that supplies its own caption. */
export function formatMonthYear(date: string): string {
  const d = new Date(DATE_ONLY_RE.test(date) ? `${date}T00:00:00Z` : date);
  return isNaN(+d) ? "" : dateFormat(DATE_LOCALE, MONTH_YEAR_OPTS).format(d);
}

/** "2y 4m" / "7 months" / "new joiner" - how long they have been here, without the date. */
export function tenureDuration(startDate: string): string {
  const start = new Date(DATE_ONLY_RE.test(startDate) ? `${startDate}T00:00:00Z` : startDate);
  if (isNaN(+start)) return "";
  // Months between two CALENDAR days on the org's clock: `new Date()`'s UTC month is a different month from
  // the org's for part of every month boundary, which slipped the tenure by a month on those days.
  const today = todayStr();
  const months = Math.max(
    0,
    (Number(today.slice(0, 4)) - start.getUTCFullYear()) * 12 + (Number(today.slice(5, 7)) - 1) - start.getUTCMonth(),
  );
  if (months < 1) return "new joiner";
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years}y ${rest}m` : `${years}y`;
}

/** "Joined Mar 2023 · 2y 4m" - tenure as one line, where there is no label to carry the "Joined". */
export function tenureLabel(startDate: string): string {
  const joined = formatMonthYear(startDate);
  return joined ? `Joined ${joined} · ${tenureDuration(startDate)}` : "";
}

/** "On probation · 12d left" (or "· ends today") for an end date that's today or later; "" once past. */
export function probationLabel(endDate: string): string {
  // A calendar-day difference on the ORG's clock, not an instant one. `Date.parse` on a date-only string is
  // UTC midnight, and comparing that against `Date.now()` made this label a day out for the first 5.5 hours of
  // the last day of probation in an IST org ("1d left" on the day it ends) and again for the first 5.5 hours
  // of the day after ("ends today" about a probation that ended yesterday).
  if (!DATE_ONLY_RE.test(endDate.slice(0, 10))) return "";
  const days = daysBetweenYmd(todayStr(), endDate.slice(0, 10));
  if (!Number.isFinite(days) || days < 0) return "";
  return days === 0 ? "On probation · ends today" : `On probation · ${days}d left`;
}

// Rounding to 2 decimal places (paise) is the SERVER's function, re-exported - not a browser copy of it.
//
// `src/domain/money.ts` states the rule ("rounding behaviour is defined in exactly one place") and the module
// is dependency-free, so the SPA imports it the way it already imports domain/leave.ts, domain/attendance.ts
// and domain/payroll.ts. It was a body-identical re-implementation here, and it had already drifted twice -
// the tie rule (the server's is symmetric about zero, the copy broke ties toward +infinity, so a negative
// preview and the figure the run wrote differed by a paise) and the upper-range guard (`${1e21}e2` parses as
// NaN, so the copy answered NaN where the server answered the number). The canonical one was in the bundle
// the whole time: EmployeeCompensation.tsx imports src/domain/payroll, which imports ./money - so the page
// doing the CTC arithmetic held both copies at once.
//
// Re-exported under this name because every mirrored money computation in the UI (the CTC breakdown, the
// top-down split preview) already reaches for `round2` from here.
export { round2 } from "../../../src/domain/money";

// Format an amount in a currency. `decimals` sets the shown precision (both min and max fraction digits) so
// the currency's configured minor-unit count is honoured everywhere - e.g. INR at 0 renders ₹1,800, not
// ₹1,800.00. Omit `decimals` to fall back to the currency's Intl default. Money is stored full-precision;
// this only controls DISPLAY, so the value is rounded to `decimals` places here.
export function formatMoney(value: number, currency = "INR", decimals?: number): string {
  const dp = decimals == null ? undefined : Math.min(4, Math.max(0, Math.trunc(decimals)));
  try {
    // The catch still guards CONSTRUCTION: an unrecognised currency code throws inside `numberFormat`, and a
    // failed construction is never cached, so a bad code falls through to `toFixed` on every call as before.
    return numberFormat(undefined, {
      style: "currency",
      currency,
      ...(dp == null ? {} : { minimumFractionDigits: dp, maximumFractionDigits: dp }),
    }).format(value);
  } catch {
    return value.toFixed(dp ?? 2);
  }
}

/** Deterministic pastel-ish accent color from a string, for avatars. `alpha` (0-1) returns the SAME
 *  hue translucent, for tints drawn from a person's colour (the profile header's avatar ring). */
export function colorFromString(input: string, alpha?: number): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = input.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return alpha === undefined ? `hsl(${hue} 65% 45%)` : `hsl(${hue} 65% 45% / ${alpha})`;
}
