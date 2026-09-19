import type { Goal, GoalConfidence, GoalStatus } from "@/types";
import { todayStr, daysBetweenYmd } from "@/lib/orgDay";

// What state a goal is in, and how that state reads. One module, for the same reason `goalMeasure.ts` is one
// module: the answer is stated on seven surfaces and they had all worked it out separately.
//
// WHAT THIS REPLACED. `goals` is rendered by the Goals page (cards, drawer, alignment cascade), the Team goals
// triage, the Performance tab on a profile, the review's goal section, the 1:1 agenda builder and the
// dashboard. Every one of them had its own copy of the same handful of rules, and the copies had drifted:
//
// - "At risk" meant two different things. The Goals page asked `pace === "at_risk"`; Team goals also accepted
//   `pace === "behind"`. The same goal was a warning on one page and fine on the other.
// - A goal's colour was decided four times. The card tinted an overdue goal rose; the alignment cascade and
//   the profile tab did not, so a goal three weeks past its date was drawn in the ordinary colour on two of
//   the three surfaces a manager looks at.
// - A due date was written four ways: "3d overdue", "Overdue 14 Mar", "14 Mar · 3d overdue", and a bare
//   "14 Mar" with no styling at all.
// - The status badge table, the sort rank, `isOpen`, the 21-day silence threshold and the measure label were
//   each duplicated two or three times, near-identically, which is the state a rule is in just before one
//   copy is changed and the others are not.
//
// So the rules live here and the chips that draw them live in components/common/GoalChips.tsx. A surface
// decides WHICH goals to show; it does not get to decide what "at risk" means.

/**
 * The least a thing has to be for these rules and the chips in GoalChips.tsx to read it.
 *
 * TWO shapes are a goal in this app: the live `goals` row, and the SNAPSHOT a review froze at sharing
 * (`review.goals[]` - narrower, and carrying a `contribution` the live row has no idea about). They were
 * rendered by completely separate code, which is why the review's goal list was still colouring by status
 * alone, writing its own word for an unagreed goal, and dropping the due date and the owner's closing note
 * on the floor although the snapshot carries both.
 *
 * Stated explicitly rather than as `Partial<Goal>` so it also documents exactly which fields a chip is
 * allowed to read - anything absent from a snapshot simply reads as undefined and the chip goes quiet.
 */
export type GoalLike = {
  status: GoalStatus;
  progress?: number | null;
  due_date?: string | null;
  stage?: string | null;
  kind?: string | null;
  weight?: number | null;
  measured?: boolean | null;
  retro?: string | null;
  pace?: string | null;
  confidence?: string | null;
  confidence_note?: string | null;
  drift?: number | null;
  expected_progress?: number | null;
  stale_days?: number | null;
  target_value?: number | null;
  current_value?: number | null;
  unit?: string | null;
};

/** The point at which silence is worth reporting. Mirrors `STALE_AFTER_DAYS` in src/domain/goals.ts. */
export const STALE_DAYS = 21;

/** Still live: not finished, not abandoned. */
export const isOpen = (g: GoalLike) => g.status === "in_progress" || g.status === "not_started";

/**
 * Past its due date and still open.
 *
 * Its own question, and not one `pace` can answer: `goalPace` clamps the elapsed fraction at 1, so once the
 * date has gone by `expected` sits at 100 and the drift is only `progress - 100`. A goal two months overdue
 * at 95% comes back `on_track`.
 */
export const isOverdue = (g: GoalLike) => isOpen(g) && !!g.due_date && g.due_date < todayStr();

/**
 * Behind where it should be - by the server's arithmetic, or because the owner has said so.
 *
 * Both halves matter. The arithmetic catches the goal nobody has admitted to; the owner's call catches the
 * one that still looks fine on paper because the deadline is far away. `behind` is included as well as
 * `at_risk`: a goal ten points down is the one worth a conversation, and by the time it is twenty-five down
 * the conversation is overdue.
 */
export const isBehind = (g: GoalLike) =>
  isOpen(g) && (g.pace === "behind" || g.pace === "at_risk" || g.confidence === "at_risk" || g.confidence === "off_track");

/** Silence. The server counts the days; a write, a progress move or a comment resets it. */
export const isQuiet = (g: GoalLike) => isOpen(g) && (g.stale_days ?? 0) >= STALE_DAYS;

/** Anything a manager would want to ask about: a missed date, a slipping goal, or one nobody has touched. */
export const isTroubled = (g: GoalLike) => isOverdue(g) || isBehind(g) || isQuiet(g);

