import { addDays, daysApart, parseYmd } from "./leaveCalendar";

// Long weekends, and the one day of leave that would buy one. A holiday on its own says almost nothing about
// whether you get a break: a Thursday holiday is one day off, but one day of leave on the Friday turns it into
// four. This module is the pure arithmetic behind that, so the page can just render it.
//
// Everything works off an `isOff` predicate the caller assembles (weekend by the org's working week, plus the
// holidays that are actually days off for THIS viewer - an unpicked optional holiday isn't one).

/** A contiguous stretch of days off. `days` is inclusive of both ends. */
export type Break = { from: string; to: string; days: number };

/** A break you could buy: `take` is the leave to apply for, `from`/`to`/`days` the break it yields. */
export type Bridge = Break & { take: string[] };

export const dowOf = (ymd: string) => new Date(parseYmd(ymd)).getUTCDay();

/** Non-working weekday per the org's working week (Sun = 0). */
export const isWeekendDay = (ymd: string, workDays: number[]) => !workDays.includes(dowOf(ymd));

/** The whole stretch of days off `ymd` sits in. Walk is capped so a mis-set working week can't spin forever. */
export function breakAround(ymd: string, isOff: (d: string) => boolean, cap = 14): Break {
  let from = ymd;
  let to = ymd;
  for (let i = 0; i < cap; i++) {
    const prev = addDays(from, -1);
    if (!isOff(prev)) break;
    from = prev;
  }
  for (let i = 0; i < cap; i++) {
    const next = addDays(to, 1);
    if (!isOff(next)) break;
    to = next;
  }
  return { from, to, days: daysApart(from, to) + 1 };
}

/**
 * The cheapest leave that turns this break into a proper one, taken from either side: up to `maxTake`
 * consecutive working days adjacent to it, kept only when the resulting stretch reaches `minDays`. Best =
 * most days off per day of leave spent; ties go to the earlier side and to the smaller ask, so one day
 * before beats two days after at the same value.
 */
export function bestBridge(
  b: Break,
  isOff: (d: string) => boolean,
  { maxTake = 2, minDays = 4, cap = 14 }: { maxTake?: number; minDays?: number; cap?: number } = {},
): Bridge | null {
  let best: Bridge | null = null;
  for (const before of [true, false]) {
    const take: string[] = [];
    for (let n = 1; n <= maxTake; n++) {
      const day = before ? addDays(b.from, -n) : addDays(b.to, n);
      if (isOff(day)) break; // already off - nothing to buy on this side
      take.push(day);
      // What the break becomes once those days are off too - which may pull in a further weekend beyond them.
      const withLeave = (d: string) => isOff(d) || take.includes(d);
      const merged = breakAround(b.from, withLeave, cap);
      if (merged.days < minDays) continue;
      const cand: Bridge = { ...merged, take: before ? [...take].reverse() : [...take] };
      if (!best || cand.days - cand.take.length > best.days - best.take.length) best = cand;
    }
  }
  return best;
}

/** "4-day break", and the copy for a break not worth calling one. */
export const breakLabel = (days: number) => `${days}-day break`;

/** How many distinct long breaks (3+ days off in a row) a set of off-days produces. Deduped by start day. */
export function longBreakCount(offDays: string[], isOff: (d: string) => boolean, minDays = 3): number {
  const starts = new Set<string>();
  for (const d of offDays) {
    const b = breakAround(d, isOff);
    if (b.days >= minDays) starts.add(b.from);
  }
  return starts.size;
}
