import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronUp, ChevronsUp, ClipboardList,
  KanbanSquare, Star, Target, TrendingDown,
} from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { AccessAction } from "@/components/access/AccessAction";
import { useSubjectCanRead } from "@/lib/perm";
import { navigate } from "@/router";
import { cn, formatDate, idOf } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import { getSetting } from "@/lib/settingsStore";
import { DEFAULT_PERFORMANCE, ratingLabel, type PerformanceFramework } from "@/lib/performance";
import { isBehind, isOpen as goalIsOpen, sortGoals } from "@/lib/goalState";
import { GoalDueChip, GoalKindMark, GoalMeasureChip, GoalProgressBar, GoalStatusBadge } from "@/components/common/GoalChips";
import type { Board, Card as CardT, Goal, Review, ReviewCycle } from "@/types";
import { DataState } from "@/components/common/DataState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// How this person is doing: the goals they own, the tasks assigned to them, and their reviews - the three
// records the performance conversation is actually held in, gathered on one tab of their profile.
//
// Three cards rather than one merged list, unlike the Posts tab: a goal, a task and a review are not the same
// kind of thing to the reader. A goal is a commitment with a number on it, a task is work in flight, a review
// is a verdict already reached - interleaving them by date would bury the two goals under forty tasks.
//
// ALL THREE READS ARE SERVER-FILTERED (`?employee=` / `?assignee=` / `?employee=`) rather than a client pass
// over a page of each collection. Goals are set a cycle at a time, reviews are launched a cycle at a time and
// tasks accumulate per board, so one person's rows are a handful scattered through hundreds and mostly past
// the first page - filtering here would have shown an arbitrary recent slice and called it their record.
//
// Each card is gated on its own collection grant and simply does not render without it: an org that runs
// goals but not boards gets a Goals card and no empty Tasks frame. The tab itself is hidden when the caller
// holds none of the three (see the gates on both profile pages).

// The goal badge table, the sort rank and the two predicates used to live here as a third copy of what the
// Goals page and the Team goals triage each had. They are lib/goalState.ts now, along with the colour rule
// this card's progress bar was missing: it toned by status alone, so an overdue goal on somebody's profile
// was drawn exactly like a healthy one.

const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-sky-600 dark:text-sky-400",
  high: "text-warning",
  urgent: "text-destructive",
};
const PRIORITY_ICON: Record<string, typeof ChevronUp> = { low: ChevronDown, medium: ChevronUp, high: ChevronsUp, urgent: AlertTriangle };

const REVIEW_BADGE: Record<string, { label: string; variant: "muted" | "secondary" | "info" | "success" }> = {
  SELF: { label: "Self-assessment", variant: "muted" },
  MANAGER: { label: "With manager", variant: "secondary" },
  SHARED: { label: "Shared", variant: "info" },
  ACKNOWLEDGED: { label: "Acknowledged", variant: "success" },
};

export function EmployeePerformance({ employeeId, isSelf }: { employeeId: string; isSelf: boolean }) {
  const employee = `employees/${employeeId}`;
  // The server's answer for THIS PERSON (`access.subject`, provided by whichever profile page mounted us),
  // never a capability string: a stripped `goals.read` is true for every employee, because everyone owns
  // goals, so it would render all three cards about anybody. See the long note in pages/EmployeeProfile.tsx.
  const canGoals = useSubjectCanRead("goals");
  const canTasks = useSubjectCanRead("cards");
  const canReviews = useSubjectCanRead("reviews");

  return (
    <div className="space-y-4">
      {/* Goals, then the reviews that scored them, then the work in flight. A goal is a commitment and a
          review is the verdict on it, so they read as one thread and are cross-linked below; tasks are a
          different tense and sit last. */}
      {canGoals && <GoalsCard employee={employee} isSelf={isSelf} />}
      {canReviews && <ReviewsCard employee={employee} isSelf={isSelf} />}
      {canTasks && <TasksCard employee={employee} isSelf={isSelf} />}
    </div>
  );
}

