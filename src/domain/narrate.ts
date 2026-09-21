// Which numbers moved, decided arithmetically, and what a sentence about them is allowed to say.
//
// THE DETECTION IS NOT THE MODEL'S JOB, and that is the whole design. `findMovements` compares two windows of
// the same report and returns what changed; the model is handed that list and asked only to write it up. A
// model that cannot find the anomaly cannot invent one, so the worst a bad generation can do is describe a
// real change badly - never announce a problem that is not there, which is the failure that would make an
// analytics narration worse than no narration.
//
// `groundedIn` is the second half of the same idea, applied to the output: a sentence may only contain
// numbers that were in the findings. It is checkable, so it is checked.
import type { MetricDef, MetricDirection, MetricUnit } from "./peopleAnalytics";

export type Finding = {
  key: string;
  label: string;
  unit: MetricUnit;
  /** Whether a rise is the good direction, the bad one, or neither. Taken from the metric, never inferred. */
  direction: MetricDirection;
  previous: number;
  current: number;
  /** Signed, as a percentage of the previous value. Absent when the previous value was zero. */
  changePct: number | null;
  movement: "up" | "down";
};

/** How much a measure has to move before it is worth a sentence. Below this the report is noise and a
 *  narration would be inventing significance the numbers do not carry. */
export const MIN_CHANGE_PCT = 15;

/**
 * The absolute floor, in the measure's own unit.
 *
 * A relative threshold alone makes small numbers shout: two late arrivals becoming three is a 50% rise and
 * means nothing. Both tests have to pass, so a finding is a change that is large in proportion AND large
 * enough to be worth saying out loud.
 */
export const MIN_ABSOLUTE: Record<MetricUnit, number> = {
  count: 3,
  // Money has no single sensible floor - a currency where the unit is worth a hundredth of another's would
  // need a different one, and this app is single-currency by design (see the org's default_currency). So the
  // floor is deliberately low and the PROPORTIONAL test does the work: a spend that moved 15% is worth a
  // sentence whatever the absolute figure, and one that moved 14% is not, whatever it was.
  money: 1,
  days: 2,
  hours: 4,
  minutes: 60,
  percent: 5,
  rating: 0.5,
  // A shift in average clock-in time, in minutes past midnight. Fifteen minutes is the smallest change
  // anybody would describe as people arriving earlier or later.
  time_of_day: 15,
};

/** At most this many findings reach a prompt. A narration is a paragraph, not a list of everything. */
export const MAX_FINDINGS = 6;

/**
 * Compare two windows of the same report and return what moved, biggest proportional change first.
 *
 * `previous` and `current` are the `team` aggregates of two runs of the SAME report over equal-length
 * windows, so every pair is like for like. A measure missing from either side is skipped rather than treated
 * as zero: absent means the caller could not see that collection, and reading it as a fall to nothing would
 * report a change caused purely by permissions.
 */
export function findMovements(
  metrics: readonly MetricDef[],
  previous: Record<string, number | null>,
  current: Record<string, number | null>,
): Finding[] {
  const out: Finding[] = [];
  for (const m of metrics) {
    const was = previous[m.key];
    const now = current[m.key];
    if (was == null || now == null) continue;
    if (was === now) continue;

    const delta = now - was;
    if (Math.abs(delta) < (MIN_ABSOLUTE[m.unit] ?? 1)) continue;
    const changePct = was === 0 ? null : (delta / Math.abs(was)) * 100;
    // A measure that was zero has no proportional change to test, so the absolute floor above is the whole
    // test for it - which is right: going from no overtime to eleven hours of it is worth a sentence.
    if (changePct !== null && Math.abs(changePct) < MIN_CHANGE_PCT) continue;

    out.push({
      key: m.key,
      label: m.label,
      unit: m.unit,
      direction: m.direction,
      previous: round(was),
      current: round(now),
      changePct: changePct === null ? null : round(changePct),
      movement: delta > 0 ? "up" : "down",
    });
  }
  // Biggest proportional move first; a measure that came off zero has no percentage, so it sorts by how far
  // it travelled instead of being dropped to the bottom.
  return out
    .sort((a, b) => Math.abs(b.changePct ?? Infinity) - Math.abs(a.changePct ?? Infinity))
    .slice(0, MAX_FINDINGS);
}

