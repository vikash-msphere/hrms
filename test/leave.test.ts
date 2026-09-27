import { describe, it, expect } from "vitest";
import { computeAccrual, creditedBeforeFloor, hrmsPricingStartMs, leaveDays, roundToIncrement, ymOf } from "../src/domain/leave";
import { orgScheduleOf } from "../src/domain/workSchedule";

// A working week as the day-by-day resolver `leaveDays` takes (domain/workSchedule.ts). The weekday set the
// cases used to pass, in the shape the walk asks for it.
const week = (...days: number[]) => orgScheduleOf({ work_days: days });

const ms = (d: string) => Date.parse(d + "T00:00:00Z");
// 12 days/year -> exactly 1.0 day per full month, keeps the arithmetic easy to read.
const ANNUAL = 12;

describe("computeAccrual", () => {
  it("prorates the joining month, then full months thereafter", () => {
    // Joined Jan 16 of a 31-day month: 16 days worked / 31 = ~0.516 of one month.
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-16"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-03-10"),
    });
    // Jan (prorated 16/31) + Feb (1) + Mar (1)
    expect(r.add).toBeCloseTo(16 / 31 + 1 + 1, 2);
    expect(r.newLastYm).toBe("2026-03");
  });

  // REGRESSION. Only the JOINING month was prorated; the leaving month was credited in full, so someone who
  // left on the 2nd earned a whole month's entitlement for two days. Accrued leave is encashable, so the FnF
  // pays cash for it - the same two days were worth a full month on the way out and a fifteenth of one on the
  // way in.
  //
  // The marker comes back as "2026-03~". The tilde says the month was priced against a KNOWN last working day,
  // which is what stops the exit reconciliation (below) taking the same difference off a second time.
  it("prorates the leaving month, not just the joining month", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: ms("2026-03-02"), // last working day: 2 of March's 31 days
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-03-20"),
    });
    expect(r.add).toBeCloseTo(1 + 1 + 2 / 31, 2); // Jan + Feb full, March prorated
    expect(r.newLastYm).toBe("2026-03~");
  });

  it("prorates a month that is both the joining and the leaving month", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-06-10"),
      endMs: ms("2026-06-20"), // 11 of June's 30 days
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-07-05"),
    });
    expect(r.add).toBeCloseTo(11 / 30, 2);
    expect(r.newLastYm).toBe("2026-06~");
  });

  it("still credits a whole month to someone who leaves on its last day", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: ms("2026-03-31"),
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-04-05"),
    });
    expect(r.add).toBeCloseTo(3, 5);
  });

  it("prorates the leaving half-period on a semi-monthly schedule", () => {
    const r = computeAccrual({
      accrualDaysPerYear: 24, // 1 day per half-period
      startMs: ms("2026-01-01"),
      endMs: ms("2026-01-20"), // H1 in full, then 5 of H2's 16 days
      probationEndMs: null,
      probationAccrualDaysPerYear: 24,
      lastAccrualYm: null,
      currentMs: ms("2026-02-10"),
      frequency: "semi_monthly",
    });
    expect(r.add).toBeCloseTo(1 + 5 / 16, 2);
    expect(r.newLastYm).toBe("2026-01-H2~");
  });

  it("is idempotent within a month (nothing new once caught up)", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: "2026-03",
      currentMs: ms("2026-03-20"),
    });
    expect(r.add).toBe(0);
    expect(r.newLastYm).toBe("2026-03");
  });

  it("credits only the new month after a prior run", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: "2026-03",
      currentMs: ms("2026-04-05"),
    });
    expect(r.add).toBeCloseTo(1, 5);
    expect(r.newLastYm).toBe("2026-04");
  });

  it("no accrual during probation when the probation rate is 0, resuming the month probation ends", () => {
    // Joined Jan 1, probation ends Mar 31. Probation rate 0: Jan/Feb accrue nothing, Mar onward normal.
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: ms("2026-03-31"),
      probationAccrualDaysPerYear: 0,
      lastAccrualYm: null,
      currentMs: ms("2026-04-30"),
    });
    // Mar (1) + Apr (1); Jan & Feb accrue 0.
    expect(r.add).toBeCloseTo(2, 5);
    expect(r.newLastYm).toBe("2026-04");
  });

  it("accrues at a REDUCED rate during probation, then the normal rate after", () => {
    // Probation rate 6/yr (0.5/mo), normal 12/yr (1/mo); probation ends Mar 31.
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      probationAccrualDaysPerYear: 6,
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: ms("2026-03-31"),
      lastAccrualYm: null,
      currentMs: ms("2026-04-30"),
    });
    // Jan(0.5) + Feb(0.5) + Mar(1) + Apr(1) = 3.0
    expect(r.add).toBeCloseTo(3, 5);
    expect(r.newLastYm).toBe("2026-04");
  });

  it("uses the full rate throughout when the probation rate equals the normal rate", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: ms("2026-03-31"),
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-04-30"),
    });
    expect(r.add).toBeCloseTo(4, 5); // Jan..Apr all accrue
  });

  it("stops accruing after the employee end month", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: ms("2026-02-15"),
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-06-01"),
    });
    // Jan in full and half of February - nothing for March onward, four months after the tick ran. This used
    // to expect a flat 2: the walk stopped at the right MONTH but paid that month whole, which is the leaving
    // -month proration the case above pins.
    expect(r.add).toBeCloseTo(1 + 15 / 28, 2);
    expect(r.newLastYm).toBe("2026-02~");
  });

  // REGRESSION. The proration above only ever bit when the last working day was ALREADY on the record the
  // first time that month was credited - and a month is credited on its first tick, in advance. Someone active
  // on the 1st who leaves on the 3rd had the whole month paid for two days earlier; the next tick found the
  // month behind the marker and added nothing, so the over-credit stood. Accrued days are encashable, so it
  // left the FnF paying cash for a month nobody worked.
  it("takes back the unearned part of a month that was credited before the exit was known", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: ms("2026-03-03"), // 3 of March's 31 days, recorded after March was credited in full
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: "2026-03", // no final mark: March was priced as if employment continued
      currentMs: ms("2026-03-20"),
    });
    expect(r.add).toBeCloseTo(-(1 - 3 / 31), 2);
    expect(r.newLastYm).toBe("2026-03~");
  });

  it("takes the reconciliation only once", () => {
    const first = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: ms("2026-03-03"),
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: "2026-03",
      currentMs: ms("2026-03-20"),
    });
    const second = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: ms("2026-03-03"),
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: first.newLastYm, // the marked month
      currentMs: ms("2026-04-02"), // and a later tick, in a later month
    });
    expect(second.add).toBe(0);
    expect(second.newLastYm).toBe("2026-03~");
  });

  // THE EMPLOYMENT WINDOW CAN MOVE UNDER THE MARKER, and the marker cannot see it. These three are the
  // corrections that were silently never made: the walk starts at the marker and only ever adds, so anything
  // that moves the window EARLIER left the balance permanently wrong with nothing to notice it by. The window
  // the periods were priced against is now recorded beside the marker (db/schema.ts `accrual_priced_start`),
  // which is what makes the difference computable.
  describe("when the employment window is corrected", () => {
    const base = {
      accrualDaysPerYear: ANNUAL,
      probationAccrualDaysPerYear: ANNUAL,
      probationEndMs: null,
      currentMs: ms("2026-05-10"),
    };

    it("credits the months before a start date corrected EARLIER", () => {
      // Recorded as joining 1 April, credited April, then the date is fixed to 1 February. The walk resumes at
      // May, so February and March were never credited by anything and never would have been.
      const r = computeAccrual({
        ...base,
        startMs: ms("2026-02-01"),
        endMs: null,
        lastAccrualYm: "2026-04",
        pricedStartMs: ms("2026-04-01"),
        pricedEndMs: null,
      });
      // February, March (the two months nobody credited) plus May, which the ordinary walk credits.
      expect(r.add).toBeCloseTo(3, 2);
      expect(r.newLastYm).toBe("2026-05");
      expect(r.pricedStartMs).toBe(ms("2026-02-01"));
    });

    it("takes back the months before a start date corrected LATER", () => {
      // The mirror, and the direction that over-credits: recorded as joining 1 February, corrected to 1 April,
      // so February and March were credited to somebody who was not there.
      const r = computeAccrual({
        ...base,
        startMs: ms("2026-04-01"),
        endMs: null,
        lastAccrualYm: "2026-04",
        pricedStartMs: ms("2026-02-01"),
        pricedEndMs: null,
      });
      // -2 for the two months taken back, +1 for May.
      expect(r.add).toBeCloseTo(-1, 2);
      expect(r.newLastYm).toBe("2026-05");
    });

    it("restores the exit month when a departure is rescinded", () => {
      // The claw-back priced March at the 3 days worked. The departure is then withdrawn - `setTransitionState`
      // says plainly that completing an offboarding is not reversed on reopen, so HR clears the end date - and
      // the month is a full month again. Without the recorded window the marker's final mark said "already
      // settled" and the missing 28/31 of a month stayed missing for ever.
      const r = computeAccrual({
        ...base,
        startMs: ms("2026-01-01"),
        endMs: null,
        lastAccrualYm: "2026-03~",
        pricedStartMs: ms("2026-01-01"),
        pricedEndMs: ms("2026-03-03"),
      });
      // The part of March the claw-back removed, plus April and May from the ordinary walk.
      expect(r.add).toBeCloseTo(1 - 3 / 31 + 2, 2);
      expect(r.newLastYm).toBe("2026-05");
      expect(r.pricedEndMs).toBeNull();
    });

    it("does nothing at all while the window is unchanged", () => {
      const r = computeAccrual({
        ...base,
        startMs: ms("2026-01-01"),
        endMs: null,
        lastAccrualYm: "2026-05",
        pricedStartMs: ms("2026-01-01"),
        pricedEndMs: null,
      });
      expect(r.add).toBe(0);
      expect(r.newLastYm).toBe("2026-05");
    });
  });

  // A backdated exit: months credited ENTIRELY after the last working day come back in full, not just the
  // month the exit falls in.
  it("takes back whole months credited after a backdated last working day", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-01-01"),
      endMs: ms("2026-02-28"), // February in full; March and April were credited and never earned
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: "2026-04",
      currentMs: ms("2026-04-20"),
    });
    expect(r.add).toBeCloseTo(-2, 5);
    expect(r.newLastYm).toBe("2026-02~");
  });

  it("reconciles a half-period credited before the exit was known (semi-monthly)", () => {
    const r = computeAccrual({
      accrualDaysPerYear: 24, // 1 day per half-period
      frequency: "semi_monthly",
      startMs: ms("2026-01-01"),
      endMs: ms("2026-01-20"), // 5 of H2's 16 days
      probationEndMs: null,
      probationAccrualDaysPerYear: 24,
      lastAccrualYm: "2026-01-H2",
      currentMs: ms("2026-01-25"),
    });
    expect(r.add).toBeCloseTo(-(1 - 5 / 16), 2);
    expect(r.newLastYm).toBe("2026-01-H2~");
  });

  it("does nothing before the employee starts", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: ms("2026-09-01"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-06-01"),
    });
    expect(r.add).toBe(0);
    expect(r.newLastYm).toBe(null);
  });

  it("ymOf returns a UTC year-month key", () => {
    expect(ymOf(ms("2026-07-15"))).toBe("2026-07");
  });

  // REGRESSION. The exit reconciliation took back "a whole month minus what was earned", but a month is only
  // ever credited for what it was worth AT THE TIME - and for the JOINING month that is the joining proration,
  // never a whole month. Somebody who joined and left inside one month was therefore charged back more than
  // they were ever given, on a balance the FnF encashes for cash.
  it("claws back only what the joining month was actually credited", () => {
    const joined = ms("2026-06-10");
    // Tick one, before anybody knows they are leaving: June is credited 21/30 of the rate.
    const first = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: joined,
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-06-12"),
    });
    expect(first.add).toBeCloseTo(21 / 30, 2); // round2, as every accrual result is
    expect(first.newLastYm).toBe("2026-06");
    // Tick two, with a last working day of the 20th now on the record: they earned 11/30, so the claw-back is
    // the difference (10/30) - leaving 11/30 on the balance, not 2/30.
    const second = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      startMs: joined,
      endMs: ms("2026-06-20"),
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: first.newLastYm,
      currentMs: ms("2026-06-25"),
    });
    expect(first.add + second.add).toBeCloseTo(11 / 30, 2);
    expect(second.newLastYm).toBe("2026-06~");
  });
});

