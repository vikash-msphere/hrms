import type { Goal } from "@/types";

// A goal's measure, on the client.
//
// The form previews what a measure will do before it is saved ("saving this puts you at 70%, which completes
// the goal"), so the percentage has to be computed here as well as on the server. That is a mirror, and mirrors
// drift - so it lives in one module of its own and is pinned to the server's version by
// test/goalMeasureDrift.test.ts rather than being inlined in the page.

/**
 * Percent complete from a measure, or null when there is no measure to compute from.
 *
 * Mirrors `measuredProgress` in src/services/goals.ts. The baseline is the part worth getting right: plenty of
 * goals start above zero (churn 8% to 4%, uptime 99.0 to 99.9), and measuring from zero would report those as
 * nearly done on the day they start. A target below the baseline counts down.
 */
export function measuredPct(baseline: number | undefined, target: number | undefined, current: number | undefined): number | null {
  if (target == null || current == null) return null;
  const from = baseline ?? 0;
  const span = target - from;
  if (span === 0) return null;
  return Math.max(0, Math.min(100, Math.round(((current - from) / span) * 100)));
}

/** A number the reader typed, or undefined when they typed nothing. "0" is a real value and must survive. */
export const numOrNone = (s: string): number | undefined => (s.trim() === "" || Number.isNaN(Number(s)) ? undefined : Number(s));

/** The measure as a person would say it: "42 of 60 customers". Null when the goal has no measure. */
export const measureLabel = (g: Goal) =>
  g.target_value == null ? null : `${g.current_value ?? 0} of ${g.target_value}${g.unit ? ` ${g.unit}` : ""}`;
