import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft, ChevronRight, CalendarRange, Plane, CalendarClock, Plus, Users, Search, X, LayoutGrid, Rows3,
  List, Inbox, ArrowRight, Filter, AlertTriangle, Printer, CalendarDays, Eye, Wallet, Grid2x2,
} from "lucide-react";
import { get } from "@/api";
import { navigate } from "@/router";
import { useCollection, useCollectionHasMore } from "@/hooks/useCollection";
import { useApprovals } from "@/lib/approvals";
import { usePermission, useCanExport } from "@/lib/perm";
import { idOf, cn } from "@/lib/utils";
import { leaveColor } from "@/lib/leaveColors";
import { readUrlQuery, writeUrlQuery } from "@/lib/urlQuery";
import { leaveSummary, leaveDecisionContext } from "@/lib/leaveApproval";
import { exportTable } from "@/lib/exportTable";
import { buildIcs, downloadIcs } from "@/lib/ics";
import { DEFAULT_SCHEDULE, type AttendanceSchedule } from "@/lib/attendance";
import {
  addDays, awayPerDay, coverOf, daysApart, dmy, expandByDay, gridCells, groupRuns, halfLabel, longDate,
  monthDaysOf, monthLabelOf, monthStart, shortName, thinDays, ymOf, ymdUtc, type CalEntry,
} from "@/lib/leaveCalendar";
import { todayStr } from "@/lib/orgDay";
import type { Me, Employee, Department, LeaveRequest, LeaveType, LeaveBalance, Holiday, Event, Celebration, RemoteWorkRequest } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { ExportButton } from "@/components/common/ExportButton";
import { AccessTarget } from "@/components/access/AccessTarget";
import { RequestLeaveDialog } from "@/components/common/RequestLeaveDialog";
import { ApprovalRow, RejectDialog, type RejectTarget } from "@/components/common/ApprovalRow";
import { MonthGrid } from "@/components/calendar/MonthGrid";
import { TeamGrid } from "@/components/calendar/TeamGrid";
import { QuarterGrid } from "@/components/calendar/QuarterGrid";
import { AgendaList } from "@/components/calendar/AgendaList";
import { DayPanel } from "@/components/calendar/DayPanel";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { DataState } from "@/components/common/DataState";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getSetting } from "@/lib/settingsStore";
import { parseRestrictions } from "../../../src/domain/leaveRestrictions";
import { useCelebrations } from "@/hooks/useCelebrations";

// Who is away, when, and what that leaves the team with. Four views over one set of rows: the month grid
// (bars, drag-to-request), the team rows (overlap), the quarter heat map (planning), the agenda (phones).
//
// The rows come from a SERVER-side date window (`?from=&to=`), not a client filter over whatever the first
// page happened to hold, and the headcount denominator comes from an aggregate - a calendar that quietly drops
// leave, or divides by the 100 employees it managed to load, is worse than no calendar.

const ONE_LEAVE_COLOR = "#14b8a6"; // single neutral colour for viewers without the leave-type breakdown
const VIEWS = [["month", "Month", LayoutGrid], ["team", "Team", Rows3], ["quarter", "Quarter", Grid2x2], ["list", "List", List]] as const;
type View = (typeof VIEWS)[number][0];
const isView = (v: string | null): v is View => VIEWS.some(([k]) => k === v);

