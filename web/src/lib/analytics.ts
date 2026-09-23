import { fmtDurationShort, fmtMinOfDay } from "@/lib/attendance";

// The people report as the server sends it (GET /v1/people-analytics). The server owns the measure catalogue -
// labels, units, which way is good, how each rolls up - so the table renders whatever it is handed instead of
// keeping a second copy of the list that would drift the day a measure is added.

export type MetricUnit = "count" | "days" | "hours" | "minutes" | "percent" | "rating" | "time_of_day" | "money";

export type MetricDef = {
  key: string;
  label: string;
  short: string;
  group: string;
  collection: string;
  needs?: string[];
  unit: MetricUnit;
  agg: "sum" | "avg";
  direction: "higher" | "lower" | "none";
  hint: string;
};

export type PersonRow = {
  employee: string;
  name: string;
  employee_number?: string | null;
  job_title?: string | null;
  department?: string | null;
  manager?: string | null;
  values: Record<string, number | null>;
};

/** One day of one person's attendance - the calendar heatmap's unit. Only ever returned for a named employee
 *  (`?employee=…&series=true`), because a series per head is a far dearer question than a table of totals. */
export type AttendanceSeriesDay = { day: string; worked_minutes: number; late: boolean };

export type AnalyticsResponse = {
  window: { from: string; to: string; timezone: string; working_days: number };
  groups: { key: string; label: string }[];
  metrics: MetricDef[];
  people: PersonRow[];
  team: Record<string, number | null>;
  truncated: boolean;
  series?: AttendanceSeriesDay[];
};

/** The overview tab: one measure per dimension, the ones a manager scans first. Anything the caller may not
 *  see is simply missing from the response, so the tab narrows itself. */
export const HIGHLIGHT_METRICS = [
  "punctuality_pct",
  "days_absent",
  "leave_days_taken",
  "remote_share_pct",
  "tasks_delivered",
  "avg_goal_progress",
  "hours_logged",
  "latest_rating",
];

/**
 * A measure's number as text. One formatter for every column, driven by the unit the server declared.
 *
 * `money` is the one unit this cannot format alone: the symbol and the decimal places are the ORG's
 * (lib/org.ts), and a currency-free number beside a count of people reads as a count of people.
 *
 * REQUIRED, not optional, and that was a correction. Optional, a caller that forgot rendered money as a bare
 * number and nothing said so - which is precisely the fail-open shape this codebase argues against everywhere
 * else (`NEVER_TO_MODEL` denying by default, a team-only measure flag defaulting to team-only). Required, a
 * caller that forgets does not compile. The cost is one argument at four call sites; the alternative was a
 * silent wrong render that shipped once already.
 */
export function formatMetric(value: number | null | undefined, unit: MetricUnit, money: (n: number) => string): string {
  if (value == null) return "-";
  switch (unit) {
    case "money":
      return money(value);
    case "percent":
      return `${Math.round(value)}%`;
    case "hours":
      return `${Math.round(value * 10) / 10}h`;
    case "minutes":
      return value >= 60 ? fmtDurationShort(Math.round(value)) : `${Math.round(value)}m`;
    case "time_of_day":
      return fmtMinOfDay(value);
    case "rating":
      return (Math.round(value * 10) / 10).toFixed(1);
    case "days":
      return String(Math.round(value * 10) / 10);
    default:
      return String(Math.round(value * 10) / 10);
  }
}

/**
 * How a person's number reads against the team line: better, worse, or unremarkable. Relative rather than a
 * threshold table, because "three days of leave" is high in one team and low in another - and because a fixed
 * threshold per measure is a policy judgement this report has no business inventing. A quarter either side of
 * the team line is unremarkable; a measure with no good direction is never tinted at all.
 */
export function toneFor(value: number | null | undefined, team: number | null | undefined, direction: MetricDef["direction"]): "good" | "bad" | null {
  if (direction === "none" || value == null || team == null) return null;
  if (team === 0) return value === 0 ? null : direction === "lower" ? "bad" : "good";
  const ratio = value / team;
  if (ratio > 0.75 && ratio < 1.25) return null;
  const above = ratio >= 1.25;
  return above === (direction === "higher") ? "good" : "bad";
}

export const TONE_CLASS: Record<"good" | "bad", string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  bad: "text-rose-600 dark:text-rose-400",
};

// ---- The window ----------------------------------------------------------------------------------------
// Presets rather than two date boxes: nearly every ask is "this month" or "last month", and a report that
// makes you type two dates before it shows anything is a report nobody runs. The custom pair stays for the
// rest. The server caps the window at 92 days, so no preset asks for more.

export type RangeKey = "this_month" | "last_month" | "last_30" | "this_quarter" | "custom";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function rangeFor(key: RangeKey, today = new Date()): { from: string; to: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (key) {
    case "last_month": {
      const start = new Date(Date.UTC(y, m - 1, 1));
      return { from: iso(start), to: iso(new Date(Date.UTC(y, m, 0))) };
    }
    case "last_30":
      return { from: iso(new Date(today.getTime() - 29 * 86_400_000)), to: iso(today) };
    case "this_quarter": {
      // Clamped to the 92-day cap: a quarter that has only just begun is short, and a long one starts at the
      // 92nd day back rather than being refused outright.
      const qStart = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1));
      const earliest = new Date(today.getTime() - 91 * 86_400_000);
      return { from: iso(qStart > earliest ? qStart : earliest), to: iso(today) };
    }
    case "this_month":
    default:
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today) };
  }
}

export const RANGE_LABELS: { key: RangeKey; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_30", label: "Last 30 days" },
  { key: "this_quarter", label: "This quarter" },
  { key: "custom", label: "Custom" },
];
