// Whether a goal can be measured, and the shape a proposed measure has to arrive in.
//
// THE ARITHMETIC HALF IS THE FEATURE. `unit`, `baseline_value` and `target_value` are the difference between
// "70%" as somebody's feeling on a Friday and "42 of 60 customers" as a fact the row computes - and with all
// three set, `progress` stops being an estimate at all (services/goals.ts derives it). A goal without them is
// not wrong, but at review time nobody can say what it achieved, which is the argument this check makes at
// the moment it is cheap to act on: before the goal is agreed.
//
// The model half only ever PROPOSES the three numbers, into fields the person then accepts one at a time. It
// is not asked whether the goal is good, whether it is ambitious, or how the person is doing.

/** A goal, as much of it as either half of this file needs. */
export type MeasurableGoal = {
  title?: string | null;
  description?: string | null;
  unit?: string | null;
  baseline_value?: number | null;
  target_value?: number | null;
  due_date?: string | null;
  kind?: string | null;
  stage?: string | null;
};

export type MeasureGap =
  /** No unit, baseline or target: progress on this goal is somebody's estimate and always will be. */
  | "no_measure"
  /** A unit and a target but no baseline, so a goal that starts at 8% reads as nearly done on day one. */
  | "no_baseline"
  /** No due date: it cannot be behind, only forgotten. */
  | "no_due_date";

/**
 * What this goal cannot answer about itself.
 *
 * Returns every gap rather than the first, because they are independent and a person fixing one should see
 * the other. Empty for a goal that measures itself, which is the point of the check - a hint that is always
 * on is a hint people stop reading.
 */
export function measureGaps(goal: MeasurableGoal): MeasureGap[] {
  const gaps: MeasureGap[] = [];
  const hasUnit = !!goal.unit?.trim();
  const hasTarget = goal.target_value != null;
  const hasBaseline = goal.baseline_value != null;

  if (!hasUnit && !hasTarget) gaps.push("no_measure");
  // Only worth saying once the goal HAS a measure: telling somebody their baseline is missing while they
  // have no unit or target either is three complaints about one thing.
  else if (!hasBaseline) gaps.push("no_baseline");
  if (!goal.due_date) gaps.push("no_due_date");
  return gaps;
}

/** What each gap costs, in the terms the goal page already uses. One line, addressed to the author. */
export const GAP_MESSAGE: Readonly<Record<MeasureGap, string>> = {
  no_measure: "No measure: progress on this goal will be somebody's estimate. Give it a unit and a target and the app computes it.",
  no_baseline: "No starting value. A goal moving churn from 8% to 4% reads as nearly done on day one without one.",
  no_due_date: "No due date, so this goal can never be behind - only forgotten.",
};

/** The instruction the model is given. It proposes numbers; it does not have a view about the goal. */
export const MEASURE_SYSTEM =
  "You are given the title and description of a work goal. Propose how it could be MEASURED. " +
  "Answer with a single JSON object and nothing else: no explanation, no markdown, no code fence. " +
  "The keys are exactly: unit, baseline_value, target_value. " +
  "`unit` is what is being counted, in one or two words as it would label a number (\"customers\", \"%\", " +
  "\"days\", \"tickets\"). `baseline_value` is where the goal starts and `target_value` where it has to get " +
  "to; a reduction goal has a target BELOW its baseline, which is correct and expected. " +
  "Use null for anything the goal does not state or imply clearly. Do NOT invent a specific figure the text " +
  "does not support: a plausible-looking number somebody accepts without noticing is worse than a null. " +
  "Do not assess the goal, do not say whether it is ambitious or realistic, and do not comment on anybody's " +
  "performance.";

export const MEASURE_PROMPT_VERSION = "v1";
