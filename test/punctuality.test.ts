import { describe, it, expect } from "vitest";
import {
  DEFAULT_PUNCTUALITY, checkFiling, excusalsByDay, judgeDay, leaveHalves, penaltyUnitsFor, periodLop, punchDays,
  punctualityOverPeriod, punctualityPolicyOf, requestMinutes, shiftScheduleOf, validatePunctuality,
  type PunctualityPolicy, type ShiftSchedule,
} from "../src/domain/punctuality";
import { summarizeAttendance } from "../src/domain/peopleAnalytics";

// The late arrival / early departure rules, as pure functions. Every reader of a day goes through these - the
// request form and the server's filing check, the attendance grid, analytics, the payroll build, the final
// settlement - so a mistake here is a mistake everywhere at once, and a pass here is what lets the rest of the
// suite test wiring rather than arithmetic.

const policy = (over: { requests?: Partial<PunctualityPolicy["requests"]>; attendance?: Partial<PunctualityPolicy["attendance"]>; penalties?: Partial<PunctualityPolicy["penalties"]> } = {}): PunctualityPolicy => ({
  requests: { ...DEFAULT_PUNCTUALITY.requests, ...over.requests },
  attendance: { ...DEFAULT_PUNCTUALITY.attendance, ...over.attendance },
  penalties: { ...DEFAULT_PUNCTUALITY.penalties, ...over.penalties },
});
const SCHED: ShiftSchedule = { timezone: "UTC", work_days: [1, 2, 3, 4, 5], shift_start: "09:00", shift_end: "18:00", grace_minutes: 15 };
const at = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h! * 60 + m!; };

describe("reading the stored policy", () => {
  it("fills every section leaf by leaf, so a partial section does not wipe its siblings", () => {
    // `getSettingValue` merges shallowly: a stored `requests` holding only `max_minutes` replaces the whole
    // default section. Read naively, every other request rule would be undefined.
    const p = punctualityPolicyOf({ requests: { max_minutes: 60 } });
    expect(p.requests.max_minutes).toBe(60);
    expect(p.requests.reason_required).toBe(true);
    expect(p.requests.enabled).toBe(true);
    expect(p.penalties).toEqual(DEFAULT_PUNCTUALITY.penalties);
  });

  it("reads a malformed leaf as its default rather than as the garbage", () => {
    const p = punctualityPolicyOf({ requests: { monthly_count: "three", before_time: "yes" }, penalties: { deduct_days: 0.3 } });
    expect(p.requests.monthly_count).toBe(DEFAULT_PUNCTUALITY.requests.monthly_count);
    expect(p.requests.before_time).toBe(false);
    expect(p.penalties.deduct_days).toBe(0.5);
  });

  it("keeps an explicit null where null means 'no limit'", () => {
    expect(punctualityPolicyOf({ requests: { max_minutes: null } }).requests.max_minutes).toBeNull();
  });
});

describe("validating a policy before it is stored", () => {
  it("accepts the defaults and a fully spelled-out policy", () => {
    expect(() => validatePunctuality(DEFAULT_PUNCTUALITY)).not.toThrow();
    expect(() => validatePunctuality(policy({ penalties: { enabled: true, max_days: 1.5, severe_minutes: 120 } }))).not.toThrow();
  });

  it("refuses an unknown section or leaf by name, because it would read as the default", () => {
    expect(() => validatePunctuality({ request: {} })).toThrow(/punctuality\.request is not a section/);
    expect(() => validatePunctuality({ requests: { monthly_cout: 3 } })).toThrow(/monthly_cout is not a setting/);
  });

  it("refuses a leaf of the wrong shape", () => {
    expect(() => validatePunctuality({ requests: { max_minutes: 0 } })).toThrow(/max_minutes must be/);
    expect(() => validatePunctuality({ requests: { limit_scope: "weekly" } })).toThrow(/limit_scope must be one of/);
    expect(() => validatePunctuality({ penalties: { deduct_days: 2 } })).toThrow(/deduct_days/);
    expect(() => validatePunctuality({ penalties: { max_days: 0.25 } })).toThrow(/max_days/);
    expect(() => validatePunctuality({ attendance: { credit_minutes: 1 } })).toThrow(/credit_minutes must be true or false/);
  });

  it("refuses requests switched on with neither kind offered - that is 'off' spelled as a choice", () => {
    expect(() => validatePunctuality({ requests: { enabled: true, late_arrival: false, early_departure: false } })).toThrow(/switch requests off instead/);
    expect(() => validatePunctuality({ requests: { enabled: false, late_arrival: false, early_departure: false } })).not.toThrow();
  });
});

