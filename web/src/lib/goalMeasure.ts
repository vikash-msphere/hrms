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

/**
 * What a set of goals adds up to, as a percentage - the client's mirror of the review score.
 *
 * Mirrors `goalAttainment` in src/domain/performance.ts, and mirrors it because the Goals page states the same
 * number in three places (a person's own scoreboard, each report's roll-up in the team band, an objective's
 * figure in the drawer) and a page that disagrees with the review is a page nobody can plan against.
 *
 * WHAT THIS REPLACED, and why it mattered. Every one of those sites weighted by `(g.weight || 1)` - reading an
 * unweighted goal as weight 1 - while the server read it as weight 0. `goals.weight` defaults to 0, so the two
 * disagreed on the ordinary case, and they disagreed WORST where it counts: a person with five untouched goals
 * and one weighted goal at 100% saw a sensible ~17% on this page and was scored 100% in their review, off the
 * same rows. One rule, in one place, pinned by test/goalRollupDrift.test.ts.
 *
 * The rule: weight only when EVERY goal carries a weight, otherwise the plain mean, so no goal is ever left
 * out of the number. Caller decides which goals are in the set (cancelled ones are the server's business to
 * drop, and the pages filter to open goals for their own reasons).
 */
export function weightedProgress(goals: { weight?: number | null; progress?: number | null }[]): number {
  if (!goals.length) return 0;
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const weightOf = (g: { weight?: number | null }) => Math.max(0, g.weight || 0);
  if (goals.every((g) => weightOf(g) > 0)) {
    const total = goals.reduce((s, g) => s + weightOf(g), 0);
    return Math.round(goals.reduce((s, g) => s + weightOf(g) * clamp(g.progress ?? 0), 0) / total);
  }
  return Math.round(goals.reduce((s, g) => s + clamp(g.progress ?? 0), 0) / goals.length);
}

/** A number the reader typed, or undefined when they typed nothing. "0" is a real value and must survive. */
export const numOrNone = (s: string): number | undefined => (s.trim() === "" || Number.isNaN(Number(s)) ? undefined : Number(s));

/**
 * The measure as a person would say it: "42 of 60 customers". Null when the goal has no measure.
 *
 * Takes the three fields rather than a whole `Goal`, so it also reads the narrower snapshot a review froze.
 */
export const measureLabel = (g: Pick<Goal, "target_value" | "current_value" | "unit">) =>
  g.target_value == null ? null : `${g.current_value ?? 0} of ${g.target_value}${g.unit ? ` ${g.unit}` : ""}`;
