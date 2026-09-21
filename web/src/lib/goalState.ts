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

/**
 * Which goals are holding up the most other goals.
 *
 * `blocked_by` makes a set of goals a graph, and a list sorted by drift can never show what a graph knows:
 * the goal whose movement would free four others. Everyone looking at a team's goals sees the four that are
 * behind; nobody sees the one that is the reason.
 *
 * TRANSITIVE, because the chain is the point. If C waits on B and B waits on A, then A is holding up two
 * goals, not one, and A is where the conversation belongs. Cycles are survivable - a pair of goals each
 * recorded as waiting on the other is somebody's data-entry mistake, not a reason to hang the page - so the
 * walk carries a seen-set and stops.
 *
 * ONLY OPEN GOALS COUNT, on both ends. A blocker that is finished is not blocking anything (its dependents
 * may not have noticed, which is worth telling them separately), and a cancelled dependent is not waiting.
 */
export function blockingChains<T extends GoalLike & { path?: string | null; blocked_by?: string | null }>(
  goals: T[],
  idOfRef: (ref: string) => string,
): { goal: T; blocking: T[] }[] {
  const byId = new Map<string, T>();
  for (const g of goals) if (g.path) byId.set(idOfRef(g.path), g);

  // blocker id -> the goals directly waiting on it.
  const dependents = new Map<string, T[]>();
  for (const g of goals) {
    if (!g.blocked_by || !isOpen(g)) continue;
    const blockerId = idOfRef(g.blocked_by);
    (dependents.get(blockerId) ?? dependents.set(blockerId, []).get(blockerId)!).push(g);
  }
  if (dependents.size === 0) return [];

  const out: { goal: T; blocking: T[] }[] = [];
  for (const [blockerId, direct] of dependents) {
    const blocker = byId.get(blockerId);
    // A blocker outside the rows on screen (another team's goal, or one this reader cannot see) is not
    // something this panel can name, so it contributes nothing rather than an anonymous row.
    if (!blocker || !isOpen(blocker)) continue;
    const seen = new Set<string>([blockerId]);
    const reached: T[] = [];
    const queue = [...direct];
    while (queue.length) {
      const g = queue.shift()!;
      const id = g.path ? idOfRef(g.path) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      reached.push(g);
      for (const next of dependents.get(id) ?? []) queue.push(next);
    }
    if (reached.length > 0) out.push({ goal: blocker, blocking: reached });
  }
  // Most held up first; a tie goes to the goal in the worst shape itself, because that is the one least
  // likely to free the others on its own.
  out.sort((a, b) => b.blocking.length - a.blocking.length || troubleRank(b.goal) - troubleRank(a.goal));
  return out;
}

/**
 * The goal's own record, as the first draft of its closing note.
 *
 * `goals.retro` is written when a goal closes, and by then nobody remembers the shape of the quarter - so it
 * is usually a sentence that says less than the percentage above it. Everything needed for a real first
 * paragraph is already on the page: where the measure started and finished, how the progress actually moved,
 * and which board tasks were delivered against it.
 *
 * NO MODEL AND NO REQUEST. Every line comes from props the drawer already holds, which is also what keeps
 * this on the right side of the line: nothing is sent anywhere, and the text is the owner's to rewrite
 * before they save it. (If it is then handed to the Draft button, the author has read it and chosen to -
 * the same shape as the self-assessment seed, and the reason `reviews.draft` spells that distinction out.)
 */
export function retroSeed(
  goal: GoalLike & { title?: string; progress?: number | null; unit?: string | null; baseline_value?: number | null; current_value?: number | null; target_value?: number | null },
  linked: { title: string; deliver_time?: string | null }[] = [],
  history: { at_time: string; progress: number }[] = [],
): string {
  const lines: string[] = [];

  const measured = goal.target_value != null && goal.unit;
  lines.push(measured
    ? `Finished at ${goal.current_value ?? "?"} ${goal.unit} against a target of ${goal.target_value} (${goal.progress ?? 0}%).`
    : `Finished at ${goal.progress ?? 0}%.`);

  // The shape of the climb, not every point of it: when it first moved and when it last did says whether
  // this was steady work or a fortnight at the end.
  const moved = history.filter((h) => h.progress > 0);
  if (moved.length >= 2) {
    lines.push(`Progress first moved on ${moved[0]!.at_time.slice(0, 10)} and last on ${moved[moved.length - 1]!.at_time.slice(0, 10)}.`);
  }

  const delivered = linked.filter((t) => !!t.deliver_time);
  if (delivered.length > 0) {
    lines.push(`Delivered against it: ${delivered.map((t) => t.title).join(", ")}.`);
  }
  const open = linked.length - delivered.length;
  if (open > 0) lines.push(`${open} linked task${open === 1 ? "" : "s"} still open.`);

  // The prompt, left in the box: the record says what happened, and only the owner can say why.
  lines.push("", "What I would do differently: ");
  return lines.join("\n");
}

/**
 * The templates that read like what somebody has started typing.
 *
 * WHY NOT THE INDEX. The obvious version of this is a vector lookup, which is how the app finds goals that
 * are the same work in other words - but `goal-templates` is not in the semantic index (domain/searchIndex.ts
 * lists what is), so a nearest-neighbour version means adding a collection to the index, the DDL and the
 * migration to save somebody a scroll through a dropdown. The overlap below costs nothing, runs on rows the
 * dialog has already loaded, and answers the question the dropdown could not: which of these thirty
 * blueprints is about what I am writing.
 *
 * THE MATCH IS WORDS, honestly and visibly. Stop-words out, stems ignored, and a template has to share at
 * least two meaningful words before it is offered - one shared "improve" is not a match, and offering it
 * teaches people that the suggestions are noise.
 */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "by", "with", "our", "we", "i", "my",
  "this", "that", "is", "are", "be", "at", "from", "as", "it", "its", "into", "per", "new", "all",
]);

const wordsOf = (text: string): Set<string> =>
  new Set(
    (text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );

export function matchingTemplates<T extends { title?: string | null; description?: string | null; group_name?: string | null }>(
  typed: string,
  templates: T[],
  limit = 3,
): { template: T; shared: string[] }[] {
  const want = wordsOf(typed);
  if (want.size === 0) return [];
  const out: { template: T; shared: string[] }[] = [];
  for (const t of templates) {
    const have = wordsOf(`${t.title ?? ""} ${t.description ?? ""} ${t.group_name ?? ""}`);
    const shared = [...want].filter((w) => have.has(w));
    if (shared.length >= 2) out.push({ template: t, shared });
  }
  return out.sort((a, b) => b.shared.length - a.shared.length).slice(0, limit);
}
