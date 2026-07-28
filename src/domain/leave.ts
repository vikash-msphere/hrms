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
): number {
  const isWork = (ms: number) => workDays.includes(new Date(ms).getUTCDay()) && !holidays.has(ymdUtc(ms));
  let full = 0;
  for (let d = startMs; d <= endMs; d += DAY_MS) if (isWork(d)) full++;
  if (full === 0) return 0;
  let days = full;
  if (startSession === 2 && isWork(startMs)) days -= 0.5; // first day starts after lunch
  if (endSession === 1 && isWork(endMs)) days -= 0.5; // last day ends at lunch
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

// Monotonic month index so we can compare/iterate "YYYY-MM" values arithmetically.
function ymIndex(ym: string): number {
  const parts = ym.split("-");
  return Number(parts[0]) * 12 + (Number(parts[1]) - 1);
}
function ymFromIndex(idx: number): string {
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

// Fraction of the joining calendar month actually worked (start day .. month end, inclusive).
function joiningMonthFraction(startMs: number): number {
  const d = new Date(startMs);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const worked = daysInMonth - d.getUTCDate() + 1;
  return worked / daysInMonth;
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

  let add = 0;
  let credited = i.lastAccrualYm;
  for (let idx = fromIdx; idx <= lastIdx; idx++) {
    credited = ymFromIndex(idx); // month is processed even if it accrues nothing
    const inProbation = probationEndIdx !== null && idx < probationEndIdx;
    const rate = inProbation ? monthlyProbation : monthly;
    add += idx === startIdx ? rate * joiningMonthFraction(i.startMs!) : rate;
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
  const m = marker.match(/-H([12])$/);
  if (m) return ymIndex(marker) * 2 + (Number(m[1]) - 1); // ymIndex ignores the trailing -Hx segment
  return ymIndex(marker) * 2 + 1; // a monthly-format marker (frequency was switched) = whole month covered
}
// Fraction of the half-period worked when the employee joins partway through it.
function joiningHalfFraction(startMs: number, hIdx: number): number {
  const d = new Date(startMs);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const firstHalf = hIdx % 2 === 0;
  const periodStart = firstHalf ? 1 : 16;
  const periodEnd = firstHalf ? 15 : daysInMonth;
  const worked = periodEnd - Math.max(d.getUTCDate(), periodStart) + 1;
  return Math.max(0, Math.min(1, worked / (periodEnd - periodStart + 1)));
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

  let add = 0;
  let credited = i.lastAccrualYm;
  for (let idx = fromIdx; idx <= lastIdx; idx++) {
    credited = halfMarker(idx);
    const inProbation = probationEndIdx !== null && idx < probationEndIdx;
    const rate = inProbation ? halfProbation : half;
    add += idx === startIdx ? rate * joiningHalfFraction(i.startMs!, idx) : rate;
  }
  return { add: round2(add), newLastYm: credited };
}
