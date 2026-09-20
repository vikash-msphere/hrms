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
import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { parseVectorId, vectorIdOf } from "../lib/vector";
import { aiFeatureOn } from "./ai";
import { vote, type TriageVote } from "./ticketTriage";

/** Neighbours asked of the index. The SQL re-check throws most away for a narrowly-scoped caller, so this is
 *  generous on purpose - the same reasoning as the semantic search top-k. */
const TOP_K = 40;

/** How alike two cards must look before one is offered as "you may already have this". Deliberately high: a
 *  false duplicate sends somebody to read a card that has nothing to do with theirs, and two of those teach
 *  people to ignore the panel. */
const DUPLICATE_SCORE = 0.82;

export type CardTriage = {
  department: TriageVote<string> | null;
  priority: TriageVote<string> | null;
  /** Size in the board's own points. Voted like the rest: what comparable work actually turned out to be. */
  size: TriageVote<string> | null;
  /** The delivered cards the votes came from, so a person can check the reasoning rather than trust it. */
  basis: { path: string; title: string; score: number }[];
  /** Cards still in flight that look like this one. */
  duplicates: { path: string; title: string; score: number; column: string }[];
};

export async function suggestCardTriage(deps: Deps, scope: ListScope | undefined, cardId: string): Promise<CardTriage | null> {
  if (!deps.vectors) return null;
  // The org's switch, checked before anything is read: off must cost nothing, not merely produce nothing.
  if (!(await aiFeatureOn(deps, "cards.triage"))) return null;

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
    .filter((r) => r.deliveredAt === null && r.score >= DUPLICATE_SCORE)
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
  // Nothing to say: no field cleared the floor and nothing looks duplicated.
  if (!triage.department && !triage.priority && !triage.size && duplicates.length === 0) return null;
  return triage;
}

/** Cards that have been delivered at least once, for the tests that need a corpus to vote from. */
export const hasDelivered = isNotNull(schema.cards.deliveredAt);
