// What similar past work says about a card: where it belongs, how big it is, and whether somebody has
// already filed it.
//
// THE SAME SHAPE AS services/ticketTriage.ts, and deliberately so - the useful half of a board is the work
// that came before it, and the index already holds every card. What differs is what counts as EVIDENCE.
//
// A ticket votes from RESOLVED neighbours, because a resolved ticket's department was confirmed by somebody
// working it. A card's equivalent is a DELIVERED card: `deliveredAt` is stamped when it reaches a done
// column, and until then its department and size are a guess the board has not yet tested. Letting open cards
// vote would let one mis-filed card teach the board to mis-file the next.
//
// THE DUPLICATE HALF IS THE OTHER WAY AROUND: only cards still in flight can be duplicated, because filing
// the same work twice is a problem exactly while both are open. A delivered card that looks like this one is
// history, and usually the reason this one exists.
//
// Nothing is written to the card. The panel suggests; a person picks. That is what keeps this on the right
// side of the line the AI plan draws - the model narrows a choice somebody was already making, and every
// field still changes only when they change it.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { parseVectorId, vectorIdOf } from "../lib/vector";
import { aiConfig, aiFeatureOn } from "./ai";
import { cardDuplicateScore } from "../domain/aiPolicy";
import { vote, type TriageVote } from "./ticketTriage";

/** Neighbours asked of the index. The SQL re-check throws most away for a narrowly-scoped caller, so this is
 *  generous on purpose - the same reasoning as the semantic search top-k. */
const TOP_K = 40;


export type CardTriage = {
  department: TriageVote<string> | null;
  priority: TriageVote<string> | null;
  /** Size in the board's own points. Voted like the rest: what comparable work actually turned out to be. */
  size: TriageVote<string> | null;
  /** The delivered cards the votes came from, so a person can check the reasoning rather than trust it. */
  basis: { path: string; title: string; score: number }[];
  /** Cards still in flight that look like this one. */
  duplicates: { path: string; title: string; score: number; column: string }[];
  /** How long comparable work actually took, start to delivery, in days. Absent when no neighbour carries
   *  both ends of that measurement. */
  took?: { p50: number; p85: number; count: number };
  /** How many of the comparable cards were blocked at some point, and what stopped them. Read off the event
   *  log, because the card row keeps only the CURRENT block - a reason is cleared the moment somebody
   *  unblocks, so the card that spent three weeks waiting on a vendor looks, afterwards, like it never
   *  waited for anything. */
  blocked?: { cards: number; of: number; reasons: string[] };
};