/**
 * Every number a narration is allowed to contain: the values and percentages in the findings.
 *
 * Rounded to the same precision the sentence will use, because "12.3" and "12.30" are the same number to a
 * reader and different strings to a check.
 */
export function allowedNumbers(findings: readonly Finding[]): Set<string> {
  const set = new Set<string>();
  for (const f of findings) {
    for (const n of [f.previous, f.current, f.changePct]) {
      if (n === null) continue;
      set.add(fmt(n));
      set.add(fmt(Math.abs(n)));
      // A writer will often round: "up by about 18%" for 18.4. Both forms are legitimate.
      set.add(fmt(Math.round(n)));
      set.add(fmt(Math.abs(Math.round(n))));
    }
    // The difference is a number nobody would consider invented, and a natural way to phrase a change.
    const diff = f.current - f.previous;
    set.add(fmt(Math.abs(diff)));
    set.add(fmt(Math.abs(round(diff))));
  }
  return set;
}

/**
 * True when every number in `text` came from the findings.
 *
 * This is the guard that makes the feature safe to show next to real figures. A model writing prose about
 * numbers will occasionally produce one that was not in its input - an average it worked out, a total it
 * assumed - and a fabricated figure sitting beside a real dashboard is worse than no sentence at all. When
 * this fails the caller falls back to the deterministic summary, which is plain but true.
 *
 * ONLY small counting words are allowed through - "three measures moved" is prose about the narration itself,
 * not a claim about the data. A YEAR IS NOT ALLOWED, and neither is a period length: "the highest since 2024"
 * and "over the last 30 days" are both claims this app never made, and a reader has no way to tell one of them
 * from a figure that was computed. The prompt is written so the model has no reason to state either
 * (services/analyticsNarrate.ts SYSTEM), which is what makes the strict rule cheap rather than a trap.
 */
export function groundedIn(text: string, findings: readonly Finding[]): boolean {
  const allowed = allowedNumbers(findings);
  // Thousands separators are folded away before the comparison. `12,400` is ONE number to a reader and was two
  // to a bare `\d+` scan - "12" and "400" - so a narration that spelled a real, computed figure the way people
  // write it failed the check and the reader got the plain summary instead. Every measure that counts anything
  // in an organisation of any size crosses a thousand, so this was not an edge case; it fired on exactly the
  // numbers a reader most wants written up. Matching the separated form and stripping the commas asks about the
  // number on the page, which is what the check is for. It does not widen anything: the value still has to be
  // one of the findings.
  const numbers = text.match(/\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? [];
  for (const raw of numbers) {
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) return false;
    // Counting words a narration legitimately uses about itself rather than about the data.
    if (Number.isInteger(n) && n <= MAX_FINDINGS) continue;
    if (allowed.has(fmt(n))) continue;
    return false;
  }
  return true;
}

/**
 * The narration used when there is nothing to say, and when a generated one fails the grounding check.
 *
 * Deliberately flat. It is the honest version of the same information, and a reader who sees it has lost
 * nothing they could rely on.
 */
export function plainSummary(findings: readonly Finding[]): string {
  if (findings.length === 0) return "Nothing moved much against the previous period.";
  return findings
    .map((f) => {
      const dir = f.movement === "up" ? "up" : "down";
      const pct = f.changePct === null ? "" : ` (${fmt(Math.abs(f.changePct))}%)`;
      return `${f.label} ${dir} from ${fmt(f.previous)} to ${fmt(f.current)}${pct}.`;
    })
    .join(" ");
}

const round = (n: number): number => Math.round(n * 10) / 10;
/** One decimal place, with a trailing ".0" dropped, which is how both the prose and the check spell a number. */
const fmt = (n: number): string => String(round(n));
