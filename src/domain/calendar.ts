// Pure UTC calendar arithmetic (NO I/O). Shared by the server and the browser, because a date the client
// previews and a date the server then writes have to be the same date.
//
// WHY THIS EXISTS. `d.setUTCMonth(d.getUTCMonth() + 1)` reads like "next month" and is not: JS normalizes an
// impossible date forward, so 31 January plus one month is **3 March**. Every series anchored on a 29th, 30th
// or 31st therefore skipped February outright and then drifted - a monthly compliance filing due on the 31st
// jumped from March to 3 May, a recurring chore lost a month, a repeating all-hands moved off its day. Three
// places in this codebase already had the correct clamp written out by hand (domain/expenses.ts,
// domain/complianceRecurrence.ts, the calendar's month nav); the sites that reached for `setUTCMonth`
// directly were the ones that got it wrong. So the primitive lives here once and they all call it.

/** Days in a 0-based UTC month, honouring leap years. */
export const daysInMonthUtc = (year: number, monthIdx: number) => new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();

/**
 * `d` plus `n` UTC months, with the day CLAMPED to the target month's length instead of rolling over.
 *
 * 31 Jan +1 -> 28 Feb (29 in a leap year); 31 Jan +3 -> 30 Apr; 30 Jan +1 -> 28 Feb. The time of day is
 * preserved. `n` may be negative.
 *
 * The clamp is lossy in one direction and deliberately so: a series that lands on 28 February keeps the 28th
 * from then on rather than springing back to the 31st. Anchoring to "last day of month" is a different rule
 * than "the 31st", and a caller that wants it should say so rather than have it inferred from one short month.
 */
export function addMonthsUtc(d: Date, n: number): Date {
  const target = d.getUTCMonth() + n;
  const year = d.getUTCFullYear() + Math.floor(target / 12);
  const monthIdx = ((target % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonthUtc(year, monthIdx));
  return new Date(Date.UTC(year, monthIdx, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/** `d` plus `n` whole UTC days. Safe as plain millisecond arithmetic - a UTC day is always 86,400,000ms. */
export function addDaysUtc(d: Date, n: number): Date {
  return new Date(+d + n * 86_400_000);
}

/**
 * Does the yearly anniversary of `anchor` fall on the UTC day `on`?
 *
 * The same clamp `addMonthsUtc` applies, for the same reason. A 29 February anchor has no matching date in a
 * common year, so the plain `month === month && date === date` test this replaces was false three years in
 * four: someone who joined on 29 February was congratulated on their work anniversary once per leap year, and
 * every anniversary-triggered automation stayed silent in between. Their anniversary lands on 28 February
 * instead - the last day the anchor's month has that year - which is where every other clamp here puts it.
 *
 * Both a 28 February and a 29 February anchor therefore fall on 28 February in a common year, which is the
 * intended answer: the day exists for one of them and is the nearest the calendar offers the other.
 *
 * Only the Y/M/D of `on` are read; pass the UTC midnight of the day being tested.
 */
export function isAnniversaryOf(anchor: Date | number, on: Date | number): boolean {
  const a = new Date(anchor);
  const d = new Date(on);
  const monthIdx = a.getUTCMonth();
  if (d.getUTCMonth() !== monthIdx) return false;
  return d.getUTCDate() === Math.min(a.getUTCDate(), daysInMonthUtc(d.getUTCFullYear(), monthIdx));
}

/**
 * Step `from` forward by `step` until it is strictly after `notBefore` - the "catch up" a recurring series
 * needs when the last occurrence is long past.
 *
 * A series that advances by exactly one period off its previous date keeps its rhythm only while it is being
 * kept up with. Let the last one run six weeks late (or let the nightly tick miss a few days) and one step
 * lands the next occurrence in the PAST, so the thing is filed already overdue and every future occurrence
 * inherits the lag. Stepping until the date is genuinely ahead keeps the day-of-week / day-of-month of the
 * original series while putting the next occurrence where it can still be done.
 */
export type EventRepeat = "weekly" | "monthly" | "yearly";

/**
 * One step of a repeating event: a weekly all-hands lands on the same weekday, a monthly one on the same
 * date, a yearly one on the same date next year. Returns the new start and end, keeping the event's length.
 *
 * Lives HERE, in the pure layer, because both sides need it: the cron creates the occurrences and the event
 * form previews them ("then 28 Aug · 4 Sep · 11 Sep") hours earlier. That used to be two copies of the rule
 * pinned to each other by a drift test - which held them equal, but held them equal to the rollover bug that
 * moved a 31st-of-the-month series permanently off its date. One implementation cannot drift and only had to
 * be corrected once.
 */
export function nextOccurrence(startMs: number, endMs: number, repeat: EventRepeat): { start: number; end: number } {
  const span = endMs - startMs;
  const from = new Date(startMs);
  const d = repeat === "weekly" ? addDaysUtc(from, 7) : addMonthsUtc(from, repeat === "monthly" ? 1 : 12);
  return { start: +d, end: +d + span };
}

/** The next `count` occurrences after this one, as start instants. For the event form's "then …" line. */
export function upcomingOccurrences(startMs: number, endMs: number, repeat: EventRepeat, count = 3): number[] {
  const out: number[] = [];
  let cur = { start: startMs, end: endMs };
  for (let i = 0; i < count; i++) {
    cur = nextOccurrence(cur.start, cur.end, repeat);
    out.push(cur.start);
  }
  return out;
}

export function advanceUntilAfter(from: Date, notBefore: Date | number, step: (d: Date) => Date): Date {
  const floor = +notBefore;
  let next = step(from);
  // Bounded: a step that cannot move the date forward would spin, so require real progress each time.
  for (let guard = 0; +next <= floor && guard < 1200; guard++) {
    const moved = step(next);
    if (+moved <= +next) break;
    next = moved;
  }
  return next;
}
