// Period arithmetic and pace for a budget cap, shared by every page that shows one.
//
// The key format is the server's own (domain/expenses periodKeyFor): "2026" | "2026-Q3" | "2026-07". These
// helpers let a page sort chronologically, label a period in prose, measure how much of it has elapsed and
// roll one forward - all without asking the server, which only ever hands back the opaque key.
//
// SHARED RATHER THAN COPIED. These started out private to the expenses budget page, and the payroll budget
// page needs the identical arithmetic on the identical key format. A second copy is how the two pages start
// disagreeing about which quarter a date is in, or about whether a cap is "current" - so the moment there was
// a second caller, they moved here. The types below are structural for the same reason: neither wire type is
// named, so nothing here can quietly become expenses-specific again.

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export type PeriodType = "monthly" | "quarterly" | "yearly";
/** Where a period sits relative to today. A budgets list is almost always asked "what are we spending against
 *  NOW" - a wall of finished periods is history, not a working set - so a page opens on the live ones. */
export type Phase = "current" | "upcoming" | "past" | "all";
export const DAY = 86400000;

/** The minimum a cap has to look like for the helpers below: the two fields that locate it in the calendar,
 *  plus the forecast the server computed. Structural so both `expense-budget` and `payroll-budget` satisfy it
 *  without this module importing either. */
export type CapLike = {
  period_type: string;
  period_key: string;
  projection?: { projected?: number; projected_utilization?: number } | null;
};

export function periodRange(type: string, key: string): { start: number; end: number } | null {
  const y = Number(key.slice(0, 4));
  if (!Number.isFinite(y) || key.length < 4) return null;
  if (type === "yearly") return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) };
  if (type === "quarterly") {
    const q = Number(key.slice(6));
    if (!(q >= 1 && q <= 4)) return null;
    return { start: Date.UTC(y, (q - 1) * 3, 1), end: Date.UTC(y, q * 3, 1) };
  }
  const m = Number(key.slice(5, 7));
  if (!(m >= 1 && m <= 12)) return null;
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}

export function periodLabel(type: string, key: string): string {
  const r = periodRange(type, key);
  if (!r) return key;
  const d = new Date(r.start);
  if (type === "yearly") return String(d.getUTCFullYear());
  if (type === "quarterly") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function keyFor(type: PeriodType, at: Date): string {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  if (type === "yearly") return String(y);
  if (type === "quarterly") return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** The period straight after this one, in the same type - what "duplicate to next period" and roll-forward
 *  mean. */
export function nextKey(type: string, key: string): string | null {
  const r = periodRange(type, key);
  if (!r) return null;
  return keyFor(type as PeriodType, new Date(r.end));
}

/** The period straight before this one - what a create dialog reads to anchor a new cap on the last one. */
export function prevKey(type: string, key: string): string | null {
  const r = periodRange(type, key);
  if (!r) return null;
  return keyFor(type as PeriodType, new Date(r.start - DAY));
}

export function phaseOf(b: CapLike, now: number): Exclude<Phase, "all"> {
  const r = periodRange(b.period_type, b.period_key);
  if (!r) return "current"; // an unparseable key is never hidden behind a phase filter
  if (now >= r.end) return "past";
  if (now < r.start) return "upcoming";
  return "current";
}

/**
 * How far into its period a cap is, and the spend that pace implies. A cap at 60% on day 5 of 30 is in
 * trouble; one at 60% on day 26 is fine. Without this, every number on the page is a post-mortem.
 *
 * THE FORECAST IS THE SERVER'S, and the day counter is the page's. The split is the same one
 * `budgetWarnThreshold` already draws for the at-risk line: where a number decides something - and this one
 * decides "Trending over", the alert the daily sweep emits, and what the drill-through shows - it has to have
 * one definition, or the page and the notification say different things about the same cap.
 *
 * `projection` is absent whenever the arithmetic cannot support a forecast: a closed period (whose spend is
 * already its total), a future one, one with no spend, and one too early to call. Absence is NOT "on track",
 * so it renders as nothing at all rather than as a zero. Day and elapsed still come out, because "day 3 of
 * 30" is a fact about the calendar that needs no spend to be true.
 */
export function paceOf(b: CapLike, now: number): { elapsed: number; day: number; days: number; projected: number | null; projectedAmount: number | null } | null {
  const r = periodRange(b.period_type, b.period_key);
  if (!r) return null;
  const days = Math.max(1, Math.round((r.end - r.start) / DAY));
  const elapsed = Math.min(1, Math.max(0, (now - r.start) / (r.end - r.start)));
  const day = Math.min(days, Math.max(0, Math.ceil((now - r.start) / DAY)));
  return {
    elapsed, day, days,
    projected: b.projection?.projected_utilization ?? null,
    projectedAmount: b.projection?.projected ?? null,
  };
}
