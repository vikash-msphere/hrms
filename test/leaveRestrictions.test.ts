import { describe, it, expect } from "vitest";
import {
  checkLeaveRestrictions,
  dayBar,
  dayBarReason,
  describeRestrictions,
  hasAnyRestriction,
  historyWindow,
  mergeRestrictions,
  needsLifetime,
  noticeBandLabel,
  noticeBands,
  parseRestrictions,
  requiredNotice,
  validateRestrictions,
  type LeaveNeighbour,
  type RestrictionFacts,
} from "../src/domain/leaveRestrictions";
import { daysByMonth, leaveDays } from "../src/domain/leave";
import { orgScheduleOf } from "../src/domain/workSchedule";

const ms = (d: string) => Date.parse(d + "T00:00:00Z");
const DAY = 86_400_000;

// A Thursday-to-Sunday week: 2026-03-02 is a Monday, so the calendar reads
// Mon 2 .. Fri 6, Sat 7, Sun 8, Mon 9 ..
const MON = "2026-03-02";

function facts(over: Partial<RestrictionFacts> & { rules: RestrictionFacts["rules"] }): RestrictionFacts {
  const start = over.startMs ?? ms(MON);
  const end = over.endMs ?? start;
  const base: RestrictionFacts = {
    rules: over.rules,
    leaveTypeId: "lt-annual",
    leaveTypeName: "Annual Leave",
    startMs: start,
    endMs: end,
    startSession: 1,
    endSession: 2,
    days: leaveDays(start, end, 1, 2),
    todayMs: ms("2026-02-01"),
    employeeStartMs: ms("2020-01-01"),
    onBehalf: false,
    hasDocument: null,
    reason: null,
    schedOf: orgScheduleOf({ work_days: [1, 2, 3, 4, 5] }),
    holidays: new Set<string>(),
    halfDayHolidays: new Set<string>(),
    neighbours: [],
    lifetime: null,
    exitWindow: null,
    exitDaysUsed: 0,
  };
  return { ...base, ...over };
}

const rules = (blob: unknown) => parseRestrictions(blob);
const codes = (f: RestrictionFacts) => checkLeaveRestrictions(f).map((v) => v.code);

const neighbour = (o: Partial<LeaveNeighbour> & { startMs: number; endMs: number }): LeaveNeighbour => ({
  uuid: `n-${o.startMs}`,
  leaveTypeId: "lt-annual",
  startSession: 1,
  endSession: 2,
  ...o,
});

