// The org's performance-review framework (stored in settings/performance; HR edits it). Pure data: the
// competencies each review rates and the scale they're rated on. Reviews store ratings keyed by competency
// `key`; the web renders the form + results from this framework. Loosely validated - unknown keys are inert.
export type Competency = {
  key: string;
  label: string;
  /**
   * The behavioural anchor: what this competency actually means, in the org's own words.
   *
   * A bare label is where rating drift comes from - "Ownership" is read as reliability by one manager and as
   * initiative by the next, and the two ratings then get compared in a calibration meeting as though they
   * measured the same thing. Rendered as help text under the label wherever the competency is rated, and in
   * the review PDF, so the definition travels with the score.
   */
  description?: string;
  /**
   * Relative importance, on any scale the org likes (see `competencyScore`). Optional: a framework that
   * carries none rates every competency equally, which is what every framework written before this did.
   */
  weight?: number;
};
export type RatingLevel = { value: number; label: string };
export type PerformanceFramework = {
  competencies: Competency[];
  scale: RatingLevel[];
  /**
   * Whether a goal has to be AGREED before it counts.
   *
   * `off` (the default) means setting a goal is agreeing it - the shape most orgs run, and the one every goal
   * written before this existed assumes. `required` turns on the goal-setting handshake: an employee's own new
   * goals start as drafts, they submit them, and their manager accepts or sends them back. A manager writing
   * a goal FOR a report still lands it agreed, because the approver is the person typing.
   */
  goal_approval?: "off" | "required";
};

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

// One of the cycle's goals as a review records it. Keyed by the goal's CODE (stable across a purge, and the
// key the manager's per-goal verdict uses); `path` rides along so a client can link back to the live goal.
export type GoalSnapshot = {
  code: string;
  path?: string;
  title: string;
  weight: number;
  progress: number;
  status: "not_started" | "in_progress" | "completed" | "cancelled";
  due_date?: string;
  /** True when the goal's progress is computed from its measure - nobody may set it by hand, here or anywhere. */
  measured?: boolean;
  /** Present only when the goal was NOT agreed - a review scoring a draft should say so on its face. */
  stage?: "DRAFT" | "PROPOSED";
  /**
   * Present when this line is a SHARE of somebody else's goal rather than the reviewee's own. `weight` is
   * already scaled to the share, so attainment needs no special case - but the review says whose goal it was,
   * because "40% of Priya's launch" and "my launch" are not the same sentence at review time.
   */
  contribution?: { share: number; owner?: string };
  /** The owner's closing account of what happened, when they wrote one. */
  retro?: string;
};

// The manager's verdict on one goal: a rating on the org scale, a note, or both.
export type GoalVerdict = { rating?: number; comment?: string };

export type GoalAttainment = {
  /** Weighted percent attained across the cycle's goals, 0-100. */
  score: number;
  /** Sum of the weights that produced it (0 when the goals carry no weights and the mean was used). */
  weight_total: number;
  /** How many goals were counted (cancelled ones never are). */
  counted: number;
  /** False when no goal carried a weight and the plain mean of their progress was used instead. */
  weighted: boolean;
};

/**
 * Weighted goal attainment for a review: what the person actually delivered against what they signed up for.
 *
 * `weight` is a relative importance, so the score is Σ(weight × progress) / Σweight - a 60-weight goal at 50%
 * and a 10-weight goal at 100% is 57%, not the 75% a plain average would claim. Cancelled goals are dropped
 * whole: a goal the org called off is not a goal the person missed, and leaving it in at 0% would punish them
 * for someone else's decision.
 *
 * Not every org fills weights in. `goals.weight` DEFAULTS TO 0 (see the schema), so an unweighted goal is the
 * ordinary case rather than an edge one - which is why the weighted arithmetic is used only when EVERY counted
 * goal carries a weight, and the plain mean of their progress otherwise.
 *
 * WHY IT IS ALL-OR-NOTHING. The test used to be Σweight > 0, and a MIXED set is what that gets wrong: a
 * weight-0 goal adds nothing to the numerator and nothing to the denominator, so it is not scored at 0 - it
 * disappears from the score entirely. Five untouched goals left at the default weight beside one weighted goal
 * at 100% scored the person at 100%, and `weight_total` was the only clue, on a number that drives review
 * outcomes and (through services/variablePay.ts) a real bonus payment. Partial weights are an unfinished
 * setup, not an instruction to ignore the rest of somebody's year, so the score falls back to the shape that
 * counts every goal and `weighted: false` says the weights were not used. The invariant this establishes:
 * NO COUNTED GOAL IS EVER LEFT OUT OF THE SCORE.
 *
 * Null when there is nothing to score (no goals, or every one of them cancelled) - distinct from a score of 0,
 * which means goals existed and none of them moved.
 */