// The org's rating scale, so a rating reads as "Exceeds" rather than as a bare 4 whose maximum the reader has
// to guess. Both cards below need it now - a goal row shows the verdict its review reached - so it is one hook
// rather than the same effect written twice. Failure-silent: an org that has never opened the panel gets the
// defaults, which is what the server scores on too.
function usePerformanceFramework(): PerformanceFramework {
  const [framework, setFramework] = useState<PerformanceFramework>(DEFAULT_PERFORMANCE);
  useEffect(() => {
    let active = true;
    getSetting<Partial<PerformanceFramework>>("performance")
      .then((cfg) => {
        if (active && cfg.value?.competencies?.length && cfg.value.scale?.length) setFramework({ ...DEFAULT_PERFORMANCE, ...cfg.value });
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return framework;
}

// ---- goals ----

function GoalsCard({ employee, isSelf }: { employee: string; isSelf: boolean }) {
  const { rows, state, error, reload } = useCollection<Goal>("goals", { params: { employee } });
  // The reviews that SCORED these goals, and the cycles that set them. Both are the same store keys the
  // Reviews card below reads, so this costs no extra request - the resource store answers from cache.
  //
  // A goal and its verdict were two cards with nothing between them: the tab showed "80% · In progress" in
  // one and "3 goals scored" in the other, and the reader had to open the review to find out that the 80%
  // had been rated Exceeds. `goals.cycle_id` is the link the server already keeps (the review scores exactly
  // the goals naming its cycle), and the review carries its verdicts keyed by goal code with the goal's own
  // `path` beside them - so the join is by path and needs nothing derived here.
  const { rows: reviews } = useCollection<Review>("reviews", { params: { employee } });
  const { rows: cycles } = useCollection<ReviewCycle>("review-cycles", { all: true });
  const framework = usePerformanceFramework();
  const today = todayStr();

  const cycleName = useMemo(() => {
    const m = new Map(cycles.map((c) => [idOf(c.path), c.name]));
    return (ref?: string | null) => (ref ? m.get(idOf(ref)) : undefined);
  }, [cycles]);

  // Goal path -> the verdict a SHARED review reached on it. Only shared/acknowledged reviews contribute: a
  // rating still being written is not a result to put on somebody's goal, and the server withholds it from
  // the employee anyway.
  const verdictOf = useMemo(() => {
    const m = new Map<string, { rating?: number; comment?: string; cycle?: string }>();
    for (const r of reviews) {
      if (r.state !== "SHARED" && r.state !== "ACKNOWLEDGED") continue;
      for (const g of r.goals ?? []) {
        const v = (r.goal_ratings ?? {})[g.code];
        if (!v || !g.path) continue;
        m.set(idOf(g.path), { rating: v.rating, comment: v.comment, cycle: cycleName(r.cycle) });
      }
    }
    return (path: string) => m.get(idOf(path));
  }, [reviews, cycleName]);

  // `sortGoals` is the one list order: live work first, then by due date (undated at the back of its bucket
  // rather than the front, which is where an empty string would put it), then newest.
  const goals = useMemo(() => sortGoals(rows), [rows]);
  const active = goals.filter(goalIsOpen).length;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        {/* Each card carries its OWN key, and that is the point of putting three here: the tab's key names
            `goals` (the one of the three an org actually tunes per person), so without these an admin asked
            for sight of somebody's reviews would have granted goals from the only affordance on screen. */}
        <CardTitle className="text-base">
          <AccessAction collection="goals" label="Goals">
            <span className="flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> Goals</span>
          </AccessAction>
        </CardTitle>
        {goals.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {active} active of {goals.length}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <DataState state={state} error={error} rows={3} onRetry={reload}>
          {goals.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {isSelf ? "You have no goals set yet." : "No goals set yet."}
            </p>
          ) : (
            <>
              <TruncationNotice collection="goals" what="goals" />
              <ul className="divide-y">
                {goals.map((g) => {
                  const progress = Math.min(100, Math.max(0, g.progress ?? 0));
                  const verdict = verdictOf(g.path);
                  return (
                    <li key={g.path}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 py-3 text-left hover:bg-muted/40"
                        onClick={() => navigate(`goals/${idOf(g.path)}`)}
                      >
                        <span className="mt-0.5 w-10 shrink-0 text-right text-xs font-semibold tabular-nums">{progress}%</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={cn("truncate text-sm font-medium", g.status === "cancelled" && "text-muted-foreground line-through")}>
                              {g.title}
                            </span>
                            <GoalKindMark goal={g} />
                            {/* `text-warning`, the design token. I moved this OFF the token earlier in the
                                name of matching the other goal surfaces, which had it backwards: this file
                                was the one doing it right, and the surfaces I was matching were the ones
                                hand-rolling amber. They have been moved onto the token instead. */}
                            {isBehind(g) && <TrendingDown className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="behind pace" />}
                            <GoalStatusBadge goal={g} />
                            {/* THE VERDICT, beside the commitment it judged. A goal and its review rating were
                                two cards with nothing between them: this row said "80% · In progress" and the
                                Reviews card below said "3 goals scored", and only opening the review told you
                                the 80% had been rated Exceeds. Present only once a review is SHARED. */}
                            {verdict?.rating != null && (
                              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-foreground" title={verdict.comment || undefined}>
                                <Star className="h-3.5 w-3.5 text-amber-500" />
                                {ratingLabel(framework.scale, verdict.rating)}
                              </span>
                            )}
                          </span>
                          {/* The bar is the row's own measure, so it sits under the title rather than beside
                              it: at a phone width a fixed-width bar in the title row pushes the title into
                              two characters and an ellipsis. */}
                          <GoalProgressBar goal={g} className="mt-1.5 w-full" />
                          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                            {/* The one due chip, so "12d overdue" here is what the Goals page says too. This
                                row used to write "Overdue 14 Mar" in `text-destructive` - a different phrase
                                and a different red from every other surface, and it never said HOW overdue. */}
                            {g.due_date ? <GoalDueChip goal={g} /> : <span>No due date</span>}
                            {/* The measure, which this card never showed at all: a measured goal reported a
                                bare percentage where the Goals page says "42 of 60 customers". */}
                            {g.measured && <><span>·</span><GoalMeasureChip goal={g} /></>}
                            {g.weight ? ` · weight ${g.weight}` : ""}
                            {/* Which cycle claimed this goal - `goals.cycle_id` is the link that decides which
                                set a review scores, so saying it here is what makes the Reviews card below
                                read as the same thread rather than a second, unrelated list. */}
                            {cycleName(g.cycle) ? ` · ${cycleName(g.cycle)}` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

// ---- tasks ----

function TasksCard({ employee, isSelf }: { employee: string; isSelf: boolean }) {
  const { rows, state, error, reload } = useCollection<CardT>("cards", { params: { assignee: employee } });
  // The boards are what turn a card's `column_key` into a word and a state: a column carries its own label and
  // its `delivery` flag, and both are per board. Small, flat, and already cached wherever the Boards page has
  // been open, so this is a lookup rather than a second heavy read.
  const { rows: boards } = useCollection<Board>("boards", { all: true });
  const today = todayStr();

  const boardOf = useMemo(() => {
    const m = new Map(boards.map((b) => [idOf(b.path), b]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [boards]);

  const tasks = useMemo(() => {
    const decorated = rows.map((c) => {
      const board = boardOf(c.board);
      const column = (board?.columns ?? []).find((col) => col.key === c.column_key);
      return {
        card: c,
        boardName: board?.name,
        columnLabel: column?.label,
        // Delivered is the board's own definition of done (the column that ends cycle time), not a guess from
        // the column's name - a board is free to call it "Shipped", "Live" or "Closed".
        done: column?.delivery === true,
      };
    });
    // Work in flight first, then by due date (undated last), then the delivered tail newest-first.
    return decorated.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return (b.card.update_time ?? "").localeCompare(a.card.update_time ?? "");
      const due = (a.card.due_date ?? "9999").localeCompare(b.card.due_date ?? "9999");
      return due !== 0 ? due : (b.card.update_time ?? "").localeCompare(a.card.update_time ?? "");
    });
  }, [rows, boardOf]);
  const open = tasks.filter((t) => !t.done).length;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="cards" label="Tasks">
            <span className="flex items-center gap-2"><KanbanSquare className="h-4 w-4 text-primary" /> Tasks</span>
          </AccessAction>
        </CardTitle>
        {tasks.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {open} open of {tasks.length}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <DataState state={state} error={error} rows={3} onRetry={reload}>
          {tasks.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {isSelf ? "Nothing is assigned to you." : "Nothing is assigned to this person."}
            </p>
          ) : (
            <>
              <TruncationNotice collection="cards" what="tasks" />
              <ul className="divide-y">
                {tasks.map(({ card, boardName, columnLabel, done }) => {
                  const Priority = PRIORITY_ICON[card.priority ?? "medium"] ?? ChevronUp;
                  const overdue = !done && !!card.due_date && card.due_date.slice(0, 10) < today;
                  return (
                    <li key={card.path}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 py-3 text-left hover:bg-muted/40"
                        onClick={() => navigate(`boards/${idOf(card.path)}`)}
                      >
                        <span className="mt-0.5 shrink-0">
                          {done ? (
                            <CheckCircle2 className="h-4 w-4 text-success" />
                          ) : (
                            <Priority className={cn("h-4 w-4", PRIORITY_TONE[card.priority ?? "medium"])} aria-label={`${card.priority ?? "medium"} priority`} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            {card.key && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{card.key}</span>}
                            <span className={cn("truncate text-sm font-medium", done && "text-muted-foreground")}>{card.title}</span>
                            {card.blocked && <Badge variant="destructive">Blocked</Badge>}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {[boardName, columnLabel].filter(Boolean).join(" · ") || "On a board"}
                            {card.due_date && (
                              <>
                                {" · "}
                                <span className={cn(overdue && "text-destructive")}>
                                  {overdue ? "Overdue " : "Due "}{formatDate(card.due_date)}
                                </span>
                              </>
                            )}
                            {typeof card.todo_total === "number" && card.todo_total > 0 ? ` · ${card.todo_done ?? 0}/${card.todo_total} checklist` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

// ---- reviews ----

function ReviewsCard({ employee, isSelf }: { employee: string; isSelf: boolean }) {
  const { rows, state, error, reload } = useCollection<Review>("reviews", { params: { employee } });
  // The cycles name and date the reviews; a review row carries only the ref. Flat, HR-managed and few.
  const { rows: cycles } = useCollection<ReviewCycle>("review-cycles", { all: true });
  const framework = usePerformanceFramework();

  const cycleOf = useMemo(() => {
    const m = new Map(cycles.map((c) => [idOf(c.path), c]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [cycles]);

  const reviews = useMemo(
    () =>
      [...rows].sort((a, b) => {
        // Newest cycle first, by the cycle's own period end - reviews are created in a batch when a cycle is
        // launched, so their create times are all within a second of each other and say nothing about order.
        const ae = cycleOf(a.cycle)?.period_end ?? a.create_time ?? "";
        const be = cycleOf(b.cycle)?.period_end ?? b.create_time ?? "";
        return be.localeCompare(ae);
      }),
    [rows, cycleOf],
  );

  return (
    // `sentry-mask`, unlike the two cards above it: `reviews` is MEMORY_ONLY (lib/resourceStore.ts), so its
    // rows may not be written to disk - and session replay ships them one hop further, to a third party with
    // retention. A cycle name, a stage and somebody's overall rating is the verdict on a person's year.
    // Goals and tasks are ordinary work in flight and stay legible in a replay.
    <Card className="sentry-mask">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="reviews" label="Reviews">
            <span className="flex items-center gap-2"><ClipboardList className="h-4 w-4 text-primary" /> Reviews</span>
          </AccessAction>
        </CardTitle>
        {reviews.length > 0 && (
          <span className="text-xs text-muted-foreground">{reviews.length} {reviews.length === 1 ? "review" : "reviews"}</span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <DataState state={state} error={error} rows={2} onRetry={reload}>
          {reviews.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {isSelf ? "You have no reviews yet." : "No reviews yet."}
            </p>
          ) : (
            <>
              <TruncationNotice collection="reviews" what="reviews" />
              <ul className="divide-y">
                {reviews.map((r) => {
                  const cycle = cycleOf(r.cycle);
                  const badge = REVIEW_BADGE[r.state] ?? { label: r.state, variant: "muted" as const };
                  // Shown only once the review is shared. Before that the field is withheld from the employee
                  // by the server anyway, and on a manager's screen a rating still being written is not a
                  // result to put on somebody's profile.
                  const rated = (r.state === "SHARED" || r.state === "ACKNOWLEDGED") && typeof r.overall_rating === "number";
                  return (
                    <li key={r.path}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 py-3 text-left hover:bg-muted/40"
                        onClick={() => navigate(`reviews/${idOf(r.path)}`)}
                      >
                        <span className="mt-0.5 shrink-0 text-muted-foreground"><CalendarClock className="h-4 w-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">{cycle?.name ?? "Review"}</span>
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                            {rated && (
                              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
                                <Star className="h-3.5 w-3.5 text-amber-500" />
                                {ratingLabel(framework.scale, r.overall_rating)}
                              </span>
                            )}
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {cycle?.period_start && cycle?.period_end
                              ? `${formatDate(cycle.period_start)} - ${formatDate(cycle.period_end)}`
                              : formatDate(r.create_time)}
                            {/* The goals half of the verdict, as a NUMBER rather than a count. "3 goals
                                scored" says the review had evidence; the weighted attainment says what the
                                evidence came to, which is the figure the rating beside it was reached on
                                (domain/performance.ts goalAttainment - the same one the PDF and the 9-box
                                use). The goals themselves are listed in the card above, each carrying the
                                verdict this review gave it. */}
                            {(r.goals ?? []).length > 0
                              ? ` · ${(r.goals ?? []).length} ${(r.goals ?? []).length === 1 ? "goal" : "goals"}${typeof r.goal_attainment === "number" ? ` at ${r.goal_attainment}%` : " scored"}`
                              : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