describe("computeAccrual (the joining-date rule)", () => {
  const base = {
    accrualDaysPerYear: ANNUAL,
    probationAccrualDaysPerYear: ANNUAL,
    probationEndMs: null,
    endMs: null,
    lastAccrualYm: null,
    currentMs: ms("2026-08-05"),
  };

  it("credits nothing for the joining month when they joined after the cutoff", () => {
    const r = computeAccrual({ ...base, startMs: ms("2026-06-20"), joiningRule: { cutoff_day: 15, if_on_or_before: "full", if_after: "none" } });
    // June earns nothing; July and August are whole months.
    expect(r.add).toBeCloseTo(2, 2);
    expect(r.newLastYm).toBe("2026-08");
  });

  it("credits the joining month in FULL when they joined on or before it", () => {
    const r = computeAccrual({ ...base, startMs: ms("2026-06-10"), joiningRule: { cutoff_day: 15, if_on_or_before: "full", if_after: "none" } });
    expect(r.add).toBeCloseTo(3, 2); // June, July, August - June not prorated
  });

  it("still prorates on either side when the rule says prorate", () => {
    const r = computeAccrual({ ...base, startMs: ms("2026-06-20"), joiningRule: { cutoff_day: 15, if_on_or_before: "prorate", if_after: "prorate" } });
    expect(r.add).toBeCloseTo(11 / 30 + 2, 2); // exactly the behaviour with no rule at all
  });

  it("does not let a full joining month outlive the employment", () => {
    // Joined the 10th, left the 20th, with the cutoff waiving the joining proration: the EXIT clamp still
    // applies, so this is 11/30 of a month and not a whole one.
    const r = computeAccrual({
      ...base,
      startMs: ms("2026-06-10"),
      endMs: ms("2026-06-20"),
      currentMs: ms("2026-06-25"),
      joiningRule: { cutoff_day: 15, if_on_or_before: "full", if_after: "none" },
    });
    expect(r.add).toBeCloseTo(11 / 30, 2);
  });

  it("applies to BOTH halves of the joining month on a semi-monthly type", () => {
    const late = computeAccrual({
      ...base,
      frequency: "semi_monthly",
      startMs: ms("2026-06-20"),
      currentMs: ms("2026-07-20"),
      joiningRule: { cutoff_day: 15, if_on_or_before: "full", if_after: "none" },
    });
    expect(late.add).toBeCloseTo(1, 2); // June's two halves earn nothing; July's two are 0.5 each
    const early = computeAccrual({
      ...base,
      frequency: "semi_monthly",
      startMs: ms("2026-06-10"),
      currentMs: ms("2026-07-20"),
      joiningRule: { cutoff_day: 15, if_on_or_before: "full", if_after: "none" },
    });
    expect(early.add).toBeCloseTo(2, 2); // June's two halves credited in full, plus July's two
  });
});

