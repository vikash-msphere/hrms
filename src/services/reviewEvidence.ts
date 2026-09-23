// Assemble the evidence pack for one review: four queries, no inference, nothing written.
//
// See domain/reviewEvidence.ts for what this is and the line it does not cross. What is worth knowing here is
// the access shape, because this endpoint reads four collections that have nothing to do with `reviews`:
//
// EACH SECTION IS DECIDED BY ITS OWN COLLECTION'S LIST VERDICT. The middleware resolves the same verdict a
// real `GET /v1/cards` (or goals, announcements, check-ins) would get for this caller and leaves the map on
// `evidenceScopes`; this file only binds it. A caller who may not list check-ins gets no check-ins section
// rather than an error, exactly as `/v1/attention` and `/v1/search` behave - and a card an ACL deny hides
// from them can never arrive here as evidence, because `applyScope` is handed that collection's denies.
//
// The review itself is authorized upstream by the ordinary item decision on `reviews:evidence`, so reading a
// pack about somebody requires being able to read their review in the first place.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import {
  EVIDENCE_CAP,
  evidenceWindow,
  type EvidenceCard,
  type EvidenceCheckIn,
  type EvidenceContribution,
  type EvidenceKudos,
  type ReviewEvidence,
} from "../domain/reviewEvidence";
import { notHeld } from "./withheld";

const day = (v: Date | number) => new Date(v).toISOString().slice(0, 10);

/** One more than the cap is read everywhere, so "there are more" is a fact rather than a guess. */
const TAKE = EVIDENCE_CAP + 1;

export async function reviewEvidenceFor(
  deps: Deps,
  scopes: Map<string, ListScope>,
  review: { uuid: string; employeeId: string; cycleId: string; createdAt: Date | number },
  now: number = Date.now(),
): Promise<ReviewEvidence> {
  const cycle = (await deps.db
    .select({ periodStart: schema.reviewCycles.periodStart, periodEnd: schema.reviewCycles.periodEnd })
    .from(schema.reviewCycles)
    .where(eq(schema.reviewCycles.uuid, review.cycleId))
    .limit(1))[0];
  const { from, to, window } = evidenceWindow(cycle ?? {}, review, now);
  const emp = review.employeeId;

  const [cards, kudos, contributions, checkIns] = await Promise.all([
    deliveredCards(deps, scopes, emp, from, to),
    kudosReceived(deps, scopes.get("announcements"), emp, from, to),
    contributedGoals(deps, scopes.get("goals"), emp, from, to, review.cycleId),
    ownCheckIns(deps, scopes.get("check-ins"), emp, from, to),
  ]);

  const truncated = [cards, kudos, contributions, checkIns].some((s) => s.length > EVIDENCE_CAP);
  return {
    window,
    cards: cards.slice(0, EVIDENCE_CAP),
    kudos: kudos.slice(0, EVIDENCE_CAP),
    contributions: contributions.slice(0, EVIDENCE_CAP),
    check_ins: checkIns.slice(0, EVIDENCE_CAP),
    truncated,
  };
}

/**
 * What they finished, and what it was for.
 *
 * DELIVERED ONLY. A card in flight says what somebody is doing, which is a stand-up question; a review asks
 * what came of the period, and `deliveredAt` is the only column that answers it. Owner OR assignee, because
 * the two are routinely different people and both did something: a card somebody owns and somebody else
 * carried belongs in both their packs, with the reader deciding what that is worth.
 */