describe("the shift the rules judge against", () => {
  it("fills the SPA's defaults into an attendance blob that never stored a shift", () => {
    expect(shiftScheduleOf({ timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5] })).toMatchObject({ shift_start: "09:00", shift_end: "18:00", grace_minutes: 15 });
    expect(shiftScheduleOf({ shift_start: "garbage" }).shift_start).toBe("09:00");
  });

  it("measures a request from the shift edge it moves", () => {
    expect(requestMinutes("late_arrival", "10:30", SCHED)).toBe(90);
    expect(requestMinutes("early_departure", "16:00", SCHED)).toBe(120);
    expect(requestMinutes("late_arrival", "08:30", SCHED)).toBeLessThan(0);
  });
});

describe("judging one day", () => {
  const judge = (o: Partial<Parameters<typeof judgeDay>[0]>) =>
    judgeDay({ arrMin: at("09:00"), depMin: at("18:00"), open: false, startMin: at("09:00"), endMin: at("18:00"), grace: 15, policy: DEFAULT_PUNCTUALITY.attendance, ...o });

  it("flags a late arrival past shift start plus grace, and measures it from the start", () => {
    expect(judge({ arrMin: at("09:14") }).late).toBe(false);
    expect(judge({ arrMin: at("09:40") })).toMatchObject({ late: true, lateByMin: 40 });
  });

  it("moves the start to an approved time, and measures lateness past it from it", () => {
    const excusal = { lateUntil: at("10:30") };
    expect(judge({ arrMin: at("10:20"), excusal })).toMatchObject({ late: false, excusedLate: true });
    // Grace still applies on top by default: 10:40 is inside 10:30 + 15.
    expect(judge({ arrMin: at("10:40"), excusal }).late).toBe(false);
    expect(judge({ arrMin: at("11:00"), excusal })).toMatchObject({ late: true, lateByMin: 30, excusedLate: false });
  });

  it("makes the approved time exact when grace is not applied on top", () => {
    const excusal = { lateUntil: at("10:30") };
    expect(judge({ arrMin: at("10:35"), excusal, policy: { grace_on_top: false, credit_minutes: false } })).toMatchObject({ late: true, lateByMin: 5 });
  });

  it("moves the end to an approved departure the same way", () => {
    const excusal = { earlyFrom: at("16:00") };
    expect(judge({ depMin: at("16:05"), excusal })).toMatchObject({ leftEarly: false, excusedEarly: true });
    expect(judge({ depMin: at("15:00"), excusal })).toMatchObject({ leftEarly: true, earlyByMin: 60 });
  });

  it("ignores an 'approval' that does not move the window at all", () => {
    // A late arrival at or before the shift start excuses nothing - it must not pull the start earlier.
    expect(judge({ arrMin: at("09:40"), excusal: { lateUntil: at("08:30") } })).toMatchObject({ late: true, lateByMin: 40 });
  });

  it("does not call a half spent on approved leave late or early", () => {
    expect(judge({ arrMin: at("13:30"), halves: { am: true, pm: false } }).late).toBe(false);
    expect(judge({ depMin: at("13:00"), halves: { am: false, pm: true } }).leftEarly).toBe(false);
  });

  it("never calls a day still running 'left early', and judges nothing under flexible hours", () => {
    expect(judge({ depMin: at("12:00"), open: true }).leftEarly).toBe(false);
    expect(judge({ arrMin: at("11:00"), flexible: true }).late).toBe(false);
  });

  it("credits only the part of the approved gap actually missed, and only when the policy says so", () => {
    const excusal = { lateUntil: at("11:00"), earlyFrom: at("17:00") };
    const credit = { grace_on_top: true, credit_minutes: true };
    expect(judge({ arrMin: at("10:30"), depMin: at("17:30"), excusal, policy: credit }).creditMinutes).toBe(90 + 30);
    expect(judge({ arrMin: at("10:30"), excusal, policy: DEFAULT_PUNCTUALITY.attendance }).creditMinutes).toBe(0);
    // Arrived on time: nothing was missed, so nothing is credited.
    expect(judge({ arrMin: at("09:00"), excusal: { lateUntil: at("11:00") }, policy: credit }).creditMinutes).toBe(0);
    // No punch at all: an approval never pays a no-show.
    expect(judge({ arrMin: null, depMin: null, excusal, policy: credit }).creditMinutes).toBe(0);
  });
});