describe("parse / validate / merge", () => {
  it("reads an unknown or malformed blob as no rules rather than throwing", () => {
    // The READ path is on every leave request; a blob that has gone bad must not take the feature down.
    expect(hasAnyRestriction(parseRestrictions("not json"))).toBe(false);
    expect(hasAnyRestriction(parseRestrictions(null))).toBe(false);
    expect(hasAnyRestriction(parseRestrictions({ nonsense: { x: 1 } }))).toBe(false);
  });

  it("refuses an unknown section or leaf on WRITE", () => {
    expect(() => validateRestrictions({ nonsense: {} })).toThrow(/unknown restrictions section/);
    expect(() => validateRestrictions({ quota: { max_days_per_fortnight: 2 } })).toThrow(/unknown restriction/);
    // A mistyped waiver code would silently waive nothing, which reads on screen as a waiver that works.
    expect(() => validateRestrictions({ soft_rules: ["advance_notiec"] })).toThrow(/unknown rule code/);
  });

  // The read path is lenient by design, so anything it cannot make sense of it drops. On the WRITE path that
  // is the enemy: a policy that saves cleanly and then enforces nothing is the exact failure this feature
  // exists to prevent, and every one of these used to do precisely that.
  it("refuses shapes the lenient parser would silently discard", () => {
    expect(() => validateRestrictions({ counting: { sandwich: { weekends: "intervining" } } })).toThrow(/exclude, intervening or flanking/);
    expect(() => validateRestrictions({ timing: { blackouts: [{ from: "soon", to: "later" }] } })).toThrow(/YYYY-MM-DD/);
    expect(() => validateRestrictions({ timing: { advance_notice: { tiers: [{ up_to: 1, notice: 2 }] } } })).toThrow(/up_to_days and notice_days/);
    expect(() => validateRestrictions({ exit: { during_notice: "blockd" } })).toThrow(/allowed, blocked or capped/);
    expect(() => validateRestrictions({ quota: { year_basis: "financial" } })).toThrow(/calendar, fiscal or anniversary/);
    expect(() => validateRestrictions({ accrual: { joining_rule: { cutoff_day: "15th" } } })).toThrow(/numeric cutoff_day/);
    expect(() => validateRestrictions({ request: { blocked_weekdays: ["monday"] } })).toThrow(/list of numbers/);
    expect(() => validateRestrictions({ quota: { max_days_per_month: "2" } })).toThrow(/must be a number, not text/);
    // …while the same rules written properly go through.
    expect(() => validateRestrictions({
      counting: { sandwich: { weekends: "intervening", holidays: "exclude" } },
      timing: { blackouts: [{ from: "2026-03-25", to: "2026-03-31", label: "close" }], advance_notice: { tiers: [{ up_to_days: 1, notice_days: 2 }] } },
      exit: { during_notice: "capped", notice_cap_days: 3 },
      quota: { year_basis: "fiscal", max_days_per_year: 12 },
      accrual: { joining_rule: { cutoff_day: 15, if_after: "none" } },
      request: { blocked_weekdays: [1, 5] },
    })).not.toThrow();
  });

  it("refuses a policy too big to carry", () => {
    // The blob rides on the leave type, and the leave types are ONE cached snapshot read by the accrual job,
    // every leave request and the serializers - so an oversized policy taxes every request in the system.
    const huge = { timing: { blackouts: Array.from({ length: 5000 }, () => ({ from: "2026-01-01", to: "2026-01-02", label: "x".repeat(100) })) } };
    expect(() => validateRestrictions(huge)).toThrow(/at most 64 KB/);
  });

  it("refuses values that could never be satisfied", () => {
    expect(() => validateRestrictions({ request: { min_days: 5, max_days: 2 } })).toThrow(/min_days cannot exceed/);
    expect(() => validateRestrictions({ accrual: { joining_rule: { cutoff_day: 30 } } })).toThrow(/cutoff_day is 1 to 28/);
    expect(() => validateRestrictions({ exit: { during_notice: "capped" } })).toThrow(/needs notice_cap_days/);
    expect(() => validateRestrictions({ quota: { min_gap_days: -1 } })).toThrow(/cannot be negative/);
  });

  it("merges per LEAF: absent inherits, present overrides, explicit null exempts", () => {
    const org = { quota: { max_days_per_month: 2, min_gap_days: 30 }, request: { min_days: 1 } };
    const type = { quota: { max_days_per_month: 5, min_gap_days: null } };
    const m = mergeRestrictions(org, type);
    expect(m.quota.max_days_per_month).toBe(5); // overridden
    expect(m.quota.min_gap_days).toBe(null); // exempted - NOT the org's 30
    expect(m.request.min_days).toBe(1); // inherited: the type never mentioned it
  });

  it("a type with no blob of its own is exactly the org baseline", () => {
    const org = { timing: { max_advance_days: 90 } };
    expect(mergeRestrictions(org, null).timing.max_advance_days).toBe(90);
    expect(mergeRestrictions(org, undefined).timing.max_advance_days).toBe(90);
  });

  it("exempts a whole section when the type nulls the group", () => {
    // The route schema accepts `{ quota: null }`; it has to MEAN something, or the policy screen offers an
    // exemption that silently inherits every rule it claims to drop.
    const m = mergeRestrictions({ quota: { max_days_per_month: 2, min_gap_days: 30 } }, { quota: null });
    expect(m.quota.max_days_per_month).toBe(null);
    expect(m.quota.min_gap_days).toBe(null);
  });

  it("replaces arrays wholesale rather than merging them", () => {
    const m = mergeRestrictions({ request: { blocked_weekdays: [1, 5] } }, { request: { blocked_weekdays: [3] } });
    expect(m.request.blocked_weekdays).toEqual([3]);
  });
});

