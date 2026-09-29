import { describe, it, expect } from "vitest";
import { describeCorrection, punchErrors, punchInstants, seedPunches, type PunchRow } from "../web/src/lib/attendance";

// How a correction request reads wherever it is listed: as the change it makes to the day as recorded when it
// was filed, not as a bare new day. An approver deciding "Clock-in 11:02 AM → 9:00 AM" is deciding one thing;
// one handed "9:00 AM–6:05 PM, 7:00 PM–8:00 PM" has to diff it against the log in their head.
//
// Times are compared as the reader sees them, so a real punch's seconds never read as an edit.

// Minute-precision 24h in UTC keeps the expectations readable and independent of the machine's zone.
const hm = (iso: string) => new Date(iso).toISOString().slice(11, 16);
const at = (t: string) => `2026-07-14T${t}:00.000Z`;
const s = (i: string, o?: string) => ({ clock_in: at(i), ...(o ? { clock_out: at(o) } : {}) });

describe("describeCorrection", () => {
  it("names the one clock-in that moved, and what it does to worked time", () => {
    const recorded = [{ clock_in: "2026-07-14T11:02:37.000Z", clock_out: at("18:05") }, s("19:00", "20:00")];
    const requested = [s("09:00", "18:05"), s("19:00", "20:00")];
    expect(describeCorrection(recorded, requested, hm)).toBe("Clock-in 11:02 → 09:00 (+2h 2m)");
  });

  it("names a moved clock-out", () => {
    expect(describeCorrection([s("09:00", "18:00")], [s("09:00", "17:30")], hm)).toBe("Clock-out 18:00 → 17:30 (-30m)");
  });

  it("reads a clock-out that was never punched as added, with no total for a day that had none", () => {
    expect(describeCorrection([s("09:00")], [s("09:00", "18:30")], hm)).toBe("Added clock-out 18:30");
  });

  it("falls back to the whole new day when punches are added or removed", () => {
    expect(describeCorrection([s("09:00", "18:00")], [s("09:00", "13:00"), s("14:00", "18:00")], hm)).toBe("09:00–13:00, 14:00–18:00");
  });

  it("falls back for a request filed before the day was recorded with it, and for clearing the day", () => {
    expect(describeCorrection(undefined, [s("09:00", "18:00")], hm)).toBe("09:00–18:00");
    expect(describeCorrection([s("09:00", "18:00")], [], hm, "remove punches")).toBe("remove punches");
  });

  it("does not read seconds as a change", () => {
    expect(describeCorrection([{ clock_in: "2026-07-14T09:00:41.000Z", clock_out: at("18:00") }], [s("09:00", "18:00")], hm)).toBe("No change to the recorded times");
  });
});

describe("the correction form", () => {
  it("seeds each recorded punch with what it was, so a changed time can be marked against it", () => {
    const rows = seedPunches([s("03:30", "12:30"), s("13:00")], "UTC");
    expect(rows).toEqual([
      { in: "03:30", out: "12:30", was: { in: "03:30", out: "12:30", at: s("03:30", "12:30") } },
      { in: "13:00", out: "", was: { in: "13:00", out: "", at: s("13:00") } },
    ]);
  });

  it("files a time left alone as the exact recorded instant, and an edited one as typed", () => {
    const [row] = seedPunches([{ clock_in: "2026-07-14T03:30:41.000Z", clock_out: "2026-07-14T12:30:12.000Z" }], "UTC");
    expect(punchInstants("2026-07-14", { ...row!, in: "03:00" }, "UTC")).toEqual({ clock_in: "2026-07-14T03:00:00.000Z", clock_out: "2026-07-14T12:30:12.000Z" });
    // A blank clock-out stays absent: today's session, still running.
    expect(punchInstants("2026-07-14", { ...row!, out: "" }, "UTC")).toEqual({ clock_in: "2026-07-14T03:30:41.000Z" });
  });

  it("lets only today's latest in/out leave its clock-out blank", () => {
    const rows: PunchRow[] = [{ in: "09:00", out: "13:00" }, { in: "14:00", out: "" }];
    expect(punchErrors(rows, undefined)).toEqual([undefined, "Add the clock-out time"]);
    expect(punchErrors(rows, { now: "15:00" })).toEqual([undefined, undefined]);
    expect(punchErrors([{ in: "09:00", out: "" }, { in: "14:00", out: "15:00" }], { now: "16:00" })[0]).toBe("Only the latest in/out can be left without a clock-out");
    expect(punchErrors([{ in: "16:30", out: "" }], { now: "16:00" })[0]).toBe("Clock-in can't be later than now");
  });
});