export async function suggestCardTriage(deps: Deps, scope: ListScope | undefined, cardId: string): Promise<CardTriage | null> {
  if (!deps.vectors) return null;
  // The org's switch, checked before anything is read: off must cost nothing, not merely produce nothing.
  if (!(await aiFeatureOn(deps, "cards.triage"))) return null;
  // The org says how alike is alike enough, as a named position rather than a cosine value it could not
  // sensibly pick (domain/aiPolicy.ts CARD_DUPLICATE_SCORES).
  const duplicateScore = cardDuplicateScore((await aiConfig(deps)).cardDuplicateSensitivity);

  // The card's OWN vector, fetched rather than recomputed - re-embedding would cost a neuron per panel open
  // and could disagree with what is actually in the index, making the neighbours wrong in a way nothing would
  // ever surface.
  const self = vectorIdOf("cards", cardId);
  let vector: number[] | undefined;
  try {
    vector = (await deps.vectors.fetch([self])).get(self);
  } catch (e) {
    console.error("card triage vector fetch failed", e);
    return null;
  }
  if (!vector) return null; // not indexed yet; the drain will reach it

  let matches: { id: string; score: number }[];
  try {
    matches = await deps.vectors.query(vector, { topK: TOP_K, collections: ["cards"] });
  } catch (e) {
    // An index outage makes the panel absent, never the board broken.
    console.error("card triage query failed", e);
    return null;
  }

  const scoreOf = new Map<string, number>();
  for (const m of matches) {
    const parsed = parseVectorId(m.id);
    if (!parsed || parsed.collection !== "cards" || parsed.recordId === cardId) continue;
    scoreOf.set(parsed.recordId, m.score);
  }
  if (scoreOf.size === 0) return null;

  // THE ACCESS RE-CHECK, and the reason this verb is in `SCOPE_READING_VERBS`: it answers with cards OTHER
  // than the one named, so it binds the caller's own card-list scope - the same predicate `listCards` uses -
  // and a card an ACL deny hides from them can never appear here as a neighbour.
  const rows = await byIdChunks([...scoreOf.keys()], (ids) =>
    deps.db
      .select({
        uuid: schema.cards.uuid,
        title: schema.cards.title,
        columnKey: schema.cards.columnKey,
        deliveredAt: schema.cards.deliveredAt,
        startedAt: schema.cards.startedAt,
        committedAt: schema.cards.committedAt,
        createdAt: schema.cards.createdAt,
        departmentId: schema.cards.departmentId,
        priority: schema.cards.priority,
        size: schema.cards.size,
      })
      .from(schema.cards)
      .where(and(
        inArray(schema.cards.uuid, ids),
        isNull(schema.cards.deleteTime),
        applyScope(scope, schema.cards.code, schema.cards.employeeId),
      )),
  );
  if (rows.length === 0) return null;

  const visible = rows
    .map((r) => ({ ...r, score: scoreOf.get(r.uuid) ?? 0 }))
    .sort((a, b) => b.score - a.score);

  const delivered = visible.filter((r) => r.deliveredAt !== null);
  const duplicates = visible
    .filter((r) => r.deliveredAt === null && r.score >= duplicateScore)
    .map((r) => ({ path: `cards/${r.uuid}`, title: r.title, score: r.score, column: r.columnKey }));

  const triage: CardTriage = {
    department: vote(delivered.map((r) => r.departmentId)),
    priority: vote(delivered.map((r) => r.priority)),
    // Numbers as strings so one vote implementation serves all three. A size is a board's own scale, not an
    // arithmetic quantity to average - "most comparable work came out at 3" is the honest claim, and a mean
    // of 2.6 would be a number no card can carry.
    size: vote(delivered.map((r) => (r.size == null ? null : String(r.size)))),
    basis: delivered.map((r) => ({ path: `cards/${r.uuid}`, title: r.title, score: r.score })),
    duplicates,
  };

  // TWO MORE ANSWERS OFF THE SAME NEIGHBOURS. The index query and the scoped re-read are already paid for;
  // what a person about to start this work wants next is how long it took last time and what stopped it, and
  // both are in rows already in hand or one indexed read away.
  const took = durationStat(delivered);
  if (took) triage.took = took;
  const blocked = await blockHistory(deps, delivered.map((r) => r.uuid));
  if (blocked) triage.blocked = blocked;

  // Nothing to say: no field cleared the floor, nothing looks duplicated, and the neighbours have no history
  // worth reporting either.
  if (!triage.department && !triage.priority && !triage.size && duplicates.length === 0 && !took && !blocked) return null;
  return triage;
}

const DAY = 86_400_000;
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/**
 * How long the comparable work actually took, in days.
 *
 * Measured from when work STARTED where the card says so, falling back to when it was committed and then to
 * when it was filed. The fallbacks matter more than they look: a board that never uses the commitment point
 * would otherwise report nothing at all, and "we have no idea" is the answer somebody is trying to replace.
 */
function durationStat(delivered: { deliveredAt: Date | number | null; startedAt: Date | number | null; committedAt: Date | number | null; createdAt: Date | number }[]) {
  const days: number[] = [];
  for (const r of delivered) {
    if (!r.deliveredAt) continue;
    const start = r.startedAt ?? r.committedAt ?? r.createdAt;
    const d = (+new Date(r.deliveredAt) - +new Date(start)) / DAY;
    if (d >= 0) days.push(d);
  }
  if (days.length === 0) return undefined;
  const s = days.sort((a, b) => a - b);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return { p50: round1(percentile(s, 50)), p85: round1(percentile(s, 85)), count: s.length };
}

/**
 * What stopped the comparable cards, from the event log.
 *
 * ONE INDEXED READ, and it answers a question the card table cannot: `blockReason` is cleared on unblock
 * (services/cards.ts), so the row of a card that waited three weeks on a vendor reads afterwards as a card
 * that was never blocked. `card.blocked` events keep the reason at the moment it was true.
 *
 * NO SEPARATE ACCESS DECISION, and none is needed: every id here survived the caller's own card list scope a
 * few lines above, and a block reason is card-level text the same caller reads on the card itself. Nothing
 * is read for an id that did not.
 */
