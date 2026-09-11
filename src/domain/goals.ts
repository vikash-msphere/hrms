// Goal health, derived - no writes, no stored fields, nothing for anyone to keep up to date.
//
// A goal row records where it got to. It never recorded where it SHOULD have got to, which is why a list of
// them reads the same in week two and week eleven: "30%" is excellent in one and a fire in the other. These
// functions answer that from the dates the row already carries, and the serializer emits the answers so the
// browser renders one implementation rather than a second opinion.

const DAY = 86_400_000;

export type GoalPaceState = "ahead" | "on_track" | "behind" | "at_risk";

export type GoalPace = {
  /** Where a straight line from the goal being set to its due date puts it today, 0-100. */
  expected: number;
  /** `progress - expected`. Negative is behind. */
  drift: number;
  state: GoalPaceState;
};

// The bands. Ten points of slack either way, because a goal is not a build pipeline and nobody moves progress
// daily; a quarter of the whole distance behind is the point at which it stops being a wobble.
const BEHIND = -10;
const AT_RISK = -25;

/**
 * Where this goal should be by now, and how far off it is.
 *
 * Null when the question has no answer rather than a flattering one:
 *
 * - **No due date.** A goal with no deadline cannot be behind; it can only be stale (see `staleDays`).
 * - **Finished.** A completed or cancelled goal has arrived at whatever it arrived at. Reporting a completed
 *   goal as "behind" because it finished a week late would put a permanent red chip on delivered work.
 * - **Due before it was set.** A back-dated goal (carried over, or filed after the fact) would read as
 *   instantly at risk on an elapsed fraction that is already past 1. There is no line to be behind.
 *
 * `now` is injected so the serializer can stamp a whole page from one clock.
 */
export function goalPace(
  goal: { createdAt: Date | number; dueDate?: Date | number | null; progress: number; status: string },
  now: number = Date.now(),
): GoalPace | null {
  if (!goal.dueDate) return null;
  if (goal.status === "completed" || goal.status === "cancelled") return null;
  const start = +new Date(goal.createdAt);
  // The due date is a DAY, stored at its midnight; a goal due today has the whole of today to land, so the
  // line runs to the end of it rather than to its first second.
  const end = +new Date(goal.dueDate) + DAY;
  if (!(end > start)) return null;
  const elapsed = Math.max(0, Math.min(1, (now - start) / (end - start)));
  const expected = Math.round(elapsed * 100);
  const drift = Math.round(Math.max(0, Math.min(100, goal.progress ?? 0)) - expected);
  const state: GoalPaceState = drift <= AT_RISK ? "at_risk" : drift <= BEHIND ? "behind" : drift >= 10 ? "ahead" : "on_track";
  return { expected, drift, state };
}

/**
 * Days since anything happened to this goal - a write, a progress move, or a comment.
 *
 * Overdue is the symptom of a lost goal; silence is the cause, and it arrives weeks earlier. A goal nobody has
 * touched since it was created counts from creation, which is the case worth catching: the goal that was set
 * in the kick-off meeting and never spoken of again.
 *
 * Finished goals report nothing. A completed goal is SUPPOSED to go quiet.
 */
export function staleDays(
  goal: { updatedAt: Date | number; status: string },
  lastCommentAt?: Date | number | null,
  now: number = Date.now(),
): number | null {
  if (goal.status === "completed" || goal.status === "cancelled") return null;
  const last = Math.max(+new Date(goal.updatedAt), lastCommentAt ? +new Date(lastCommentAt) : 0);
  return Math.max(0, Math.floor((now - last) / DAY));
}

/** The point at which silence is worth reporting: a goal nobody has touched in three weeks. */
export const STALE_AFTER_DAYS = 21;