describe("filing a request", () => {
  const base = {
    kind: "late_arrival" as const, date: "2026-03-02", at: "10:30", reason: "Doctor", sched: SCHED, policy: policy(),
    todayYmd: "2026-03-02", nowMin: at("08:00"), isHoliday: false, onFullLeave: false, monthRequests: [],
  };
  const check = (over: Partial<Parameters<typeof checkFiling>[0]>) => checkFiling({ ...base, ...over });

  it("files an ordinary late arrival and prices it in minutes", () => {
    expect(check({})).toMatchObject({ minutes: 90, errors: [], overLimit: false, autoApprove: false });
  });

  it("refuses days nobody works, and a time that does not move the shift edge", () => {
    expect(check({ date: "2026-03-07" }).errors.join()).toMatch(/not a working day/); // Saturday
    expect(check({ isHoliday: true }).errors.join()).toMatch(/holiday/);
    expect(check({ onFullLeave: true }).errors.join()).toMatch(/approved leave/);
    expect(check({ at: "08:45" }).errors.join()).toMatch(/after the shift starts/);
    expect(check({ kind: "early_departure", at: "18:30" }).errors.join()).toMatch(/before the shift ends/);
  });

  it("refuses a request longer than the policy allows", () => {
    expect(check({ at: "14:00", policy: policy({ requests: { max_minutes: 120 } }) }).errors.join()).toMatch(/at most 2h/);
  });

  it("holds the filing window both ways", () => {
    expect(check({ date: "2026-02-20", policy: policy({ requests: { backdate_days: 7 } }) }).errors.join()).toMatch(/at most 7 days after/);
    expect(check({ date: "2026-02-27", policy: policy({ requests: { backdate_days: 7 } }) }).errors).toEqual([]);
    expect(check({ date: "2026-03-02", todayYmd: "2026-03-03", policy: policy({ requests: { backdate_days: 0 } }) }).errors.join()).toMatch(/has passed/);
    expect(check({ date: "2026-07-01", policy: policy({ requests: { advance_days: 30 } }) }).errors.join()).toMatch(/at most 30 days ahead/);
  });

  it("with 'before the time it covers', refuses a late arrival asked for after the shift started", () => {
    const p = policy({ requests: { before_time: true } });
    expect(check({ policy: p, nowMin: at("08:59") }).errors).toEqual([]);
    expect(check({ policy: p, nowMin: at("09:05") }).errors.join()).toMatch(/before the shift starts/);
    // An early departure's cutoff is the time the person means to leave, not the shift start.
    expect(check({ policy: p, kind: "early_departure", at: "16:00", nowMin: at("15:00") }).errors).toEqual([]);
    expect(check({ policy: p, kind: "early_departure", at: "16:00", nowMin: at("16:30") }).errors.join()).toMatch(/before you leave/);
  });

  it("asks for a reason only when the policy does", () => {
    expect(check({ reason: " " }).errors.join()).toMatch(/reason/);
    expect(check({ reason: null, policy: policy({ requests: { reason_required: false } }) }).errors).toEqual([]);
  });

  it("refuses a request past the monthly allowance, or flags it, as the policy says", () => {
    const monthRequests = [{ kind: "late_arrival" as const, minutes: 60, date: "2026-03-03" }, { kind: "early_departure" as const, minutes: 30, date: "2026-03-04" }];
    const refuse = policy({ requests: { monthly_count: 2 } });
    expect(check({ policy: refuse, monthRequests }).errors.join()).toMatch(/monthly allowance/);
    const allow = policy({ requests: { monthly_count: 2, over_limit: "allow", auto_approve_minutes: 240 } });
    // Accepted and flagged - and never approved automatically, however short.
    expect(check({ policy: allow, monthRequests })).toMatchObject({ errors: [], overLimit: true, autoApprove: false });
    // Counted per kind, the early departure does not use up the late-arrival allowance.
    expect(check({ policy: policy({ requests: { monthly_count: 2, limit_scope: "per_kind" } }), monthRequests }).errors).toEqual([]);
    // Minutes are an allowance too: 90 already asked for plus 90 more is past 150.
    expect(check({ policy: policy({ requests: { monthly_minutes: 150 } }), monthRequests }).errors.join()).toMatch(/monthly allowance/);
  });

  it("approves on filing up to the threshold, and not a minute past it", () => {
    expect(check({ at: "10:00", policy: policy({ requests: { auto_approve_minutes: 60 } }) }).autoApprove).toBe(true);
    expect(check({ at: "10:01", policy: policy({ requests: { auto_approve_minutes: 60 } }) }).autoApprove).toBe(false);
  });

  it("refuses a kind the org does not offer, and everything once requests are off", () => {
    expect(check({ policy: policy({ requests: { late_arrival: false } }) }).errors.join()).toMatch(/Late arrival requests are switched off/);
    expect(check({ policy: policy({ requests: { enabled: false } }) }).errors.join()).toMatch(/switched off/);
  });
});

