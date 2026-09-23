// The org's performance-review framework, mirrored on the web (the bundle can't import from src/). Reviews
// render their competency ratings + scale from this; HR overrides it via settings/performance. Defaults match
// src/domain/performance.ts.
export type Competency = {
  key: string;
  label: string;
  /** The behavioural anchor: what this competency means here, shown to whoever is rating it. */
  description?: string;
  /** Relative importance, on any scale. Absent means it counts like the others (see `competencyScore`). */
  weight?: number;
};
export type RatingLevel = { value: number; label: string };
export type PerformanceFramework = { competencies: Competency[]; scale: RatingLevel[] };

export const DEFAULT_PERFORMANCE: PerformanceFramework = {
  competencies: [
    { key: "impact", label: "Impact & results" },
    { key: "ownership", label: "Ownership & reliability" },
    { key: "collaboration", label: "Collaboration & teamwork" },
    { key: "communication", label: "Communication" },
    { key: "growth", label: "Growth & learning" },
  ],
  scale: [
    { value: 1, label: "Below expectations" },
    { value: 2, label: "Partially meets" },
    { value: 3, label: "Meets expectations" },
    { value: 4, label: "Exceeds" },
    { value: 5, label: "Outstanding" },
  ],
};

// The label for a rating value on the given scale (falls back to the bare number).
export const ratingLabel = (scale: RatingLevel[], value?: number) =>
  value == null ? "" : scale.find((s) => s.value === value)?.label ?? String(value);

/**
 * The competencies one cycle rates: the framework, narrowed to the cycle's own selection.
 *
 * Mirrors `competenciesForCycle` in src/domain/performance.ts, which is what the review's competency score
 * and the PDF use. Order comes from the framework so two cycles present shared competencies the same way
 * round, and a selection matching nothing live falls back to the whole framework - a review form with no
 * questions on it is a broken review.
 */
export function competenciesForCycle<T extends { key: string }>(competencies: T[], keys?: string[] | null): T[] {
  if (!keys?.length) return competencies;
  const want = new Set(keys);
  const narrowed = competencies.filter((c) => want.has(c.key));
  return narrowed.length ? narrowed : competencies;
}

/**
 * What a set of competency ratings adds up to, on the framework's weights. Mirrors `competencyScore` in
 * src/domain/performance.ts, which is what the review resource and the PDF carry.
 *
 * The client needs its own copy for one reason: a manager rating a review has not saved anything yet, and
 * the number is most useful while they are still choosing the overall rating. Unrated competencies are left
 * out rather than counted zero; with no weights anywhere it is the plain mean.
 */
export function competencyScore(competencies: Competency[], ratings: Record<string, number | undefined>): { score: number; weighted: boolean; counted: number } | null {
  const rated = competencies.filter((c) => typeof ratings[c.key] === "number" && Number.isFinite(ratings[c.key]));
  if (!rated.length) return null;
  const weightTotal = rated.reduce((s, c) => s + Math.max(0, c.weight || 0), 0);
  const round = (n: number) => Math.round(n * 10) / 10;
  if (weightTotal > 0) {
    const earned = rated.reduce((s, c) => s + Math.max(0, c.weight || 0) * (ratings[c.key] as number), 0);
    return { score: round(earned / weightTotal), weighted: true, counted: rated.length };
  }
  return { score: round(rated.reduce((s, c) => s + (ratings[c.key] as number), 0) / rated.length), weighted: false, counted: rated.length };
}