/** Worst first, for the lists that sort by how much trouble a goal is in. */
export const troubleRank = (g: GoalLike) =>
  isOverdue(g) || g.pace === "at_risk" || g.confidence === "off_track" ? 0 : isBehind(g) ? 1 : isQuiet(g) ? 2 : 3;

export const statusBadge: Record<GoalStatus, { label: string; variant: "muted" | "secondary" | "success" | "destructive" }> = {
  not_started: { label: "Not started", variant: "muted" },
  in_progress: { label: "In progress", variant: "secondary" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

/** Active goals sort ahead of finished ones; within a bucket the due date decides. */
export const STATUS_RANK: Record<GoalStatus, number> = { in_progress: 0, not_started: 1, completed: 2, cancelled: 3 };

/** The ordinary list order: live work first, then by due date, then newest. */
export const sortGoals = <T extends GoalLike & { create_time?: string | null }>(list: T[]): T[] =>
  [...list].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
      (b.create_time ?? "").localeCompare(a.create_time ?? ""),
  );

/**
 * The goal-setting handshake, as a badge. AGREED is the resting state and gets none: in an org that has not
 * turned approval on every goal is agreed, and a badge on all of them says nothing.
 */
export const STAGE_BADGE: Record<string, { label: string; variant: "muted" | "secondary" }> = {
  DRAFT: { label: "Draft", variant: "muted" },
  PROPOSED: { label: "Awaiting approval", variant: "secondary" },
};

/**
 * How the three confidence calls read and colour, in the order a picker offers them.
 *
 * The SEMANTIC tokens, not a hand-rolled light/dark pair off the raw palette. The app defines `--success`,
 * `--warning` and `--destructive` with both themes already set, and half of it says "this is a warning" that
 * way while the other half writes `text-amber-600 dark:text-amber-400` - two vocabularies for one meaning,
 * picked per page. The token is the one that follows the org's theme and cannot forget its dark variant.
 */
export const CONFIDENCE: { value: GoalConfidence; label: string; className: string }[] = [
  { value: "on_track", label: "On track", className: "text-success" },
  { value: "at_risk", label: "At risk", className: "text-warning" },
  { value: "off_track", label: "Off track", className: "text-destructive" },
];
export const confidenceOf = (v?: string | null) => CONFIDENCE.find((c) => c.value === v);

/** Which colour a goal is drawn in, everywhere it is drawn. */
export type GoalTone = "done" | "overdue" | "muted" | "normal";
export const goalTone = (g: GoalLike): GoalTone =>
  g.status === "completed" ? "done" : g.status === "cancelled" ? "muted" : isOverdue(g) ? "overdue" : "normal";

/** The bar/ring fill for a tone. */
export const TONE_FILL: Record<GoalTone, string> = {
  done: "bg-success",
  overdue: "bg-destructive",
  muted: "bg-muted-foreground/40",
  normal: "bg-primary",
};
/** The same tone as text, for the dates and chips that carry it. */
export const TONE_TEXT: Record<GoalTone, string> = {
  done: "text-success",
  overdue: "text-destructive",
  muted: "text-muted-foreground",
  normal: "text-muted-foreground",
};

/** Relative due phrase: "5d left" / "due today" / "3d overdue". `soon` is within a week. */
export const dueRel = (ymd: string): { text: string; overdue: boolean; soon: boolean } => {
  const days = daysBetweenYmd(todayStr(), ymd);
  if (days > 0) return { text: `${days}d left`, overdue: false, soon: days <= 7 };
  if (days === 0) return { text: "due today", overdue: false, soon: true };
  return { text: `${-days}d overdue`, overdue: true, soon: false };
};

/**
 * Landing this week: still open, not yet past its date, and due inside a week.
 *
 * The other end of `isOverdue`. Everything else these rules answer is about work that has already gone wrong,
 * and the question a person actually opens their goals with on a Monday - what is due in the next few days -
 * could only be answered by reading every date on the page.
 */
export const isDueSoon = (g: GoalLike) => isOpen(g) && !!g.due_date && !isOverdue(g) && dueRel(g.due_date).soon;

/**
 * The status a progress figure implies, or undefined when it implies none.
 *
 * Moving progress to 100 closes a goal out and moving it off zero starts it, and that rule was written out
 * by hand on the Goals page and again inside the review's own progress row - two places that both write
 * through `:updateProgress` and have to agree about what the number means.
 */
export const statusForProgress = (progress: number, current: GoalStatus | string): GoalStatus | undefined =>
  progress >= 100 && current !== "completed" ? "completed"
  : progress > 0 && current === "not_started" ? "in_progress"
  : undefined;
