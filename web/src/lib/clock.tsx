import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { get, invoke, type ApiError } from "@/api";
import { idOf } from "@/lib/utils";
import { navigate } from "@/router";
import { fireIntent } from "@/lib/intent";
import { useConfirm } from "@/components/common/confirm";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import { useToast } from "@/components/ui/use-toast";
import type { AttendanceSession, Me } from "@/types";
import { getSetting } from "@/lib/settingsStore";
import { subscribeInvalidations } from "@/lib/resourceStore";
import { setOrgTimezone } from "@/lib/orgDay";
import { hasCapability } from "@/lib/perm";

// Every session matching a query, following the server cursor: a list page is capped at 100 rows, and an
// approver's window covers their whole team, so a single page would silently drop days from the caller's own
// history. Bounded so a pathological range can't spin forever.
export async function listAllSessions(query: string): Promise<AttendanceSession[]> {
  return (await listAllSessionsPaged(query)).sessions;
}

/** The same walk, saying whether it stopped on the page ceiling rather than on the end of the list.
 *
 *  A caller that reads a MISSING session as an accusation ("No log" against somebody who did clock in) needs
 *  to know the difference: a day the walk never reached is not a day nobody worked. */
export async function listAllSessionsPaged(query: string): Promise<{ sessions: AttendanceSession[]; truncated: boolean }> {
  const all: AttendanceSession[] = [];
  // A STUCK CURSOR is a different failure from a long one, and the page ceiling only catches the second. The
  // same `seen` set guards `api.ts#listAll` and `#getAllPages`, after the cases their notes describe - a keyset
  // key that ties across more rows than a page holds, a filter change mid-walk, a bug in a route's own `list`
  // hook. Here it would have meant the same page appended up to ten times, with duplicate rows in every total
  // built off the result.
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await get<{ results?: AttendanceSession[]; next_page_token?: string }>(
      `${query}&max_page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
    );
    all.push(...(page.results ?? []));
    pageToken = page.next_page_token;
    if (!pageToken || seen.has(pageToken)) return { sessions: all, truncated: false };
    seen.add(pageToken);
  }
  // Ten pages of 100 and the cursor still had more: the window is a window.
  return { sessions: all, truncated: true };
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
  const confirm = useConfirm();
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

  const readSchedule = useCallback(() => {
    getSetting<Partial<AttendanceSchedule>>("attendance")
      .then((cfg) => {
        if (!cfg.value) return;
        setSched({ ...DEFAULT_SCHEDULE, ...cfg.value });
        // The same read answers "what day is it for this org" for the whole SPA (lib/orgDay.ts). Handing it
        // over here means the two can never disagree about the timezone, and costs nothing.
        setOrgTimezone(cfg.value.timezone);
      })
      .catch(() => { /* not configured -> defaults */ });
  }, []);

  // Read on mount AND whenever a settings write lands - this tab's or a sibling's (subscribeInvalidations
  // covers both). A mount-only effect meant that saving the org's timezone, shift or working days left every
  // consumer of this schedule - the TopBar chip, the Attendance page's late/early flags, `workingDaysInRange`,
  // the overtime suggestion - and the whole SPA's idea of "today" running on the pre-save values until
  // somebody reloaded the page, while the server had already adopted the new ones.
  useEffect(() => {
    readSchedule();
    return subscribeInvalidations((collections) => {
      if (collections.includes("settings")) readSchedule();
    });
  }, [readSchedule]);

  // Whether to offer the remote-work request when the network fence refuses a punch. Gated on the capability
  // for the same reason every other affordance is: nothing the caller can't actually use may be offered.
  const canRequestRemote = Boolean(me.employee_id) && hasCapability(me.capabilities, "remote-work-requests.write");

  const punch = useCallback(async (verb: "clockIn" | "clockOut") => {
    if (!me.employee_id) return; // no record, no session of one's own to open
    setBusy(true);
    let failure: unknown = null;
    try {
      await invoke("attendance/me", verb);
      toast({ title: verb === "clockIn" ? "Clocked in" : "Clocked out", variant: "success" });
      await reload();
    } catch (e) {
      failure = e;
    } finally {
      setBusy(false);
    }
    if (!failure) return;
    // The network fence is the one punch failure with a way out, so it gets an offer instead of a dead-end
    // toast: working from home is a request, not an error. Matched on the problem TYPE, never the sentence.
    // Asked after `busy` clears, so the button isn't left spinning behind a modal.
    if ((failure as ApiError).problem?.type === "/errors/clock-network-fence" && canRequestRemote) {
      const ask = await confirm({
        title: "You're not on a work network",
        description: "Clocking in and out is limited to your organisation's networks. If you're working remotely, request it for these dates - once it's approved you can punch from anywhere.",
        confirmLabel: "Request remote work",
        cancelLabel: "Not now",
      });
      // The create form lives on the Remote work page; the intent survives the navigation and opens it on
      // mount, so confirming lands straight in the form (dated today) rather than on the page.
      if (ask) { navigate("remote-work"); fireIntent("new-remote"); }
      return;
    }
    toast({ title: verb === "clockIn" ? "Couldn't clock in" : "Couldn't clock out", description: (failure as Error).message, variant: "destructive" });
  }, [reload, toast, me.employee_id, canRequestRemote, confirm]);

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

/**
 * The current time, re-read on `everyMs` (default a minute).
 *
 * For a view whose ANSWER depends on the clock rather than only its display: which interviews are still
 * upcoming, what is overdue, what is on today. Computing that inside a `useMemo` keyed on the rows captures
 * the instant of the last data change, so the boundary stops moving - a round that started ten minutes ago
 * sits in "upcoming" until something happens to refetch, which on a day somebody leaves the schedule open is
 * most of the day.
 *
 * A minute is the granularity every such boundary in the app is stated at, and the re-render is a list sort.
 */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
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
