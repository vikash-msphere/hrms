// PURE leave helpers. No I/O.
import { round2 } from "./money";

export function monthlyAccrual(daysPerYear: number): number {
  return round2(daysPerYear / 12);
}

// Round a day amount to a configured increment: 0 = exact (2dp), 0.5 = nearest half day, 1 = nearest whole
// day. Keeps accrued balances tidy (no e.g. 2.41) when the org wants whole/half-day leave only.
export function roundToIncrement(value: number, increment: number): number {
  const v = increment > 0 ? Math.round(value / increment) * increment : value;
  return round2(v);
}

const DAY_MS = 86_400_000;
const ymdUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Chargeable leave days for a range, counting only the org's configured working days and excluding holidays.
// `workDays` is the weekday set (0=Sun..6=Sat; default Mon-Fri); `holidays` is a set of "YYYY-MM-DD" (UTC).
// Sessions: 1 = first half (morning), 2 = second half (afternoon). The leave runs contiguously from
// `startSession` of the start day to `endSession` of the end day, so a first day that starts in the afternoon
// (startSession=2) and a last day that ends at midday (endSession=1) each drop half a working day - but only
// when that boundary day is itself a working day (a half flag on a weekend/holiday is ignored). Works for a
// single day too: (1,1)=morning, (2,2)=afternoon, (1,2)=full.
export function leaveDays(
  startMs: number,
  endMs: number,
  startSession = 1,
  endSession = 2,
  workDays: readonly number[] = [1, 2, 3, 4, 5],
  holidays: ReadonlySet<string> = new Set(),
  halfDayHolidays: ReadonlySet<string> = new Set(),
): number {
  // What one calendar day is worth: a working day is 1, a holiday 0, and a half-day holiday 0.5 (the office
  // is open for the other half, so leave across it costs half a day).
  const valueOf = (ms: number) => {
    const ymd = ymdUtc(ms);
    if (!workDays.includes(new Date(ms).getUTCDay()) || holidays.has(ymd)) return 0;
    return halfDayHolidays.has(ymd) ? 0.5 : 1;
  };
  let days = 0;
  for (let d = startMs; d <= endMs; d += DAY_MS) days += valueOf(d);
  if (days === 0) return 0;
  // A session flag shaves at most what the boundary day is actually worth (so a PM start on a morning-only
  // half-day holiday costs nothing, not -0.5).
  if (startSession === 2) days -= Math.min(0.5, valueOf(startMs)); // first day starts after lunch
  if (endSession === 1) days -= Math.min(0.5, valueOf(endMs)); // last day ends at lunch
  return Math.round(days * 2) / 2;
}

// ---- Prorated monthly accrual ----
// Leave is earned 1/12 of the annual allowance each calendar month. The joining month is
// prorated by the fraction of days actually worked. No accrual before start or after end.
// Leave types that aren't available during probation don't accrue until probation ends.

// UTC year-month key, e.g. 1717200000000 -> "2024-06".
export function ymOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The marker suffix that says a period was priced against a KNOWN last working day - and so is final.
 *
 * The marker column is the only state this computation has, and without this it cannot answer the question the
 * exit reconciliation below has to ask: was this month credited for a whole month, or for the part of it the
 * employee was actually here? `monthFraction(idx, start, null)` is 1, so any month credited while the end date
 * was still unknown got the full rate; a month credited after it was known got the true fraction. The suffix
 * records which of those happened, so the reconciliation runs exactly once and never against a month that was
 * already priced correctly.
 *
 * Carried in the existing text column rather than in a new one: it is a property OF the marker, and a second
 * column would be a second thing to keep in step.
 */
const FINAL_MARK = "~";
const stripMark = (ym: string): string => (ym.endsWith(FINAL_MARK) ? ym.slice(0, -1) : ym);
const isFinalMarker = (ym: string | null): boolean => !!ym && ym.endsWith(FINAL_MARK);

