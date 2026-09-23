import { CalendarDays, MessageSquareDashed, TrendingDown, TrendingUp } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { measureLabel } from "@/lib/goalMeasure";
import { CONFIDENCE, STAGE_BADGE, TONE_FILL, confidenceOf, dueRel, goalTone, isBehind, isOverdue, isQuiet, statusBadge, type GoalLike } from "@/lib/goalState";
import type { GoalConfidence } from "@/types";
import { Badge } from "@/components/ui/badge";

// One goal, drawn the same way wherever it is drawn.
//
// These are the visible half of lib/goalState.ts, and they exist for the same reason: a goal appears on the
// Goals page, the Team goals triage, the Performance tab of a profile and inside a review, and each surface
// had written its own version of every chip. The status badge existed twice, the progress bar three times
// with three different colour rules, the due date four times with four different phrasings, and "key result"
// was a Badge in one place and bare uppercase text in two others.
//
// A surface chooses WHICH of these to show and where to put them. It does not restate what they say.

/** Not started / In progress / Completed / Cancelled. */
export function GoalStatusBadge({ goal, className }: { goal: GoalLike; className?: string }) {
  const badge = statusBadge[goal.status];
  return <Badge variant={badge.variant} className={className}>{badge.label}</Badge>;
}

/**
 * The progress bar, toned by the goal's own state.
 *
 * The tone is the point. Two of the three surfaces that drew a bar coloured it by status alone, so a goal
 * three weeks past its due date was drawn in the ordinary colour - the one signal a bar could carry for free,
 * on the goals most in need of it.
 */
