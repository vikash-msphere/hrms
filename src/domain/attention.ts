// What needs this person, across their work. Derived, ranked, and nothing stored.
//
// WHY THIS EXISTS. The app already works out that a goal is at risk, that nobody has touched another for
// three weeks, that a card has sat in Review for a fortnight, that a review is waiting on somebody. Every one
// of those answers is computed correctly and then left where only a person who goes looking will find it:
// behind a filter on the Goals page, in a column on a board, on a review somebody has to remember to open.
// The dashboard's "My day" spends its space on leave balance, next payday and assets.
//
// So the intelligence was never missing - the TELLING was. This module is the telling: one ranked list of the
// things that are off track or waiting, assembled from predicates that already exist.
//
// NO NEW TRUTH IS INVENTED HERE. Every item comes from a signal the app already computes and renders
// somewhere else (domain/goals.ts `goalPace` and `staleDays`, a card's `column_since`, a review's state), so
// this surface and the page it points at can never disagree. That is deliberate: a summary that does its own
// arithmetic becomes a second opinion, and the first thing anybody does with a second opinion is stop
// trusting both.
//
// AND NO MODEL IS REQUIRED. The detection is arithmetic. A model is offered one job on top - putting the list
// into a sentence and saying what to look at first - and when it is off, absent or out of budget the list is
// exactly the same list. See services/attention.ts.

/** The collections this surface reads. Handed to the middleware so each is scoped by the very decision its
 *  own list request would get - a collection the caller cannot list simply contributes nothing. */
export const ATTENTION_COLLECTIONS = ["goals", "cards", "reviews"] as const;

/**
 * Why an item is on the list. The kind is what decides its rank and its wording, so it is a closed set rather
 * than a free string: a new signal should have to be named here and ranked deliberately.
 */
export type AttentionKind =
  /** Progress is far enough behind the line from start to due date that it will not land. */
  | "goal_at_risk"
  /** Behind the line, but not yet hopeless. */
  | "goal_behind"
  /** Nobody has touched it in three weeks. Silence arrives weeks before overdue does. */
  | "goal_stale"
  /** A review is at a stage that is waiting on this person. */
  | "review_waiting"
  /** A card has sat in one column long enough that the board is lying about it being in flight. */
  | "card_aged";

export type AttentionItem = {
  kind: AttentionKind;
  /** `<collection>/<id>`, so the caller can navigate straight to the thing. Tokenised by the wire edge. */
  path: string;
  /** What the thing is called, for a list somebody reads at a glance. */
  title: string;
  /** The specific fact, already in words: "18% with 9 days left", "in Review for 14 days". */
  detail: string;
  /** Days, where the signal is about elapsed time. Used for ordering within a kind. */
  days?: number;
};

/**
 * How bad each kind is, before the per-item detail is considered.
 *
 * ORDERED BY WHAT GOES WRONG IF IT IS IGNORED, not by how loud it is. A review waiting outranks a goal that
 * is merely behind because it blocks another person and it has a deadline somebody else set. `goal_stale`
 * sits below `goal_behind` deliberately even though silence is the earlier symptom: three weeks of quiet on a
 * goal that is otherwise on track is worth a nudge, not the top of the list.
 */
const SEVERITY: Record<AttentionKind, number> = {
  goal_at_risk: 5,
  review_waiting: 4,
  goal_behind: 3,
  card_aged: 2,
  goal_stale: 1,
};

/**
 * Most-in-need-of-attention first, and stable.
 *
 * Within a kind the older thing wins, because age is the whole complaint: a card stuck for three weeks is a
 * worse problem than one stuck for eight days, and a list that shuffles them by id teaches people to ignore
 * the order. Ties fall back to the path so two runs produce the same list - a surface that reorders itself on
 * every refresh reads as noise however good its contents.
 */
export function rankAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) =>
    SEVERITY[b.kind] - SEVERITY[a.kind]
    || (b.days ?? 0) - (a.days ?? 0)
    || a.path.localeCompare(b.path));
}

/**
 * How many items reach the surface.
 *
 * A list of forty is a second inbox, and an inbox is the thing this is supposed to save somebody from. The
 * cut is after ranking, so what survives is the worst of what there is rather than the first found.
 */
export const ATTENTION_LIMIT = 8;
