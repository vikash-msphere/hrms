// PURE leave carry-forward helpers. No DB/IO - the cron (src/cron.ts) gathers balances + config and persists;
// this module owns the year-end split math (what carries over, what's excess) and how the excess is handled.
import { round2 } from "./money";

// Calendar-year key (UTC), e.g. "2025". Carry-forward and the encashment cap window both key off this.
export const calendarYearOf = (at: number | Date): string => String(new Date(at).getUTCFullYear());

// [start, end] of the calendar year containing `at` (UTC), for "encashed this year" cap windows.
export function calendarYearWindow(at: number | Date): { start: Date; end: Date } {
  const y = new Date(at).getUTCFullYear();
  return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999)) };
}

export type CarryForwardExcess = "encash" | "forfeit";

// Per-type split: how much of `balance` carries into the next year and how much is excess. The flag gates it
// (off => the whole balance is excess); a null cap means unlimited carry-forward.
export function splitCarryForward(balance: number, carryForward: boolean, capDays: number | null): { carried: number; excess: number } {
  if (!carryForward) return { carried: 0, excess: round2(balance) };
  if (capDays == null) return { carried: round2(balance), excess: 0 };
  const carried = Math.min(balance, capDays);
  return { carried: round2(carried), excess: round2(balance - carried) };
}

// Cumulative split across several eligible balances against ONE shared cap: carry over proportionally so the
// kept total equals the cap (when the summed balance exceeds it). Returns carried/excess per input index.
export function splitCarryForwardCumulative(balances: number[], capDays: number | null): { carried: number; excess: number }[] {
  const total = balances.reduce((s, b) => s + b, 0);
  if (capDays == null || total <= capDays) return balances.map((b) => ({ carried: round2(b), excess: 0 }));
  const factor = total > 0 ? capDays / total : 0;
  return balances.map((b) => {
    const carried = round2(b * factor);
    return { carried, excess: round2(b - carried) };
  });
}

// What happens to the excess: auto-encash up to the remaining encashment cap (the rest forfeited), or forfeit
// it all. `encashCapRemaining` is the days still encashable this year (Infinity = uncapped).
export function splitEncashExcess(excess: number, behavior: CarryForwardExcess, encashCapRemaining: number): { encash: number; forfeit: number } {
  if (behavior !== "encash") return { encash: 0, forfeit: round2(excess) };
  const encash = Math.max(0, Math.min(excess, encashCapRemaining));
  return { encash: round2(encash), forfeit: round2(excess - encash) };
}
