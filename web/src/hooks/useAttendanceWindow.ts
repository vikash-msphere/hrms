import { useCallback, useMemo, useState } from "react";
import { addMonths, monthEndOf, monthStartOf, monthLabel } from "@/lib/attendance";

// How the history is shown: a list of days (with weekly subtotals) or a month grid. Attendance is
// calendar-shaped, so the grid is the pattern view; the list is the detail view. Remembered per reader, and
// per whose attendance is being read - somebody who works in the month grid on their own record and the list
// on the people they manage should get each back as they left it.
export type AttendanceView = "list" | "calendar";
const storageKey = (key: string) => `hrms.attendance.view:${key}`;
const loadView = (key: string): AttendanceView => {
  try { return localStorage.getItem(storageKey(key)) === "calendar" ? "calendar" : "list"; } catch { return "list"; }
};

export type AttendanceWindow = {
  view: AttendanceView;
  /** 0 = the current window; each higher page steps one window further back. */
  page: number;
  fromYmd: string;
  toYmd: string;
  /** The window immediately before this one, for the opt-in comparison. */
  prevWindow: { from: string; to: string };
  windowLabel: string;
  prevLabel: string;
  switchView: (v: AttendanceView) => void;
  goPage: (next: number) => void;
};

/**
 * The window of days an attendance history is showing, and the two controls that move it. Held in a hook so
 * the page around the history (which fetches the whole team's punches for the SAME window) and the history
 * itself cannot drift apart - they read one object rather than mirroring each other's state.
 *
 * The per-window selection (the day whose detail is open) belongs to whoever renders it and is dropped
 * there, off `fromYmd`/`toYmd` - a different month has different days.
 */
export function useAttendanceWindow(key: string, orgToday: string): AttendanceWindow {
  const [view, setView] = useState<AttendanceView>(() => loadView(key));
  const [page, setPage] = useState(0);

  // The visible window (YYYY-MM-DD): one calendar month, in BOTH views. The list and the grid are two shapes of
  // the same days, and every figure around them (the hours chart, the stat row, the team period table) reads
  // this window, so a month in one view is the same month in the other.
  const { fromYmd, toYmd } = useMemo(() => {
    const month = addMonths(monthStartOf(orgToday), -page);
    return { fromYmd: month, toYmd: monthEndOf(month) };
  }, [page, orgToday]);

  const prevWindow = useMemo(() => {
    const month = addMonths(fromYmd, -1);
    return { from: month, to: monthEndOf(month) };
  }, [fromYmd]);

  // The window does not depend on the view, so switching keeps the month the reader paged to.
  const switchView = useCallback((v: AttendanceView) => {
    setView(v);
    try { localStorage.setItem(storageKey(key), v); } catch { /* private mode - the toggle just won't stick */ }
  }, [key]);

  const goPage = useCallback((next: number) => setPage(next), []);

  return {
    view, page, fromYmd, toYmd, prevWindow,
    windowLabel: monthLabel(fromYmd),
    prevLabel: "last month",
    switchView, goPage,
  };
}
