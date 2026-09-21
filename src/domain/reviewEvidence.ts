// What a person actually did during a review cycle, as a list of records rather than as an opinion.
//
// NO MODEL TOUCHES ANY OF THIS, and that is the design rather than a limitation. A manager writing a review
// hunts through goals, boards, kudos and their own notes for what the person did, gives up somewhere around
// the third tab, and writes from memory - which is how a year of work becomes whatever happened in November.
// The app already holds the answer in four places; this is the list of them, gathered under the window the
// cycle names, every line a link to the record it came from.
//
// `reviews` is on NEVER_TO_MODEL (domain/aiPolicy.ts) and stays there. Nothing here is sent anywhere, nothing
// is summarised, nothing is scored: the assembly is queries the caller could already have made by hand, run
// under the scope their own list request would have been given. That is also why it needs no feature flag -
// there is no inference to switch off and no fallback to degrade to.
//
// THE LINE THIS DOES NOT CROSS: it says what happened, never how well. No ranking, no "strong quarter", no
// count presented as a score. A delivered card is evidence in both directions depending on what it was, and
// deciding which is the reader's job.

/** The collections an evidence pack reads. Each is decided by the same list verdict a real
 *  `GET /v1/<collection>` would get, so a caller who cannot list one simply gets that section empty. */
export const EVIDENCE_COLLECTIONS = ["goals", "cards", "announcements", "check-ins"] as const;

/** A goal this person contributed a share of, owned by somebody else. */
export type EvidenceContribution = {
  path: string;
  title: string;
  /** Percent of the goal's weight credited to them (goal_contributors.share). */
  share: number;
  note?: string;
  progress: number;
  status: string;
};

export type EvidenceCard = {
  path: string;
  /** The card's human key (MS-4), when its board gives one. */
  key?: string;
  title: string;
  /** ISO day the card was delivered. */
  delivered: string;
  board: string;
  size?: number;
  /** The goal the card was filed against, when it carries the link. */
  goal?: { path: string; title: string };
};

export type EvidenceKudos = {
  path: string;
  body: string;
  at: string;
  from?: string;
  category?: string;
  level?: string;
};

export type EvidenceCheckIn = {
  path: string;
  date: string;
  notes: string;
};

export type ReviewEvidence = {
  /** The window everything below was gathered from, as ISO days. Absent ends mean the cycle left them open. */
  window: { start?: string; end?: string };
  cards: EvidenceCard[];
  kudos: EvidenceKudos[];
  contributions: EvidenceContribution[];
  /** The SHARED notes of the person's own 1:1s. The two private notes are never read here - see the service. */
  check_ins: EvidenceCheckIn[];
  /** True when a section was cut to its cap, so the panel can say so rather than imply that was all of it. */
  truncated: boolean;
};

/**
 * The window an evidence pack covers.
 *
 * The cycle's period is the answer when it has one. When it does not - plenty of cycles are named "H1" and
 * dated by nothing - the review's own creation is the earliest moment anybody agreed this review was about,
 * and "now" is the other end. Falling back to no window at all would quietly gather a person's entire history
 * into a panel about one quarter, which is the failure that reads as a feature until somebody's 2023 kudos
 * turns up in their 2026 review.
 */
export function evidenceWindow(
  cycle: { periodStart?: Date | number | null; periodEnd?: Date | number | null },
  review: { createdAt: Date | number },
  now: number = Date.now(),
): { from: number; to: number; window: ReviewEvidence["window"] } {
  const day = (v: Date | number) => new Date(v).toISOString().slice(0, 10);
  const start = cycle.periodStart ? +new Date(cycle.periodStart) : +new Date(review.createdAt);
  // A period end is a DAY: work delivered on the last day of the cycle belongs to the cycle, so the window
  // runs to the end of it rather than to its first second.
  const end = cycle.periodEnd ? +new Date(cycle.periodEnd) + 86_400_000 : now;
  return {
    from: start,
    to: end,
    window: {
      ...(cycle.periodStart ? { start: day(cycle.periodStart) } : {}),
      ...(cycle.periodEnd ? { end: day(cycle.periodEnd) } : {}),
    },
  };
}

/** Rows read per section. A review panel is a reading surface, not a report: past this many the reader is
 *  scrolling rather than remembering, and the count says how much was left. */
export const EVIDENCE_CAP = 25;
