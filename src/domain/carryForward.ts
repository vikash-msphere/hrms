// PURE leave carry-forward helpers. No DB/IO - the cron (src/cron.ts) gathers balances + config and persists;
// this module owns the year-end split math (what carries over, what's excess) and how the excess is handled.
import { round2 } from "./money";

// NO CALENDAR-YEAR HELPERS HERE, deliberately - not the year an instant falls in, not a year's bounds. Both
// used to live here as UTC, and both were wrong for the same reason: a calendar year is the ORG's, and only
// the org's timezone can say where it starts. The nightly tick fires at 02:00 UTC, which is still 31 December
// anywhere west of UTC, so the year-end rollover forfeited and paid out a day early there; and a UTC year
// window over `created_at` counted an encashment raised at 02:00 on 1 January IST against the previous year's
// cap. A pure helper taking only an instant cannot know the timezone, so offering one is offering the bug
// back. `orgYear` in services/orgDay.ts is the one answer, and it is resolved once and passed in.

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
  // Allocated against a RUNNING total, not rounded share by share. Each share rounded on its own can go up by
  // half a paise-day, and N of them put the KEPT total over the cap the policy states (measured at 0.02 days
  // across seven leave types, on ~10% of splits) - while the excess, which the year-end auto-encashment pays
  // out, came up short by exactly the same amount. Rounding the cumulative sum instead lands the kept total on
  // the cap to the paise and still leaves every row at 2dp.
  let allocated = 0; // rounded days handed out so far
  let exact = 0; // unrounded running share
  return balances.map((b) => {
    exact += b * factor;
    const cum = round2(exact);
    const carried = round2(cum - allocated);
    allocated = cum;
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