export function goalAttainment(goals: Pick<GoalSnapshot, "weight" | "progress" | "status">[]): GoalAttainment | null {
  const counted = goals.filter((g) => g.status !== "cancelled");
  if (!counted.length) return null;
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const weightOf = (g: { weight: number }) => Math.max(0, g.weight || 0);
  if (counted.every((g) => weightOf(g) > 0)) {
    const weightTotal = counted.reduce((sum, g) => sum + weightOf(g), 0);
    const earned = counted.reduce((sum, g) => sum + weightOf(g) * clamp(g.progress || 0), 0);
    return { score: Math.round(earned / weightTotal), weight_total: weightTotal, counted: counted.length, weighted: true };
  }
  const mean = counted.reduce((sum, g) => sum + clamp(g.progress || 0), 0) / counted.length;
  return { score: Math.round(mean), weight_total: 0, counted: counted.length, weighted: false };
}

/**
 * The competency keys one cycle rates, defensively parsed from `review_cycles.competency_keys_json`.
 *
 * Stored rather than validated against the framework at write time on purpose: HR renames and retires
 * competencies, and a cycle narrowed to one of them must not become unreadable when it goes. Unknown keys are
 * inert - `competenciesForCycle` intersects with the live framework, so a retired key stops appearing.
 */
export function parseCompetencyKeys(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    const keys = v.filter((k): k is string => typeof k === "string" && !!k.trim()).map((k) => k.trim());
    return keys.length ? [...new Set(keys)] : null;
  } catch {
    return null;
  }
}

/**
 * The competencies THIS cycle rates: the framework, narrowed to the cycle's own selection.
 *
 * Order comes from the framework rather than the stored list, so two cycles rating the same three
 * competencies present them the same way round. A selection matching nothing live falls back to the whole
 * framework - a review form with no questions on it is a broken review, and a retired competency should not
 * be able to produce one.
 */
export function competenciesForCycle<T extends { key: string }>(competencies: T[], keysJson: string | null | undefined): T[] {
  const keys = parseCompetencyKeys(keysJson);
  if (!keys) return competencies;
  const want = new Set(keys);
  const narrowed = competencies.filter((c) => want.has(c.key));
  return narrowed.length ? narrowed : competencies;
}

export type CompetencyScore = {
  /** The competency ratings as one number, on the framework's own scale (e.g. 3.4 out of 5). */
  score: number;
  /** Sum of the weights behind it (0 when the framework carries none and the plain mean was used). */
  weight_total: number;
  /** How many competencies were rated. Unrated ones are left out, never counted as zero. */
  counted: number;
  /** False when no rated competency carried a weight, so the mean was used. */
  weighted: boolean;
};

/**
 * What a review's competency ratings add up to - the same arithmetic as goal attainment, on the rating scale.
 *
 * A manager gives five competency ratings and one overall rating, and the overall one is a judgement, not a
 * calculation: two managers with identical competency ratings routinely land on different overalls, and a
 * calibration meeting has no way to see which of the two numbers moved. This is the computed half, so the
 * meeting can argue with the difference instead of guessing at it. The overall rating remains the manager's
 * own and is never overwritten by this.
 *
 * Weights are relative and may be on any scale (5/3/2 and 50/30/20 give the same answer). A competency with
 * no rating is dropped rather than scored zero - an unanswered question is not a bad answer.
 *
 * The weighted arithmetic needs a weight on EVERY rated competency, for the reason spelled out in
 * `goalAttainment`: on the old Σweight > 0 test a rated competency the framework left unweighted vanished from
 * the score rather than being averaged into it, so a framework half-way through being weighted quietly scored
 * people on a subset of the questions their manager answered. A framework with any unweighted competency
 * therefore falls back to the plain mean, saying so in `weighted`.
 *
 * Null when nothing was rated, which is distinct from a score of 0.
 */
export function competencyScore(competencies: Competency[], ratings: Record<string, number | undefined>): CompetencyScore | null {
  const rated = competencies.filter((c) => typeof ratings[c.key] === "number" && Number.isFinite(ratings[c.key]));
  if (!rated.length) return null;
  const weightOf = (c: Competency) => Math.max(0, c.weight || 0);
  const round = (n: number) => Math.round(n * 10) / 10;
  if (rated.every((c) => weightOf(c) > 0)) {
    const weightTotal = rated.reduce((sum, c) => sum + weightOf(c), 0);
    const earned = rated.reduce((sum, c) => sum + weightOf(c) * (ratings[c.key] as number), 0);
    return { score: round(earned / weightTotal), weight_total: weightTotal, counted: rated.length, weighted: true };
  }
  const mean = rated.reduce((sum, c) => sum + (ratings[c.key] as number), 0) / rated.length;
  return { score: round(mean), weight_total: 0, counted: rated.length, weighted: false };
}