describe("the penalty ladder", () => {
  const pen = (over: Partial<PunctualityPolicy["penalties"]>) => ({ ...DEFAULT_PUNCTUALITY.penalties, enabled: true, ...over });

  it("frees the first marks, then docks each full block after them", () => {
    const p = pen({ free_marks: 3, every: 3, deduct_days: 0.5 });
    expect(penaltyUnitsFor(3, p)).toBe(0);
    expect(penaltyUnitsFor(5, p)).toBe(0); // two past the free three is not yet a block
    expect(penaltyUnitsFor(6, p)).toBe(0.5);
    expect(penaltyUnitsFor(10, p)).toBe(1);
  });

  it("can dock every single mark past the allowance, and caps the period", () => {
    expect(penaltyUnitsFor(5, pen({ free_marks: 2, every: 1, deduct_days: 1 }))).toBe(3);
    expect(penaltyUnitsFor(20, pen({ free_marks: 0, every: 1, deduct_days: 0.5, max_days: 2 }))).toBe(2);
  });

  it("docks nothing while penalties are off", () => {
    expect(penaltyUnitsFor(20, { ...DEFAULT_PUNCTUALITY.penalties, enabled: false })).toBe(0);
  });
});

describe("a pay period's punctuality", () => {
  // March 2026: the 2nd is a Monday. Every punch is in UTC, which is the schedule's own zone here.
  const day = (ymd: string, inAt: string, outAt: string) => ({ clockInMs: Date.parse(`${ymd}T${inAt}:00Z`), clockOutMs: Date.parse(`${ymd}T${outAt}:00Z`) });
  const week = (lateOn: string[], arrival = "09:40") =>
    punchDays(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"].map((d) => day(d, lateOn.includes(d) ? arrival : "09:00", "18:00")), (ms) => new Date(ms).toISOString().slice(0, 10));
  const over = (o: Partial<Parameters<typeof punctualityOverPeriod>[0]>) =>
    punctualityOverPeriod({ startYmd: "2026-03-02", endYmd: "2026-03-06", holidays: new Set(), sched: SCHED, punches: week([]), policy: policy({ penalties: { enabled: true, free_marks: 0, every: 2, deduct_days: 0.5 } }), ...o });

  it("collapses sessions into a first-in / last-out day", () => {
    const d = punchDays([day("2026-03-02", "09:00", "13:00"), day("2026-03-02", "14:00", "18:30")], (ms) => new Date(ms).toISOString().slice(0, 10)).get("2026-03-02")!;
    expect(new Date(d.arrMs).toISOString()).toBe("2026-03-02T09:00:00.000Z");
    expect(new Date(d.depMs!).toISOString()).toBe("2026-03-02T18:30:00.000Z");
    expect(d.open).toBe(false);
  });

  it("counts unexcused late arrivals as marks", () => {
    const r = over({ punches: week(["2026-03-02", "2026-03-03", "2026-03-04"]) });
    expect(r.lateMarks).toBe(3);
    expect(r.penaltyUnits).toBe(0.5); // every 2 marks = half a day
  });

  it("does not count a day the approved window excuses, a holiday, a day HR marked or a day on leave", () => {
    const r = over({
      punches: week(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]),
      excusals: excusalsByDay([{ date: "2026-03-02", kind: "late_arrival", at: "10:00" }]),
      holidays: new Set(["2026-03-03"]),
      marksByDay: new Map([["2026-03-04", "full"]]),
      leaveRanges: [{ start: "2026-03-05", end: "2026-03-05" }],
    });
    expect(r.lateMarks).toBe(0);
    expect(r.penaltyUnits).toBe(0);
  });

  it("caps a severely late day at half and does not also count it as a mark", () => {
    const r = over({ punches: week(["2026-03-02"], "12:30"), policy: policy({ penalties: { enabled: true, free_marks: 0, every: 1, deduct_days: 0.5, severe_minutes: 120 } }) });
    expect(r.capByDay.get("2026-03-02")).toBe(0.5);
    expect(r.severeDays).toBe(1);
    expect(r.lateMarks).toBe(0);
  });

  it("counts only the kind the policy names", () => {
    const punches = punchDays([day("2026-03-02", "09:40", "18:00"), day("2026-03-03", "09:00", "16:00")], (ms) => new Date(ms).toISOString().slice(0, 10));
    const p = (counts: "late" | "early" | "both") => policy({ penalties: { enabled: true, counts } });
    expect(over({ punches, policy: p("late") })).toMatchObject({ lateMarks: 1, earlyMarks: 0 });
    expect(over({ punches, policy: p("early") })).toMatchObject({ lateMarks: 0, earlyMarks: 1 });
    expect(over({ punches, policy: p("both") })).toMatchObject({ lateMarks: 1, earlyMarks: 1 });
  });
});

