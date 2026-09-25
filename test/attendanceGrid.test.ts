import { describe, it, expect } from "vitest";
import {
  buildAttendanceRows, statsOf, summarizeByDay, trackedFromOf, DEFAULT_SCHEDULE,
  type AttendanceSchedule, type DayCredit,
} from "../web/src/lib/attendance";
import type { AttendanceSession } from "../web/src/types";

// The grid the browser draws, where a day mark has to agree with what the server settles.
//
// `lopDayUnits` is the money; this is the picture of it. The two are separate implementations of the same
// judgement, so the failure mode worth testing is DISAGREEMENT - a day the strip calls an absence that
// payroll does not dock, or the reverse. Nothing covered this rule before marks existed; the arithmetic it
// guards is small, and the cost of it drifting is somebody arguing with their payslip holding a screenshot.

const TZ = "Asia/Kolkata";
const sched: AttendanceSchedule = { ...DEFAULT_SCHEDULE, timezone: TZ, work_days: [1, 2, 3, 4, 5], full_day_minutes: 480, half_day_minutes: 240 };

// 2026-06-01 is a Monday; 06-06 a Saturday.
const MON = "2026-06-01";
const TUE = "2026-06-02";
const TODAY = "2026-06-10";

const punch = (day: string, hours: number): AttendanceSession => ({
  path: `attendance/${day}`,
  clock_in: `${day}T04:00:00.000Z`, // 09:30 IST
  clock_out: `${day}T${String(4 + hours).padStart(2, "0")}:00:00.000Z`,
} as unknown as AttendanceSession);

const build = (opts: { sessions?: AttendanceSession[]; marks?: Map<string, DayCredit>; holidays?: Set<string>; leaveRanges?: { start: string; end: string; startSession?: number; endSession?: number }[] } = {}) =>
  buildAttendanceRows({
    fromYmd: MON, toYmd: TUE, todayYmd: TODAY, sched,
    summaries: summarizeByDay(opts.sessions ?? [], sched),
    holidays: opts.holidays ?? new Set<string>(),
    leaveRanges: opts.leaveRanges ?? [],
    marksByDay: opts.marks,
  });

const absences = (rows: ReturnType<typeof build>) => statsOf(rows, TZ, sched.full_day_minutes, TODAY).absent;

describe("a day mark rides on the row beside what the punches earned", () => {
  it("keeps both facts, because a marked day is the one somebody asks about later", () => {
    const rows = build({ sessions: [punch(MON, 3)], marks: new Map([[MON, "full"]]) });
    const mon = rows.find((r) => r.day === MON)!;
    // Three hours: the punches say the day was too short to earn even a half day, and that stays on the row.
    expect(mon.status).toBe("insufficient");
    expect(mon.mark).toBe("full");
  });

  it("leaves an unmarked day with no mark on it", () => {
    const rows = build({ sessions: [punch(MON, 9)] });
    expect(rows.find((r) => r.day === MON)!.mark).toBeUndefined();
  });

  it("marks a day that has no punches at all", () => {
    // The absent row is built from the schedule rather than from a punch, so the mark has to reach that
    // branch too - it is the case a regularization cannot serve without inventing clock times.
    const rows = build({ marks: new Map([[MON, "full"]]) });
    expect(rows.find((r) => r.day === MON)!.mark).toBe("full");
  });
});