describe("advance notice tiers", () => {
  const notice = { tiers: [{ up_to_days: 1, notice_days: 2 }, { up_to_days: 2, notice_days: 7 }], beyond_notice_days: 14 };

  // The tiers are a LADDER: each one's `up_to_days` is the top of a band and the band below it sets the
  // bottom, so every length falls in exactly one band and "what applies between two tiers" has no answer
  // because there is no between. The editor renders these same bands, so both sides read the list one way.
  it("reads as bands with no gaps, including an open-ended last one", () => {
    const bands = noticeBands(parseRestrictions({ timing: { advance_notice: notice } }).timing.advance_notice);
    expect(bands).toEqual([
      { moreThan: null, upTo: 1, noticeDays: 2 },
      { moreThan: 1, upTo: 2, noticeDays: 7 },
      { moreThan: 2, upTo: null, noticeDays: 14 },
    ]);
    expect(bands.map(noticeBandLabel)).toEqual(["up to 1 day", "over 1 day, up to 2 days", "over 2 days"]);
  });

  it("still shows the last band when nothing was set for it - a policy that asks for no notice says so", () => {
    const open = noticeBands(parseRestrictions({ timing: { advance_notice: { tiers: [{ up_to_days: 1, notice_days: 2 }] } } }).timing.advance_notice);
    expect(open).toHaveLength(2);
    expect(open[1]).toEqual({ moreThan: 1, upTo: null, noticeDays: null });
  });

  it("orders the bands however the tiers were stored", () => {
    const jumbled = parseRestrictions({ timing: { advance_notice: { tiers: [{ up_to_days: 5, notice_days: 7 }, { up_to_days: 1, notice_days: 2 }] } } });
    expect(noticeBands(jumbled.timing.advance_notice).map((b) => b.upTo)).toEqual([1, 5, null]);
    expect(requiredNotice(jumbled.timing.advance_notice, 1)).toBe(2);
  });

  it("refuses two tiers that end at the same length", () => {
    // One of them could never apply, and which one would depend on the order they happened to be stored in.
    expect(() => validateRestrictions({ timing: { advance_notice: { tiers: [{ up_to_days: 2, notice_days: 1 }, { up_to_days: 2, notice_days: 9 }] } } }))
      .toThrow(/both end at 2/);
  });

  it("picks the shortest tier that covers the request", () => {
    expect(requiredNotice(parseRestrictions({ timing: { advance_notice: notice } }).timing.advance_notice, 1)).toBe(2);
    expect(requiredNotice(parseRestrictions({ timing: { advance_notice: notice } }).timing.advance_notice, 2)).toBe(7);
    expect(requiredNotice(parseRestrictions({ timing: { advance_notice: notice } }).timing.advance_notice, 5)).toBe(14);
  });

  it("blocks a request filed with too little notice, and passes one with enough", () => {
    const r = rules({ timing: { advance_notice: notice } });
    const today = ms("2026-03-01");
    // One day of leave needs two days' notice: the 2nd is one day away.
    expect(codes(facts({ rules: r, todayMs: today, startMs: ms("2026-03-02"), endMs: ms("2026-03-02") }))).toContain("advance_notice");
    expect(codes(facts({ rules: r, todayMs: today, startMs: ms("2026-03-03"), endMs: ms("2026-03-03") }))).toEqual([]);
  });

  it("doesn't apply when HR files on somebody's behalf", () => {
    const r = rules({ timing: { advance_notice: notice } });
    expect(codes(facts({ rules: r, todayMs: ms("2026-03-01"), startMs: ms("2026-03-02"), endMs: ms("2026-03-02"), onBehalf: true }))).toEqual([]);
  });

  it("a soft rule warns instead of blocking", () => {
    const r = rules({ timing: { advance_notice: notice }, soft_rules: ["advance_notice"] });
    const v = checkLeaveRestrictions(facts({ rules: r, todayMs: ms("2026-03-01"), startMs: ms("2026-03-02"), endMs: ms("2026-03-02") }));
    expect(v).toHaveLength(1);
    expect(v[0]!.severity).toBe("warning");
  });
});