describe("a period's loss of pay with the policy in play", () => {
  const DAYS = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"];
  const base = { startYmd: "2026-03-02", endYmd: "2026-03-06", workDays: [1, 2, 3, 4, 5], holidays: new Set<string>(), leaveRanges: [], fullDayMinutes: 480, halfDayMinutes: 240 };
  const worked = (minutes: Record<string, number>) => new Map(DAYS.map((d) => [d, minutes[d] ?? 540]));

  it("is exactly lopDayUnits without the policy", () => {
    expect(periodLop({ ...base, workedByDay: worked({ "2026-03-02": 300 }) })).toMatchObject({ absenceUnits: 0.5, penaltyUnits: 0, units: 0.5 });
  });

  it("credits an approved gap so a late start does not turn the day into a half day", () => {
    // 10:30 to 17:30 is 420 minutes, under the 480 full day; the approved 90-minute late start makes it 510.
    const punches = punchDays([{ clockInMs: Date.parse("2026-03-02T10:30:00Z"), clockOutMs: Date.parse("2026-03-02T17:30:00Z") }], (ms) => new Date(ms).toISOString().slice(0, 10));
    const excusals = excusalsByDay([{ date: "2026-03-02", kind: "late_arrival", at: "10:30" }]);
    const workedByDay = worked({ "2026-03-02": 420 });
    const without = periodLop({ ...base, workedByDay, punctuality: { sched: SCHED, policy: policy(), punches, excusals } });
    const withCredit = periodLop({ ...base, workedByDay, punctuality: { sched: SCHED, policy: policy({ attendance: { credit_minutes: true } }), punches, excusals } });
    expect(without.absenceUnits).toBe(0.5);
    expect(withCredit.absenceUnits).toBe(0);
  });

  it("adds the marks' penalty to the absence, never past the days owed", () => {
    const late = DAYS.map((d) => ({ clockInMs: Date.parse(`${d}T09:40:00Z`), clockOutMs: Date.parse(`${d}T18:00:00Z`) }));
    const punches = punchDays(late, (ms) => new Date(ms).toISOString().slice(0, 10));
    const r = periodLop({ ...base, workedByDay: worked({}), punctuality: { sched: SCHED, policy: policy({ penalties: { enabled: true, free_marks: 0, every: 1, deduct_days: 1 } }), punches } });
    expect(r.lateMarks).toBe(5);
    expect(r.penaltyUnits).toBe(5);
    expect(r.units).toBe(5);
  });

  it("clamps the penalty so absence and marks together never dock more days than the window owed", () => {
    // Mon-Wed: in 09:40 and out 17:00 - late AND early (two marks a day) and 440 minutes, a half day each.
    // Thu-Fri: no punches at all, so a whole absence each. That is 3.5 days of absence out of 5 owed, and six
    // marks that would dock six more at a day each - only 1.5 of them fit.
    const three = ["2026-03-02", "2026-03-03", "2026-03-04"];
    const punches = punchDays(three.map((d) => ({ clockInMs: Date.parse(`${d}T09:40:00Z`), clockOutMs: Date.parse(`${d}T17:00:00Z`) })), (ms) => new Date(ms).toISOString().slice(0, 10));
    const r = periodLop({
      ...base,
      workedByDay: new Map(three.map((d) => [d, 440])),
      punctuality: { sched: SCHED, policy: policy({ penalties: { enabled: true, counts: "both", free_marks: 0, every: 1, deduct_days: 1 } }), punches },
    });
    expect(r).toMatchObject({ lateMarks: 3, earlyMarks: 3, absenceUnits: 3.5, penaltyUnits: 1.5, units: 5 });
  });

  it("owes nothing for an empty day before HRMS records start, in the absence AND in the penalty clamp", () => {
    // Records start Wednesday. Mon-Tue are empty and before it; Wed-Fri are the half days with two marks each
    // from the test above. Owed is Wed-Fri only (3), so six marks at a day each fit 3 - 1.5 = 1.5 - the clamp
    // must count the same days the absence walk does, or the penalty would dock the untracked days after all.
    const three = ["2026-03-04", "2026-03-05", "2026-03-06"];
    const punches = punchDays(three.map((d) => ({ clockInMs: Date.parse(`${d}T09:40:00Z`), clockOutMs: Date.parse(`${d}T17:00:00Z`) })), (ms) => new Date(ms).toISOString().slice(0, 10));
    const r = periodLop({
      ...base,
      workedByDay: new Map(three.map((d) => [d, 440])),
      trackedFromYmd: "2026-03-04",
      punctuality: { sched: SCHED, policy: policy({ penalties: { enabled: true, counts: "both", free_marks: 0, every: 1, deduct_days: 1 } }), punches },
    });
    expect(r).toMatchObject({ lateMarks: 3, earlyMarks: 3, absenceUnits: 1.5, penaltyUnits: 1.5, units: 3 });
  });

  it("gives analytics the same reading of an approved day as the grid and payroll", () => {
    const sched = { ...SCHED, full_day_minutes: 480, half_day_minutes: 240 };
    const days = [{ employeeId: "e", day: "2026-03-02", firstIn: Date.parse("2026-03-02T10:20:00Z"), lastOut: Date.parse("2026-03-02T18:30:00Z"), workedMinutes: 490, open: false }];
    expect(summarizeAttendance(days, sched)).toMatchObject({ days_late: 1, late_minutes: 80 });
    const excused = excusalsByDay([{ date: "2026-03-02", kind: "late_arrival", at: "10:30" }]);
    expect(summarizeAttendance(days, sched, excused)).toMatchObject({ days_late: 0, late_minutes: 0, punctuality_pct: 100 });
  });

  it("reads the AM/PM cover of leave, paid or not", () => {
    expect(leaveHalves("2026-03-02", [{ start: "2026-03-02", end: "2026-03-02", startSession: 1, endSession: 1 }])).toEqual({ am: true, pm: false });
    expect(leaveHalves("2026-03-02", [{ start: "2026-03-01", end: "2026-03-02", endSession: 2, paid: false }])).toEqual({ am: true, pm: true });
  });
});
