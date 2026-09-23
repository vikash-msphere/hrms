// Pure recurrence core for the statutory compliance calendar: given a recurring obligation rule, compute the
// concrete due dates that fall within a window. No I/O - the service binds it to the DB (dedupe + insert) and
// the cron rolls the window forward. UTC throughout (matches the rest of the date handling).

export type RecurrenceRule = {
  frequency: "monthly" | "quarterly" | "annual";
  dueDay: number; // 1-31, clamped to the month's length
  anchorMonth?: number | null; // 1-12: quarterly cycle start (then +3/+6/+9) and the annual month; ignored for monthly
};

const daysInMonth = (year: number, monthIdx: number) => new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();

// Whether this rule fires in the given 0-based month index.
function fires(rule: RecurrenceRule, monthIdx: number): boolean {
  if (rule.frequency === "monthly") return true;
  const anchor = ((rule.anchorMonth ?? 1) - 1 + 12) % 12; // 0-based anchor month
  if (rule.frequency === "annual") return monthIdx === anchor;
  return (((monthIdx - anchor) % 3) + 3) % 3 === 0; // quarterly: anchor, +3, +6, +9
}

// Sorted due-date timestamps (UTC midnight) for the rule within [fromMs, toMs] inclusive. dueDay is clamped to
// each month's length (e.g. day 31 -> 30 in June, 28/29 in Feb), so a rule never silently skips a short month.
export function dueDatesInRange(rule: RecurrenceRule, fromMs: number, toMs: number): number[] {
  if (fromMs > toMs) return [];
  const out: number[] = [];
  const from = new Date(fromMs);
  let year = from.getUTCFullYear();
  let monthIdx = from.getUTCMonth();
  // Walk month by month from the `from` month until past `to`.
  for (;;) {
    const firstOfMonth = Date.UTC(year, monthIdx, 1);
    if (firstOfMonth > toMs) break;
    if (fires(rule, monthIdx)) {
      const day = Math.min(Math.max(1, rule.dueDay), daysInMonth(year, monthIdx));
      const dueMs = Date.UTC(year, monthIdx, day);
      if (dueMs >= fromMs && dueMs <= toMs) out.push(dueMs);
    }
    monthIdx += 1;
    if (monthIdx > 11) { monthIdx = 0; year += 1; }
  }
  return out;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Default "period covered" label for a generated occurrence. Statutory monthly filings cover the PRIOR month
// (PF/ESI/TDS/GST are filed in the following month), so monthly -> "May 2026" for a June due date. Quarterly /
// annual periods vary by fiscal convention, so we leave them blank for the user to fill on the occurrence.
export function periodLabelFor(rule: RecurrenceRule, dueMs: number): string | null {
  if (rule.frequency !== "monthly") return null;
  const d = new Date(dueMs);
  let m = d.getUTCMonth() - 1;
  let y = d.getUTCFullYear();
  if (m < 0) { m = 11; y -= 1; }
  return `${MONTHS_SHORT[m]} ${y}`;
}
