import { describe, it, expect } from "vitest";
import { addDaysUtc, addMonthsUtc, advanceUntilAfter, daysInMonthUtc, isAnniversaryOf } from "../src/domain/calendar";

// The two primitives every recurring thing in this app steps with. They exist because `setUTCMonth(+1)` is
// not "next month": JS normalizes an impossible date forward, so 31 January became 3 March, and a series
// anchored on a month-end day skipped February and then kept the wrong day for good. Nine call sites had
// reached for it directly - recurring cards, 1:1s, repeating events, compliance dates, expense previews.
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("addMonthsUtc clamps instead of rolling over", () => {
  it("lands a month-end date in the short month, not past it", () => {
    expect(ymd(addMonthsUtc(at("2026-01-31"), 1))).toBe("2026-02-28"); // NOT 2026-03-03
    expect(ymd(addMonthsUtc(at("2026-01-30"), 1))).toBe("2026-02-28"); // NOT 2026-03-02
    expect(ymd(addMonthsUtc(at("2026-08-31"), 1))).toBe("2026-09-30"); // NOT 2026-10-01
    expect(ymd(addMonthsUtc(at("2026-05-31"), 1))).toBe("2026-06-30");
  });

  it("knows about leap years", () => {
    expect(ymd(addMonthsUtc(at("2028-01-31"), 1))).toBe("2028-02-29");
    expect(ymd(addMonthsUtc(at("2028-02-29"), 12))).toBe("2029-02-28");
    expect(daysInMonthUtc(2028, 1)).toBe(29);
    expect(daysInMonthUtc(2026, 1)).toBe(28);
  });

  it("carries across year boundaries, forwards and backwards", () => {
    expect(ymd(addMonthsUtc(at("2026-11-30"), 3))).toBe("2027-02-28");
    expect(ymd(addMonthsUtc(at("2026-12-31"), 1))).toBe("2027-01-31");
    expect(ymd(addMonthsUtc(at("2026-03-31"), -1))).toBe("2026-02-28");
    expect(ymd(addMonthsUtc(at("2026-01-15"), -12))).toBe("2025-01-15");
  });

  it("leaves an ordinary day alone and keeps the time of day", () => {
    expect(ymd(addMonthsUtc(at("2026-03-15"), 1))).toBe("2026-04-15");
    const withTime = new Date("2026-03-15T09:30:45.250Z");
    expect(addMonthsUtc(withTime, 1).toISOString()).toBe("2026-04-15T09:30:45.250Z");
  });

  it("does not accumulate drift when a quarterly step passes a short month", () => {
    // Three months from 31 December is 31 March - the clamp must not shorten a step that has a 31st to land
    // on just because an intervening month is short.
    expect(ymd(addMonthsUtc(at("2026-12-31"), 3))).toBe("2027-03-31");
  });
});

describe("advanceUntilAfter catches a stale series up", () => {
  const monthly = (d: Date) => addMonthsUtc(d, 1);

  it("steps once when one step is already ahead", () => {
    expect(ymd(advanceUntilAfter(at("2026-03-10"), at("2026-03-20"), monthly))).toBe("2026-04-10");
  });

  it("keeps stepping until the date is genuinely in the future", () => {
    // A chore due in January, delivered in June: one step would file its replacement due in February, which
    // is already four months past. The day-of-month is kept either way.
    const next = advanceUntilAfter(at("2026-01-15"), at("2026-06-20"), monthly);
    expect(ymd(next)).toBe("2026-07-15");
  });

  it("keeps the weekday on a weekly catch-up", () => {
    const start = at("2026-01-02"); // a Friday
    const next = advanceUntilAfter(start, at("2026-03-01"), (d) => addDaysUtc(d, 7));
    expect(next.getUTCDay()).toBe(start.getUTCDay());
    expect(+next).toBeGreaterThan(+at("2026-03-01"));
  });

  it("always moves at least one step, even from a date already ahead", () => {
    expect(ymd(advanceUntilAfter(at("2026-05-10"), at("2026-01-01"), monthly))).toBe("2026-06-10");
  });

  it("returns rather than spins when the step cannot make progress", () => {
    expect(ymd(advanceUntilAfter(at("2026-05-10"), at("2030-01-01"), (d) => d))).toBe("2026-05-10");
  });
});

// The cron decides "is today their anniversary" for the work-anniversary event, the in-app notification and
// the email. It used to be `month === month && date === date`, which has no answer at all for a 29 February
// anchor in a common year: someone who joined on a leap day was congratulated once every four years, and the
// automations that hang off `schedule.workAnniversary` never fired for them in between.
describe("isAnniversaryOf", () => {
  const anniv = (anchor: string, on: string) => isAnniversaryOf(at(anchor), at(on));

  it("matches the same month and day in an ordinary year", () => {
    expect(anniv("2022-06-15", "2026-06-15")).toBe(true);
    expect(anniv("2022-06-15", "2026-06-14")).toBe(false);
    expect(anniv("2022-06-15", "2026-07-15")).toBe(false);
  });

  it("gives a 29 February anchor its anniversary on the 28th in a common year", () => {
    expect(anniv("2024-02-29", "2026-02-28")).toBe(true); // 2026 is not a leap year
    expect(anniv("2024-02-29", "2026-03-01")).toBe(false); // NOT rolled over into March
  });

  it("keeps a 29 February anchor on the 29th in a leap year", () => {
    expect(anniv("2024-02-29", "2028-02-29")).toBe(true);
    expect(anniv("2024-02-29", "2028-02-28")).toBe(false);
  });

  it("still gives a 28 February anchor the 28th, leap year or not", () => {
    expect(anniv("2022-02-28", "2026-02-28")).toBe(true);
    expect(anniv("2022-02-28", "2028-02-28")).toBe(true);
    expect(anniv("2022-02-28", "2028-02-29")).toBe(false);
  });

  it("leaves a 31st anchor alone - every month it can occur in has 31 days", () => {
    expect(anniv("2022-01-31", "2026-01-31")).toBe(true);
    expect(anniv("2022-01-31", "2026-02-28")).toBe(false);
  });
});