describe("computeAccrual (semi-monthly: annual/24 on the 1st & 16th)", () => {
  it("credits each half-period from a Jan 1 start", () => {
    // Jan 1 .. Mar 10 = Jan-H1, Jan-H2, Feb-H1, Feb-H2, Mar-H1 = 5 halves of 12/24 = 0.5 each.
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      frequency: "semi_monthly",
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-03-10"),
    });
    expect(r.add).toBeCloseTo(2.5, 5);
    expect(r.newLastYm).toBe("2026-03-H1");
  });

  it("is idempotent once caught up within a half-period", () => {
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      frequency: "semi_monthly",
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: "2026-03-H1",
      currentMs: ms("2026-03-10"),
    });
    expect(r.add).toBe(0);
    expect(r.newLastYm).toBe("2026-03-H1");
  });

  it("credits only the new half after a prior run", () => {
    // lastAccrualYm = Mar-H1, now Mar 20 (>=16) reaches Mar-H2: one more half = 0.5.
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      frequency: "semi_monthly",
      startMs: ms("2026-01-01"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: "2026-03-H1",
      currentMs: ms("2026-03-20"),
    });
    expect(r.add).toBeCloseTo(0.5, 5);
    expect(r.newLastYm).toBe("2026-03-H2");
  });

  it("prorates the joining half-period when starting mid-half", () => {
    // Joined Jan 8: first half is days 1-15, worked 15-8+1 = 8 days / 15 = 0.5333 of 0.5.
    const r = computeAccrual({
      accrualDaysPerYear: ANNUAL,
      frequency: "semi_monthly",
      startMs: ms("2026-01-08"),
      endMs: null,
      probationEndMs: null,
      probationAccrualDaysPerYear: ANNUAL,
      lastAccrualYm: null,
      currentMs: ms("2026-01-20"),
    });
    // Jan-H1 prorated (8/15 * 0.5 = 0.2667) + Jan-H2 full (0.5) = 0.7667, rounded to 2dp = 0.77.
    expect(r.add).toBe(0.77);
    expect(r.newLastYm).toBe("2026-01-H2");
  });
});

