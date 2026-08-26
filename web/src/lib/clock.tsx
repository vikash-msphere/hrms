import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { get, invoke } from "@/api";
import { idOf } from "@/lib/utils";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import { useToast } from "@/components/ui/use-toast";
import type { AttendanceSession, Me } from "@/types";
import { getSetting } from "@/lib/settingsStore";
import { hasCapability } from "@/lib/perm";

// Every session matching a query, following the server cursor: a list page is capped at 100 rows, and an
// approver's window covers their whole team, so a single page would silently drop days from the caller's own
// history. Bounded so a pathological range can't spin forever.
export async function listAllSessions(query: string): Promise<AttendanceSession[]> {
  const all: AttendanceSession[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await get<{ results?: AttendanceSession[]; next_page_token?: string }>(
      `${query}&max_page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
    );
    all.push(...(page.results ?? []));
    pageToken = page.next_page_token;
    if (!pageToken) break;
  }
  return all;
}

// Am I on the clock, and the one place that punches. Held session-wide so the top-bar chip and the Attendance
// page are the same state: punching from either updates both, and neither refetches what the other has.
// The open-session list (everyone the caller can see) and the org schedule ride along, because every consumer
// of "who's clocked in" needs them and they'd otherwise be fetched per page.
export type ClockState = {
  enabled: boolean; // false for a caller with no employee record - nothing to punch
  ready: boolean;
  sched: AttendanceSchedule;
  openSessions: AttendanceSession[];
  mine?: AttendanceSession;
  busy: boolean;
  punch: (verb: "clockIn" | "clockOut") => Promise<void>;
  reload: () => Promise<void>;
};

const EMPTY: ClockState = {
  enabled: false, ready: true, sched: DEFAULT_SCHEDULE, openSessions: [], busy: false,
  punch: async () => {}, reload: async () => {},
};
const ClockContext = createContext<ClockState>(EMPTY);
export const useClock = () => useContext(ClockContext);

function ActiveProvider({ me, children }: { me: Me; children: ReactNode }) {
  const { toast } = useToast();
  const [sched, setSched] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  const [openSessions, setOpenSessions] = useState<AttendanceSession[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setOpenSessions(await listAllSessions("attendance?open=true"));
    } catch {
      /* keep the last known state - a failed poll shouldn't claim you're clocked out */
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    getSetting<Partial<AttendanceSchedule>>("attendance")
      .then((cfg) => { if (cfg.value) setSched({ ...DEFAULT_SCHEDULE, ...cfg.value }); })
      .catch(() => { /* not configured -> defaults */ });
  }, []);

  const punch = useCallback(async (verb: "clockIn" | "clockOut") => {
    if (!me.employee_id) return; // no record, no session of one's own to open
    setBusy(true);
    try {
      await invoke("attendance/me", verb);
      toast({ title: verb === "clockIn" ? "Clocked in" : "Clocked out", variant: "success" });
      await reload();
    } catch (e) {
      toast({ title: verb === "clockIn" ? "Couldn't clock in" : "Couldn't clock out", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [reload, toast, me.employee_id]);

  const mine = useMemo(() => openSessions.find((s) => s.employee && idOf(s.employee) === me.employee_id), [openSessions, me.employee_id]);
  // `enabled` is about PUNCHING: it needs an employee record to open a session for AND the verb that opens
  // it. A caller without either can still see who is on the clock (the directory's presence dots), which is
  // org data, not personal - so the open-session read happens either way, and the top bar simply offers them
  // no button rather than one that 403s.
  const canPunch = hasCapability(me.capabilities, "attendance.clockIn");
  const enabled = Boolean(me.employee_id) && canPunch;
  const value = useMemo<ClockState>(() => ({ enabled, ready, sched, openSessions, mine, busy, punch, reload }), [enabled, ready, sched, openSessions, mine, busy, punch, reload]);
  return <ClockContext.Provider value={value}>{children}</ClockContext.Provider>;
}

export function ClockProvider({ me, children }: { me: Me; children: ReactNode }) {
  return <ActiveProvider me={me}>{children}</ActiveProvider>;
}

// Minutes elapsed on an open session, re-rendered on `everyMs` (default 15s - the display is minute-grained,
// so a per-second tick would just burn renders).
export function useElapsedMinutes(since?: string, everyMs = 15000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [since, everyMs]);
  return since ? Math.max(0, Math.round((now - +new Date(since)) / 60000)) : 0;
}
