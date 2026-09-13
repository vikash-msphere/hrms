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

/**
 * The SANDWICH RULE: whether the days off inside (or beside) a leave block are charged to the balance anyway.
 *
 * - "exclude"    - the default, and what this function did before it took the argument: a weekend or holiday
 *                  costs nothing, so Friday + Monday is two days.
 * - "intervening" - days off that fall BETWEEN the first and last charged day are charged. Friday + Monday is
 *                  four days, because the weekend was sandwiched.
 * - "flanking"   - intervening, plus the unbroken run of days off the leave ABUTS on either side. A single
 *                  Friday costs three, because the weekend behind it follows the leave.
 *
 * Weekends and holidays are configured SEPARATELY because real policies differ on them: charging the weekend
 * inside a block is common, charging a public holiday inside it much less so.
 */
export type SandwichMode = "exclude" | "intervening" | "flanking";
export type SandwichRule = { weekends: SandwichMode; holidays: SandwichMode };
export const NO_SANDWICH: SandwichRule = { weekends: "exclude", holidays: "exclude" };
// How far a "flanking" walk may run outwards. A long weekend plus a holiday is four or five days; anything
// past a week is a calendar nobody has, and an unbounded walk off the end of the holiday set is a loop with
// no reason to stop.
const FLANK_LIMIT_DAYS = 7;

// Chargeable leave days for a range, counting only the org's configured working days and excluding holidays.
// `workDays` is the weekday set (0=Sun..6=Sat; default Mon-Fri); `holidays` is a set of "YYYY-MM-DD" (UTC).
// Sessions: 1 = first half (morning), 2 = second half (afternoon). The leave runs contiguously from
// `startSession` of the start day to `endSession` of the end day, so a first day that starts in the afternoon
// (startSession=2) and a last day that ends at midday (endSession=1) each drop half a working day - but only
// when that boundary day is itself a working day (a half flag on a weekend/holiday is ignored). Works for a
// single day too: (1,1)=morning, (2,2)=afternoon, (1,2)=full.
//
// `sandwich` (default: charge nothing for days off) can put those days back - see SandwichRule.
export function leaveDays(
  startMs: number,
  endMs: number,
  startSession = 1,
  endSession = 2,
  workDays: readonly number[] = [1, 2, 3, 4, 5],
  holidays: ReadonlySet<string> = new Set(),
  halfDayHolidays: ReadonlySet<string> = new Set(),
  sandwich: SandwichRule = NO_SANDWICH,
): number {
  let total = 0;
  for (const v of Object.values(daysByMonth(startMs, endMs, startSession, endSession, workDays, holidays, halfDayHolidays, sandwich))) total += v;
  return Math.round(total * 2) / 2;
}

/**
 * The same walk as `leaveDays`, split by the calendar month each day falls in ("YYYY-MM" -> days).
 *
 * It exists because the per-month quota rules (domain/leaveRestrictions.ts) have to ask what a request costs
 * in ONE month, and a request that straddles a month boundary cannot answer that from its stored total. Both
 * functions therefore share one implementation rather than one being a re-derivation of the other: the number
 * the employee is shown, the number charged to the balance, and the number a monthly cap is checked against
 * are the same arithmetic or they are a bug.
 *
 * Months with no chargeable day are absent rather than zero.
 */