describe("request shape", () => {
  it("enforces a minimum and maximum length", () => {
    expect(codes(facts({ rules: rules({ request: { min_days: 3 } }) }))).toContain("min_days");
    expect(codes(facts({ rules: rules({ request: { max_days: 2 } }), endMs: ms("2026-03-05") }))).toContain("max_days");
  });

  it("bars half days when the type is whole-day only", () => {
    expect(codes(facts({ rules: rules({ request: { half_day_allowed: false } }), startSession: 2, endSession: 2, days: 0.5 }))).toContain("half_day");
    expect(codes(facts({ rules: rules({ request: { half_day_allowed: false } }) }))).toEqual([]);
  });

  it("blocks a charged day that falls on a blocked weekday", () => {
    // 2026-03-06 is a Friday.
    const r = rules({ request: { blocked_weekdays: [5] } });
    expect(codes(facts({ rules: r, startMs: ms("2026-03-06"), endMs: ms("2026-03-06") }))).toContain("blocked_weekday");
    expect(codes(facts({ rules: r, startMs: ms("2026-03-05"), endMs: ms("2026-03-05") }))).toEqual([]);
  });

  it("requires a reason, and one long enough", () => {
    expect(codes(facts({ rules: rules({ request: { reason_required: true } }) }))).toContain("reason_required");
    expect(codes(facts({ rules: rules({ request: { reason_required: true } }), reason: "flu" }))).toEqual([]);
    expect(codes(facts({ rules: rules({ request: { reason_required: true, reason_min_length: 10 } }), reason: "flu" }))).toContain("reason_required");
  });

  it("skips the document rule while the answer cannot be known yet", () => {
    const r = rules({ request: { document_required_over_days: 1 } });
    // hasDocument null = create time, when the row does not exist for a file to hang off yet.
    expect(codes(facts({ rules: r, endMs: ms("2026-03-05"), hasDocument: null }))).toEqual([]);
    expect(codes(facts({ rules: r, endMs: ms("2026-03-05"), hasDocument: false }))).toContain("document_required");
    expect(codes(facts({ rules: r, endMs: ms("2026-03-05"), hasDocument: true }))).toEqual([]);
  });

  it("holds a per-type back-dating window", () => {
    const r = rules({ request: { backdate_days: 0 } });
    expect(codes(facts({ rules: r, todayMs: ms("2026-03-03"), startMs: ms("2026-03-02"), endMs: ms("2026-03-02") }))).toContain("backdated");
    const lenient = rules({ request: { backdate_days: 3 } });
    expect(codes(facts({ rules: lenient, todayMs: ms("2026-03-03"), startMs: ms("2026-03-02"), endMs: ms("2026-03-02") }))).toEqual([]);
  });
});

describe("the merged run", () => {
  it("counts leave either side of a weekend as ONE stretch against the consecutive cap", () => {
    // Existing leave Mon 2 - Fri 6; the new request is Mon 9 - Tue 10. Only a weekend separates them, so the
    // run is seven days - which is how splitting a fortnight into two requests would otherwise slip a cap.
    const r = rules({ request: { max_consecutive_days: 5 } });
    const f = facts({
      rules: r,
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-10"),
      neighbours: [neighbour({ startMs: ms("2026-03-02"), endMs: ms("2026-03-06") })],
    });
    expect(codes(f)).toContain("max_consecutive");
  });

  it("leaves a genuinely separate request alone", () => {
    const r = rules({ request: { max_consecutive_days: 5 } });
    const f = facts({
      rules: r,
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-10"),
      // A working day (Fri 6) sits between the two, so they are not one run.
      neighbours: [neighbour({ startMs: ms("2026-03-02"), endMs: ms("2026-03-04") })],
    });
    expect(codes(f)).toEqual([]);
  });

  it("insists the whole entitlement is one block when the type says so", () => {
    const r = rules({ request: { must_be_single_block: true } });
    const f = facts({
      rules: r,
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-10"),
      neighbours: [neighbour({ startMs: ms("2026-01-05"), endMs: ms("2026-01-09") })],
    });
    expect(codes(f)).toContain("single_block");
  });
});