export default function LeaveCalendar({ me }: { me: Me }) {
  // ---- View state, all of it in the URL query so a reload, a back press and a pasted link agree -----------
  const [view, setView] = useState<View>(() => {
    const v = readUrlQuery("view");
    if (isView(v)) return v;
    // A 7-column month grid at phone width is unreadable, so small screens open on the agenda instead.
    return typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches ? "list" : "month";
  });
  const [cursor, setCursor] = useState(() => {
    // `m=YYYY-MM` is this page's own month param. `d=YYYY-MM-DD` is what links from elsewhere carry (the
    // holiday calendar's "open this day" is one), and a day names its month - without this those links
    // landed on the CURRENT month, which is never the month the reader clicked.
    const m = readUrlQuery("m") ?? readUrlQuery("d")?.slice(0, 7);
    return m && /^\d{4}-\d{2}$/.test(m) ? new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1)) : monthStart(new Date());
  });
  const [dept, setDept] = useState(() => readUrlQuery("dept") ?? "all");
  const [typeFilter, setTypeFilter] = useState(() => readUrlQuery("type") ?? "all");
  const [query, setQuery] = useState(() => readUrlQuery("q") ?? "");
  const [showPending, setShowPending] = useState(() => readUrlQuery("pending") === "1");
  const [compact, setCompact] = useState(() => readUrlQuery("compact") === "1");
  // Optional layers, each one an extra read - off by default, so the page costs what it shows.
  const [layers, setLayers] = useState<Set<string>>(() => new Set((readUrlQuery("layers") ?? "").split(",").filter(Boolean)));
  const [selected, setSelected] = useState<string | null>(() => {
    const d = readUrlQuery("d");
    if (d) return d;
    const m = readUrlQuery("m");
    const t = todayStr();
    return !m || m === t.slice(0, 7) ? t : `${m}-01`;
  });
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  const [rejecting, setRejecting] = useState<RejectTarget | null>(null);
  const [decided, setDecided] = useState<Set<string>>(() => new Set());

  useEffect(() => { writeUrlQuery("view", view); }, [view]);
  useEffect(() => { writeUrlQuery("m", ymOf(cursor)); }, [cursor]);
  useEffect(() => { writeUrlQuery("dept", dept === "all" ? null : dept); }, [dept]);
  useEffect(() => { writeUrlQuery("type", typeFilter === "all" ? null : typeFilter); }, [typeFilter]);
  useEffect(() => { writeUrlQuery("q", query.trim() || null); }, [query]);
  useEffect(() => { writeUrlQuery("pending", showPending ? "1" : null); }, [showPending]);
  useEffect(() => { writeUrlQuery("compact", compact ? "1" : null); }, [compact]);
  useEffect(() => { writeUrlQuery("layers", layers.size ? [...layers].sort().join(",") : null); }, [layers]);
  useEffect(() => { writeUrlQuery("d", selected); }, [selected]);

  const today = todayStr();
  const showRemote = layers.has("remote");
  const showCelebrations = layers.has("celebrations");

  // ---- Org schedule (working days + which weekday a grid starts on) ---------------------------------------
  const [schedule, setSchedule] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  useEffect(() => {
    getSetting<Partial<AttendanceSchedule>>("attendance")
      .then((s) => { if (s.value) setSchedule({ ...DEFAULT_SCHEDULE, ...s.value }); })
      .catch(() => {});
  }, []);
  // Memoized: the fallback is a fresh array literal, and the month grid's memo keys off this.
  const workDays = useMemo(() => (schedule.work_days?.length ? schedule.work_days : [1, 2, 3, 4, 5]), [schedule.work_days]);
  const weekStart = schedule.week_start ?? 0;

  // ---- The visible window, and the rows for exactly that window ------------------------------------------
  const cells = useMemo(() => gridCells(cursor, weekStart), [cursor, weekStart]);
  const monthDays = useMemo(() => monthDaysOf(cursor), [cursor]);
  const range = useMemo(() => {
    if (view === "quarter") {
      const end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 3, 0));
      return { from: ymdUtc(monthStart(cursor)), to: ymdUtc(end) };
    }
    // The month grid shows the tail of the previous month and the head of the next, so the window is the grid.
    return { from: ymdUtc(cells[0]), to: ymdUtc(cells[cells.length - 1]) };
  }, [view, cursor, cells]);

  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  // `all: true`, not `max: 500`: the server caps a page at 100 whatever is asked for, so a busy month's
  // calendar silently drew only part of itself. The read is already narrowed to the grid's own window.
  const { rows: leaves, state: leavesState, reload: reloadLeaves } = useCollection<LeaveRequest>("leave-requests", {
    all: true,
    params: { from: range.from, to: range.to },
  });
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  const { rows: holidays } = useCollection<Holiday>("holidays", { all: true });
  // Org events show in the SELECTED day's panel and nowhere else on the calendar, so a month nobody has
  // clicked into reads none of them.
  // `all: true` for the same reason the leave read above carries it, and the lazy gating stays: the route has
  // no date window, so one page of an org-wide, newest-first collection meant clicking into any day older than
  // the newest hundred events showed a day the panel called clear.
  const { rows: events } = useCollection<Event>("events", { enabled: !!selected, all: true });
  // The remote layer is drawn on the same grid as the leave layer and was the one read that kept the window
  // without the walk - so a hybrid month past a hundred remote-work requests drew part of one layer and all of
  // the other, with nothing to tell "nobody was remote" from "not loaded".
  const { rows: remoteRows } = useCollection<RemoteWorkRequest>("remote-work-requests", {
    enabled: showRemote,
    all: true,
    params: { from: range.from, to: range.to },
  });
  // Employees only: this one marks the HEADCOUNT as approximate, and a windowed event list says nothing about
  // how many people the org has. The layers admit their own ceiling through the notice below.
  const employeesTruncated = useCollectionHasMore(["employees"]);
  const approvals = useApprovals();
  const canRequest = usePermission("leave-requests.write");
  // The calendar is a view over leave requests, so a per-collection export grant on them covers it.
  const canExport = useCanExport("leave-requests");

  // Birthdays and work anniversaries, placed by their month/day. The feed only reaches 90 days ahead, so the
  // markers thin out on far-future months - and it's only fetched when the layer is on.
  // Held per tab and revalidated rather than re-read - the same copy the dashboard card uses when the two
  // windows match. See hooks/useCelebrations.ts for what this read costs the server.
  const { rows: celebrations } = useCelebrations(90, showCelebrations);

  // The denominator. An aggregate, because counting loaded employee rows counts one page, not the org.
  const [headcount, setHeadcount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    get<{ kpis?: { headcount?: { value: number } } }>("dashboard-summary?keys=headcount")
      .then((r) => live && setHeadcount(r.kpis?.headcount?.value ?? null))
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // ---- Deriving what the views draw ----------------------------------------------------------------------
  const distinctColors = usePermission("leave-types.write");
  const typeById = useMemo(() => new Map(leaveTypes.map((t) => [idOf(t.path), t] as const)), [leaveTypes]);
  const colorOf = useCallback(
    (ref?: string) => (!distinctColors ? ONE_LEAVE_COLOR : leaveColor(typeById.get(ref ? idOf(ref) : "")?.color, ref ? idOf(ref) : "")),
    [distinctColors, typeById],
  );
  const typeName = useCallback((ref?: string) => typeById.get(ref ? idOf(ref) : "")?.display_name ?? "Leave", [typeById]);
  const empById = useMemo(() => new Map(employees.map((e) => [idOf(e.path), e] as const)), [employees]);
  const deptName = useCallback((id: string) => departments.find((d) => idOf(d.path) === id)?.display_name ?? "Department", [departments]);
  const deptOf = useCallback((empId: string) => { const d = empById.get(empId)?.department; return d ? idOf(d) : ""; }, [empById]);
  const inDept = useCallback((empId: string) => dept === "all" || deptOf(empId) === dept, [dept, deptOf]);

  // Leavers are `disabled` (the exit transition sets it with the end date), so they leave the denominator the
  // same way the server's headcount aggregate drops them.
  const activeEmployees = useMemo(() => employees.filter((e) => !e.delete_time && !e.disabled), [employees]);
  // Org-wide the aggregate is authoritative; inside a department only the loaded rows can answer, so the page
  // says when that answer is standing on a truncated list rather than quietly rounding it off.
  const scopedEmployees = useMemo(() => activeEmployees.filter((e) => inDept(idOf(e.path))), [activeEmployees, inDept]);
  const total = dept === "all" ? headcount ?? activeEmployees.length : scopedEmployees.length;
  const totalApprox = dept === "all" ? headcount === null && employeesTruncated : employeesTruncated;

  const entries = useMemo<CalEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const out: CalEntry[] = [];
    const push = (row: LeaveRequest | RemoteWorkRequest, kind: CalEntry["kind"]) => {
      if (!row.employee) return;
      const state = (row.state ?? "").toUpperCase();
      const pending = state === "PENDING";
      if (state !== "APPROVED" && !(pending && showPending)) return;
      const leaveTypeRef = kind === "leave" ? (row as LeaveRequest).leave_type : undefined;
      if (kind === "leave" && typeFilter !== "all" && !(leaveTypeRef && idOf(leaveTypeRef) === typeFilter)) return;
      const empId = idOf(row.employee);
      if (!inDept(empId)) return;
      const e = empById.get(empId);
      const name = e ? `${e.first_name} ${e.last_name}` : "Someone";
      if (q && !name.toLowerCase().includes(q)) return;
      const start = row.start_date.slice(0, 10);
      const end = row.end_date.slice(0, 10);
      out.push({
        key: row.path,
        row: row as LeaveRequest,
        kind,
        empId,
        name,
        short: e ? shortName(e.first_name, e.last_name) : name,
        photo: e?.photo,
        deptId: deptOf(empId),
        start,
        end: end < start ? start : end,
        startSession: row.start_session === 2 ? 2 : 1,
        endSession: row.end_session === 1 ? 1 : 2,
        days: (row as LeaveRequest).days ?? 0,
        pending,
        mine: !!me.employee_id && empId === me.employee_id,
        color: kind === "remote" ? "#64748b" : colorOf(leaveTypeRef),
        type: kind === "remote" ? "Remote work" : typeName(leaveTypeRef),
        reason: row.reason ?? undefined,
      });
    };
    for (const l of leaves) push(l, "leave");
    // Remote work is only ever a filter-free overlay: it isn't a leave type, so the type filter can't name it.
    if (showRemote && typeFilter === "all") for (const r of remoteRows) push(r, "remote");
    return out.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
  }, [leaves, remoteRows, showRemote, showPending, typeFilter, inDept, empById, deptOf, query, colorOf, typeName, me.employee_id]);

  const byDay = useMemo(() => expandByDay(entries), [entries]);
  // "Away" counts LEAVE only - someone working remotely is still working.
  const awayByDay = useMemo(() => awayPerDay(byDay, "leave"), [byDay]);
  const awayOn = useCallback((ymd: string) => awayByDay.get(ymd) ?? 0, [awayByDay]);

  const holidayMap = useMemo(() => {
    const m = new Map<string, Holiday>();
    // Regional holidays for another location aren't this viewer's days off, so they don't mark the grid.
    for (const h of holidays) { if (!h.disabled && !h.delete_time && h.applies !== false) m.set(h.date.slice(0, 10), h); }
    return m;
  }, [holidays]);
  const holidayOn = useCallback((ymd: string) => holidayMap.get(ymd), [holidayMap]);
  const holidaySet = useMemo(() => new Set(holidayMap.keys()), [holidayMap]);

  // The org-wide closed periods, so this calendar and the request picker agree about which days are bookable.
  // The ORG baseline rather than any one type's overrides: this grid shows the whole team's leave of every
  // kind, so the honest thing for it to draw is what the org closes for everybody. A type that opts out of a
  // closure still says so in the request form, which is where a specific type is actually chosen.
  const [orgClosures, setOrgClosures] = useState<{ from: string; to: string; label?: string }[]>([]);
  useEffect(() => {
    getSetting<Record<string, unknown>>("leave_restrictions")
      .then((s) => setOrgClosures(parseRestrictions(s.value).timing.blackouts ?? []))
      .catch(() => {});
  }, []);
  const closedOn = useCallback(
    (ymd: string) => {
      const w = orgClosures.find((b) => ymd >= b.from && ymd <= b.to);
      return w ? w.label || "Closed period" : undefined;
    },
    [orgClosures],
  );

  // Celebrations recur every year, so a month/day pair places one on any month the page is showing.
  const celebrationsByMd = useMemo(() => {
    const m = new Map<string, Celebration[]>();
    if (!showCelebrations) return m;
    for (const c of celebrations) {
      if (!inDept(idOf(c.employee))) continue;
      const k = `${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
      const list = m.get(k);
      if (list) list.push(c);
      else m.set(k, [c]);
    }
    return m;
  }, [celebrations, showCelebrations, inDept]);
  const celebrationsOn = useCallback((ymd: string) => celebrationsByMd.get(ymd.slice(5)) ?? [], [celebrationsByMd]);

  const eventsOn = useCallback(
    (ymd: string) =>
      events.filter((ev) => ev.start_time.slice(0, 10) <= ymd && ev.end_time.slice(0, 10) >= ymd && (ev.attendees ?? []).some((a) => inDept(idOf(a)))),
    [events, inDept],
  );

  // ---- Navigation ----------------------------------------------------------------------------------------
  const selectDay = useCallback((ymd: string | null) => {
    setSelected(ymd);
    // A day outside the visible month brings the month with it, so the panel never describes an off-screen day.
    if (ymd && ymd.slice(0, 7) !== ymOf(cursor) && view !== "quarter") setCursor(new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, 1)));
  }, [cursor, view]);
  const goMonth = useCallback((delta: number) => {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + delta, 1));
    setCursor(next);
    setSelected(today.slice(0, 7) === ymOf(next) ? today : ymdUtc(next));
  }, [cursor, today]);
  const goToday = () => { setCursor(monthStart(new Date())); setSelected(today); };
  const requestFor = (from: string, to: string) => setDraft({ from, to });

  // ---- Thin cover, as an alert list rather than a month of strips to eyeball ------------------------------
  // Over the whole window on screen, so the quarter view flags the far months too.
  const visibleDays = useMemo(
    () => (view === "quarter"
      ? [0, 1, 2].flatMap((k) => monthDaysOf(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + k, 1))))
      : monthDays),
    [view, cursor, monthDays],
  );
  const alertDays = useMemo(() => thinDays(visibleDays, awayOn, total, workDays, holidaySet), [visibleDays, awayOn, total, workDays, holidaySet]);
  const alertRuns = useMemo(() => groupRuns(alertDays), [alertDays]);

  // ---- Decisions waiting on this caller, for the window on screen ----------------------------------------
  const pendingForMe = useMemo(
    () =>
      approvals.leaves
        .filter((r) => !decided.has(r.path) && r.employee && inDept(idOf(r.employee)))
        .filter((r) => r.start_date.slice(0, 10) <= range.to && r.end_date.slice(0, 10) >= range.from)
        .sort((a, b) => a.start_date.localeCompare(b.start_date)),
    [approvals.leaves, decided, inDept, range.from, range.to],
  );
  // Balances serve two readers - my own remaining days, and an approver's decision context - so they are read
  // once, and only when one of those readers is actually on screen.
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { enabled: !!me.employee_id || pendingForMe.length > 0 });
  const myBalance = useMemo(
    () => balances
      .filter((b) => b.employee && me.employee_id && idOf(b.employee) === me.employee_id && (b.balance_days ?? 0) !== 0)
      .map((b) => ({ label: typeName(b.leave_type), days: b.balance_days ?? 0, color: colorOf(b.leave_type) }))
      .sort((a, b) => b.days - a.days),
    [balances, me.employee_id, typeName, colorOf],
  );
  const empName = (ref?: string) => { const e = ref ? empById.get(idOf(ref)) : undefined; return e ? `${e.first_name} ${e.last_name}` : "Someone"; };

  // ---- Taking the window elsewhere: spreadsheet, calendar app, paper -------------------------------------
  const windowLabel = view === "quarter" ? `${monthLabelOf(cursor)} +2` : monthLabelOf(cursor);
  const exportRows = () =>
    entries.map((en) => [
      en.name,
      en.deptId ? deptName(en.deptId) : "",
      en.kind === "remote" ? "Remote work" : en.type,
      en.start,
      en.end,
      halfLabel(en) || "full",
      en.days || "",
      en.pending ? "Pending" : "Approved",
    ]);
  const doExport = (format: "csv" | "xlsx") =>
    void exportTable(`leave-${range.from}-to-${range.to}`, ["Person", "Department", "Type", "Start", "End", "Part", "Days", "Status"], exportRows(), format, "leave-requests");
  const doIcs = () =>
    downloadIcs(
      `leave-${range.from}-to-${range.to}`,
      buildIcs(
        entries.map((en) => ({
          uid: `${idOf(en.key)}@hrms`,
          start: en.start,
          end: en.end,
          summary: `${en.name} - ${en.type}${halfLabel(en) ? ` (${halfLabel(en)})` : ""}`,
          // The department and the state, NOT the reason. The exporter can already read the reasons on screen,
          // so this is not an access question - but an .ics is imported into Outlook or Google Calendar, which
          // would put a colleague's "hospital appointment" on a calendar the org does not control. The type and
          // the dates are what a calendar entry needs.
          description: [en.deptId ? deptName(en.deptId) : "", en.pending ? "Pending approval" : "Approved"].filter(Boolean).join(" · "),
          tentative: en.pending,
        })),
        `Leave · ${windowLabel}`,
      ),
    );

  const filtered = dept !== "all" || typeFilter !== "all" || !!query.trim();
  const usedTypes = useMemo(() => {
    const used = new Set(entries.filter((e) => e.kind === "leave").map((e) => (e.row.leave_type ? idOf(e.row.leave_type) : "")));
    return leaveTypes.filter((t) => used.has(idOf(t.path)));
  }, [entries, leaveTypes]);
  const loading = leavesState === "loading" && leaves.length === 0;
  const onLeaveToday = awayOn(today);

  const viewProps = { byDay, awayOn, holidayOn, closedOn, celebrationsOn, workDays, weekStart, total, today, selected, onSelect: selectDay };

  return (
    <TooltipProvider delayDuration={250}>
      <PageHeader
        title="Leave calendar"
        description="Who's away each day, how thin cover gets, and what still needs a decision."
        actions={
          <>
            <PageSettings me={me} host="leave-calendar" />
            {canRequest && (
              <Button size="sm" onClick={() => requestFor(selected ?? today, selected ?? today)}>
                <Plus className="h-4 w-4" /> Request leave
              </Button>
            )}
          </>
        }
      />

      {/* The printout has no toolbar to say what it is, so it says so itself. */}
      <p className="mb-3 hidden text-sm font-medium print:block">
        Leave · {windowLabel}
        {dept !== "all" ? ` · ${deptName(dept)}` : ""}
        {typeFilter !== "all" ? ` · ${typeName(`leave-types/${typeFilter}`)}` : ""}
      </p>

      {/* Every layer the grid draws, not just the leave one: a remote-work or event layer that stopped at its
          ceiling looks exactly like a quiet day. */}
      <TruncationNotice collection={["leave-requests", "remote-work-requests", "events"]} what="entries" className="mb-3" />

      {/* `grid-cols-1` is not redundant with a bare `grid`. With no explicit template the single implicit
          column is an `auto` track, which sizes toward MAX-content - so the calendar card grew to whatever its
          filter row wanted and took the page sideways with it (measured: 410px inside a 360px screen).
          Tailwind's `grid-cols-1` is `repeat(1, minmax(0, 1fr))`, and the `minmax(0, …)` is what caps the
          track at the container and lets the card shrink. The two-column layout still starts at `xl`. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent className="p-0 sm:p-0">
              {/* Toolbar: window, view, and the ways out of the page */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3" data-print-hide>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => goMonth(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
                  <Button variant="outline" size="sm" className="h-8" onClick={goToday}>Today</Button>
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => goMonth(1)} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
                  <span className="ml-1 flex items-center gap-2 text-base font-semibold"><CalendarRange className="h-4 w-4 text-primary" />{windowLabel}</span>
                  <AccessTarget target={{ collection: "leave-requests", label: "Leave calendar" }} className="h-6 w-6" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* flex-wrap: four labelled segments state ~323px on a 320px screen, and an `inline-flex`
                      group cannot give way - it pushed the page 3px wider than the viewport. Wrapping keeps
                      the segmented look and drops the last segment onto a second line instead. */}
                  <div className="inline-flex flex-wrap rounded-lg bg-muted p-0.5" role="group" aria-label="Calendar view">
                    {VIEWS.map(([v, label, Icon]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setView(v)}
                        aria-pressed={view === v}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                          view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" /> {label}
                      </button>
                    ))}
                  </div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Layers and density" title="What's drawn on the calendar"><Eye className="h-3.5 w-3.5" /></Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-60 space-y-2 p-3 text-sm">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Show</p>
                      <label className="flex items-center gap-2">
                        <Checkbox checked={showPending} onCheckedChange={(v) => setShowPending(v === true)} /> Pending requests
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox checked={showRemote} onCheckedChange={() => setLayers((s) => toggle(s, "remote"))} /> Remote work
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox checked={showCelebrations} onCheckedChange={() => setLayers((s) => toggle(s, "celebrations"))} /> Birthdays & anniversaries
                      </label>
                      {view === "team" && (
                        <label className="flex items-center gap-2 border-t pt-2">
                          <Checkbox checked={compact} onCheckedChange={(v) => setCompact(v === true)} /> Working days only
                        </label>
                      )}
                    </PopoverContent>
                  </Popover>
                  <ExportButton canExport={canExport} label={`Export ${entries.length} rows`} onExport={doExport} disabled={entries.length === 0} />
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={doIcs} disabled={entries.length === 0} aria-label="Download as calendar file" title="Download .ics for Google Calendar / Outlook"><CalendarDays className="h-3.5 w-3.5" /></Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => window.print()} aria-label="Print this calendar" title="Print"><Printer className="h-3.5 w-3.5" /></Button>
                  <button
                    type="button"
                    onClick={goToday}
                    title="Jump to today and show who's out"
                    className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Plane className="h-4 w-4 text-primary" /> {onLeaveToday} of {total}{totalApprox ? "+" : ""} on leave today
                  </button>
                </div>
              </div>

              {/* Filters: who is counted, and what is drawn */}
              <div className="flex flex-wrap items-center gap-2 border-b p-3" data-print-hide>
                <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find a person"
                    aria-label="Filter the calendar by person"
                    className="h-8 pl-8 pr-8"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery("")} aria-label="Clear the person filter" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {departments.length > 0 && (
                  <Select value={dept} onValueChange={setDept}>
                    <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All departments</SelectItem>
                      {departments.filter((d) => !d.delete_time).map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {leaveTypes.length > 0 && (
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All leave types</SelectItem>
                      {leaveTypes.filter((t) => !t.delete_time).map((t) => <SelectItem key={t.path} value={idOf(t.path)}>{t.display_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {filtered && (
                  <Badge variant="secondary" className="gap-1.5 py-1 pl-2 pr-1">
                    <Filter className="h-3.5 w-3.5" />
                    {entries.length} shown
                    <button
                      type="button"
                      aria-label="Clear all filters"
                      onClick={() => { setDept("all"); setTypeFilter("all"); setQuery(""); }}
                      className="rounded p-0.5 hover:bg-background/60"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </Badge>
                )}
                {myBalance.length > 0 && (
                  <span className="ml-auto flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Wallet className="h-3.5 w-3.5" />
                    {myBalance.slice(0, 3).map((b) => (
                      <span key={b.label} className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: b.color }} />
                        {b.label} <span className="font-medium text-foreground">{Math.round(b.days * 10) / 10}d</span>
                      </span>
                    ))}
                  </span>
                )}
              </div>

              {/* The view itself */}
              {loading ? (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : leavesState === "error" ? (
                // An unread month and a month with nobody away drew the same empty calendar - which is the
                // wrong answer to "is anyone off next week", and the one people plan around.
                <div className="p-3"><DataState state="error" error={null} onRetry={reloadLeaves}><div /></DataState></div>
              ) : view === "month" ? (
                <MonthGrid
                  {...viewProps}
                  cells={cells}
                  month={cursor.getUTCMonth()}
                  canRequest={canRequest}
                  onRange={requestFor}
                  onMonth={goMonth}
                  holidaySet={holidaySet}
                />
              ) : view === "team" ? (
                <TeamGrid
                  {...viewProps}
                  monthDays={monthDays}
                  entries={entries}
                  employees={dept === "all" ? total : scopedEmployees.length}
                  monthLabel={monthLabelOf(cursor)}
                  compact={compact}
                  deptName={deptName}
                />
              ) : view === "quarter" ? (
                <QuarterGrid {...viewProps} cursor={cursor} />
              ) : (
                <AgendaList {...viewProps} monthDays={monthDays} eventsOn={eventsOn} monthLabel={monthLabelOf(cursor)} />
              )}

              {/* Legend */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t p-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {/* The ORG's day number, like the ring it explains - `new Date().getDate()` is the viewer's. */}
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold tabular-nums text-primary-foreground">{Number(todayStr().slice(8, 10))}</span> Today
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded bg-violet-100 ring-1 ring-inset ring-violet-300 dark:bg-violet-950/40 dark:ring-violet-800" /> Holiday
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded bg-brand-neutral-100 ring-1 ring-inset ring-brand-neutral-300 dark:bg-brand-neutral-800/40 dark:ring-brand-neutral-600" /> Non-working day
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-6 rounded-full bg-warning" /> Cover strip: amber past 30% away, red past 50%
                </span>
                <span className="flex items-center gap-1.5"><span className="h-3 w-6 rounded-sm border-l-[3px] border-primary bg-primary/10" /> Half day = half-width bar</span>
                {distinctColors ? (
                  usedTypes.map((t) => (
                    <span key={t.path} className="flex items-center gap-1.5">
                      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: colorOf(t.path) }} /> {t.display_name}
                    </span>
                  ))
                ) : (
                  <span className="flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: ONE_LEAVE_COLOR }} /> On leave (one bar per request)
                  </span>
                )}
                {showRemote && <span className="flex items-center gap-1.5"><span className="h-3 w-6 rounded-sm border border-dotted border-muted-foreground/70" /> Remote work (still working)</span>}
                {showPending && <span className="flex items-center gap-1.5"><span className="h-3 w-6 rounded-sm border border-dashed border-muted-foreground/60" /> Pending approval</span>}
              </div>
            </CardContent>
          </Card>

          {/* Thin cover, named. Eyeballing 31 strips is not a staffing process. */}
          {alertRuns.length > 0 && (
            <Card className="p-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-warning" />
                Thin cover in {windowLabel}
                <Badge variant="warning">{alertDays.length} day{alertDays.length === 1 ? "" : "s"}</Badge>
              </p>
              <div className="flex flex-wrap gap-2">
                {alertRuns.map((r) => (
                  <button
                    key={r.from}
                    type="button"
                    onClick={() => selectDay(r.from)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent",
                      coverOf(r.peak, total) === "critical" ? "border-destructive/40 text-destructive" : "border-warning/40 text-warning",
                    )}
                  >
                    {r.from === r.to ? dmy(r.from) : `${dmy(r.from)} – ${dmy(r.to)}`} · up to {r.peak} of {total} away
                  </button>
                ))}
              </div>
            </Card>
          )}

          {/* Decisions, where the approver is already looking at the dates they affect. */}
          {pendingForMe.length > 0 && (
            <Card className="p-4" data-print-hide>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Inbox className="h-4 w-4 text-warning" />
                  Pending your decision in {windowLabel}
                  <Badge variant="warning">{pendingForMe.length}</Badge>
                </p>
                <Button size="sm" variant="ghost" onClick={() => navigate("approvals")}>
                  Open Approvals <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
              <div className="divide-y">
                {pendingForMe.slice(0, 5).map((r) => (
                  <ApprovalRow
                    key={r.path}
                    collection="leave-requests"
                    row={r}
                    employeeId={r.employee ? idOf(r.employee) : undefined}
                    selfEmployeeId={me.employee_id}
                    name={empName(r.employee)}
                    photo={r.employee ? empById.get(idOf(r.employee))?.photo : undefined}
                    summary={leaveSummary(r, typeName)}
                    context={leaveDecisionContext(r, balances, leaves)}
                    onApproved={(path) => { setDecided((d) => new Set(d).add(path)); approvals.reload(); reloadLeaves(); }}
                    onRejectClick={() => setRejecting({ collection: "leave-requests", row: r, name: empName(r.employee), summary: leaveSummary(r, typeName) })}
                  />
                ))}
              </div>
              {pendingForMe.length > 5 && (
                <p className="mt-2 text-xs text-muted-foreground">{pendingForMe.length - 5} more waiting in the Approvals inbox.</p>
              )}
            </Card>
          )}
        </div>

        {/* Day detail: a column beside the calendar where there's room, stacked underneath where there isn't. */}
        <div className="xl:sticky xl:top-4 xl:self-start">
          {selected ? (
            <DayPanel
              ymd={selected}
              holiday={holidayOn(selected)}
              closed={closedOn(selected)}
              entries={byDay.get(selected) ?? []}
              events={eventsOn(selected)}
              celebrations={celebrationsOn(selected)}
              away={awayOn(selected)}
              total={total}
              canRequest={canRequest}
              onRequest={() => requestFor(selected, selected)}
              onClose={() => setSelected(null)}
            />
          ) : (
            <Card className="hidden xl:block">
              <CardContent className="p-4 text-center text-sm text-muted-foreground sm:p-6">
                Pick a day to see who's away and how many are left.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* What a screen reader hears as the selection moves. */}
      <p className="sr-only" aria-live="polite">
        {selected ? `${longDate(selected)}: ${awayOn(selected)} of ${total} away${holidayOn(selected) ? `, ${holidayOn(selected)!.display_name}` : ""}` : "No day selected"}
      </p>

      {draft && (
        <RequestLeaveDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          me={me}
          initial={{ from: draft.from, to: draft.to, startSession: 1, endSession: 2 }}
          onSubmitted={() => { setDraft(null); reloadLeaves(); }}
        />
      )}
      <RejectDialog
        target={rejecting}
        onClose={() => setRejecting(null)}
        onRejected={(path) => { setDecided((d) => new Set(d).add(path)); approvals.reload(); reloadLeaves(); }}
      />
    </TooltipProvider>
  );
}

const toggle = (s: Set<string>, key: string) => {
  const next = new Set(s);
  if (!next.delete(key)) next.add(key);
  return next;
};