describe("the absence count says what payroll will dock", () => {
  it("counts an unmarked working day with no punches", () => {
    expect(absences(build())).toBe(2); // Mon + Tue
  });

  it("stops counting a day marked as worked", () => {
    expect(absences(build({ marks: new Map([[MON, "full"]]) }))).toBe(1);
    expect(absences(build({ marks: new Map([[MON, "half"]]) }))).toBe(1);
  });

  it("starts counting a fully worked day marked absent", () => {
    const worked = [punch(MON, 9), punch(TUE, 9)];
    expect(absences(build({ sessions: worked }))).toBe(0);
    expect(absences(build({ sessions: worked, marks: new Map([[MON, "absent"]]) }))).toBe(1);
  });

  it("counts a LATE day marked absent", () => {
    // Named rather than left to luck. The lateness tally and the absence tally used to be one `else if`
    // chain, which was sound while a status was one value and no day could be both - a mark breaks that, and
    // chained, the late branch swallowed the day and the absence went uncounted. Shift starts 09:00 with 15
    // minutes of grace, so 09:30 IST is unambiguously late and the day is still fully worked.
    // Tuesday clocks in at 08:30 IST so it is on time, leaving Monday the only late day in the window.
    const onTimeTue = { ...punch(TUE, 9), clock_in: `${TUE}T03:00:00.000Z` } as AttendanceSession;
    const late = build({ sessions: [punch(MON, 9), onTimeTue], marks: new Map([[MON, "absent"]]) });
    expect(late.find((r) => r.day === MON)!.status).toBe("late");
    const stats = statsOf(late, TZ, sched.full_day_minutes, TODAY);
    expect(stats.late).toBe(1); // still late - the mark does not claim the punches were wrong
    expect(stats.absent).toBe(1); // and still docked
  });

  it("ignores a mark on a day that owed nothing, the way lopDayUnits does", () => {
    // A holiday or a wholly-excused leave day is skipped before the server ever reads a mark, so a mark can
    // sit on one (leave is approved after the fact, and the mark stays visible so it can be withdrawn)
    // without changing anything. Counted here, this strip would show an absence the payroll build does not -
    // the grid and the money disagreeing, which is the one thing this figure must never do.
    const holiday = build({ holidays: new Set([MON]), marks: new Map([[MON, "absent"]]) });
    expect(absences(holiday)).toBe(1); // Tue only
    const onLeave = build({ leaveRanges: [{ start: MON, end: MON }], marks: new Map([[MON, "absent"]]) });
    expect(absences(onLeave)).toBe(1); // Tue only
  });

  it("leaves every other figure reading the punches", () => {
    // A mark does not claim the punches were wrong - that is a regularization's job - so days worked, hours
    // and lateness stay observations.
    const marked = statsOf(build({ sessions: [punch(MON, 3)], marks: new Map([[MON, "full"]]) }), TZ, sched.full_day_minutes, TODAY);
    expect(marked.worked).toBe(1);
    expect(marked.minutes).toBe(180);
  });
});

describe("days before HRMS records start are not absences", () => {
  // Joined years ago, HRMS records start on Tuesday: Monday had no way to be punched.
  const tracked = (opts: { sessions?: AttendanceSession[]; marks?: Map<string, DayCredit>; holidays?: Set<string>; leaveRanges?: { start: string; end: string; startSession?: number; endSession?: number; paid?: boolean }[] } = {}) =>
    buildAttendanceRows({
      fromYmd: MON, toYmd: TUE, todayYmd: TODAY, sched,
      summaries: summarizeByDay(opts.sessions ?? [], sched),
      holidays: opts.holidays ?? new Set<string>(),
      leaveRanges: opts.leaveRanges ?? [],
      marksByDay: opts.marks,
      joinedYmd: "2020-01-06",
      trackedFromYmd: TUE,
    });

  it("reads an empty working day before it as untracked, and still flags one on it", () => {
    const rows = tracked();
    expect(rows.find((r) => r.day === MON)?.status).toBe("untracked");
    expect(rows.find((r) => r.day === TUE)?.status).toBe("absent");
    const stats = statsOf(rows, TZ, sched.full_day_minutes, TODAY);
    expect(stats.absent).toBe(1);
    expect(stats.workingDays).toBe(1); // the untracked day owes nothing
  });

  it("keeps the untracked day a row, so a correction or a mark can be filed against it", () => {
    // A day with no row is an inert cell in the month grid: it cannot be ticked, opened or marked.
    expect(tracked().some((r) => r.day === MON)).toBe(true);
  });

  it("judges a day somebody backfilled with punches as usual", () => {
    expect(tracked({ sessions: [punch(MON, 9)] }).find((r) => r.day === MON)?.summary?.workedMinutes).toBe(540);
  });

  it("lets HR's mark give an untracked day its value", () => {
    const marked = (credit: DayCredit) => statsOf(tracked({ marks: new Map([[MON, credit]]) }), TZ, sched.full_day_minutes, TODAY);
    expect(marked("absent").absent).toBe(2);
    expect(marked("full").absent).toBe(1);
  });

  it("keeps a holiday before it, which is the org's fact, not the employee's", () => {
    expect(tracked({ holidays: new Set([MON]) }).find((r) => r.day === MON)?.status).toBe("holiday");
  });

  // Leave is a record, so a day it falls on is judged the way payroll judges it (domain/attendance.ts
  // isUntracked): unpaid leave is still an unworked day, half a day of paid leave still leaves half owed.
  it("judges a day before it that approved leave falls on, as payroll does", () => {
    const day = (leaveRanges: NonNullable<Parameters<typeof tracked>[0]>["leaveRanges"]) => tracked({ leaveRanges }).find((r) => r.day === MON)?.status;
    expect(day([{ start: MON, end: MON }])).toBe("on_leave");
    expect(day([{ start: MON, end: MON, paid: false }])).toBe("absent");
    expect(day([{ start: MON, end: MON, endSession: 1 }])).toBe("half_day_leave");
  });

  it("reads the date off the employee record", () => {
    expect(trackedFromOf({ tracked_from: "2026-09-24" })).toBe("2026-09-24");
    expect(trackedFromOf({})).toBeUndefined();
    expect(trackedFromOf(undefined)).toBeUndefined();
  });
});