// Monotonic month index so we can compare/iterate "YYYY-MM" values arithmetically. Tolerates the final mark
// (and the semi-monthly "-H1/-H2" tail, which `Number` on the second segment already ignored).
function ymIndex(ym: string): number {
  const parts = stripMark(ym).split("-");
  return Number(parts[0]) * 12 + (Number(parts[1]) - 1);
}
function ymFromIndex(idx: number): string {
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * Fraction of one calendar month the employee is actually employed for, both ends clamped.
 *
 * BOTH ends, which is the fix: only the JOINING month used to be prorated, so a leaver was credited a whole
 * month's entitlement for a month they worked two days of. That is not a rounding difference - accrued leave is
 * encashable, so the FnF pays cash for it (services/settlements.ts prices `encashableBalances`), and the
 * asymmetry meant the same two days were worth a full month on the way out and a fifteenth of one on the way
 * in. A month the employee is present for throughout returns exactly 1, so nothing about the ordinary case
 * moves.
 *
 * `monthIdx` is the monotonic index the accrual walk iterates (year * 12 + month), so the month's own bounds
 * come from the index rather than from either date - which is what lets one helper answer for the joining
 * month, the leaving month, and the month that is both.
 */
function monthFraction(monthIdx: number, startMs: number, endMs: number | null): number {
  const year = Math.floor(monthIdx / 12);
  const month = monthIdx % 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthStart = Date.UTC(year, month, 1);
  const monthEnd = Date.UTC(year, month, daysInMonth);
  const from = Math.max(startMs, monthStart);
  const to = endMs == null ? monthEnd : Math.min(endMs, monthEnd);
  if (to < from) return 0;
  return Math.min(1, (Math.round((to - from) / 86_400_000) + 1) / daysInMonth);
}

export type AccrualFrequency = "monthly" | "semi_monthly";

export type AccrualInputs = {
  accrualDaysPerYear: number; // normal (post-probation) annual rate
  probationAccrualDaysPerYear: number; // annual rate during probation (often 0 or reduced)
  startMs: number | null; // employee first working day (no start -> no accrual)
  endMs: number | null; // employee last day (null = ongoing)
  probationEndMs: number | null; // null = no probation (normal rate throughout)
  lastAccrualYm: string | null; // last period credited: "YYYY-MM" (monthly) or "YYYY-MM-H1/H2" (semi-monthly)
  currentMs: number;
  frequency?: AccrualFrequency; // default "monthly"
};

export type AccrualResult = { add: number; newLastYm: string | null };

// Pure: returns the days to add since the last credited period and the new high-water marker. Idempotent
// (running twice in the same period adds nothing). Branches on frequency; the monthly path is unchanged.
export function computeAccrual(i: AccrualInputs): AccrualResult {
  if (!i.startMs || (!i.accrualDaysPerYear && !i.probationAccrualDaysPerYear)) return { add: 0, newLastYm: i.lastAccrualYm };
  return i.frequency === "semi_monthly" ? computeSemiMonthly(i) : computeMonthly(i);
}

function computeMonthly(i: AccrualInputs): AccrualResult {
  const monthly = i.accrualDaysPerYear / 12;
  const monthlyProbation = i.probationAccrualDaysPerYear / 12;
  const startIdx = ymIndex(ymOf(i.startMs!));
  const currentIdx = ymIndex(ymOf(i.currentMs));
  const endIdx = i.endMs ? ymIndex(ymOf(i.endMs)) : currentIdx;
  const lastIdx = Math.min(currentIdx, endIdx);
  // Months before the probation-end month use the probation rate; from that month on, the normal rate.
  const probationEndIdx = i.probationEndMs ? ymIndex(ymOf(i.probationEndMs)) : null;

  let fromIdx = i.lastAccrualYm ? ymIndex(i.lastAccrualYm) + 1 : startIdx;
  if (fromIdx < startIdx) fromIdx = startIdx;

  const rateAt = (idx: number) => (probationEndIdx !== null && idx < probationEndIdx ? monthlyProbation : monthly);

  let add = 0;
  let credited = i.lastAccrualYm;
  for (let idx = fromIdx; idx <= lastIdx; idx++) {
    // A month priced against a KNOWN last working day is final - see FINAL_MARK. Every other month is priced
    // as if employment continues, because at that moment, as far as anything here knows, it does.
    credited = ymFromIndex(idx) + (i.endMs != null && idx >= endIdx ? FINAL_MARK : ""); // processed even if it accrues nothing
    // Prorated at BOTH ends of employment, not just the joining month - see monthFraction. A full month in the
    // middle is 1, so this is the same arithmetic as before everywhere except the first and last months.
    add += rateAt(idx) * monthFraction(idx, i.startMs!, i.endMs);
  }

  // ---- The exit reconciliation ---------------------------------------------------------------------------
  //
  // WHY THE CLAMP ABOVE WAS NOT ENOUGH ON ITS OWN. A month is credited on its FIRST tick, in advance, and the
  // marker then says it is done - `add` is only ever added to the stored balance, and nothing recomputes a
  // month once it is behind the marker. So `monthFraction`'s leaver clamp only ever bit when the last working
  // day was already on the record when that month was first credited. Someone active on the 1st who leaves on
  // the 3rd had the whole month credited two days earlier, the next tick finds the month already marked and
  // adds nothing, and the over-credit stands - which is the exact case the clamp was written for. It is money,
  // not tidiness: those days are encashable and services/settlements.ts prices the balance into the FnF.
  //
  // So when a last working day appears for months that were already credited, the difference is taken back:
  // per month, what was credited (the full rate, since the end date was unknown then) less what was actually
  // earned. A month entirely after the exit reconciles to zero, which is the backdated-exit case. It runs at
  // most once - the final mark is what says so - and never against a month already priced with the end date
  // known, because that month carries the mark already.
  if (i.endMs != null && credited && !isFinalMarker(credited)) {
    const markerIdx = ymIndex(credited);
    if (markerIdx >= endIdx && endIdx >= startIdx) {
      for (let idx = endIdx; idx <= markerIdx; idx++) add -= rateAt(idx) * (1 - monthFraction(idx, i.startMs!, i.endMs));
      credited = ymFromIndex(endIdx) + FINAL_MARK;
    }
  }
  return { add: round2(add), newLastYm: credited };
}

// ---- Semi-monthly accrual ----
// Two periods a month: the first half (days 1-15, creditable from the 1st) and the second half (16th-end,
// creditable from the 16th), each worth annual/24. Period index = month*2 + half. Marker = "YYYY-MM-H1/H2".
const monthIndex0 = (ms: number) => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const halfIndexOf = (ms: number) => monthIndex0(ms) * 2 + (new Date(ms).getUTCDate() >= 16 ? 1 : 0);
const halfMarker = (hIdx: number) => `${ymFromIndex(Math.floor(hIdx / 2))}-H${(hIdx % 2) + 1}`;
function halfMarkerToIndex(marker: string): number {
  // The final mark comes off first: it is a property of the marker, not part of the period it names.
  const bare = stripMark(marker);
  const m = bare.match(/-H([12])$/);
  if (m) return ymIndex(bare) * 2 + (Number(m[1]) - 1); // ymIndex ignores the trailing -Hx segment
  return ymIndex(bare) * 2 + 1; // a monthly-format marker (frequency was switched) = whole month covered
}
// Fraction of one half-period the employee is employed for - the semi-monthly twin of `monthFraction`, and
// clamped at BOTH ends for the same reason (a leaver must not be credited a whole half-period for a day of it).
function halfFraction(hIdx: number, startMs: number, endMs: number | null): number {
  const monthIdx = Math.floor(hIdx / 2);
  const year = Math.floor(monthIdx / 12);
  const month = monthIdx % 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstHalf = hIdx % 2 === 0;
  const periodStartDay = firstHalf ? 1 : 16;
  const periodEndDay = firstHalf ? 15 : daysInMonth;
  const total = periodEndDay - periodStartDay + 1;
  if (total <= 0) return 0;
  const from = Math.max(startMs, Date.UTC(year, month, periodStartDay));
  const to = endMs == null ? Date.UTC(year, month, periodEndDay) : Math.min(endMs, Date.UTC(year, month, periodEndDay));
  if (to < from) return 0;
  return Math.min(1, (Math.round((to - from) / 86_400_000) + 1) / total);
}

function computeSemiMonthly(i: AccrualInputs): AccrualResult {
  const half = i.accrualDaysPerYear / 24;
  const halfProbation = i.probationAccrualDaysPerYear / 24;
  const startIdx = halfIndexOf(i.startMs!);
  const currentIdx = halfIndexOf(i.currentMs);
  const endIdx = i.endMs ? halfIndexOf(i.endMs) : currentIdx;
  const lastIdx = Math.min(currentIdx, endIdx);
  const probationEndIdx = i.probationEndMs ? halfIndexOf(i.probationEndMs) : null;

  let fromIdx = i.lastAccrualYm ? halfMarkerToIndex(i.lastAccrualYm) + 1 : startIdx;
  if (fromIdx < startIdx) fromIdx = startIdx;

  const rateAt = (idx: number) => (probationEndIdx !== null && idx < probationEndIdx ? halfProbation : half);

  let add = 0;
  let credited = i.lastAccrualYm;
  for (let idx = fromIdx; idx <= lastIdx; idx++) {
    credited = halfMarker(idx) + (i.endMs != null && idx >= endIdx ? FINAL_MARK : "");
    add += rateAt(idx) * halfFraction(idx, i.startMs!, i.endMs);
  }
  // The exit reconciliation, on half-periods - see the monthly twin for the whole argument. The window is
  // narrower here (half a period rather than a whole month), and the failure is the same one: a half-period
  // credited in advance, before anyone knew it would be the employee's last.
  if (i.endMs != null && credited && !isFinalMarker(credited)) {
    const markerIdx = halfMarkerToIndex(credited);
    if (markerIdx >= endIdx && endIdx >= startIdx) {
      for (let idx = endIdx; idx <= markerIdx; idx++) add -= rateAt(idx) * (1 - halfFraction(idx, i.startMs!, i.endMs));
      credited = halfMarker(endIdx) + FINAL_MARK;
    }
  }
  return { add: round2(add), newLastYm: credited };
}