describe("leaveDays (sessions: 1=AM, 2=PM)", () => {
  // 2026-06-01 Mon .. 2026-06-03 Wed = 3 working days.
  const mon = ms("2026-06-01");
  const wed = ms("2026-06-03");
  it("full multi-day range (1..2)", () => expect(leaveDays(mon, wed, 1, 2)).toBe(3));
  it("starts in the afternoon (2..2) -> 2.5", () => expect(leaveDays(mon, wed, 2, 2)).toBe(2.5));
  it("ends at midday (1..1) -> 2.5", () => expect(leaveDays(mon, wed, 1, 1)).toBe(2.5));
  it("PM start + AM end (2..1) -> 2.0", () => expect(leaveDays(mon, wed, 2, 1)).toBe(2));
  it("single working day: full / first half (AM) / second half (PM)", () => {
    expect(leaveDays(mon, mon, 1, 2)).toBe(1);
    expect(leaveDays(mon, mon, 1, 1)).toBe(0.5); // morning only
    expect(leaveDays(mon, mon, 2, 2)).toBe(0.5); // afternoon only
  });
  it("defaults are a full range", () => expect(leaveDays(mon, wed)).toBe(3));
  it("excludes holidays from the count", () => {
    // Mon..Wed with Tue (2026-06-02) a holiday -> Mon + Wed = 2 working days.
    expect(leaveDays(mon, wed, 1, 2, week(1, 2, 3, 4, 5), new Set(["2026-06-02"]))).toBe(2);
  });
  it("honors a custom working week (Saturday configured as a working day)", () => {
    const sat = ms("2026-06-06");
    expect(leaveDays(sat, sat, 1, 2, week(1, 2, 3, 4, 5, 6))).toBe(1); // Sat counts when configured
    expect(leaveDays(sat, sat, 1, 2, week(1, 2, 3, 4, 5))).toBe(0); // and not otherwise
  });
  it("weekends don't count and sessions on a weekend boundary are ignored", () => {
    expect(leaveDays(ms("2026-06-06"), ms("2026-06-07"), 2, 1)).toBe(0); // Sat..Sun, no working days
    // Fri..Mon = Fri + Mon = 2 working days; PM-start (Fri) + AM-end (Mon) = half each = 1.
    expect(leaveDays(ms("2026-06-05"), ms("2026-06-08"), 2, 1)).toBe(1);
  });
  it("charges a half-day holiday as half a day", () => {
    const half = new Set(["2026-06-02"]); // Tue, office open in the afternoon only
    expect(leaveDays(mon, wed, 1, 2, week(1, 2, 3, 4, 5), new Set(), half)).toBe(2.5);
    // A full holiday wins over a half one, so a mis-set pair can't charge 1.5 days for a closed office.
    expect(leaveDays(mon, wed, 1, 2, week(1, 2, 3, 4, 5), new Set(["2026-06-02"]), half)).toBe(2);
  });
  it("shaves only what a half-day holiday boundary is worth", () => {
    const tue = ms("2026-06-02");
    const half = new Set(["2026-06-02"]);
    // The one day is worth 0.5; a PM start can't take it below zero.
    expect(leaveDays(tue, tue, 1, 2, week(1, 2, 3, 4, 5), new Set(), half)).toBe(0.5);
    expect(leaveDays(tue, tue, 2, 2, week(1, 2, 3, 4, 5), new Set(), half)).toBe(0);
  });
});

