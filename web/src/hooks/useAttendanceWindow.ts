import { useCallback, useMemo, useState } from "react";
import { addMonths, monthEndOf, monthStartOf, monthLabel } from "@/lib/attendance";
import { formatDate } from "@/lib/utils";

const DAY_MS = 86400000;

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
 * The per-window selections (the day whose detail is open, the days ticked for a bulk correction) belong to
 * whoever renders them and are dropped there, off `fromYmd`/`toYmd` - a different month has different days.
 */
export function useAttendanceWindow(key: string, orgToday: string): AttendanceWindow {
  const [view, setView] = useState<AttendanceView>(() => loadView(key));
  const [page, setPage] = useState(0);

  // The visible window (YYYY-MM-DD). The list pages by 30 days from today; the grid pages by calendar month,
  // so the month it draws is exactly the month it fetched.
  const { fromYmd, toYmd } = useMemo(() => {
    if (view === "calendar") {
      const month = addMonths(monthStartOf(orgToday), -page);
      return { fromYmd: month, toYmd: monthEndOf(month) };
    }
    const toMs = Date.parse(orgToday + "T00:00:00Z") - page * 30 * DAY_MS;
    return { fromYmd: new Date(toMs - 29 * DAY_MS).toISOString().slice(0, 10), toYmd: new Date(toMs).toISOString().slice(0, 10) };
  }, [view, page, orgToday]);

  const prevWindow = useMemo(() => {
    if (view === "calendar") {
      const month = addMonths(fromYmd, -1);
      return { from: month, to: monthEndOf(month) };
    }
    const to = new Date(Date.parse(fromYmd + "T00:00:00Z") - DAY_MS);
    return { from: new Date(+to - 29 * DAY_MS).toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [view, fromYmd]);

  // Switching view re-bases the window (30 days vs a calendar month), so start again at the current one.
  const switchView = useCallback((v: AttendanceView) => {
    setView(v);
    setPage(0);
    try { localStorage.setItem(storageKey(key), v); } catch { /* private mode - the toggle just won't stick */ }
  }, [key]);

  const goPage = useCallback((next: number) => setPage(next), []);

  return {
    view, page, fromYmd, toYmd, prevWindow,
    windowLabel: view === "calendar" ? monthLabel(fromYmd) : `${formatDate(fromYmd)} – ${formatDate(toYmd)}`,
    prevLabel: view === "calendar" ? "last month" : "the previous 30 days",
    switchView, goPage,
  };
}
