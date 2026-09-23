// The duplicate check, run by the board on itself overnight.
//
// WHY A SWEEP AT ALL, when `cards:triage` already finds duplicates: it finds them when somebody opens the
// panel, which is after the second card was filed, and usually by the person who filed it - the one person
// who is sure it is not a duplicate. The pair that matters is the one filed by two different people in two
// different weeks, and nobody opens a panel to look for it.
//
// NO GENERATION AND NO EMBEDDING. Every card in the index already has its vector; this asks the index for
// neighbours and writes what came back. The cost is queries and D1 writes, which is why it can run over the
// whole open backlog rather than a sample of it.
//
// WHAT IT WRITES: one `ai_suggestions` row per card that has a lookalike, keyed (cards, <id>,
// cards.duplicates) so a re-run REPLACES the previous answer rather than stacking. Nothing is written to the
// card itself, ever - a sweep that merged, closed or relabelled work overnight is the version of this that
// should not exist.
//
// NO SCOPE IS BOUND, and that is right for a cron: there is no caller. The rows are read back through
// `boardDuplicates`, which binds the reader's own card list scope at that point, so a card somebody may not
// list can never reach them - the sweep just does not know who will eventually ask.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { parseVectorId, vectorIdOf } from "../lib/vector";
import { aiConfig, aiFeatureOn } from "./ai";
import { cardDuplicateScore, MODELS } from "../domain/aiPolicy";

/** The feature key these rows carry, and the one `boardDuplicates` reads back. */
export const SWEEP_FEATURE = "cards.duplicates";

/**
 * Cards examined per nightly tick.
 *
 * A ceiling on SUBREQUESTS, not on usefulness: each card is one index query, and the tick already runs
 * twenty-odd subtasks inside one invocation's budget. A backlog larger than this is swept over several
 * nights, oldest-unswept first, which converges - the same way the embed drain spreads a first-run backfill.
 */
const SWEEP_CARDS = 60;

/** Neighbours asked per card. The threshold throws nearly all of them away. */
const TOP_K = 10;

/** Lookalikes kept per card. A backlog groomer needs the pair, not a ranking. */
const KEEP = 3;

export type SweepResult = { scanned: number; flagged: number };

