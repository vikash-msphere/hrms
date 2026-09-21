// How long work like this one has taken on this board, from the board's own movement log. No model, no
// estimate anybody has to maintain, and nothing stored: the numbers are already in `card_movements` and this
// is the arithmetic that turns them into the sentence a person needs while looking at one card.
//
// THE TWO QUESTIONS A BOARD COULD NOT ANSWER ABOUT A CARD:
//
//   1. "Is this one stuck?" A card has sat in Review for nine days. That is a crisis on a board where work
//      clears Review in a day and a Tuesday on a board where it takes a fortnight. `columnSince` gave the
//      nine; the distribution of everything that has already been through that column gives the meaning.
//   2. "When will it land?" Not from an estimate - estimates are the thing this replaces - but from what
//      happened to the cards that reached this column before it. If 85% of them were delivered within six
//      days of getting here, that is a forecast with its own evidence attached.
//
// COMPARABLE MEANS SAME COLUMN, and same size when the board sizes its work and has enough of it. A size band
// with three samples in it is not a distribution, so the fallback is the column's whole history rather than a
// confident number drawn from nearly nothing - and `basis` says which of the two answered, because a
// percentile whose sample size is hidden is a number pretending to be a fact.

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Below this many samples a percentile is noise, so the narrower cut is abandoned for the wider one. */
export const MIN_SAMPLES = 5;

export type FlowMovement = { cardId: string; toColumn: string; at: number };
export type FlowCard = { uuid: string; columnKey: string; size: number | null; deliveredAt: number | null };

export type FlowStat = {
  p50: number;
  p85: number;
  count: number;
  /** Which corpus answered: the column's cards of this size, or the column's cards at any size. */
  basis: "size" | "column";
};

export type CardFlow = {
  column: string;
  /** Days this card has been where it is. Null when the board never stamped it (a card written before the
   *  column-since column existed), which is a missing fact rather than a zero. */
  days_here: number | null;
  /** How long comparable work took to LEAVE this column. Absent when nothing has left it yet. */
  dwell?: FlowStat;
  /** How long comparable work took from ENTERING this column to being delivered. Absent on a board with no
   *  delivered work that passed through here - which is every board's first month, and is said rather than
   *  guessed around. */
  to_delivery?: FlowStat;
  /** The share of comparable cards that had already left this column by the age this one has reached, 0-100.
   *  The honest way to say "this one is taking longer than most": it is a rank, not a verdict. */
  slower_than?: number;
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function statOf(samples: number[], basis: FlowStat["basis"]): FlowStat {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: round1(percentile(s, 50)), p85: round1(percentile(s, 85)), count: s.length, basis };
}

/** Every stretch a card spent in `column`, in days, for the cards that have already left it. A card sitting
 *  there now contributes nothing: counting an unfinished stay would drag every average down and make a board
 *  look faster exactly while it is getting slower. */
function dwellSamples(column: string, byCard: Map<string, FlowMovement[]>, ids: Set<string>): number[] {
  const out: number[] = [];
  for (const [cardId, moves] of byCard) {
    if (!ids.has(cardId)) continue;
    for (let i = 0; i < moves.length; i++) {
      if (moves[i]!.toColumn !== column) continue;
      const left = moves[i + 1];
      if (!left) continue; // still there
      out.push((left.at - moves[i]!.at) / DAY);
    }
  }
  return out;
}

/** For each delivered card that passed through `column`, the time from the LAST time it entered the column to
 *  delivery. Last rather than first, because a card bounced back from review has to travel the remaining
 *  distance again, and the question being answered is "from here, how long". */
function toDeliverySamples(
  column: string,
  byCard: Map<string, FlowMovement[]>,
  cards: Map<string, FlowCard>,
  ids: Set<string>,
): number[] {
  const out: number[] = [];
  for (const [cardId, moves] of byCard) {
    if (!ids.has(cardId)) continue;
    const card = cards.get(cardId);
    if (!card?.deliveredAt) continue;
    let entered: number | null = null;
    for (const m of moves) {
      if (m.toColumn === column && m.at <= card.deliveredAt) entered = m.at;
    }
    if (entered === null) continue;
    const days = (card.deliveredAt - entered) / DAY;
    if (days >= 0) out.push(days);
  }
  return out;
}

/** Cards whose size sits in the same band as this one. Sizes are a board's own scale, so the band is exact
 *  equality rather than a bucketing this code would have to invent. */
function sameSize(cards: FlowCard[], size: number | null): Set<string> {
  return new Set(cards.filter((c) => c.size != null && c.size === size).map((c) => c.uuid));
}

/**
 * What this board's history says about this card.
 *
 * `cards` and `movements` are whatever the caller was allowed to list, so a narrowly-scoped reader gets a
 * smaller corpus and a smaller `count` rather than a more confident number drawn from rows they cannot see.
 */
export function cardFlow(
  card: { uuid: string; columnKey: string; size: number | null; columnSince: number | null; deliveredAt: number | null },
  cards: FlowCard[],
  movements: FlowMovement[],
  now: number = Date.now(),
): CardFlow {
  const byCard = new Map<string, FlowMovement[]>();
  for (const m of movements) {
    const arr = byCard.get(m.cardId) ?? [];
    arr.push(m);
    byCard.set(m.cardId, arr);
  }
  for (const arr of byCard.values()) arr.sort((a, b) => a.at - b.at);

  const cardById = new Map(cards.map((c) => [c.uuid, c]));
  // This card's own stay is not evidence about itself, in either corpus.
  const others = new Set(cards.filter((c) => c.uuid !== card.uuid).map((c) => c.uuid));
  const sized = card.size == null ? new Set<string>() : sameSize(cards.filter((c) => c.uuid !== card.uuid), card.size);

  const pick = (forSize: number[], forColumn: number[]): FlowStat | undefined => {
    if (forSize.length >= MIN_SAMPLES) return statOf(forSize, "size");
    if (forColumn.length > 0) return statOf(forColumn, "column");
    return undefined;
  };

  const dwellAll = dwellSamples(card.columnKey, byCard, others);
  const dwell = pick(dwellSamples(card.columnKey, byCard, sized), dwellAll);
  const to_delivery = pick(
    toDeliverySamples(card.columnKey, byCard, cardById, sized),
    toDeliverySamples(card.columnKey, byCard, cardById, others),
  );

  const daysHere = card.columnSince == null ? null : round1((now - card.columnSince) / DAY);
  // The rank, computed against the SAME corpus the dwell figures came from, so the sentence a panel writes
  // ("9 days, longer than 90% of them") cannot mix two different sets of cards.
  const rankAgainst = dwell?.basis === "size" ? dwellSamples(card.columnKey, byCard, sized) : dwellAll;
  // Suppressed for a delivered card on the same grounds `days_here` is: its "age" is time since it landed in
  // the done column, so a rank drawn from it would read as "this took longer than 90% of comparable work"
  // about a card that is finished, with no age beside it to check the claim against.
  const slower_than = daysHere == null || card.deliveredAt != null || rankAgainst.length === 0
    ? undefined
    : Math.round((rankAgainst.filter((d) => d <= daysHere).length / rankAgainst.length) * 100);

  return {
    column: card.columnKey,
    days_here: card.deliveredAt ? null : daysHere, // a delivered card is not ageing anywhere
    ...(dwell ? { dwell } : {}),
    ...(to_delivery ? { to_delivery } : {}),
    ...(slower_than != null ? { slower_than } : {}),
  };
}