describe("quota", () => {
  it("caps days per calendar month, counting leave already booked in it", () => {
    const r = rules({ quota: { max_days_per_month: 2 } });
    const f = facts({
      rules: r,
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-10"), // 2 days
      neighbours: [neighbour({ startMs: ms("2026-03-03"), endMs: ms("2026-03-03") })], // 1 already used
    });
    expect(codes(f)).toContain("max_days_per_month");
  });

  it("counts each month of a straddling request separately", () => {
    // 31 Mar - 1 Apr is one day in each month, so a two-a-month cap is not breached by it.
    const r = rules({ quota: { max_days_per_month: 1 } });
    const f = facts({ rules: r, startMs: ms("2026-03-31"), endMs: ms("2026-04-01") });
    expect(codes(f)).toEqual([]);
  });

  it("caps days per year on the configured basis", () => {
    const calendar = rules({ quota: { max_days_per_year: 2 } });
    const f = (r: ReturnType<typeof rules>) => facts({
      rules: r,
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-10"),
      neighbours: [neighbour({ startMs: ms("2026-05-05"), endMs: ms("2026-05-05") })],
    });
    expect(codes(f(calendar))).toContain("max_days_per_year");
    // On an April-start financial year, March is the END of FY 2025-26 and May the start of FY 2026-27, so
    // the very same two rows fall in different years and don't collide.
    const fiscal = rules({ quota: { max_days_per_year: 2, year_basis: "fiscal", fiscal_year_start_month: 4 } });
    expect(codes(f(fiscal))).toEqual([]);
  });

  it("caps the NUMBER of requests in a month", () => {
    const r = rules({ quota: { max_requests_per_month: 1 } });
    const f = facts({ rules: r, neighbours: [neighbour({ startMs: ms("2026-03-20"), endMs: ms("2026-03-20") })] });
    expect(codes(f)).toContain("max_requests_per_month");
  });

  it("keeps a minimum gap between requests of the type, measured in WORKING days", () => {
    const r = rules({ quota: { min_gap_days: 5 } });
    // Previous leave ends Fri 6; the new one starts Mon 9. The weekend is not a gap, so this is 0 working days.
    const f = facts({
      rules: r,
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-09"),
      neighbours: [neighbour({ startMs: ms("2026-03-06"), endMs: ms("2026-03-06") })],
    });
    expect(codes(f)).toContain("min_gap");
  });
});

describe("combinations", () => {
  it("refuses two types the policy says may not run back to back", () => {
    const r = rules({ combinations: { no_combination_with: ["leave-types/lt-sick"], gap_days: 0 } });
    const f = facts({
      rules: r,
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-09"),
      neighbours: [neighbour({ startMs: ms("2026-03-06"), endMs: ms("2026-03-06"), leaveTypeId: "lt-sick", leaveTypeName: "Sick Leave" })],
    });
    expect(codes(f)).toContain("combination");
  });

  it("holds when the OTHER type is the one that declares the rule", () => {
    // Symmetric on purpose: whichever of the pair the policy is written on, the pair is still barred.
    const f = facts({
      rules: rules({}),
      startMs: ms("2026-03-09"),
      endMs: ms("2026-03-09"),
      neighbours: [neighbour({
        startMs: ms("2026-03-06"),
        endMs: ms("2026-03-06"),
        leaveTypeId: "lt-sick",
        leaveTypeName: "Sick Leave",
        noCombinationWith: ["leave-types/lt-annual"],
      })],
    });
    // `rules({})` configures nothing, so the evaluator has nothing else to say - only the neighbour's rule.
    expect(codes(f)).toEqual(["combination"]);
  });
});

describe("exit process", () => {
  const window = { fromMs: ms("2026-03-01"), toMs: ms("2026-03-31") };
  it("blocks leave inside the notice period when the type says so", () => {
    const r = rules({ exit: { during_notice: "blocked" } });
    expect(codes(facts({ rules: r, exitWindow: window }))).toContain("exit_notice");
  });

  it("caps it instead when the type says capped", () => {
    const r = rules({ exit: { during_notice: "capped", notice_cap_days: 2 } });
    expect(codes(facts({ rules: r, exitWindow: window, exitDaysUsed: 2 }))).toContain("exit_notice");
    expect(codes(facts({ rules: r, exitWindow: window, exitDaysUsed: 1 }))).toEqual([]);
  });

  it("says nothing to somebody who isn't leaving", () => {
    const r = rules({ exit: { during_notice: "blocked" } });
    expect(codes(facts({ rules: r, exitWindow: null }))).toEqual([]);
  });
});

describe("the joining month", () => {
  it("bars a request in the joining month when that month earns nothing", () => {
    const r = rules({ accrual: { joining_rule: { cutoff_day: 15, if_after: "none" } } });
    const joinedLate = facts({ rules: r, employeeStartMs: ms("2026-03-20"), startMs: ms("2026-03-25"), endMs: ms("2026-03-25") });
    expect(codes(joinedLate)).toContain("joining_month");
    // Joined before the cutoff: the month counts, so the request is fine.
    const joinedEarly = facts({ rules: r, employeeStartMs: ms("2026-03-10"), startMs: ms("2026-03-25"), endMs: ms("2026-03-25") });
    expect(codes(joinedEarly)).toEqual([]);
    // The month AFTER the joining month is never barred.
    const later = facts({ rules: r, employeeStartMs: ms("2026-03-20"), startMs: ms("2026-04-06"), endMs: ms("2026-04-06") });
    expect(codes(later)).toEqual([]);
  });
});