async function deliveredCards(
  deps: Deps,
  scopes: Map<string, ListScope>,
  employeeId: string,
  from: number,
  to: number,
): Promise<EvidenceCard[]> {
  const scope = scopes.get("cards");
  if (!scope) return [];
  const rows = await deps.db
    .select({
      uuid: schema.cards.uuid,
      seq: schema.cards.seq,
      keyPrefix: schema.cards.keyPrefix,
      title: schema.cards.title,
      deliveredAt: schema.cards.deliveredAt,
      size: schema.cards.size,
      goalId: schema.cards.goalId,
      boardName: schema.boards.name,
    })
    .from(schema.cards)
    .innerJoin(schema.boards, eq(schema.boards.uuid, schema.cards.boardId))
    .where(and(
      isNull(schema.cards.deleteTime),
      isNotNull(schema.cards.deliveredAt),
      gte(schema.cards.deliveredAt, new Date(from)),
      lt(schema.cards.deliveredAt, new Date(to)),
      or(eq(schema.cards.employeeId, employeeId), eq(schema.cards.assigneeId, employeeId)),
      applyScope(scope, schema.cards.code, schema.cards.employeeId),
    ))
    .orderBy(desc(schema.cards.deliveredAt))
    .limit(TAKE);
  if (rows.length === 0) return [];

  // The goal a card was filed against, named rather than linked by id - the panel is read, not joined. Only
  // the goals the caller may list are resolved, so a card pointing at a goal they cannot see loses its label
  // rather than leaking the title.
  const goalIds = [...new Set(rows.map((r) => r.goalId).filter((g): g is string => !!g))];
  const goalScope = scopes.get("goals");
  const goalTitle = new Map<string, string>();
  if (goalIds.length && goalScope) {
    const goals = await deps.db
      .select({ uuid: schema.goals.uuid, title: schema.goals.title })
      .from(schema.goals)
      .where(and(
        inArray(schema.goals.uuid, goalIds),
        isNull(schema.goals.deleteTime),
        applyScope(goalScope, schema.goals.code, schema.goals.employeeId),
      ));
    for (const g of goals) goalTitle.set(g.uuid, g.title);
  }
  return rows.map((r) => ({
    path: `cards/${r.uuid}`,
    ...(r.seq != null && r.keyPrefix ? { key: `${r.keyPrefix}-${r.seq}` } : {}),
    title: r.title,
    delivered: day(r.deliveredAt!),
    board: r.boardName,
    ...(r.size != null ? { size: r.size } : {}),
    ...(r.goalId && goalTitle.has(r.goalId) ? { goal: { path: `goals/${r.goalId}`, title: goalTitle.get(r.goalId)! } } : {}),
  }));
}

/**
 * What colleagues said at the time, in their own words.
 *
 * A kudos is an announcement with `kind = "kudos"` and a recipient, so this is the wall filtered to one
 * person and one period. It is quoted rather than counted: "four kudos" is a number that invites being read
 * as a score, and the sentence somebody wrote in March is the thing a review should carry.
 */
async function kudosReceived(
  deps: Deps,
  scope: ListScope | undefined,
  employeeId: string,
  from: number,
  to: number,
): Promise<EvidenceKudos[]> {
  if (!scope) return [];
  const rows = await deps.db
    .select({
      uuid: schema.announcements.uuid,
      body: schema.announcements.body,
      createdAt: schema.announcements.createdAt,
      publishTime: schema.announcements.publishTime,
      authorId: schema.announcements.authorEmployeeId,
      category: schema.announcements.category,
      level: schema.announcements.level,
    })
    .from(schema.announcements)
    .where(and(
      eq(schema.announcements.kind, "kudos"),
      eq(schema.announcements.recipientEmployeeId, employeeId),
      isNull(schema.announcements.deleteTime),
      // A hidden kudos is one a moderator took off the wall. It does not come back as evidence.
      eq(schema.announcements.disabled, false),
      // A held kudos has never been seen by anybody, including the person it names. It is not evidence yet.
      notHeld(schema.announcements),
      gte(schema.announcements.createdAt, new Date(from)),
      lt(schema.announcements.createdAt, new Date(to)),
      applyScope(scope, schema.announcements.code, schema.announcements.authorEmployeeId),
    ))
    .orderBy(desc(schema.announcements.createdAt))
    .limit(TAKE);
  if (rows.length === 0) return [];

  const givers = [...new Set(rows.map((r) => r.authorId).filter((a): a is string => !!a))];
  const name = new Map<string, string>();
  if (givers.length) {
    const people = await deps.db
      .select({ uuid: schema.employees.uuid, firstName: schema.employees.firstName, lastName: schema.employees.lastName })
      .from(schema.employees)
      .where(inArray(schema.employees.uuid, givers));
    for (const p of people) name.set(p.uuid, `${p.firstName} ${p.lastName}`.trim());
  }

  return rows.map((r) => ({
    path: `announcements/${r.uuid}`,
    body: r.body,
    at: day(r.publishTime ?? r.createdAt),
    ...(r.authorId && name.has(r.authorId) ? { from: name.get(r.authorId)! } : {}),
    ...(r.category ? { category: r.category } : {}),
    ...(r.level ? { level: r.level } : {}),
  }));
}