export function daysByMonth(
  startMs: number,
  endMs: number,
  startSession = 1,
  endSession = 2,
  workDays: readonly number[] = [1, 2, 3, 4, 5],
  holidays: ReadonlySet<string> = new Set(),
  halfDayHolidays: ReadonlySet<string> = new Set(),
  sandwich: SandwichRule = NO_SANDWICH,
): Record<string, number> {
  // What kind of day this is, before any sandwich rule: a weekend is one the org doesn't work, a holiday is a
  // working weekday the org has declared off. The distinction is the whole point of two sandwich settings.
  const kindOf = (ms: number): "work" | "weekend" | "holiday" | "half" => {
    if (!workDays.includes(new Date(ms).getUTCDay())) return "weekend";
    const ymd = ymdUtc(ms);
    if (holidays.has(ymd)) return "holiday";
    return halfDayHolidays.has(ymd) ? "half" : "work";
  };
  // What one calendar day is worth with no sandwich rule applied: a working day is 1, a holiday 0, and a
  // half-day holiday 0.5 (the office is open for the other half, so leave across it costs half a day).
  const baseOf = (ms: number) => {
    const k = kindOf(ms);
    return k === "work" ? 1 : k === "half" ? 0.5 : 0;
  };
  // What the sandwich rule adds back for a day off, given which mode covers that kind of day.
  const modeFor = (k: ReturnType<typeof kindOf>) => (k === "weekend" ? sandwich.weekends : sandwich.holidays);
  const sandwichTop = (ms: number) => {
    const k = kindOf(ms);
    if (k === "work") return 0;
    return modeFor(k) === "exclude" ? 0 : 1 - baseOf(ms); // a half-day holiday is topped up to a whole day
  };

  // The per-day charge, built up before anything is totalled. It is a map rather than a running sum because
  // the session shave has to take back what a boundary day was ACTUALLY charged - which, once a sandwich rule
  // is in play, is not something the day can be asked for on its own: a Saturday at the head of the range is
  // charged nothing (nothing was sandwiched behind it) while the same Saturday inside the block is charged a
  // full day. Deriving the shave from the day's kind instead got that wrong in exactly that case.
  const charged = new Map<number, number>();
  const add = (ms: number, v: number) => { if (v) charged.set(ms, (charged.get(ms) ?? 0) + v); };

  // Pass one: the base value of every day in the range, and where the charged days actually begin and end -
  // the sandwich is what sits BETWEEN those two, not between the requested dates (a range that opens on a
  // Saturday has not sandwiched that Saturday).
  let firstCharged = -1;
  let lastCharged = -1;
  for (let d = startMs; d <= endMs; d += DAY_MS) {
    const base = baseOf(d);
    add(d, base);
    if (base > 0) {
      if (firstCharged < 0) firstCharged = d;
      lastCharged = d;
    }
  }
  if (firstCharged < 0) return {}; // nothing chargeable: no sandwich to apply, and no sessions to shave

  // Pass two: the days off the rule charges anyway. Inside first: everything between the first and last
  // charged day. Then, for "flanking", the unbroken run of days off immediately before and after the block.
  for (let d = firstCharged; d <= lastCharged; d += DAY_MS) add(d, sandwichTop(d));
  const flank = (from: number, step: number) => {
    for (let i = 1, d = from + step; i <= FLANK_LIMIT_DAYS; i++, d += step) {
      const k = kindOf(d);
      if (k === "work") return; // the run of days off has ended
      if (modeFor(k) !== "flanking") return; // this kind of day off isn't charged on the flank
      add(d, 1);
    }
  };
  flank(firstCharged, -DAY_MS);
  flank(lastCharged, DAY_MS);

  // A session flag shaves at most what the boundary day was actually charged (so a PM start on a morning-only
  // half-day holiday costs nothing, not -0.5 - unless a sandwich rule charged that holiday in full, in which
  // case half of it is genuinely being skipped).
  if (startSession === 2) add(startMs, -Math.min(0.5, charged.get(startMs) ?? 0)); // first day starts after lunch
  if (endSession === 1) add(endMs, -Math.min(0.5, charged.get(endMs) ?? 0)); // last day ends at lunch

  const out: Record<string, number> = {};
  for (const [ms, v] of charged) {
    const ym = ymdUtc(ms).slice(0, 7);
    out[ym] = (out[ym] ?? 0) + v;
  }
  for (const [ym, v] of Object.entries(out)) {
    const rounded = Math.round(v * 2) / 2;
    if (rounded <= 0) delete out[ym];
    else out[ym] = rounded;
  }
  return out;
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

/**
 * The joining-date rule applied to ONE period's fraction - see JoiningRule.
 *
 * It only ever touches the period the employee JOINED in (`isJoiningPeriod`); every later period is whatever
 * the proration said. "full" is expressed by re-asking for the fraction with the month's own start in place of
 * the joining date, which is what keeps the exit clamp: a month someone joined AND left in is still priced for
 * the days they were here, because `endMs` is still in the answer.
 */
function applyJoiningRule(
  base: number,
  isJoiningPeriod: boolean,
  startMs: number,
  rule: JoiningRule | null | undefined,
  fullFraction: () => number,
): number {
  if (!rule || !isJoiningPeriod) return base;
  const joinedOn = new Date(startMs).getUTCDate();
  if (joinedOn <= rule.cutoff_day) return rule.if_on_or_before === "full" ? fullFraction() : base;
  return rule.if_after === "none" ? 0 : base;
}

export type AccrualFrequency = "monthly" | "semi_monthly";

/**
 * The JOINING-DATE RULE: how the month somebody joins in is priced.
 *
 * The default (no rule) is the proration above - join on the 20th of a 30-day month and earn a third of that
 * month's entitlement. Plenty of policies are written as a cutoff instead: join on or before the 15th and the
 * month counts in full, join after it and the month does not count at all. `cutoff_day` is that date;
 * `if_on_or_before` and `if_after` say what happens on each side of it, so a policy can waive the proration on
 * one side without changing the other.
 *
 * `if_after: "none"` ALSO bars requests of that type starting in the joining month (services/leaveRequests.ts):
 * a month that earns nothing is a month there is nothing to spend, and for an unpaid type - which no balance
 * check would stop - saying so is the only place the rule exists.
 *
 * The exit clamp still wins. "full" waives the JOINING proration, not the leaving one; somebody who joins and
 * leaves inside one month is priced for the days they were here either way.
 */
export type JoiningRule = {
  cutoff_day: number; // 1..28
  if_on_or_before: "full" | "prorate";
  if_after: "none" | "prorate";
};

export type AccrualInputs = {
  accrualDaysPerYear: number; // normal (post-probation) annual rate
  probationAccrualDaysPerYear: number; // annual rate during probation (often 0 or reduced)
  startMs: number | null; // employee first working day (no start -> no accrual)
  endMs: number | null; // employee last day (null = ongoing)
  probationEndMs: number | null; // null = no probation (normal rate throughout)
  lastAccrualYm: string | null; // last period credited: "YYYY-MM" (monthly) or "YYYY-MM-H1/H2" (semi-monthly)
  currentMs: number;
  frequency?: AccrualFrequency; // default "monthly"
  joiningRule?: JoiningRule | null; // null/absent = prorate the joining month, as before
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
  // The joining month's fraction, once the joining-date rule has had its say (see applyJoiningRule). The
  // month's own first day stands in for the joining date when the rule credits the month in full.
  const monthStartOf = (idx: number) => Date.UTC(Math.floor(idx / 12), idx % 12, 1);
  // "Credit the joining month in full" waives the JOINING proration and nothing else. If the employment also
  // ENDS in that month the waiver stands down entirely and the month is priced for the days actually worked:
  // the alternative - crediting from the 1st, before the person had joined - hands out entitlement for days
  // nobody was employed, and accrued leave is encashed for cash at exit.
  const fullOrWorked = (idx: number) => {
    const capped = monthFraction(idx, monthStartOf(idx), i.endMs);
    return capped < 1 ? monthFraction(idx, i.startMs!, i.endMs) : 1;
  };
  const fractionAt = (idx: number) =>
    applyJoiningRule(monthFraction(idx, i.startMs!, i.endMs), idx === startIdx, i.startMs!, i.joiningRule, () => fullOrWorked(idx));
  // The same fraction as it stood when the month was first credited - i.e. with no last working day known.
  // The exit reconciliation below is a difference between these two, so it needs both.
  const creditedFractionAt = (idx: number) =>
    applyJoiningRule(monthFraction(idx, i.startMs!, null), idx === startIdx, i.startMs!, i.joiningRule, () => 1);

  let add = 0;
  let credited = i.lastAccrualYm;
  for (let idx = fromIdx; idx <= lastIdx; idx++) {
    // A month priced against a KNOWN last working day is final - see FINAL_MARK. Every other month is priced
    // as if employment continues, because at that moment, as far as anything here knows, it does.
    credited = ymFromIndex(idx) + (i.endMs != null && idx >= endIdx ? FINAL_MARK : ""); // processed even if it accrues nothing
    // Prorated at BOTH ends of employment, not just the joining month - see monthFraction. A full month in the
    // middle is 1, so this is the same arithmetic as before everywhere except the first and last months.
    add += rateAt(idx) * fractionAt(idx);
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
      // WHAT WAS CREDITED, not "a whole month". The claw-back is the difference between the two prices, so
      // both halves of it have to be the price this walk would really have paid: the month was credited with
      // `endMs` unknown, which is `monthFraction(idx, start, null)` - exactly 1 for every month after the
      // joining one, but the joining PRORATION for the joining month, and whatever the joining-date rule says
      // where one is configured. Hard-coding 1 took back a full month's entitlement from someone who joined
      // and left inside the same month, having only ever been credited part of it.
      for (let idx = endIdx; idx <= markerIdx; idx++) add -= rateAt(idx) * (creditedFractionAt(idx) - fractionAt(idx));
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
  // The joining-date rule, on half-periods. It is a rule about the MONTH somebody joined, so it covers both
  // halves of it - a joiner past the cutoff earns nothing for either half, and a waived proration credits both
  // in full. `isJoiningMonth` is therefore a month comparison, not the `idx === startIdx` of the monthly twin.
  const monthStartOfHalf = (hIdx: number) => { const m = Math.floor(hIdx / 2); return Date.UTC(Math.floor(m / 12), m % 12, 1); };
  const joiningMonthIdx = Math.floor(startIdx / 2);
  const isJoiningMonth = (hIdx: number) => Math.floor(hIdx / 2) === joiningMonthIdx;
  // See the monthly twin: a waived joining proration stands down when the employment ends in that month too.
  const fullOrWorked = (idx: number) => {
    const capped = halfFraction(idx, monthStartOfHalf(idx), i.endMs);
    return capped < 1 ? halfFraction(idx, i.startMs!, i.endMs) : 1;
  };
  const fractionAt = (idx: number) =>
    applyJoiningRule(halfFraction(idx, i.startMs!, i.endMs), isJoiningMonth(idx), i.startMs!, i.joiningRule, () => fullOrWorked(idx));
  const creditedFractionAt = (idx: number) =>
    applyJoiningRule(halfFraction(idx, i.startMs!, null), isJoiningMonth(idx), i.startMs!, i.joiningRule, () => 1);

  let add = 0;
  let credited = i.lastAccrualYm;
  for (let idx = fromIdx; idx <= lastIdx; idx++) {
    credited = halfMarker(idx) + (i.endMs != null && idx >= endIdx ? FINAL_MARK : "");
    add += rateAt(idx) * fractionAt(idx);
  }
  // The exit reconciliation, on half-periods - see the monthly twin for the whole argument. The window is
  // narrower here (half a period rather than a whole month), and the failure is the same one: a half-period
  // credited in advance, before anyone knew it would be the employee's last.
  if (i.endMs != null && credited && !isFinalMarker(credited)) {
    const markerIdx = halfMarkerToIndex(credited);
    if (markerIdx >= endIdx && endIdx >= startIdx) {
      // The difference between what was credited and what was earned - see the monthly twin for why it is not
      // `1 - fraction`.
      for (let idx = endIdx; idx <= markerIdx; idx++) add -= rateAt(idx) * (creditedFractionAt(idx) - fractionAt(idx));
      credited = halfMarker(endIdx) + FINAL_MARK;
    }
  }
  return { add: round2(add), newLastYm: credited };
}