async function blockHistory(deps: Deps, ids: string[]): Promise<{ cards: number; of: number; reasons: string[] } | undefined> {
  if (ids.length === 0) return undefined;
  const subjects = ids.map((id) => `cards/${id}`);
  const rows = await byIdChunks(subjects, (chunk) =>
    deps.db
      .select({ subject: schema.eventLog.subject, payload: schema.eventLog.payloadJson })
      .from(schema.eventLog)
      .where(and(eq(schema.eventLog.type, "card.blocked"), inArray(schema.eventLog.subject, chunk))),
  );
  if (rows.length === 0) return undefined;

  const cards = new Set<string>();
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.subject) cards.add(r.subject);
    let reason: unknown;
    try {
      reason = r.payload ? (JSON.parse(r.payload) as { reason?: unknown }).reason : undefined;
    } catch {
      reason = undefined; // a payload that will not parse is a row to skip, not a request to fail
    }
    const text = typeof reason === "string" ? reason.trim() : "";
    if (text) seen.set(text, (seen.get(text) ?? 0) + 1);
  }
  return {
    cards: cards.size,
    of: ids.length,
    // The commonest first, and only a few: this is a hint about what to check before starting, not a report.
    reasons: [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text]) => text),
  };
}

/** Cards that have been delivered at least once, for the tests that need a corpus to vote from. */
export const hasDelivered = isNotNull(schema.cards.deliveredAt);

/**
 * The goal this card is probably serving.
 *
 * `cards.goal_id` has existed as long as the boards have, and `deliveryAdvancesGoal` rolls a delivered card's
 * progress up into the goal it names - which is a feature that does nothing, because the link is filled in by
 * hand and so it usually is not. A card and a goal about the same work are two pieces of text about the same
 * work, and the index already holds both.
 *
 * BINDS THE GOALS SCOPE, NOT THE CARDS ONE, which is why the verb is registered in SCOPE_READING_VERBS
 * against `goals`: everything it answers with is a goal, and a goal is frequently a statement of strategy. A
 * goal the caller could not have listed is never named, so a board member with no sight of their department's
 * goals is offered nothing rather than a title they should not read.
 *
 * Nothing is written. The dialog's own Goal field takes the suggestion, and saving it is the ordinary card
 * update with the ordinary audit row.
 */