describe("roundToIncrement", () => {
  it("rounds to half days (the .41 case)", () => {
    expect(roundToIncrement(2.41, 0.5)).toBe(2.5);
    expect(roundToIncrement(2.2, 0.5)).toBe(2);
    expect(roundToIncrement(2.75, 0.5)).toBe(3); // .75 rounds up to nearest 0.5
  });
  it("rounds to whole days", () => {
    expect(roundToIncrement(2.41, 1)).toBe(2);
    expect(roundToIncrement(2.6, 1)).toBe(3);
  });
  it("0 increment = exact (2dp)", () => {
    expect(roundToIncrement(2.414, 0)).toBe(2.41);
  });
});

// BEFORE HRMS RECORDS START (`floorMs`, from employees.tracked_from). Somebody who joined in March 2021 and
// whose records start on 24 September 2026: the first nightly run credited 67 months in one go with nothing
// taken off for the leave they used in those years. Those months belong to the opening balance, so the walk
// must leave them exactly where they are - neither re-pricing them nor taking them back on its own - and say
// precisely what they hold, which is the figure the opening replaces.
describe("accrual before HRMS records start", () => {
  const base = {
    accrualDaysPerYear: ANNUAL,
    probationAccrualDaysPerYear: ANNUAL,
    startMs: ms("2021-03-01"),
    endMs: null,
    probationEndMs: null,
  };
  const FLOOR = ms("2026-09-24");
  // The row the first nightly run after go-live left: every month through September, priced from the start.
  const firstNight = computeAccrual({ ...base, lastAccrualYm: null, currentMs: ms("2026-09-25") });
  const row = { lastAccrualYm: firstNight.newLastYm, pricedStartMs: firstNight.pricedStartMs, pricedEndMs: firstNight.pricedEndMs };

  it("reads the backlog the first night credited as what it is", () => {
    expect(firstNight.add).toBe(67); // March 2021 .. September 2026
    expect(creditedBeforeFloor({ ...base, ...row, currentMs: ms("2026-09-26"), floorMs: FLOOR })).toBe(67);
    // Without a floor there is nothing before it.
    expect(creditedBeforeFloor({ ...base, ...row, currentMs: ms("2026-09-26") })).toBe(0);
  });

  it("takes nothing back when the date is set, and credits HRMS's own months after it", () => {
    const sameMonth = computeAccrual({ ...base, ...row, currentMs: ms("2026-09-26"), floorMs: FLOOR });
    expect(sameMonth.add).toBe(0);
    const october = computeAccrual({ ...base, ...row, currentMs: ms("2026-10-02"), floorMs: FLOOR });
    expect(october.add).toBe(1);
    expect(october.newLastYm).toBe("2026-10");
    // The window those 67 months were priced against is kept, so the figure the opening reads does not move.
    expect(october.pricedStartMs).toBe(ms("2021-03-01"));
    expect(creditedBeforeFloor({ ...base, lastAccrualYm: october.newLastYm, pricedStartMs: october.pricedStartMs, pricedEndMs: october.pricedEndMs, currentMs: ms("2026-10-03"), floorMs: FLOOR })).toBe(67);
  });

  it("does not credit months nobody here saw when the start date is corrected years back", () => {
    const corrected = { ...base, startMs: ms("2020-01-01") };
    // Without the floor, the correction credits January 2020 .. February 2021: fourteen months.
    expect(computeAccrual({ ...corrected, ...row, currentMs: ms("2026-09-26") }).add).toBe(14);
    const r = computeAccrual({ ...corrected, ...row, currentMs: ms("2026-09-26"), floorMs: FLOOR });
    expect(r.add).toBe(0);
    expect(r.pricedStartMs).toBe(ms("2021-03-01"));
    expect(creditedBeforeFloor({ ...corrected, ...row, currentMs: ms("2026-09-26"), floorMs: FLOOR })).toBe(67);
  });

  it("starts a balance HRMS has not credited yet at the floor, with nothing to replace", () => {
    const r = computeAccrual({ ...base, lastAccrualYm: null, currentMs: ms("2026-10-05"), floorMs: FLOOR });
    expect(r.add).toBe(1); // October alone
    expect(r.pricedStartMs).toBe(ms("2026-10-01"));
    expect(creditedBeforeFloor({ ...base, lastAccrualYm: r.newLastYm, pricedStartMs: r.pricedStartMs, pricedEndMs: r.pricedEndMs, currentMs: ms("2026-10-06"), floorMs: FLOOR })).toBe(0);
    // ...and keeps walking from there on later nights without re-reading the months before it.
    const nov = computeAccrual({ ...base, lastAccrualYm: r.newLastYm, pricedStartMs: r.pricedStartMs, pricedEndMs: r.pricedEndMs, currentMs: ms("2026-11-02"), floorMs: FLOOR });
    expect(nov.add).toBe(1);
    expect(nov.pricedStartMs).toBe(ms("2026-10-01"));
  });

  it("gives the whole joining month to the opening for someone who joined in the go-live month", () => {
    const joinedSept = { ...base, startMs: ms("2026-09-05") };
    const r = computeAccrual({ ...joinedSept, lastAccrualYm: null, currentMs: ms("2026-10-05"), floorMs: FLOOR });
    expect(r.add).toBe(1); // October; September is before the floor
  });

  it("does nothing when records start on or before the start date", () => {
    const joinedLate = { ...base, startMs: ms("2026-09-10") };
    const withFloor = computeAccrual({ ...joinedLate, lastAccrualYm: null, currentMs: ms("2026-09-26"), floorMs: ms("2026-09-01") });
    const without = computeAccrual({ ...joinedLate, lastAccrualYm: null, currentMs: ms("2026-09-26") });
    expect(withFloor).toEqual(without);
  });

  it("does the same on half-month periods", () => {
    const semi = { ...base, frequency: "semi_monthly" as const };
    const night = computeAccrual({ ...semi, lastAccrualYm: null, currentMs: ms("2026-09-17") });
    const semiRow = { lastAccrualYm: night.newLastYm, pricedStartMs: night.pricedStartMs, pricedEndMs: night.pricedEndMs };
    // Records start on the 16th, so the second half of September is HRMS's and everything before it is not:
    // March 2021 H1 .. September 2026 H1 = 133 halves at half a day each.
    const floor16 = ms("2026-09-16");
    expect(creditedBeforeFloor({ ...semi, ...semiRow, currentMs: ms("2026-09-18"), floorMs: floor16 })).toBe(66.5);
    const r = computeAccrual({ ...semi, ...semiRow, currentMs: ms("2026-10-02"), floorMs: floor16 });
    expect(r.add).toBe(0.5); // October H1
    expect(r.pricedStartMs).toBe(ms("2021-03-01"));
  });

  it("names the first day HRMS prices", () => {
    expect(hrmsPricingStartMs({ startMs: ms("2021-03-01"), floorMs: FLOOR })).toBe(ms("2026-10-01"));
    expect(hrmsPricingStartMs({ startMs: ms("2021-03-01"), floorMs: ms("2026-10-01") })).toBe(ms("2026-10-01"));
    expect(hrmsPricingStartMs({ startMs: ms("2021-03-01"), floorMs: ms("2026-09-20"), frequency: "semi_monthly" })).toBe(ms("2026-10-01"));
    expect(hrmsPricingStartMs({ startMs: ms("2021-03-01"), floorMs: ms("2026-09-16"), frequency: "semi_monthly" })).toBe(ms("2026-09-16"));
    expect(hrmsPricingStartMs({ startMs: ms("2021-03-01"), floorMs: null })).toBeNull();
    expect(hrmsPricingStartMs({ startMs: ms("2026-09-10"), floorMs: ms("2026-09-01") })).toBeNull();
  });
});
