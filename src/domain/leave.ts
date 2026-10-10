// PURE leave helpers. No I/O.
import { round2 } from "./money";
import { orgScheduleOf, type DayScheduleOf } from "./workSchedule";

/**
 * The default schedule these helpers fall back to: Mon-Fri, which is what the `workDays` parameter they used
 * to take defaulted to. Callers that know whose leave it is pass that person's own resolver instead, so a
 * Mon/Wed/Fri part-timer's week of leave costs three days rather than five.
 */
const MON_TO_FRI: DayScheduleOf = orgScheduleOf({ work_days: [1, 2, 3, 4, 5] });

export function monthlyAccrual(daysPerYear: number): number {
  return round2(daysPerYear / 12);
}

// Round a day amount to a configured increment: 0 = exact (2dp), 0.5 = nearest half day, 1 = nearest whole
// day. Keeps accrued balances tidy (no e.g. 2.41) when the org wants whole/half-day leave only.
export function roundToIncrement(value: number, increment: number): number {
  const v = increment > 0 ? Math.round(value / increment) * increment : value;
  return round2(v);
}

/**
 * An accrual credit, cut to what fits under the leave type's accrual cap (null = uncapped).
 *
 * Only a CREDIT is capped: a negative `add` is the exit claw-back (computeAccrual) and passes through. The cap
 * is taken down to the rounding increment first, so the rounded balance can never land above it - rounding a
 * value at or below a cap that is itself on the increment grid cannot pass the cap, where a 10.3 cap with
 * half-day rounding would otherwise round every capped balance up to 10.5. A balance already at or above the
 * cap gets nothing; it is never reduced to the cap.
 */
