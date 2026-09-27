import { useEffect, useMemo, useState } from "react";
import { getAllPages } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { scheduleView, type ScheduleView } from "@/lib/workSchedule";
import type { AttendanceSchedule } from "@/lib/attendance";
import type { Shift, ShiftAssignment, WorkPattern, WorkPatternAssignment } from "@/types";

// WHOSE DAY IS WHAT, for a window of the calendar, wherever the browser draws one.
//
// Every surface that says "absent" has to agree with the payroll build about which days were owed - the grid
// calling a rest day an absence tells somebody they missed work nobody asked them for. So the attendance
// grid, the history strip and the team timeline all resolve days through this rather than through the org's
// working week.
//
// It reads NOTHING while `schedule_source` is "org" (the default): on that setting no roster entry and no
// work pattern decides anything, so the org's own week IS the answer and the four reads would be spent
// proving it.

/**
 * @param sched   the org's schedule (the clock's `settings/attendance`) - the bottom layer, and the gate.
 * @param fromYmd/toYmd the window being drawn.
 * @param employeeId when the surface is about ONE person, so the two assignment reads narrow in SQL.
 */
export function useScheduleView(sched: AttendanceSchedule, fromYmd: string, toYmd: string, employeeId?: string): ScheduleView {
  const on = sched.schedule_source === "resolved";
  // The catalogs are small and shared, so they go through the store and are cached across surfaces.
  const { rows: shifts } = useCollection<Shift>("shifts", { all: true, enabled: on });
  const { rows: patterns } = useCollection<WorkPattern>("work-patterns", { all: true, enabled: on });

  const [rows, setRows] = useState<{ shifts: ShiftAssignment[]; patterns: WorkPatternAssignment[] }>({ shifts: [], patterns: [] });
  useEffect(() => {
    if (!on || !fromYmd || !toYmd) { setRows({ shifts: [], patterns: [] }); return; }
    const emp = employeeId ? `&employee=${encodeURIComponent(`employees/${employeeId}`)}` : "";
    const window = `from=${fromYmd}&to=${toYmd}${emp}`;
    // A LATE ANSWER MUST NOT PAINT AN OLD WINDOW over a new one: these are cursor-followed walks, so moving
    // the month twice quickly can land the slower first response last - and the rows it carries are the ones
    // the grid then judges absences against. The same generation guard the roster uses (pages/Schedule.tsx).
    let live = true;
    void Promise.all([
      getAllPages<ShiftAssignment>(`shift-assignments?${window}`, 2000),
      getAllPages<WorkPatternAssignment>(`work-pattern-assignments?${window}`, 500),
    ])
      // A failed read leaves the org's week in place rather than blanking the grid: the server decides what a
      // day was worth either way, and a half-loaded window is worse than a plain one.
      .then(([s, p]) => { if (live) setRows({ shifts: s.results, patterns: p.results }); })
      .catch(() => {});
    return () => { live = false; };
  }, [on, fromYmd, toYmd, employeeId]);

  return useMemo(
    () => scheduleView({ sched, shifts, patterns, assignments: rows.shifts, patternAssignments: rows.patterns }),
    [sched, shifts, patterns, rows],
  );
}
