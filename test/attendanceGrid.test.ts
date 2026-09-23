import { describe, it, expect } from "vitest";
import {
  buildAttendanceRows, statsOf, summarizeByDay, DEFAULT_SCHEDULE,
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