export async function sweepCardDuplicates(deps: Deps): Promise<SweepResult> {
  const out: SweepResult = { scanned: 0, flagged: 0 };
  if (!deps.vectors) return out;
  // Rides the board triage switch: an org that has not agreed to compare its cards has not agreed to compare
  // them overnight either. Checked before anything is read, so off costs nothing.
  if (!(await aiFeatureOn(deps, "cards.triage"))) return out;
  const threshold = cardDuplicateScore((await aiConfig(deps)).cardDuplicateSensitivity);

  // The open backlog, least-recently-swept first. `ai_suggestions.updated_at` is the sweep's own clock, so a
  // card never looked at leads (no row at all), and a card swept last night goes to the back.
  const candidates = await deps.db
    .select({
      uuid: schema.cards.uuid,
      boardId: schema.cards.boardId,
      title: schema.cards.title,
      sweptAt: schema.aiSuggestions.updatedAt,
    })
    .from(schema.cards)
    .leftJoin(schema.aiSuggestions, and(
      eq(schema.aiSuggestions.hostCollection, "cards"),
      eq(schema.aiSuggestions.hostRecordId, schema.cards.uuid),
      eq(schema.aiSuggestions.feature, SWEEP_FEATURE),
    ))
    .where(and(
      isNull(schema.cards.deleteTime),
      // Only work still in flight can be duplicated: filing the same thing twice is a problem exactly while
      // both are open, and a delivered lookalike is history.
      isNull(schema.cards.deliveredAt),
    ))
    .orderBy(sql`${schema.aiSuggestions.updatedAt} is not null`, schema.aiSuggestions.updatedAt)
    .limit(SWEEP_CARDS);
  if (candidates.length === 0) return out;

  for (const card of candidates) {
    const self = vectorIdOf("cards", card.uuid);
    let vector: number[] | undefined;
    try {
      vector = (await deps.vectors.fetch([self])).get(self);
    } catch (e) {
      console.error("duplicate sweep: vector fetch failed", e);
      continue;
    }
    // Not embedded yet. The embed drain reaches it, and the next sweep finds it here again.
    if (!vector) continue;
    out.scanned++;

    let matches: { id: string; score: number }[];
    try {
      matches = await deps.vectors.query(vector, { topK: TOP_K, collections: ["cards"] });
    } catch (e) {
      console.error("duplicate sweep: query failed", e);
      continue;
    }

    const near: { id: string; score: number }[] = [];
    for (const m of matches) {
      if (m.score < threshold) continue;
      const parsed = parseVectorId(m.id);
      if (!parsed || parsed.collection !== "cards" || parsed.recordId === card.uuid) continue;
      near.push({ id: parsed.recordId, score: m.score });
    }

    // The index answers with whatever is in it, including cards that have since been delivered or deleted,
    // so the candidates are confirmed against the table before anything is written.
    const confirmed = near.length
      ? await deps.db
        .select({ uuid: schema.cards.uuid, title: schema.cards.title, columnKey: schema.cards.columnKey })
        .from(schema.cards)
        .where(and(
          inArray(schema.cards.uuid, near.map((n) => n.id)),
          isNull(schema.cards.deleteTime),
          isNull(schema.cards.deliveredAt),
          // THE SAME BOARD, because the index is org-wide and a backlog is not. Two teams tracking similar
          // work on their own boards is not somebody having filed the same thing twice, and the stored
          // payload carries a COLUMN KEY - which means a different board's column vocabulary rendered
          // against this one's.
          eq(schema.cards.boardId, card.boardId),
        ))
      : [];

    const scoreOf = new Map(near.map((n) => [n.id, n.score]));
    const duplicates = confirmed
      .map((r) => ({ path: `cards/${r.uuid}`, title: r.title, column: r.columnKey, score: scoreOf.get(r.uuid) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, KEEP);

    // THE ROW IS WRITTEN EITHER WAY, INCLUDING WITH AN EMPTY LIST, and that is what makes the ordering above
    // work at all. `updated_at` on this row is the sweep's only record of having looked at a card; deleting
    // the row when nothing was found would put that card straight back at the front of the "never swept"
    // queue, and a backlog larger than one tick would then be the same sixty cards every night for ever
    // while the rest were never reached. An empty list is a finding - "looked, nothing like it" - and
    // `boardDuplicates` renders it as nothing, which is the same thing a missing row used to mean.
    const payload = JSON.stringify({
      board: `boards/${card.boardId}`,
      title: card.title,
      duplicates,
    });

    await deps.db
      .insert(schema.aiSuggestions)
      .values({
        hostCollection: "cards",
        hostRecordId: card.uuid,
        feature: SWEEP_FEATURE,
        payloadJson: payload,
        // The embedding model is what produced the neighbours; no generative model was involved.
        model: MODELS.embed,
        basis: duplicates.length,
        state: "pending",
      })
      .onConflictDoUpdate({
        target: [schema.aiSuggestions.hostCollection, schema.aiSuggestions.hostRecordId, schema.aiSuggestions.feature],
        set: {
          // A pair that stopped looking alike (somebody rewrote one of them) has its warning REPLACED by an
          // empty list rather than left to age: a stale duplicate warning about work that was merged last
          // week is worse than none, because somebody goes and checks it.
          payloadJson: payload,
          basis: duplicates.length,
          // A fresh answer is a fresh decision: a pair somebody dismissed last month and filed again this
          // month is worth raising again.
          state: "pending",
          decidedBy: null,
          decidedAt: null,
          updatedAt: new Date(),
        },
      });
    if (duplicates.length > 0) out.flagged++;
  }
  return out;
}

export type BoardDuplicatePair = {
  /** The card the sweep was looking at. */
  card: { path: string; title: string };
  /** What it looks like, with the column each one is sitting in. */
  duplicates: { path: string; title: string; column: string; score: number }[];
};

/**
 * What the sweep found on one board, for whoever grooms its backlog.
 *
 * THE READER'S OWN SCOPE IS BOUND HERE, which is the half the cron could not do: both sides of every pair
 * are re-read under `applyScope`, so a pair involving a card this caller may not list is dropped entirely
 * rather than shown with one half missing.
 *
 * Pairs are reported ONCE. The sweep writes a row per card, so A-looks-like-B and B-looks-like-A are both in
 * the table; a groomer wants one line about one problem.
 */
export async function boardDuplicates(deps: Deps, scope: ListScope | undefined, boardId: string): Promise<BoardDuplicatePair[]> {
  const rows = await deps.db
    .select({
      hostRecordId: schema.aiSuggestions.hostRecordId,
      payload: schema.aiSuggestions.payloadJson,
      title: schema.cards.title,
    })
    .from(schema.aiSuggestions)
    .innerJoin(schema.cards, eq(schema.cards.uuid, schema.aiSuggestions.hostRecordId))
    .where(and(
      eq(schema.aiSuggestions.hostCollection, "cards"),
      eq(schema.aiSuggestions.feature, SWEEP_FEATURE),
      eq(schema.aiSuggestions.state, "pending"),
      eq(schema.cards.boardId, boardId),
      isNull(schema.cards.deleteTime),
      isNull(schema.cards.deliveredAt),
      applyScope(scope, schema.cards.code, schema.cards.employeeId),
    ))
    .orderBy(desc(schema.aiSuggestions.updatedAt))
    .limit(50);
  if (rows.length === 0) return [];

  type Pay = { duplicates?: { path: string; title: string; column: string; score: number }[] };
  const wanted = new Set<string>();
  const parsed = rows.map((r) => {
    let payload: Pay = {};
    try {
      payload = JSON.parse(r.payload) as Pay;
    } catch {
      payload = {}; // a row that will not parse is a row to skip, not a request to fail the page
    }
    for (const d of payload.duplicates ?? []) wanted.add(d.path.split("/").pop()!);
    return { id: r.hostRecordId, title: r.title, duplicates: payload.duplicates ?? [] };
  });

  // The other half of every pair, under the same scope. A card an ACL deny hides from this reader must not
  // arrive as the thing their card supposedly duplicates.
  //
  // ITS TITLE AND COLUMN COME BACK WITH IT, live. The payload carries what the sweep saw last night, and a
  // card renamed or moved since then was rendered under last night's title in last night's column - while the
  // HOST card's title was read live off the join above, so one half of every pair was current and the other
  // was not. The read is already happening; taking two more columns off it costs nothing.
  const visible = new Map<string, { title: string; column: string }>();
  if (wanted.size) {
    const others = await byIdChunks([...wanted], (ids) =>
      deps.db
        .select({ uuid: schema.cards.uuid, title: schema.cards.title, columnKey: schema.cards.columnKey })
        .from(schema.cards)
        .where(and(
          inArray(schema.cards.uuid, ids),
          isNull(schema.cards.deleteTime),
          isNull(schema.cards.deliveredAt),
          applyScope(scope, schema.cards.code, schema.cards.employeeId),
        )),
    );
    for (const o of others) visible.set(o.uuid, { title: o.title, column: o.columnKey });
  }

  const seenPair = new Set<string>();
  const out: BoardDuplicatePair[] = [];
  for (const row of parsed) {
    const kept: BoardDuplicatePair["duplicates"] = [];
    for (const d of row.duplicates) {
      const otherId = d.path.split("/").pop()!;
      const live = visible.get(otherId);
      if (!live) continue;
      // One line per problem: the pair is keyed by both ids, whichever way round the sweep wrote it.
      const key = [row.id, otherId].sort().join("\u0000");
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      // The SCORE is the sweep's - it is a statement about the text as it was compared - but the title and
      // the column are what the card says now.
      kept.push({ path: d.path, score: d.score, title: live.title, column: live.column });
    }
    if (kept.length) out.push({ card: { path: `cards/${row.id}`, title: row.title }, duplicates: kept });
  }
  return out;
}

/** Sweep rows for cards that have since been delivered or deleted, cleared on the same tick. Keeps the table
 *  from accumulating answers about work nobody can act on. */
export async function pruneDuplicateSuggestions(deps: Deps): Promise<number> {
  const stale = await deps.db
    .select({ uuid: schema.aiSuggestions.uuid })
    .from(schema.aiSuggestions)
    .innerJoin(schema.cards, eq(schema.cards.uuid, schema.aiSuggestions.hostRecordId))
    .where(and(
      eq(schema.aiSuggestions.hostCollection, "cards"),
      eq(schema.aiSuggestions.feature, SWEEP_FEATURE),
      sql`(${schema.cards.deleteTime} is not null or ${schema.cards.deliveredAt} is not null)`,
    ))
    .limit(200);
  if (stale.length === 0) return 0;
  await deps.db.delete(schema.aiSuggestions).where(inArray(schema.aiSuggestions.uuid, stale.map((s) => s.uuid)));
  return stale.length;
}
