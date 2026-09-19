// Derived columns every list page keeps re-inventing: an age in days beside a date, and a period label a
// date can be GROUPED by.
//
// WHY THESE TWO. A date column can be filtered by calendar window but not compared by size - "unseen for
// more than 90 days" is not a window, it is a number - and it deliberately cannot be grouped, because a day
// folds a table into a heap of one-row groups (docs/07-table-interactions.md). So every page that wants
// either question has to carry a second, derived column. Six pages had written some of this inline and no
// two agreed on the rounding or on what a missing date meant.
//
// Everything here reads the ORG's today (lib/orgDay.ts), never the browser's.
import { daysBetweenYmd, todayStr, weekdayOf } from "./orgDay";

/** The `YYYY-MM-DD` inside a date or timestamp field, or "" when there is nothing there. */
export const ymd = (v: string | null | undefined): string => (v ? String(v).slice(0, 10) : "");

/**
 * Whole days since `v`, counting forward to the org's today. Negative for a date in the future, and `null`
 * when there is no date - which is what keeps a blank out of a `filter: "number"` comparison instead of
 * letting it read as day zero, the oldest or the newest depending on the sort.
 */
export function daysSince(v: string | null | undefined): number | null {
  const day = ymd(v);
  return day ? daysBetweenYmd(day, todayStr()) : null;
}

/** Whole days from the org's today until `v`. Negative once it is past. `null` when there is no date. */
export function daysUntil(v: string | null | undefined): number | null {
  const day = ymd(v);
  return day ? daysBetweenYmd(todayStr(), day) : null;
}

/** `${n} days`, the wording every `formatTotal` on a day column uses, with "day" singular where it belongs. */
export const fmtDaysCount = (n: number): string => `${Math.round(n)} day${Math.round(n) === 1 ? "" : "s"}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The month a date falls in, as `YYYY-MM`.
 *
 * Deliberately the ISO key and not "Mar 2026": a group's fold order is its value's order, and month NAMES
 * fold alphabetically, so a table grouped by month would run April, August, December. The cell renders
 * `monthLabel` for reading; the group header shows the key, which is unambiguous and in the right order.
 */
export const monthKey = (v: string | null | undefined): string => ymd(v).slice(0, 7);

/** `2026-03` as "Mar 2026", for the cell of a `monthKey` column. */
export const monthLabel = (key: string): string => {
  if (!/^\d{4}-\d{2}$/.test(key)) return key;
  return `${MONTHS[Number(key.slice(5, 7)) - 1] ?? ""} ${key.slice(0, 4)}`;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The weekday a date falls on, spelled out. A select filter over seven values; not worth grouping by. */
export const weekdayName = (v: string | null | undefined): string => {
  const day = ymd(v);
  return day ? WEEKDAYS[weekdayOf(day)] ?? "" : "";
};

/** True when the date lands on a Saturday or Sunday. The question behind most weekday columns. */
export const isWeekend = (v: string | null | undefined): boolean => {
  const day = ymd(v);
  if (!day) return false;
  const w = weekdayOf(day);
  return w === 0 || w === 6;
};

/** "Weekend" / "Weekday", groupable, for the pages where falling on a weekend is the whole point. */
export const weekendLabel = (v: string | null | undefined): string => (ymd(v) ? (isWeekend(v) ? "Weekend" : "Weekday") : "");