export async function suggestGoalForCard(deps: Deps, goalScope: ListScope | undefined, cardId: string): Promise<{ path: string; title: string; score: number; owner?: string }[]> {
  if (!deps.vectors) return [];
  if (!(await aiFeatureOn(deps, "cards.triage"))) return [];

  const card = (await deps.db
    .select({ uuid: schema.cards.uuid, goalId: schema.cards.goalId })
    .from(schema.cards)
    .where(and(eq(schema.cards.uuid, cardId), isNull(schema.cards.deleteTime)))
    .limit(1))[0];
  // A card that already names a goal has had this decided by a person.
  if (!card || card.goalId) return [];

  const self = vectorIdOf("cards", cardId);
  let vector: number[] | undefined;
  try {
    vector = (await deps.vectors.fetch([self])).get(self);
  } catch (e) {
    console.error("card goal match: vector fetch failed", e);
    return [];
  }
  if (!vector) return [];

  let matches: { id: string; score: number }[];
  try {
    // The card's own vector against the GOALS half of the index. One query, no embedding: the neighbours are
    // in a different collection, which is the whole trick.
    matches = await deps.vectors.query(vector, { topK: GOAL_TOP_K, collections: ["goals"] });
  } catch (e) {
    console.error("card goal match: query failed", e);
    return [];
  }

  const scoreOf = new Map<string, number>();
  for (const m of matches) {
    if (m.score < GOAL_MATCH_SCORE) continue;
    const parsed = parseVectorId(m.id);
    if (!parsed || parsed.collection !== "goals") continue;
    scoreOf.set(parsed.recordId, m.score);
  }
  if (scoreOf.size === 0) return [];

  const rows = await byIdChunks([...scoreOf.keys()], (ids) =>
    deps.db
      .select({
        uuid: schema.goals.uuid,
        title: schema.goals.title,
        status: schema.goals.status,
        firstName: schema.employees.firstName,
        lastName: schema.employees.lastName,
      })
      .from(schema.goals)
      .leftJoin(schema.employees, eq(schema.employees.uuid, schema.goals.employeeId))
      .where(and(
        inArray(schema.goals.uuid, ids),
        isNull(schema.goals.deleteTime),
        // Only a live goal can absorb this card's delivery.
        inArray(schema.goals.status, ["not_started", "in_progress"]),
        applyScope(goalScope, schema.goals.code, schema.goals.employeeId),
      )),
  );

  return rows
    .map((r) => ({
      path: `goals/${r.uuid}`,
      title: r.title,
      score: scoreOf.get(r.uuid) ?? 0,
      ...(r.firstName ? { owner: `${r.firstName} ${r.lastName}`.trim() } : {}),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, GOAL_SUGGESTIONS);
}

/** Goals asked of the index before the SQL re-check. */
const GOAL_TOP_K = 15;
/** How close a card has to read to a goal before the link is worth offering. A wrong goal link quietly moves
 *  somebody's progress when the card is delivered, so this sits above the "related goals" floor. */
const GOAL_MATCH_SCORE = 0.8;
/** A field takes one value. Three is enough to recognise the right one without turning a dialog into a list. */
const GOAL_SUGGESTIONS = 3;

/**
 * The steps comparable finished work actually took.
 *
 * THE DRAFT BUTTON ASKS A MODEL TO IMAGINE THEM. The board knows: every delivered card like this one has a
 * checklist somebody ticked off, and the items that recur across several of them are the steps this work
 * really has. That answer is free (the neighbours are one index query away and their checklists are one
 * indexed read), evidence-based rather than plausible, and in the board's own vocabulary - it will say
 * "raise a change request" if that is what this company does.
 *
 * FREQUENCY, NOT ONE NEIGHBOUR'S LIST. An item is offered when it appears on at least two comparable cards:
 * copying one card's checklist wholesale would import whatever was peculiar about that card, and a step that
 * two separate people wrote down is a step.
 *
 * Falls back to nothing rather than to something weak. The `task-checklist` draft kind is still there for a
 * card with no comparable history, which is the right division: the model writes when there is nothing to
 * read, and reads when there is.
 */
export async function suggestStepsForCard(
  deps: Deps,
  scope: ListScope | undefined,
  cardId: string,
): Promise<{ text: string; seen: number; of: number }[]> {
  if (!deps.vectors) return [];
  if (!(await aiFeatureOn(deps, "cards.triage"))) return [];

  const self = vectorIdOf("cards", cardId);
  let vector: number[] | undefined;
  try {
    vector = (await deps.vectors.fetch([self])).get(self);
  } catch (e) {
    console.error("card steps: vector fetch failed", e);
    return [];
  }
  if (!vector) return [];

  let matches: { id: string; score: number }[];
  try {
    matches = await deps.vectors.query(vector, { topK: TOP_K, collections: ["cards"] });
  } catch (e) {
    console.error("card steps: query failed", e);
    return [];
  }

  const ids = new Set<string>();
  for (const m of matches) {
    if (m.score < STEP_SCORE) continue;
    const parsed = parseVectorId(m.id);
    if (!parsed || parsed.collection !== "cards" || parsed.recordId === cardId) continue;
    ids.add(parsed.recordId);
  }
  if (ids.size === 0) return [];

  // DELIVERED neighbours only, under the caller's own card scope - the same evidence rule the votes use. A
  // checklist on a card still in flight is a plan, not a record of what the work took.
  const delivered = await byIdChunks([...ids], (chunk) =>
    deps.db
      .select({ uuid: schema.cards.uuid })
      .from(schema.cards)
      .where(and(
        inArray(schema.cards.uuid, chunk),
        isNull(schema.cards.deleteTime),
        isNotNull(schema.cards.deliveredAt),
        applyScope(scope, schema.cards.code, schema.cards.employeeId),
      )),
  );
  if (delivered.length < MIN_NEIGHBOURS) return [];

  const todos = await byIdChunks(delivered.map((d) => d.uuid), (chunk) =>
    deps.db
      .select({ cardId: schema.cardTodos.cardId, text: schema.cardTodos.text })
      .from(schema.cardTodos)
      .where(inArray(schema.cardTodos.cardId, chunk)),
  );
  if (todos.length === 0) return [];

  // Counted per CARD, not per row: one card whose checklist repeats an item three times must not out-vote
  // three cards that each wrote it once.
  const cardsByStep = new Map<string, { text: string; cards: Set<string> }>();
  for (const t of todos) {
    const text = t.text.trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ");
    const entry = cardsByStep.get(key) ?? { text, cards: new Set<string>() };
    entry.cards.add(t.cardId);
    cardsByStep.set(key, entry);
  }

  return [...cardsByStep.values()]
    .filter((e) => e.cards.size >= MIN_AGREEMENT)
    .map((e) => ({ text: e.text, seen: e.cards.size, of: delivered.length }))
    .sort((a, b) => b.seen - a.seen)
    .slice(0, MAX_STEPS);
}

/** How alike a delivered card has to be before its checklist is evidence about this one. Below the duplicate
 *  floor: the steps of nearby work are useful where "this is the same card" would be wrong. */
const STEP_SCORE = 0.8;
/** Comparable delivered cards needed before this says anything. Two cards is an anecdote, so three is the
 *  floor - the guard reads `< MIN_NEIGHBOURS`, which admitted exactly the case this rejects while the
 *  constant was 2. */
const MIN_NEIGHBOURS = 3;
/** Cards that must have written a step before it is offered. */
const MIN_AGREEMENT = 2;
/** Steps offered. A checklist somebody has to prune is a checklist they abandon. */
const MAX_STEPS = 7;