export function GoalProgressBar({ goal, className }: { goal: GoalLike; className?: string }) {
  const pct = Math.min(100, Math.max(0, goal.progress ?? 0));
  return (
    <span className={cn("block h-1.5 overflow-hidden rounded-full bg-muted", className)}>
      <span className={cn("block h-full rounded-full transition-all", TONE_FILL[goalTone(goal)])} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** The progress donut, with the figure in the middle. */
export function GoalRing({ goal, pct, className }: { goal: GoalLike; pct?: number; className?: string }) {
  const value = Math.min(100, Math.max(0, pct ?? goal.progress ?? 0));
  const tone = goalTone(goal);
  const r = 18;
  const c = 2 * Math.PI * r;
  const stroke = tone === "done" ? "stroke-success" : tone === "overdue" ? "stroke-destructive" : tone === "muted" ? "stroke-muted-foreground/50" : "stroke-primary";
  return (
    <div className={cn("relative h-12 w-12 shrink-0", className)}>
      <svg viewBox="0 0 44 44" className="h-12 w-12 -rotate-90" aria-hidden="true">
        <circle cx="22" cy="22" r={r} className="fill-none stroke-muted" strokeWidth="4" />
        <circle cx="22" cy="22" r={r} className={cn("fill-none transition-all", stroke)} strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">{Math.round(value)}</span>
    </div>
  );
}

/**
 * When it is due, said the one way.
 *
 * `absolute` puts the date first and the relative phrase after it, which is what the detail surfaces want;
 * a list row wants the phrase alone. Both come from `dueRel`, and both go quiet on a finished goal - a
 * completed goal has arrived, and a red date on delivered work is a permanent accusation.
 */
export function GoalDueChip({ goal, absolute, className }: { goal: GoalLike; absolute?: boolean; className?: string }) {
  if (!goal.due_date) return null;
  const closed = goal.status === "completed" || goal.status === "cancelled";
  const rel = dueRel(goal.due_date);
  const tone = closed ? "text-muted-foreground" : rel.overdue ? "font-medium text-destructive" : rel.soon ? "font-medium text-warning" : "text-muted-foreground";
  return (
    <span title={formatDate(goal.due_date)} className={cn("inline-flex items-center gap-1 tabular-nums", tone, className)}>
      <CalendarDays className="h-3 w-3 shrink-0" />
      {absolute || closed ? `${formatDate(goal.due_date)}${closed ? "" : ` · ${rel.text}`}` : rel.text}
    </span>
  );
}

/** Draft / Awaiting approval. Nothing at all once the goal is agreed. */
export function GoalStageBadge({ goal, className }: { goal: GoalLike; className?: string }) {
  const stage = STAGE_BADGE[goal.stage ?? "AGREED"];
  if (!stage) return null;
  return <Badge variant={stage.variant} className={className}>{stage.label}</Badge>;
}

/** The KR marker on a key result. Nothing on an objective. */
export function GoalKindMark({ goal, className }: { goal: GoalLike; className?: string }) {
  if (goal.kind !== "key_result") return null;
  return <span className={cn("text-[11px] font-medium uppercase tracking-wide text-muted-foreground", className)} title="Key result">KR</span>;
}

/** How long since anybody touched it. Nothing until it crosses the silence threshold. */
export function GoalQuietChip({ goal, className }: { goal: GoalLike; className?: string }) {
  if (!isQuiet(goal)) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-muted-foreground", className)} title={`No progress, edit or comment for ${goal.stale_days} days`}>
      <MessageSquareDashed className="h-3 w-3" /> quiet {goal.stale_days}d
    </span>
  );
}

/**
 * Where this goal should be by now, in one chip.
 *
 * The owner's own call wins it when they have made one - a person who has said "at risk" has told you more
 * than the arithmetic can - and the drift rides along beside it. Silent on a goal that is fine: a chip on
 * every healthy goal is a chip nobody reads.
 */
export function GoalPaceChip({ goal, className }: { goal: GoalLike; className?: string }) {
  const conf = confidenceOf(goal.confidence);
  if (!conf && !isBehind(goal)) return null;
  const drift = goal.drift;
  const driftText = drift != null && drift < 0 ? `${-drift} pts behind` : drift != null && drift > 0 ? `${drift} pts ahead` : null;
  // The owner says it is fine and the arithmetic says it is not. Both halves are true and the chip used to
  // print only the cheerful one: a green "On track" beside "12 pts behind", on a goal the At risk filter was
  // counting at the same time. Said in the warning tone, with the reason in the tooltip.
  const behindByPace = goal.status !== "completed" && goal.status !== "cancelled" && (goal.pace === "behind" || goal.pace === "at_risk");
  const optimistic = conf?.value === "on_track" && behindByPace;
  const tone = optimistic ? "text-warning" : conf?.className ?? (goal.pace === "at_risk" ? "text-destructive" : "text-warning");
  // The arrow is half the chip's meaning, and it pointed DOWN on an owner who had just said the goal was on
  // track - a falling arrow next to the word "on track", in green, on every goal anybody had confirmed.
  const Icon = conf?.value === "on_track" && !optimistic ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-medium", tone, className)}
      title={[
        conf ? `Owner says: ${conf.label}` : null,
        optimistic ? "The numbers say it is behind" : null,
        goal.expected_progress != null ? `Should be about ${goal.expected_progress}% by now` : null,
        goal.confidence_note,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <Icon className="h-3 w-3" />
      {conf ? conf.label : driftText ?? "Behind"}
      {conf && driftText && <span className="font-normal text-muted-foreground">· {driftText}</span>}
    </span>
  );
}

/** The measure as a person would say it: "42 of 60 customers". Nothing on a goal that counts nothing. */
export function GoalMeasureChip({ goal, className }: { goal: GoalLike; className?: string }) {
  const label = measureLabel(goal);
  if (!label) return null;
  return <span className={cn("tabular-nums text-muted-foreground", className)}>{label}</span>;
}

/** The three-way confidence call, as a segmented control. Writes through `:setConfidence`. */
export function ConfidencePicker({ value, onPick, disabled }: { value?: string | null; onPick: (v: GoalConfidence) => void; disabled?: boolean }) {
  return (
    <div className="flex overflow-hidden rounded-md border text-xs font-medium">
      {CONFIDENCE.map((c) => (
        <button
          key={c.value}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c.value)}
          aria-pressed={value === c.value}
          className={cn("px-2.5 py-1 transition-colors disabled:opacity-50", value === c.value ? "bg-primary text-primary-foreground" : cn("hover:bg-accent", c.className))}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** Overdue, behind, quiet - the one row of trouble signals, in the order a reader triages them. */
export function GoalTroubleChips({ goal, className }: { goal: GoalLike; className?: string }) {
  return (
    <>
      {isOverdue(goal) && <GoalDueChip goal={goal} className={className} />}
      <GoalPaceChip goal={goal} className={className} />
      <GoalQuietChip goal={goal} className={className} />
    </>
  );
}