describe("eligibility", () => {
  it("holds a type back until the service requirement is met", () => {
    const r = rules({ eligibility: { min_tenure_days: 90 } });
    const f = facts({ rules: r, employeeStartMs: ms("2026-02-01"), startMs: ms("2026-03-02"), endMs: ms("2026-03-02") });
    expect(codes(f)).toContain("min_tenure");
    // Booking ahead for a date past the waiting period is allowed - the rule is measured against the leave.
    const ahead = facts({ rules: r, employeeStartMs: ms("2026-02-01"), startMs: ms("2026-06-01"), endMs: ms("2026-06-01") });
    expect(codes(ahead)).toEqual([]);
  });

  it("caps lifetime occurrences and days", () => {
    const occ = rules({ eligibility: { max_occurrences_lifetime: 2 } });
    expect(codes(facts({ rules: occ, lifetime: { requests: 2, days: 40 } }))).toContain("max_occurrences");
    expect(codes(facts({ rules: occ, lifetime: { requests: 1, days: 20 } }))).toEqual([]);
    const days = rules({ eligibility: { max_lifetime_days: 10 } });
    expect(codes(facts({ rules: days, lifetime: { requests: 3, days: 10 } }))).toContain("max_lifetime_days");
  });
});

describe("blackouts", () => {
  it("refuses a charged day inside a closed window, or on a closed day of the month", () => {
    const r = rules({ timing: { blackouts: [{ from: "2026-03-25", to: "2026-03-31", label: "Year-end close" }] } });
    expect(codes(facts({ rules: r, startMs: ms("2026-03-26"), endMs: ms("2026-03-26") }))).toContain("blackout");
    expect(codes(facts({ rules: r, startMs: ms("2026-03-24"), endMs: ms("2026-03-24") }))).toEqual([]);
    const dom = rules({ timing: { blackout_days_of_month: [30, 31] } });
    expect(codes(facts({ rules: dom, startMs: ms("2026-03-30"), endMs: ms("2026-03-30") }))).toContain("blackout");
  });

  it("refuses leave that would bridge a public holiday when the type forbids it", () => {
    const r = rules({ timing: { block_adjacent_to_holiday: true } });
    const f = facts({ rules: r, startMs: ms("2026-03-05"), endMs: ms("2026-03-05"), holidays: new Set(["2026-03-06"]) });
    expect(codes(f)).toContain("holiday_adjacent");
  });
});

