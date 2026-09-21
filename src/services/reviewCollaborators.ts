// Who worked with this person during the cycle: four reads over the collections that already record it.
//
// Same access shape as the evidence pack (services/reviewEvidence.ts): the middleware decides, per
// collection, whether this caller may list it, and this file only binds those verdicts. A caller who may not
// list cards simply gets no task-based signal, which makes the list shorter rather than the request refused.
//
// WHAT IS DELIBERATELY NOT A SIGNAL: the reporting line. A manager is not a 360 - they write the review - and
// a list that suggests "their manager" has told nobody anything. The 1:1 counterpart is left out for the same
// reason, since it is almost always that same person.
import { and, desc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { evidenceWindow } from "../domain/reviewEvidence";
import { rankCollaborators, type Collaborator, type CollaboratorReason } from "../domain/reviewCollaborators";

/** Cards read per side of the join. A cycle's worth of one person's work, bounded so a heavy board cannot
 *  turn a picker into a table scan. */
const CARD_WINDOW = 300;

export async function collaboratorsFor(
  deps: Deps,
  scopes: Map<string, ListScope>,
  review: { uuid: string; employeeId: string; cycleId: string; createdAt: Date | number },
  now: number = Date.now(),
): Promise<Collaborator[]> {
  const cycle = (await deps.db
    .select({ periodStart: schema.reviewCycles.periodStart, periodEnd: schema.reviewCycles.periodEnd })
    .from(schema.reviewCycles)
    .where(eq(schema.reviewCycles.uuid, review.cycleId))
    .limit(1))[0];
  const { from, to } = evidenceWindow(cycle ?? {}, review, now);
  const subject = review.employeeId;

  const signals = new Map<string, CollaboratorReason[]>();
  const add = (employeeId: string, reason: CollaboratorReason) => {
    if (!employeeId || employeeId === subject) return;
    (signals.get(employeeId) ?? signals.set(employeeId, []).get(employeeId)!).push(reason);
  };

  const [tasks, boards] = await taskSignals(deps, scopes.get("cards"), subject, from, to);
  for (const [id, count] of tasks) add(id, { kind: "same_task", detail: `${count} task${count === 1 ? "" : "s"} together`, count });
  for (const [id, count] of boards) add(id, { kind: "same_board", detail: `${count} task${count === 1 ? "" : "s"} on the same board`, count });

  for (const [id, count] of await goalSignals(deps, scopes.get("goals"), subject, from, to))
    add(id, { kind: "shared_goal", detail: `${count} shared goal${count === 1 ? "" : "s"}`, count });

  for (const [id, count] of await kudosSignals(deps, scopes.get("announcements"), subject, from, to))
    add(id, { kind: "kudos", detail: count === 1 ? "exchanged kudos" : `exchanged ${count} kudos`, count });

  if (signals.size === 0) return [];
  // CHUNKED: `signals` holds one entry per distinct colleague found across two windows of 300 cards, so it
  // can run to several hundred ids - well past D1's bound-parameter cap (lib/dbBatch.ts). Unchunked, a busy
  // board turns this endpoint into an error rather than a picker.
  const people = await byIdChunks([...signals.keys()], (group) =>
    deps.db
      .select({ uuid: schema.employees.uuid, firstName: schema.employees.firstName, lastName: schema.employees.lastName, status: schema.employees.status })
      .from(schema.employees)
      .where(inArray(schema.employees.uuid, group)),
  );
  const names = new Map<string, string>();
  for (const p of people) {
    // Somebody who has left cannot answer a feedback request, and offering them reads as the app not knowing
    // who still works here.
    if (p.status !== "active") signals.delete(p.uuid);
    else names.set(p.uuid, `${p.firstName} ${p.lastName}`.trim());
  }
  // An id with no employee row behind it (a deleted record) drops out for the same reason.
  for (const id of [...signals.keys()]) if (!names.has(id)) signals.delete(id);

  return rankCollaborators(signals, names);
}

/**
 * Two signals off one read of the cards the subject touched.
 *
 * The first is the strong one: another name on the SAME card, whether as owner, assignee or the person who
 * filed it. The second is the weak one, and it is a fallback rather than an equal - a board tells you two
 * people were in the same area, which is worth offering when nothing better exists and worth ranking below
 * anything that is.
 */
async function taskSignals(
  deps: Deps,
  scope: ListScope | undefined,
  subject: string,
  from: number,
  to: number,
): Promise<[Map<string, number>, Map<string, number>]> {
  const together = new Map<string, number>();
  const nearby = new Map<string, number>();
  if (!scope) return [together, nearby];

  const window = and(
    isNull(schema.cards.deleteTime),
    gte(schema.cards.createdAt, new Date(from)),
    lt(schema.cards.createdAt, new Date(to)),
    applyScope(scope, schema.cards.code, schema.cards.employeeId),
  );

  const mine = await deps.db
    .select({ uuid: schema.cards.uuid, boardId: schema.cards.boardId, employeeId: schema.cards.employeeId, assigneeId: schema.cards.assigneeId, reporterId: schema.cards.reporterId })
    .from(schema.cards)
    .where(and(window, or(eq(schema.cards.employeeId, subject), eq(schema.cards.assigneeId, subject), eq(schema.cards.reporterId, subject))))
    // Newest first, so a cycle with more cards than the window keeps the recent ones rather than whichever
    // rows the table happened to return - a picker that suggests different people on two visits to the same
    // review is one nobody trusts.
    .orderBy(desc(schema.cards.createdAt))
    .limit(CARD_WINDOW);
  if (mine.length === 0) return [together, nearby];

  const bump = (m: Map<string, number>, id: string | null | undefined) => {
    if (!id || id === subject) return;
    m.set(id, (m.get(id) ?? 0) + 1);
  };
  for (const c of mine) {
    // Each of the three roles counts once per card, so a card somebody both owns and is assigned does not
    // count as two pieces of shared work.
    for (const id of new Set([c.employeeId, c.assigneeId, c.reporterId].filter((x): x is string => !!x && x !== subject))) bump(together, id);
  }

  // Chunked for the same reason: a reviewee who worked across many boards in a cycle would otherwise put
  // more board ids into one statement than D1 accepts bound parameters.
  const boardIds = [...new Set(mine.map((c) => c.boardId))];
  const others = await byIdChunks(boardIds, (group) =>
    deps.db
      .select({ employeeId: schema.cards.employeeId, assigneeId: schema.cards.assigneeId })
      .from(schema.cards)
      .where(and(window, inArray(schema.cards.boardId, group), ne(schema.cards.employeeId, subject)))
      .orderBy(desc(schema.cards.createdAt))
      .limit(CARD_WINDOW),
  );
  for (const c of others) {
    for (const id of new Set([c.employeeId, c.assigneeId].filter((x): x is string => !!x && x !== subject))) {
      // Already counted on a card of their own: the stronger signal stands rather than being added to.
      if (!together.has(id)) bump(nearby, id);
    }
  }
  return [together, nearby];
}

/** Goals with both names on them: they were credited a share of one of the subject's, or the subject was
 *  credited a share of one of theirs. Either way the two of them delivered something together. */
async function goalSignals(
  deps: Deps,
  scope: ListScope | undefined,
  subject: string,
  from: number,
  to: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!scope) return out;
  const inWindow = and(gte(schema.goalContributors.createdAt, new Date(from)), lt(schema.goalContributors.createdAt, new Date(to)));

  // Their share of the subject's goals.
  const onMine = await deps.db
    .select({ employeeId: schema.goalContributors.employeeId })
    .from(schema.goalContributors)
    .innerJoin(schema.goals, eq(schema.goals.uuid, schema.goalContributors.goalId))
    .where(and(
      eq(schema.goals.employeeId, subject),
      isNull(schema.goals.deleteTime),
      inWindow,
      applyScope(scope, schema.goals.code, schema.goals.employeeId),
    ));
  for (const r of onMine) out.set(r.employeeId, (out.get(r.employeeId) ?? 0) + 1);

  // The subject's share of theirs.
  const onTheirs = await deps.db
    .select({ employeeId: schema.goals.employeeId })
    .from(schema.goalContributors)
    .innerJoin(schema.goals, eq(schema.goals.uuid, schema.goalContributors.goalId))
    .where(and(
      eq(schema.goalContributors.employeeId, subject),
      isNull(schema.goals.deleteTime),
      inWindow,
      applyScope(scope, schema.goals.code, schema.goals.employeeId),
    ));
  for (const r of onTheirs) if (r.employeeId !== subject) out.set(r.employeeId, (out.get(r.employeeId) ?? 0) + 1);
  return out;
}

/** Kudos in either direction. Somebody who wrote about this person's work in March has already shown they
 *  saw it, and somebody this person praised is usually somebody they worked alongside. */
async function kudosSignals(
  deps: Deps,
  scope: ListScope | undefined,
  subject: string,
  from: number,
  to: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!scope) return out;
  const rows = await deps.db
    .select({ authorId: schema.announcements.authorEmployeeId, recipientId: schema.announcements.recipientEmployeeId })
    .from(schema.announcements)
    .where(and(
      eq(schema.announcements.kind, "kudos"),
      isNull(schema.announcements.deleteTime),
      eq(schema.announcements.disabled, false),
      gte(schema.announcements.createdAt, new Date(from)),
      lt(schema.announcements.createdAt, new Date(to)),
      or(eq(schema.announcements.recipientEmployeeId, subject), eq(schema.announcements.authorEmployeeId, subject)),
      applyScope(scope, schema.announcements.code, schema.announcements.authorEmployeeId),
    ));
  for (const r of rows) {
    const other = r.authorId === subject ? r.recipientId : r.authorId;
    if (other && other !== subject) out.set(other, (out.get(other) ?? 0) + 1);
  }
  return out;
}
