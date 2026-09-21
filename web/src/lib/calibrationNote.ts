// The distribution of a cycle's ratings, said in a sentence. Assembled from the numbers, not written by a
// model.
//
// WHY A TEMPLATE AND NOT A GENERATION. `reviews` is on NEVER_TO_MODEL (src/domain/aiPolicy.ts), and while a
// distribution is counts rather than text, a narration derived from review rows would need its own named
// exception with a written basis - a decision for whoever is accountable for the data, not something to
// slide in behind a feature flag. The sentence a template produces here is the same sentence: the facts are
// arithmetic, and the model's only job would have been the grammar.
//
// WHAT IT SAYS AND WHAT IT REFUSES TO SAY. It names COHORTS and COUNTS: where the mass of the distribution
// sits against the middle of the scale, which band is commonest, and which department's mean sits furthest
// from the rest. It never names a person, never suggests moving anybody's rating, and never calls a
// distribution right or wrong - a cohort rated higher than another is a thing to discuss in the meeting this
// sentence is read in, not a verdict this app is entitled to.

export type RatingRow = { rating: number; departmentId: string };

export type CalibrationNote = {
  /** The sentence, or an empty string when there is nothing honest to say. */
  text: string;
  /** The facts behind it, so a reader can check rather than trust. */
  facts: string[];
};

/** Below this many rated reviews a distribution is a handful of opinions, and a sentence about its shape
 *  would be inventing a pattern. */
export const MIN_RATED = 5;

/** A department needs at least this many rated reviews before it is named as a cohort: three people is not a
 *  cohort, and naming one that small comes close to naming the people in it. */
export const MIN_COHORT = 4;

/** How far a cohort's mean must sit from the rest before it is worth a clause, in rating points. */
const MIN_GAP = 0.4;

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * What this cycle's ratings look like.
 *
 * `scale` is the org's own rating scale, in order, so "the middle of the scale" is its middle rather than a
 * number this file assumed.
 */
export function calibrationNote(
  rows: RatingRow[],
  scale: { value: number; label: string }[],
  departmentName: (id: string) => string,
): CalibrationNote {
  const facts: string[] = [];
  if (rows.length < MIN_RATED || scale.length === 0) return { text: "", facts };

  const values = rows.map((r) => r.rating);
  const avg = round1(mean(values));
  const mid = round1((Math.min(...scale.map((s) => s.value)) + Math.max(...scale.map((s) => s.value))) / 2);
  facts.push(`${rows.length} rated, mean ${avg}, scale midpoint ${mid}`);

  // The commonest band, and how much of the cycle sits in it. A distribution where two thirds of people
  // share one rating is the thing a calibration meeting exists to look at.
  const counts = scale.map((s) => ({ ...s, count: values.filter((v) => v === s.value).length }));
  const top = [...counts].sort((a, b) => b.count - a.count)[0]!;
  const share = Math.round((top.count / rows.length) * 100);
  facts.push(`${top.count} of ${rows.length} at "${top.label}"`);

  const parts: string[] = [];
  const gap = round1(avg - mid);
  parts.push(Math.abs(gap) < 0.2
    ? `${rows.length} ratings sit around the middle of the scale`
    : `${rows.length} ratings average ${avg}, ${Math.abs(gap)} ${gap > 0 ? "above" : "below"} the middle of the scale`);
  if (share >= 50) parts.push(`${share}% of them at "${top.label}"`);

  // The cohort furthest from everybody else, when there is one big enough to name. Stated as a comparison of
  // two means, with no suggestion about what to do about it.
  const byDept = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.departmentId) continue;
    (byDept.get(r.departmentId) ?? byDept.set(r.departmentId, []).get(r.departmentId)!).push(r.rating);
  }
  let outlier: { id: string; gap: number; mean: number; rest: number; n: number } | null = null;
  for (const [id, vals] of byDept) {
    if (vals.length < MIN_COHORT) continue;
    const rest = rows.filter((r) => r.departmentId !== id).map((r) => r.rating);
    if (rest.length < MIN_COHORT) continue;
    const diff = mean(vals) - mean(rest);
    if (Math.abs(diff) < MIN_GAP) continue;
    if (!outlier || Math.abs(diff) > Math.abs(outlier.gap)) {
      outlier = { id, gap: round1(diff), mean: round1(mean(vals)), rest: round1(mean(rest)), n: vals.length };
    }
  }
  if (outlier) {
    const name = departmentName(outlier.id) || "one department";
    parts.push(`${name} averages ${outlier.mean} against ${outlier.rest} everywhere else, over ${outlier.n} ratings`);
    facts.push(`${name}: mean ${outlier.mean} vs ${outlier.rest} (n=${outlier.n})`);
  }

  return { text: `${parts.join("; ")}.`, facts };
}