/**
 * Other people's goals they were credited a share of.
 *
 * This is the half of the year that a review made from one person's own goal list cannot see: the launch two
 * teams pulled off counts on one row, and everybody else's contribution is invisible unless somebody
 * remembers it. `goal_contributors` records the share; this reads it back at the moment it matters.
 */
async function contributedGoals(
  deps: Deps,
  scope: ListScope | undefined,
  employeeId: string,
  from: number,
  to: number,
  cycleId: string,
): Promise<EvidenceContribution[]> {
  if (!scope) return [];
  const rows = await deps.db
    .select({
      uuid: schema.goals.uuid,
      title: schema.goals.title,
      progress: schema.goals.progress,
      status: schema.goals.status,
      share: schema.goalContributors.share,
      note: schema.goalContributors.note,
    })
    .from(schema.goalContributors)
    .innerJoin(schema.goals, eq(schema.goals.uuid, schema.goalContributors.goalId))
    .where(and(
      eq(schema.goalContributors.employeeId, employeeId),
      // Their own goals are already the review's evidence, attached to it as the cycle's snapshot.
      ne(schema.goals.employeeId, employeeId),
      isNull(schema.goals.deleteTime),
      // The cycle's own goals, plus anything else credited inside the window: a goal set for no cycle is
      // still work somebody did this year.
      or(eq(schema.goals.cycleId, cycleId), and(gte(schema.goalContributors.createdAt, new Date(from)), lt(schema.goalContributors.createdAt, new Date(to)))),
      applyScope(scope, schema.goals.code, schema.goals.employeeId),
    ))
    .orderBy(desc(schema.goalContributors.share))
    .limit(TAKE);

  return rows.map((r) => ({
    path: `goals/${r.uuid}`,
    title: r.title,
    share: r.share,
    ...(r.note ? { note: r.note } : {}),
    progress: r.progress,
    status: r.status,
  }));
}

/**
 * The shared notes of their own 1:1s.
 *
 * ONLY `notes`, and that is a rule rather than a column list that happened to come out this way. A check-in
 * carries two private notes - one per party - served to their owner and stripped for everybody else
 * (services/checkIns.ts), and the whole point of them is that a 1:1 whose every word is read by both people
 * is a 1:1 where the honest half goes somewhere else. Those columns are not selected here at all, so no
 * future shape change to this file can start including them by accident.
 */
async function ownCheckIns(
  deps: Deps,
  scope: ListScope | undefined,
  employeeId: string,
  from: number,
  to: number,
): Promise<EvidenceCheckIn[]> {
  if (!scope) return [];
  const rows = await deps.db
    .select({
      uuid: schema.checkIns.uuid,
      notes: schema.checkIns.notes,
      meetingDate: schema.checkIns.meetingDate,
      createdAt: schema.checkIns.createdAt,
    })
    .from(schema.checkIns)
    .where(and(
      eq(schema.checkIns.employeeId, employeeId),
      isNull(schema.checkIns.deleteTime),
      isNotNull(schema.checkIns.notes),
      // WINDOWED ON THE DATE THIS IS RENDERED BY. A 1:1 is usually filed before it happens, so bounding on
      // `created_at` while showing `meeting_date` dropped the December-booked January meeting out of a Q1
      // pack and let a meeting booked for April in - rendered with an April date, outside the window the
      // same response states. `created_at` is the fallback only where the meeting was never dated.
      or(
        and(isNotNull(schema.checkIns.meetingDate), gte(schema.checkIns.meetingDate, new Date(from)), lt(schema.checkIns.meetingDate, new Date(to))),
        and(isNull(schema.checkIns.meetingDate), gte(schema.checkIns.createdAt, new Date(from)), lt(schema.checkIns.createdAt, new Date(to))),
      ),
      applyScope(scope, schema.checkIns.code, schema.checkIns.employeeId),
    ))
    .orderBy(desc(schema.checkIns.createdAt))
    .limit(TAKE);

  return rows
    .filter((r) => (r.notes ?? "").trim().length > 0)
    .map((r) => ({
      path: `check-ins/${r.uuid}`,
      date: day(r.meetingDate ?? r.createdAt),
      notes: r.notes!,
    }));
}