describe("historyWindow", () => {
  it("answers null when nothing configured needs history - the no-policy org pays no extra read", () => {
    expect(historyWindow(parseRestrictions({}), ms(MON), ms(MON), null)).toBeNull();
    expect(historyWindow(parseRestrictions({ request: { min_days: 2 } }), ms(MON), ms(MON), null)).toBeNull();
  });

  it("widens to the month, the year, or the gap, depending on the rule", () => {
    const month = historyWindow(parseRestrictions({ quota: { max_days_per_month: 2 } }), ms("2026-03-10"), ms("2026-03-10"), null)!;
    expect(new Date(month.fromMs).toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(new Date(month.toMs).toISOString().slice(0, 10)).toBe("2026-03-31");
    // A gap counted in WORKING days needs a window wider than that many CALENDAR days, or the neighbour that
    // breaks the rule sits outside the query and the rule passes silently. 30 working days is six weeks of
    // calendar; the window has to reach at least that far back.
    const gap = historyWindow(parseRestrictions({ quota: { min_gap_days: 30 } }), ms("2026-03-10"), ms("2026-03-10"), null)!;
    expect(Math.round((ms("2026-03-10") - gap.fromMs) / DAY)).toBeGreaterThanOrEqual(42);
  });

  it("reaches far enough back for a gap measured in working days", () => {
    // The regression this pins: a 5-working-day gap padded by 5 CALENDAR days missed a neighbour nine days
    // back across two weekends, so the rule never fired.
    const win = historyWindow(parseRestrictions({ quota: { min_gap_days: 5 } }), ms("2026-03-16"), ms("2026-03-16"), null)!;
    const neighbourEnd = ms("2026-03-06"); // Friday, 4 working days before Monday the 16th
    expect(win.fromMs).toBeLessThanOrEqual(neighbourEnd);
  });

  // `hasAnyRestriction` is what decides whether a leave request pays for the policy reads at all, so a leaf
  // that restricts NOTHING on its own must not switch them on.
  it("is not switched on by a modifier, an empty list, or a waiver", () => {
    expect(hasAnyRestriction(parseRestrictions({ quota: { year_basis: "fiscal", fiscal_year_start_month: 4 } }))).toBe(false);
    expect(hasAnyRestriction(parseRestrictions({ combinations: { no_combination_with: [], gap_days: 3 } }))).toBe(false);
    expect(hasAnyRestriction(parseRestrictions({ exit: { notice_cap_days: 5 } }))).toBe(false);
    expect(hasAnyRestriction(parseRestrictions({ soft_rules: ["advance_notice"] }))).toBe(false);
    // …and IS switched on by an actual rule, including one that only rides alongside a modifier.
    expect(hasAnyRestriction(parseRestrictions({ quota: { max_days_per_year: 12, year_basis: "fiscal" } }))).toBe(true);
    expect(hasAnyRestriction(parseRestrictions({ combinations: { no_combination_with: ["leave-types/x"] } }))).toBe(true);
  });

  it("knows when a lifetime total is needed instead of a window", () => {
    expect(needsLifetime(parseRestrictions({ eligibility: { max_lifetime_days: 10 } }))).toBe(true);
    expect(needsLifetime(parseRestrictions({ quota: { max_days_per_year: 10 } }))).toBe(false);
  });
});

describe("sandwich counting", () => {
  // Mon-Fri as the day-by-day resolver `leaveDays` takes (domain/workSchedule.ts).
  const workDays = orgScheduleOf({ work_days: [1, 2, 3, 4, 5] });
  it("charges nothing extra by default", () => {
    // Fri 6 + Mon 9, as one request across the weekend.
    expect(leaveDays(ms("2026-03-06"), ms("2026-03-09"), 1, 2, workDays)).toBe(2);
  });

  it("charges the weekend between the leave when the rule says intervening", () => {
    const s = { weekends: "intervening" as const, holidays: "exclude" as const };
    expect(leaveDays(ms("2026-03-06"), ms("2026-03-09"), 1, 2, workDays, new Set(), new Set(), s)).toBe(4);
    // A range that merely STARTS on a Saturday has sandwiched nothing.
    expect(leaveDays(ms("2026-03-07"), ms("2026-03-09"), 1, 2, workDays, new Set(), new Set(), s)).toBe(1);
  });

  it("charges the weekend beside the leave too when the rule says flanking", () => {
    const s = { weekends: "flanking" as const, holidays: "exclude" as const };
    // A single Friday: the Saturday and Sunday that follow it are charged as well.
    expect(leaveDays(ms("2026-03-06"), ms("2026-03-06"), 1, 2, workDays, new Set(), new Set(), s)).toBe(3);
  });

  it("treats holidays separately from weekends", () => {
    const holidays = new Set(["2026-03-04"]); // a Wednesday
    const weekendsOnly = { weekends: "intervening" as const, holidays: "exclude" as const };
    expect(leaveDays(ms("2026-03-03"), ms("2026-03-05"), 1, 2, workDays, holidays, new Set(), weekendsOnly)).toBe(2);
    const both = { weekends: "intervening" as const, holidays: "intervening" as const };
    expect(leaveDays(ms("2026-03-03"), ms("2026-03-05"), 1, 2, workDays, holidays, new Set(), both)).toBe(3);
  });

  it("tops a half-day holiday up to a whole day when it is charged", () => {
    const half = new Set(["2026-03-04"]);
    const both = { weekends: "intervening" as const, holidays: "intervening" as const };
    expect(leaveDays(ms("2026-03-03"), ms("2026-03-05"), 1, 2, workDays, new Set(), half)).toBe(2.5);
    expect(leaveDays(ms("2026-03-03"), ms("2026-03-05"), 1, 2, workDays, new Set(), half, both)).toBe(3);
  });

  it("shaves a half-day session off what the day was ACTUALLY charged", () => {
    const s = { weekends: "flanking" as const, holidays: "exclude" as const };
    // Sat 7 - Mon 9 with a morning-only last day. The Saturday and Sunday are flanked into the charge, and the
    // session takes half off the Monday - not off a weekend day that was only charged by the sandwich rule.
    expect(leaveDays(ms("2026-03-09"), ms("2026-03-09"), 1, 1, workDays, new Set(), new Set(), s)).toBe(2.5);
  });

  it("splits the charge by month for the quota rules", () => {
    expect(daysByMonth(ms("2026-03-30"), ms("2026-04-02"), 1, 2, workDays)).toEqual({ "2026-03": 2, "2026-04": 2 });
  });
});

// The per-day bars are what the CALENDAR greys a cell with and what the evaluator refuses a request over -
// one set of predicates, so a day the grid strikes out and a day the server refuses cannot come apart. These
// pin the predicates themselves; the refusal messages they feed are covered by the checkLeaveRestrictions
// cases above.
describe("dayBar", () => {
  const rules = parseRestrictions({
    request: { blocked_weekdays: [1] }, // no Mondays
    timing: {
      blackouts: [{ from: "2026-12-20", to: "2027-01-02", label: "Year-end close" }],
      blackout_days_of_month: [28, 29, 30, 31],
    },
  });

  it("names each kind of bar, and nothing for a day the policy allows", () => {
    // 2026-09-14 is a Monday.
    expect(dayBar(rules, "2026-09-14")).toEqual({ kind: "weekday", code: "blocked_weekday", weekday: 1 });
    expect(dayBar(rules, "2026-12-22")).toEqual({
      kind: "window",
      code: "blackout",
      window: { from: "2026-12-20", to: "2027-01-02", label: "Year-end close" },
    });
    expect(dayBar(rules, "2026-09-29")).toEqual({ kind: "day_of_month", code: "blackout", dayOfMonth: 29 });
    // A Tuesday, outside every window and not a blocked day of the month.
    expect(dayBar(rules, "2026-09-15")).toBeNull();
  });

  it("covers both ends of a closed period - the window is inclusive, as the refusal says it is", () => {
    expect(dayBar(rules, "2026-12-20")).not.toBeNull();
    expect(dayBar(rules, "2027-01-02")).not.toBeNull();
    expect(dayBar(rules, "2026-12-19")).toBeNull();
    expect(dayBar(rules, "2027-01-03")).toBeNull();
  });

  it("bars nothing when the policy configures nothing", () => {
    const none = parseRestrictions({});
    for (const d of ["2026-09-14", "2026-12-22", "2026-09-29"]) expect(dayBar(none, d)).toBeNull();
  });

  it("says why, in words a calendar cell can carry", () => {
    expect(dayBarReason(dayBar(rules, "2026-09-14")!)).toBe("No leave on a Monday");
    expect(dayBarReason(dayBar(rules, "2026-12-22")!)).toBe("Closed: Year-end close");
    expect(dayBarReason(dayBar(rules, "2026-09-29")!)).toBe("No leave on the 29th of the month");
    // An unlabelled window still has to say something, so it states its own dates.
    const unlabelled = parseRestrictions({ timing: { blackouts: [{ from: "2026-03-01", to: "2026-03-03" }] } });
    expect(dayBarReason(dayBar(unlabelled, "2026-03-02")!)).toBe("Closed 2026-03-01 to 2026-03-03");
  });
});

describe("describeRestrictions", () => {
  it("says every configured rule, and nothing for an empty policy", () => {
    expect(describeRestrictions(parseRestrictions({}))).toEqual([]);
    const said = describeRestrictions(parseRestrictions({
      timing: { advance_notice: { tiers: [{ up_to_days: 1, notice_days: 2 }], beyond_notice_days: 7 } },
      quota: { max_days_per_month: 2 },
      counting: { sandwich: { weekends: "intervening", holidays: "exclude" } },
      exit: { during_notice: "blocked" },
    }));
    // Said as the bands it enforces, so a reader never has to work out what falls where.
    expect(said.join(" · ")).toMatch(/notice: up to 1 day needs 2 days; over 1 day needs 7 days/);
    expect(said.join(" · ")).toMatch(/at most 2 days a month/);
    expect(said.join(" · ")).toMatch(/sandwich rule charges weekends/);
    expect(said.join(" · ")).toMatch(/not during notice period/);
  });
});
