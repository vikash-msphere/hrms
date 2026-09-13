// Indian financial year (Apr-Mar), formatted "YYYY-YY" - the label Form 16, tax declarations and the payroll
// year all key off.
//
// THE ORG'S CALENDAR, not the browser's. This read `d.getMonth()`/`d.getFullYear()`, which is the VIEWER's
// local calendar - right about UTC being wrong, wrong about whose local calendar settles it. Around the
// 31 March / 1 April boundary a viewer whose local date differs from the org's got the wrong year as the
// default for Form 16 and tax declarations, and the wrong answer to "is this year still running". lib/orgDay.ts
// exists precisely to end that class of bug and every other date default in the SPA goes through it; this is
// the one that did not.
import { todayStr } from "./orgDay";

/** FY label ("2025-26") for a day, defaulting to the org's today. `d` is "YYYY-MM-DD". */
export function currentFy(d: string = todayStr()): string {
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7)); // 1-12
  const start = month >= 4 ? year : year - 1;
  return fyLabel(start);
}

/** FY label for a starting calendar year (2025 -> "2025-26"). */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The current FY first, then `back` earlier ones - a picker beats a free-text year nobody can format right. */
export function fyOptions(back = 4, from: string = todayStr()): string[] {
  const start = Number(currentFy(from).slice(0, 4));
  return Array.from({ length: back + 1 }, (_, i) => fyLabel(start - i));
}

/**
 * Whether `s` is an FY label ("2025-26") rather than a month key ("2026-09").
 *
 * The shape alone cannot tell them apart - `/^\d{4}-\d{2}$/` matches both, and `YYYY-MM` is the month key used
 * throughout the app (`monthOf`, `thisMonthStr`, `periodKeyOf`) - so the second pair has to be checked against
 * the first: an FY label's tail is its start year plus one, modulo a century.
 */
export const isFyLabel = (s: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) return false;
  return Number(m[2]) === (Number(m[1]) + 1) % 100;
};

/** "1 Apr 2025 to 31 Mar 2026" - spells out what a bare FY label covers. */
export function fySpan(fy: string): string {
  const start = Number(fy.slice(0, 4));
  if (!Number.isFinite(start)) return "";
  return `1 Apr ${start} to 31 Mar ${start + 1}`;
}