export function capAccrual(balance: number, add: number, capDays: number | null | undefined, increment = 0): number {
  if (add <= 0 || capDays == null) return add;
  const cap = increment > 0 ? Math.floor(capDays / increment + 1e-9) * increment : capDays;
  return round2(Math.max(0, Math.min(add, cap - balance)));
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

// Chargeable leave days for a range, counting only the days THAT PERSON was scheduled to work and excluding
// holidays. `schedOf` is their resolved schedule (domain/workSchedule.ts); `holidays` is a set of
// "YYYY-MM-DD" (UTC).
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
  schedOf: DayScheduleOf = MON_TO_FRI,
  holidays: ReadonlySet<string> = new Set(),
  halfDayHolidays: ReadonlySet<string> = new Set(),
  sandwich: SandwichRule = NO_SANDWICH,
): number {
  let total = 0;
  for (const v of Object.values(daysByMonth(startMs, endMs, startSession, endSession, schedOf, holidays, halfDayHolidays, sandwich))) total += v;
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
  schedOf: DayScheduleOf = MON_TO_FRI,
  holidays: ReadonlySet<string> = new Set(),
  halfDayHolidays: ReadonlySet<string> = new Set(),
  sandwich: SandwichRule = NO_SANDWICH,
): Record<string, number> {
  // What kind of day this is, before any sandwich rule: a weekend is a day this person isn't scheduled on (an
  // ordinary weekend, or a rest day in their rotation), a holiday is a scheduled day the org has declared off.
  // The distinction is the whole point of two sandwich settings.
  const kindOf = (ms: number): "work" | "weekend" | "holiday" | "half" => {
    const ymd = ymdUtc(ms);
    if (schedOf(ymd).off) return "weekend";
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
  /**
   * THE EMPLOYMENT WINDOW THE MARKER WAS PRICED AGAINST, as recorded when those periods were credited.
   *
   * The marker is a high-water mark and the walk only ever adds, which is correct while the window only grows
   * and silently wrong the moment somebody CORRECTS it. Three ordinary edits move it the other way: a start
   * date fixed earlier (the months before the old start are never credited - the walk resumes past them), a
   * departure rescinded (the exit month keeps the partial credit the claw-back left it with), and a start date
   * fixed later (months before the real start stay credited). None of them is detectable from the marker
   * alone, which names a period and says nothing about the window it was priced for.
   *
   * `pricedStartMs` null means "not recorded" - a balance credited before this was carried - and the walk then
   * assumes the window it has always assumed: the current start, with no end date. That is exactly what the
   * exit reconciliation used to hard-code (`creditedFractionAt`), so an unrecorded row is priced today the way
   * it was priced yesterday, and the correction below reduces to the reconciliation it replaces.
   */
  pricedStartMs?: number | null;
  pricedEndMs?: number | null;
  /**
   * THE DAY HRMS RECORDS START for this person (`employees.tracked_from`), or null. Somebody who joined before
   * the org used the app has entitlement that was earned - and partly spent - somewhere else, and the app has
   * no record of the spending. So a period that STARTS before this day is not the walk's to price: its
   * entitlement belongs to the opening balance (services/leaveAdjustments.ts), which is entered as a figure
   * rather than accrued.
   *
   * Such a period is left alone in BOTH directions. The forward walk never credits it, and the window
   * correction never re-prices it - so setting the date takes nothing back on its own (the opening balance
   * does that, explicitly, with `creditedBeforeFloor`), and a start date corrected years back afterwards
   * does not credit months nobody here ever saw. The recorded window keeps describing what the balance holds
   * for those periods for the same reason: it is what `creditedBeforeFloor` reads.
   *
   * No effect unless it is after the start date: records that start on or before the day somebody joined
   * leave nothing to open.
   */
  floorMs?: number | null;
};

/** `pricedStart`/`pricedEnd` come back so the caller can store the window these periods were priced against. */
export type AccrualResult = { add: number; newLastYm: string | null; pricedStartMs: number | null; pricedEndMs: number | null };

// Pure: returns the days to add since the last credited period and the new high-water marker. Idempotent
// (running twice in the same period adds nothing). Branches on frequency; the monthly path is unchanged.
export function computeAccrual(i: AccrualInputs): AccrualResult {
  if (!i.startMs || (!i.accrualDaysPerYear && !i.probationAccrualDaysPerYear)) {
    return { add: 0, newLastYm: i.lastAccrualYm, pricedStartMs: i.pricedStartMs ?? null, pricedEndMs: i.pricedEndMs ?? null };
  }
  return i.frequency === "semi_monthly" ? computeSemiMonthly(i) : computeMonthly(i);
}

// ---- Where HRMS pricing starts (`floorMs`) -----------------------------------------------------------------
//
// The first period HRMS prices for somebody whose records start after they joined: the first period that
// STARTS on or after the floor day, and never one inside the month they joined in. The second half is what
// keeps the joining-date rule entirely on the opening side: a period HRMS prices is never a joining period,
// so the rule never has to be re-read against a window that only exists because of the floor.
// Null when there is no floor, or it is not after the start date.

function floorMonthIdx(i: AccrualInputs): number | null {
  if (i.floorMs == null || !i.startMs || i.floorMs <= i.startMs) return null;
  const d = new Date(i.floorMs);
  const idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
  return Math.max(d.getUTCDate() === 1 ? idx : idx + 1, ymIndex(ymOf(i.startMs)) + 1);
}

function floorHalfIdx(i: AccrualInputs): number | null {
  if (i.floorMs == null || !i.startMs || i.floorMs <= i.startMs) return null;
  const day = new Date(i.floorMs).getUTCDate();
  const h = halfIndexOf(i.floorMs);
  return Math.max(day === 1 || day === 16 ? h : h + 1, (monthIndex0(i.startMs) + 1) * 2);
}

/**
 * The first day of the first period HRMS prices for this person (see floorMs), or null when their records
 * start on their start date. For a reader listing what accrual did - a period before it is the opening
 * balance's, whatever an earlier tick happened to credit for it.
 */
export function hrmsPricingStartMs(i: Pick<AccrualInputs, "startMs" | "floorMs" | "frequency">): number | null {
  const probe = i as AccrualInputs;
  if (i.frequency === "semi_monthly") {
    const h = floorHalfIdx(probe);
    if (h === null) return null;
    const m = Math.floor(h / 2);
    return Date.UTC(Math.floor(m / 12), m % 12, h % 2 === 0 ? 1 : 16);
  }
  const idx = floorMonthIdx(probe);
  return idx === null ? null : Date.UTC(Math.floor(idx / 12), idx % 12, 1);
}

/**
 * What a balance holds for the periods before the floor: the credits the walk made for them, priced against
 * the window it recorded (or the marker's own fallback where none was recorded - see `pricedStartMs`). This is
 * the figure an opening balance REPLACES (services/leaveAdjustments.ts): the app's reading of years it never
 * saw, credited in one go by the first nightly run with nothing deducted for leave used before go-live.
 *
 * Exact because of what the walk does under a floor: it never re-prices those periods, and it keeps the
 * window they were priced against (computeMonthly / computeSemiMonthly). A balance that HRMS first credited
 * after the floor was set recorded the floor's own period as its start, so it answers zero.
 *
 * `rateAt` is the current rate, the same approximation `windowCorrection` makes: a rate edited after these
 * periods were credited makes the figure differ by the edit. The opening preview shows it for that reason.
 */
export function creditedBeforeFloor(i: AccrualInputs): number {
  if (!i.startMs || !i.lastAccrualYm || (!i.accrualDaysPerYear && !i.probationAccrualDaysPerYear)) return 0;
  return i.frequency === "semi_monthly" ? semiMonthlyCreditedBeforeFloor(i) : monthlyCreditedBeforeFloor(i);
}

/**
 * The marker a balance should carry once its opening is applied, when the walk has not yet reached the last
 * period before the floor. From the opening on, every period before the floor is the opening's, so one the
 * walk had not credited yet must never be credited after it - marking it processed is what guarantees that.
 * Null when the marker needs no move: no floor, no marker (the walk then starts at the floor on its own), a
 * marker already at or past the floor, or a leaver's final mark (which says the window is closed).
 */
export function openingMarker(i: AccrualInputs): string | null {
  if (!i.startMs || !i.lastAccrualYm || isFinalMarker(i.lastAccrualYm)) return null;
  const before = floorMarker(i);
  if (before === null) return null;
  const at = i.frequency === "semi_monthly" ? halfMarkerToIndex(i.lastAccrualYm) : ymIndex(i.lastAccrualYm);
  const floorLast = i.frequency === "semi_monthly" ? halfMarkerToIndex(before) : ymIndex(before);
  return at >= floorLast ? null : before;
}

/** The marker of the last period before the floor (see floorMs), or null when there is no floor. */
export function floorMarker(i: AccrualInputs): string | null {
  if (i.frequency === "semi_monthly") {
    const floorIdx = floorHalfIdx(i);
    return floorIdx === null ? null : halfMarker(floorIdx - 1);
  }
  const floorIdx = floorMonthIdx(i);
  return floorIdx === null ? null : ymFromIndex(floorIdx - 1);
}

/**
 * What the leave policy grants for the periods before the floor at `floorMs` (see floorMs): every period from
 * the joining one, priced against the employment window as it reads now, whether HRMS credited it or not. With
 * `through` (an accrual marker) it stops at that period instead, which is how a caller asks for only the
 * periods the walk has reached. Zero when `floorMs` is on or before the start date.
 *
 * An opening balance as of a day other than the records start reads this twice (services/leaveAdjustments.ts):
 * the difference between two floors is the entitlement between two days, which is what a sheet dated before
 * the records start is missing and what one dated after them already has.
 */
export function entitlementBefore(i: AccrualInputs, floorMs: number, through?: string | null): number {
  const at = { ...i, floorMs };
  const last = through === undefined ? floorMarker(at) : through;
  if (!last) return 0;
  return creditedBeforeFloor({ ...at, lastAccrualYm: last, pricedStartMs: i.startMs, pricedEndMs: i.endMs });
}

// The recorded window the pre-floor periods were priced against, with the marker's fallback for a balance
// that recorded none (see computeMonthly's correction for the same reading).
function wasWindow(i: AccrualInputs): { startMs: number; endMs: number | null } {
  const startMs = i.pricedStartMs ?? i.startMs!;
  const endMs = i.pricedStartMs != null ? i.pricedEndMs ?? null : isFinalMarker(i.lastAccrualYm) ? i.endMs : null;
  return { startMs, endMs };
}

// A recorded start that is only a floor's own first day was never a joining period (the walk starts there
// under a floor and prices it as an ordinary one). A real start date that happens to fall on the 1st or 16th
// AND has since been edited is read the same way - the one case this approximates, and only on a semi-monthly
// type with a joining-date rule.
const isPeriodStartDay = (ms: number) => { const d = new Date(ms).getUTCDate(); return d === 1 || d === 16; };

function monthlyCreditedBeforeFloor(i: AccrualInputs): number {
  const floorIdx = floorMonthIdx(i);
  if (floorIdx === null) return 0;
  const was = wasWindow(i);
  const wasStartIdx = ymIndex(ymOf(was.startMs));
  const wasEndIdx = was.endMs != null ? ymIndex(ymOf(was.endMs)) : null;
  const last = Math.min(ymIndex(i.lastAccrualYm!), floorIdx - 1, wasEndIdx ?? Number.POSITIVE_INFINITY);
  const probationEndIdx = i.probationEndMs ? ymIndex(ymOf(i.probationEndMs)) : null;
  const rateAt = (idx: number) => (probationEndIdx !== null && idx < probationEndIdx ? i.probationAccrualDaysPerYear : i.accrualDaysPerYear) / 12;
  const realStart = was.startMs === i.startMs || !isPeriodStartDay(was.startMs);
  const fullOrWorked = (idx: number) => {
    const capped = monthFraction(idx, Date.UTC(Math.floor(idx / 12), idx % 12, 1), was.endMs);
    return capped < 1 ? monthFraction(idx, was.startMs, was.endMs) : 1;
  };
  let sum = 0;
  for (let idx = wasStartIdx; idx <= last; idx++) {
    sum += rateAt(idx) * applyJoiningRule(monthFraction(idx, was.startMs, was.endMs), realStart && idx === wasStartIdx, was.startMs, i.joiningRule, () => fullOrWorked(idx));
  }
  return round2(sum);
}

function semiMonthlyCreditedBeforeFloor(i: AccrualInputs): number {
  const floorIdx = floorHalfIdx(i);
  if (floorIdx === null) return 0;
  const was = wasWindow(i);
  const wasStartIdx = halfIndexOf(was.startMs);
  const wasEndIdx = was.endMs != null ? halfIndexOf(was.endMs) : null;
  const last = Math.min(halfMarkerToIndex(i.lastAccrualYm!), floorIdx - 1, wasEndIdx ?? Number.POSITIVE_INFINITY);
  const probationEndIdx = i.probationEndMs ? halfIndexOf(i.probationEndMs) : null;
  const rateAt = (idx: number) => (probationEndIdx !== null && idx < probationEndIdx ? i.probationAccrualDaysPerYear : i.accrualDaysPerYear) / 24;
  const joiningMonth = Math.floor(wasStartIdx / 2);
  const realStart = was.startMs === i.startMs || !isPeriodStartDay(was.startMs);
  const monthStartOfHalf = (hIdx: number) => { const m = Math.floor(hIdx / 2); return Date.UTC(Math.floor(m / 12), m % 12, 1); };
  const fullOrWorked = (idx: number) => {
    const capped = halfFraction(idx, monthStartOfHalf(idx), was.endMs);
    return capped < 1 ? halfFraction(idx, was.startMs, was.endMs) : 1;
  };
  let sum = 0;
  for (let idx = wasStartIdx; idx <= last; idx++) {
    sum += rateAt(idx) * applyJoiningRule(halfFraction(idx, was.startMs, was.endMs), realStart && Math.floor(idx / 2) === joiningMonth, was.startMs, i.joiningRule, () => fullOrWorked(idx));
  }
  return round2(sum);
}

/**
 * What the already-credited periods are worth NOW, less what they were worth when they were credited.
 *
 * ONE correction, not two. This replaces the exit reconciliation that used to sit in each frequency's walk,
 * and it is the same arithmetic generalised: that block compared "what a month was credited at, assuming
 * employment continued" against "what it is worth now the last working day is known", which is this function
 * with the old window taken to be `(start, null)` - which is exactly what an unrecorded window means below. So
 * a balance with no recorded window is priced identically to before, and a recorded one additionally survives
 * the corrections the marker cannot see: a start date moved either way, and an exit that was withdrawn.
 *
 * `rateAt` is the CURRENT rate. A correction to the window is priced at today's rate even for an old period,
 * which is the one approximation here: a rate that also changed makes the difference slightly off. Re-pricing
 * history at the current rate is the alternative, and it is worse - it would make every rate edit retroactive,
 * silently restating balances nobody touched.
 */
function windowCorrection(args: {
  fromIdx: number; // the first period either window credits
  markerIdx: number; // the last period the marker says was credited
  rateAt: (idx: number) => number;
  /** The period's value under the window it was CREDITED against, and under the window as it reads now. */
  wasFractionAt: (idx: number) => number;
  nowFractionAt: (idx: number) => number;
  /** Which periods each window actually covers - outside its own range a period is worth nothing at all. */
  wasCovers: (idx: number) => boolean;
  nowCovers: (idx: number) => boolean;
}): number {
  let delta = 0;
  for (let idx = args.fromIdx; idx <= args.markerIdx; idx++) {
    const was = args.wasCovers(idx) ? args.wasFractionAt(idx) : 0;
    const now = args.nowCovers(idx) ? args.nowFractionAt(idx) : 0;
    if (was !== now) delta += args.rateAt(idx) * (now - was);
  }
  return delta;
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
  // UNDER A FLOOR (see floorMs), a balance HRMS has not credited yet starts at the floor's month: the months
  // before it are the opening balance's. One it HAS credited keeps walking from its marker - any month it
  // covers before the floor is a credit `creditedBeforeFloor` counts and the opening then replaces, so the
  // walk never has to leave a hole in the marker that nothing could account for.
  const floorIdx = floorMonthIdx(i);
  if (floorIdx !== null && !i.lastAccrualYm && fromIdx < floorIdx) fromIdx = floorIdx;

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

  // ---- The window correction ------------------------------------------------------------------------------
  //
  // Everything above prices months from the marker FORWARD. This is the other direction: months already behind
  // the marker, whose price changed because the employment window moved under them. See `windowCorrection` for
  // why this is one rule rather than the exit-only reconciliation it replaces.
  // ONLY PERIODS AN EARLIER TICK CREDITED. The months the walk above just priced were priced against the
  // window as it reads NOW, so there is nothing about them to correct - and correcting them anyway subtracts
  // the leaver clamp a second time, which is what the first draft of this did.
  const priorMarkerIdx = i.lastAccrualYm ? ymIndex(i.lastAccrualYm) : null;
  if (credited && priorMarkerIdx !== null) {
    const markerIdx = priorMarkerIdx;
    // The window those months were credited against.
    //
    // Unrecorded (a balance carried from before the columns existed) falls back to what the marker itself
    // says, which is all the old design ever recorded: this start, and an end date only where the FINAL MARK
    // says the month was already priced with one. That mark was a one-bit version of exactly this window -
    // which is why reading it here reproduces the old reconciliation's "only once" guarantee rather than
    // clawing the same exit back on every tick.
    const wasStartMs = i.pricedStartMs ?? i.startMs!;
    const wasEndMs = i.pricedStartMs != null ? i.pricedEndMs ?? null : isFinalMarker(i.lastAccrualYm) ? i.endMs : null;
    const wasStartIdx = ymIndex(ymOf(wasStartMs));
    const wasEndIdx = wasEndMs != null ? ymIndex(ymOf(wasEndMs)) : null;
    const wasJoining = (idx: number) => idx === wasStartIdx;
    const wasFullOrWorked = (idx: number) => {
      const capped = monthFraction(idx, monthStartOf(idx), wasEndMs);
      return capped < 1 ? monthFraction(idx, wasStartMs, wasEndMs) : 1;
    };
    add += windowCorrection({
      // From whichever window starts earlier: a start corrected EARLIER has months the old walk never reached,
      // and they are the ones nothing else will ever credit. Never from before the floor: those months are the
      // opening balance's, in both directions (see floorMs).
      fromIdx: floorIdx === null ? Math.min(startIdx, wasStartIdx) : Math.max(Math.min(startIdx, wasStartIdx), floorIdx),
      markerIdx,
      rateAt,
      // Under a floor no month it reaches is a joining month (floorMonthIdx), on either side.
      wasFractionAt: (idx) => applyJoiningRule(monthFraction(idx, wasStartMs, wasEndMs), floorIdx === null && wasJoining(idx), wasStartMs, i.joiningRule, () => wasFullOrWorked(idx)),
      nowFractionAt: fractionAt,
      wasCovers: (idx) => idx >= wasStartIdx && (wasEndIdx == null || idx <= wasEndIdx),
      nowCovers: (idx) => idx >= startIdx && (i.endMs == null || idx <= endIdx),
    });
    // The marker follows the window. It stays where it is while employment continues; where the window now
    // ENDS before it, the exit month becomes the marker (and is final), which is what the reconciliation this
    // replaces did explicitly. Computed from the marker as the walk above left it, not from the prior one.
    const reached = Math.max(ymIndex(credited), lastIdx);
    const coveredIdx = i.endMs != null ? Math.min(reached, endIdx) : reached;
    if (coveredIdx >= startIdx) credited = ymFromIndex(coveredIdx) + (i.endMs != null && coveredIdx >= endIdx ? FINAL_MARK : "");
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
  return { add: round2(add), newLastYm: credited, pricedStartMs: pricedStartUnder(i, floorIdx, (ms) => ymIndex(ymOf(ms)), monthStartOf), pricedEndMs: i.endMs ?? null };
}

/**
 * The window START to record after a walk. Without a floor it is the start date, as it has always been. Under
 * one it describes what the balance holds for the periods before the floor, because that is what
 * `creditedBeforeFloor` reads and nothing re-prices them any more:
 *   - a start recorded before the floor stays exactly as it was, so a start date corrected afterwards (still
 *     before the floor) cannot make those periods look differently credited;
 *   - otherwise HRMS priced this balance from the floor's own period, and that is its start - for a balance
 *     credited for the first time under the floor, and for one whose floor moved earlier.
 * A balance credited before windows were recorded (no recorded start, but a marker) was priced from the start
 * date, which is what the correction's own fallback assumes too.
 */
function pricedStartUnder(i: AccrualInputs, floorIdx: number | null, idxOf: (ms: number) => number, periodStart: (idx: number) => number): number {
  if (floorIdx === null) return i.startMs!;
  const recorded = i.pricedStartMs ?? (i.lastAccrualYm ? i.startMs! : null);
  return recorded != null && idxOf(recorded) < floorIdx ? recorded : periodStart(floorIdx);
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
  // Under a floor, an uncredited balance starts at the floor's half-period - see the monthly twin.
  const floorIdx = floorHalfIdx(i);
  if (floorIdx !== null && !i.lastAccrualYm && fromIdx < floorIdx) fromIdx = floorIdx;

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

  let add = 0;
  let credited = i.lastAccrualYm;
  for (let idx = fromIdx; idx <= lastIdx; idx++) {
    credited = halfMarker(idx) + (i.endMs != null && idx >= endIdx ? FINAL_MARK : "");
    add += rateAt(idx) * fractionAt(idx);
  }

  // The window correction, on half-periods - see the monthly twin for the whole argument. The only difference
  // is the period: half a month rather than a month, so an exit or a corrected start lands inside one twice as
  // often.
  // Periods an earlier tick credited, only - see the monthly twin.
  const priorMarkerIdx = i.lastAccrualYm ? halfMarkerToIndex(i.lastAccrualYm) : null;
  if (credited && priorMarkerIdx !== null) {
    const markerIdx = priorMarkerIdx;
    // Unrecorded falls back to the marker's own one-bit record of it - see the monthly twin.
    const wasStartMs = i.pricedStartMs ?? i.startMs!;
    const wasEndMs = i.pricedStartMs != null ? i.pricedEndMs ?? null : isFinalMarker(i.lastAccrualYm) ? i.endMs : null;
    const wasStartIdx = halfIndexOf(wasStartMs);
    const wasEndIdx = wasEndMs != null ? halfIndexOf(wasEndMs) : null;
    const wasJoiningMonthIdx = Math.floor(wasStartIdx / 2);
    const wasJoining = (hIdx: number) => Math.floor(hIdx / 2) === wasJoiningMonthIdx;
    const wasFullOrWorked = (idx: number) => {
      const capped = halfFraction(idx, monthStartOfHalf(idx), wasEndMs);
      return capped < 1 ? halfFraction(idx, wasStartMs, wasEndMs) : 1;
    };
    add += windowCorrection({
      // Never from before the floor, and no joining month past it - see the monthly twin.
      fromIdx: floorIdx === null ? Math.min(startIdx, wasStartIdx) : Math.max(Math.min(startIdx, wasStartIdx), floorIdx),
      markerIdx,
      rateAt,
      wasFractionAt: (idx) => applyJoiningRule(halfFraction(idx, wasStartMs, wasEndMs), floorIdx === null && wasJoining(idx), wasStartMs, i.joiningRule, () => wasFullOrWorked(idx)),
      nowFractionAt: fractionAt,
      wasCovers: (idx) => idx >= wasStartIdx && (wasEndIdx == null || idx <= wasEndIdx),
      nowCovers: (idx) => idx >= startIdx && (i.endMs == null || idx <= endIdx),
    });
    const reached = Math.max(halfMarkerToIndex(credited), lastIdx);
    const coveredIdx = i.endMs != null ? Math.min(reached, endIdx) : reached;
    if (coveredIdx >= startIdx) credited = halfMarker(coveredIdx) + (i.endMs != null && coveredIdx >= endIdx ? FINAL_MARK : "");
  }
  const halfStartOf = (hIdx: number) => { const m = Math.floor(hIdx / 2); return Date.UTC(Math.floor(m / 12), m % 12, hIdx % 2 === 0 ? 1 : 16); };
  return { add: round2(add), newLastYm: credited, pricedStartMs: pricedStartUnder(i, floorIdx, halfIndexOf, halfStartOf), pricedEndMs: i.endMs ?? null };
}
