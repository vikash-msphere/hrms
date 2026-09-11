// The one categorical palette every chart in the app draws from, and the small amount of arithmetic that
// turns app data into the shapes frappe-charts expects.
//
// The colours are chosen for CATEGORY IDENTITY, not for prettiness: eight hues that stay distinguishable to
// the common colour-vision deficiencies and hold their contrast against both grounds, in a fixed order so a
// series keeps its colour from one chart to the next. The dark set is the same hues lifted for a dark
// ground - never the light set on a dark background, where the deeper blues and greens turn to mud.
//
// Identity is never carried by colour ALONE anywhere in the app: every chart that uses more than one series
// names them in a legend, and every chart carries the same numbers in a screen-reader table (see Chart.tsx).
import { round2 } from "./utils";

export const CHART_SERIES = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
export const CHART_SERIES_DARK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

/** The categorical palette for the resolved theme, repeated if a chart has more series than hues. */
export function chartColors(resolved: "light" | "dark", count = 8): string[] {
  const base = resolved === "dark" ? CHART_SERIES_DARK : CHART_SERIES;
  return Array.from({ length: Math.max(1, count) }, (_, i) => base[i % base.length]!);
}

/** One hue by index - for a chart that wants a specific series colour outside a `colors` array. */
export const chartColor = (resolved: "light" | "dark", i: number) =>
  (resolved === "dark" ? CHART_SERIES_DARK : CHART_SERIES)[i % CHART_SERIES.length]!;

/** The heatmap's five steps, lightest (no activity) to darkest (a full day). Frappe wants exactly five. */
export function heatmapColors(resolved: "light" | "dark"): string[] {
  return resolved === "dark"
    ? ["#26262b", "#123a63", "#1a5591", "#2470c4", "#3987e5"]
    : ["#ebedf0", "#c6dcf7", "#8ebbef", "#569ae4", "#2a78d6"];
}

// ---- Data shaping (pure) ---------------------------------------------------------------------------------
// Kept here rather than in the chart component so it can be unit-tested without a DOM, and so two pages that
// draw the same shape cannot arrive at two different sets of numbers.

/**
 * Stack a cumulative-flow series: each column's band is drawn at the height of ITSELF PLUS everything below
 * it, which is what makes a stacked area readable - a band's thickness is its own count, its top edge is the
 * running total. Frappe has no stacked-area mode of its own, so the stacking is done here and handed over as
 * ordinary line datasets with `areaFill`, drawn back-to-front.
 */
export function stackSeries(series: number[][]): number[][] {
  const out: number[][] = [];
  const running: number[] = [];
  for (const values of series) {
    const stacked = values.map((v, i) => (running[i] = (running[i] ?? 0) + v));
    out.push([...stacked]);
  }
  return out;
}

/**
 * A heatmap's points: `{ "<seconds since epoch>": value }` for every day that has one, which is the shape
 * frappe's calendar heatmap reads. Days with no value are left out (an absent key draws as the empty step),
 * because a zero and "nothing happened" look the same on a calendar and only one of them is a fact.
 */
export function heatmapPoints(byDay: Map<string, number> | Record<string, number>): Record<string, number> {
  const entries = byDay instanceof Map ? [...byDay.entries()] : Object.entries(byDay);
  const out: Record<string, number> = {};
  for (const [ymd, value] of entries) {
    if (!value) continue;
    const ts = Date.parse(`${ymd}T00:00:00Z`);
    if (Number.isNaN(ts)) continue;
    out[String(Math.floor(ts / 1000))] = value;
  }
  return out;
}

/** Percentages of a whole, rounded to whole points, for a funnel or a share bar. A zero total is all zeroes
 *  rather than NaNs - an empty funnel is a legitimate thing to draw. */
export function shareOf(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return values.map(() => 0);
  return values.map((v) => Math.round((v / total) * 100));
}

/**
 * Bucket dated values into months ("2026-06" -> total), oldest first, filling the months in between so a
 * quiet month is a gap in the line rather than a missing step on the axis.
 */
export function monthlyTotals(rows: { date: string; value: number }[], months: number, endYmd: string): { labels: string[]; values: number[] } {
  const end = new Date(`${endYmd.slice(0, 7)}-01T00:00:00Z`);
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const totals = new Map(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const k = r.date.slice(0, 7);
    if (totals.has(k)) totals.set(k, (totals.get(k) ?? 0) + r.value);
  }
  return {
    labels: keys.map((k) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" })),
    values: keys.map((k) => Math.round((totals.get(k) ?? 0) * 100) / 100),
  };
}

/** Group rows by a key and total a number over them, biggest first, with a "Other" bucket past `top`.
 *  A chart with forty slices communicates nothing; the tail is honest as one named slice. */
export function topSlices<T>(rows: T[], keyOf: (row: T) => string, valueOf: (row: T) => number, top = 7): { labels: string[]; values: number[] } {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r) || "Unspecified";
    totals.set(k, (totals.get(k) ?? 0) + valueOf(r));
  }
  const sorted = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, top);
  const tail = sorted.slice(top);
  const labels = head.map(([k]) => k);
  // `round2` (lib/utils), never an inline `Math.round(v * 100) / 100`: these are money totals, and a chart
  // sitting beside the table that lists the same rows must not round a half-case the other way from it.
  const values = head.map(([, v]) => round2(v));
  if (tail.length) {
    labels.push(`Other (${tail.length})`);
    values.push(round2(tail.reduce((s, [, v]) => s + v, 0)));
  }
  return { labels, values };
}
