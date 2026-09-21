// One card's ageing against the board's own record of comparable work.
//
// The arithmetic is in domain/cardFlow.ts; this file is the two reads and the access rule.
//
// SCOPED LIKE A LIST, and registered in SCOPE_READING_VERBS for it: the answer is computed from OTHER cards
// on the board, so the corpus is exactly the set this caller could have listed themselves. A narrowly-scoped
// reader gets a smaller sample and a `count` that says so, rather than percentiles drawn from rows an ACL
// deny hides from them.
//
// NO MODEL, NO FLAG. There is nothing here to switch off: the movement log is written by the `move` verb on
// every board, and a board with no history answers "nothing comparable yet" rather than degrading.
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { cardFlow, type CardFlow } from "../domain/cardFlow";

/** How far back the corpus reaches. A board's way of working changes; a column's behaviour two years ago is
 *  not evidence about it now, and the read has to stay bounded on a board that has run for years. */
const WINDOW_DAYS = 365;

/** Cards read as the corpus, newest first. A percentile settles long before this many samples, and the cap is
 *  what keeps an on-press panel from reading a large board end to end. */
const CORPUS_CARDS = 500;

export async function cardFlowFor(deps: Deps, scope: ListScope | undefined, cardId: string): Promise<CardFlow | null> {
  const card = (await deps.db
    .select({
      uuid: schema.cards.uuid,
      boardId: schema.cards.boardId,
      columnKey: schema.cards.columnKey,
      columnSince: schema.cards.columnSince,
      size: schema.cards.size,
      deliveredAt: schema.cards.deliveredAt,
      createdAt: schema.cards.createdAt,
    })
    .from(schema.cards)
    .where(and(eq(schema.cards.uuid, cardId), isNull(schema.cards.deleteTime)))
    .limit(1))[0];
  if (!card) return null;

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  // The board's cards, under the caller's own list scope. Deleted cards are not work, the same way the board
  // metrics read them out of every other figure on this board.
  const corpus = await deps.db
    .select({ uuid: schema.cards.uuid, columnKey: schema.cards.columnKey, size: schema.cards.size, deliveredAt: schema.cards.deliveredAt })
    .from(schema.cards)
    .where(and(
      eq(schema.cards.boardId, card.boardId),
      isNull(schema.cards.deleteTime),
      gte(schema.cards.createdAt, since),
      applyScope(scope, schema.cards.code, schema.cards.employeeId),
    ))
    // BOUNDED, unlike the board roll-up this borrows its shape from. That one runs once for an analytics tab
    // somebody opened deliberately; this runs per card, on a press, so a board with years of history would
    // pay for its whole past every time. Newest first, because a column's behaviour last quarter is the
    // evidence about it now.
    .orderBy(desc(schema.cards.createdAt))
    .limit(CORPUS_CARDS);

  const live = new Set(corpus.map((c) => c.uuid));
  // `card_movements` carries no delete stamp of its own (the soft delete marks the card), so the visible card
  // ids are what say which movements still describe work this caller may be told about.
  const moves = await deps.db
    .select({ cardId: schema.cardMovements.cardId, toColumn: schema.cardMovements.toColumn, at: schema.cardMovements.at })
    .from(schema.cardMovements)
    .where(and(eq(schema.cardMovements.boardId, card.boardId), gte(schema.cardMovements.at, since)));

  const flow = cardFlow(
    {
      uuid: card.uuid,
      columnKey: card.columnKey,
      size: card.size ?? null,
      columnSince: card.columnSince ? +new Date(card.columnSince) : null,
      deliveredAt: card.deliveredAt ? +new Date(card.deliveredAt) : null,
    },
    corpus.map((c) => ({ uuid: c.uuid, columnKey: c.columnKey, size: c.size ?? null, deliveredAt: c.deliveredAt ? +new Date(c.deliveredAt) : null })),
    moves.filter((m) => live.has(m.cardId)).map((m) => ({ cardId: m.cardId, toColumn: m.toColumn, at: +new Date(m.at) })),
  );
  // Nothing comparable has been through this column yet. Said as an absence rather than as zeroes, which
  // would read as "everything here takes no time".
  if (!flow.dwell && !flow.to_delivery) return null;
  return flow;
}
