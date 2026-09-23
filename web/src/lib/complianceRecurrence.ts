// Client mirror of the recurrence core in src/domain/complianceRecurrence.ts.
//
// The server owns generation; this exists so the rule editor can SHOW what it is about to generate ("next:
// 15 Sep, 15 Oct, 15 Nov") before the rule is saved. Keep the two in step: same clamping, same anchor maths.
import { todayStr } from "@/lib/orgDay";

export type RecurrenceRule = {
  frequency: "monthly" | "quarterly" | "annual";
  dueDay: number; // 1-31, clamped to the month's length
  anchorMonth?: number | null; // 1-12: quarterly cycle start (then +3/+6/+9) and the annual month
};

const daysInMonth = (year: number, monthIdx: number) => new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();

function fires(rule: RecurrenceRule, monthIdx: number): boolean {
  if (rule.frequency === "monthly") return true;
  const anchor = ((rule.anchorMonth ?? 1) - 1 + 12) % 12;
  if (rule.frequency === "annual") return monthIdx === anchor;
  return (((monthIdx - anchor) % 3) + 3) % 3 === 0;
}

/**
 * The next `count` due dates on or after `from` (a "YYYY-MM-DD" day), as YYYY-MM-DD.
 *
 * `from` defaults to the ORG's day. It used to default to `new Date()` and then read `getFullYear()` /
 * `getMonth()` / `getDate()` off it - the VIEWER's local calendar, anchored at UTC - which is the mistake
 * lib/fy.ts documents at length and lib/orgDay.ts exists to end. Around a month boundary the preview showed a
 * different first due date than the server would generate.
 */
export function nextDueDates(rule: RecurrenceRule, count = 3, from: string = todayStr()): string[] {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const out: string[] = [];
  let year = new Date(fromMs).getUTCFullYear();
  let monthIdx = new Date(fromMs).getUTCMonth();
  // Bounded by the sparsest schedule: an annual rule fires once every twelve months, so a year per wanted date
  // (plus one, since the current year's date may already be past) always fills the list.
  const months = 12 * (count + 1);
  for (let i = 0; i < months && out.length < count; i++) {
    if (fires(rule, monthIdx)) {
      const day = Math.min(Math.max(1, rule.dueDay), daysInMonth(year, monthIdx));
      const dueMs = Date.UTC(year, monthIdx, day);
      if (dueMs >= fromMs) out.push(new Date(dueMs).toISOString().slice(0, 10));
    }
    monthIdx += 1;
    if (monthIdx > 11) { monthIdx = 0; year += 1; }
  }
  return out;
}
