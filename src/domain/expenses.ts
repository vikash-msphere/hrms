// Pure expense domain (NO I/O): budget-period keys/bounds, spend rollup, recurrence next-date. Shared by the
// expense-budgets service (utilization), the cron (recurring generation + budget alerts), and tests.
import { addMonthsFromAnchor, seriesAnchorDay } from "./calendar";
import { round2 } from "./money";

export type RecurrenceRule = "monthly" | "quarterly" | "yearly";
export type PeriodType = "monthly" | "quarterly" | "yearly";

const pad2 = (n: number) => String(n).padStart(2, "0");

// The period key a UTC date falls into, for a period type: "2026" | "2026-Q3" | "2026-07".
export function periodKeyFor(type: PeriodType, d: Date): string {
  const y = d.getUTCFullYear();
  if (type === "yearly") return `${y}`;
  if (type === "quarterly") return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return `${y}-${pad2(d.getUTCMonth() + 1)}`;
}

// [start, end) millisecond bounds of a period key. Throws on a malformed key (defensive; keys are generated).
export function periodBounds(type: PeriodType, key: string): { start: number; end: number } {
  if (type === "yearly") {
    const y = Number(key);
    if (!Number.isInteger(y)) throw new Error(`bad yearly period key: ${key}`);
    return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) };
  }
  if (type === "quarterly") {
    const m = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!m) throw new Error(`bad quarterly period key: ${key}`);
    const y = Number(m[1]);
    const startMonth = (Number(m[2]) - 1) * 3;
    return { start: Date.UTC(y, startMonth, 1), end: Date.UTC(y, startMonth + 3, 1) };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`bad monthly period key: ${key}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: Date.UTC(y, mo, 1), end: Date.UTC(y, mo + 1, 1) };
}

// Advance a UTC date by one recurrence step. `anchorDay` is the series' own day of the month - pass it, or a
// template written for the 31st spends the rest of its life on the 28th after one February (see
// domain/calendar.ts#addMonthsFromAnchor). Omitted, the day is taken from `d`, which is right for the first
// step of a series and for a one-off "when is this due next".
export function advanceRecurrence(d: Date, rule: RecurrenceRule, anchorDay?: number | null): Date {
  return addMonthsFromAnchor(d, rule === "monthly" ? 1 : rule === "quarterly" ? 3 : 12, seriesAnchorDay(d, anchorDay));
}

// Utilization from a cap + spent (+ spend still awaiting approval). `remaining` goes negative on overspend;
// `utilization` is a 0..>1 fraction (0 when the cap is 0, to avoid divide-by-zero). `pending` is NOT part of
// utilization - it is not yet spend - but a cap at 92% with a queue behind it is already blown, so the number
// travels alongside instead of being discovered after approval.
export function budgetUtilization(amount: number, spent: number, pending = 0): { spent: number; pending: number; remaining: number; utilization: number } {
  const s = round2(spent);
  return { spent: s, pending: round2(pending), remaining: round2(amount - s), utilization: amount > 0 ? s / amount : 0 };
}
