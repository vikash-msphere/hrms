// A repeating event's next dates, on the client.
//
// The event form shows the dates a repeat will produce before it is saved ("then 28 Aug · 4 Sep · 11 Sep"),
// because a repeat nobody can see is a repeat nobody trusts - and the cron that actually creates them runs
// hours later, so the form is the only chance to be wrong in front of somebody who can correct it.
//
// That makes this a mirror of `nextOccurrence` in src/services/events.ts, pinned by
// test/eventRepeatDrift.test.ts. Weekly steps in days (so the weekday sticks), monthly and yearly step the
// calendar field (so the date sticks), and both keep the event's own length.

export type EventRepeat = "weekly" | "monthly" | "yearly";

export function nextOccurrence(startMs: number, endMs: number, repeat: EventRepeat): { start: number; end: number } {
  const span = endMs - startMs;
  const d = new Date(startMs);
  if (repeat === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return { start: +d, end: +d + span };
}

/** The next `count` occurrences after this one, as start instants. For the form's "then …" line. */
export function upcomingOccurrences(startMs: number, endMs: number, repeat: EventRepeat, count = 3): number[] {
  const out: number[] = [];
  let cur = { start: startMs, end: endMs };
  for (let i = 0; i < count; i++) {
    cur = nextOccurrence(cur.start, cur.end, repeat);
    out.push(cur.start);
  }
  return out;
}
