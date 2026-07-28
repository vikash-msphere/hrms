import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Clock, LogIn, LogOut, CircleDot, Pencil, ChevronLeft, ChevronRight, AlertTriangle, Plus, Trash2 } from "lucide-react";
import { get, create, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, idOf, formatDate } from "@/lib/utils";
import { DEFAULT_SCHEDULE, summarizeByDay, buildAttendanceRows, fmtHM, fmtDuration, localDay, zonedInstant, type AttendanceSchedule, type DayStatus, type AttendanceRow } from "@/lib/attendance";
import type { AttendanceSession, AttendanceRegularization, Employee, Holiday, LeaveRequest, LeaveType, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldRow } from "@/components/common/Field";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

// Wall-clock "HH:MM" (24h) of an instant in the org timezone, for prefilling the correction modal's time inputs.
const hhmm = (iso: string, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
// "Thu, Jun 12" for the history table's day column (the range caption above carries the year).
const fmtDay = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

export default function Attendance({ me }: { me: Me }) {
  const { toast } = useToast();
  const DAY = 86400000;
  const [sched, setSched] = useState<AttendanceSchedule>(DEFAULT_SCHEDULE);
  const [pageSessions, setPageSessions] = useState<AttendanceSession[]>([]); // sessions for the 30-day history window
  const [recentSessions, setRecentSessions] = useState<AttendanceSession[]>([]); // last couple of days, for "today"
  const [openSessions, setOpenSessions] = useState<AttendanceSession[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // history days whose punch detail is unfolded
  const [page, setPage] = useState(0); // 0 = most recent 30 days; each higher page steps 30 days further back
  const [pageLoading, setPageLoading] = useState(true); // history window fetch in flight (skeleton, not "no data")
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false); // a clock in/out call in flight
  const [correctionBusy, setCorrectionBusy] = useState(false); // a correction-ticket submit in flight
  const [correcting, setCorrecting] = useState<AttendanceRow | null>(null); // the day a correction modal is open for
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: holidays } = useCollection<Holiday>("holidays");
  const { rows: leaves } = useCollection<LeaveRequest>("leave-requests");
  const { rows: leaveTypes } = useCollection<LeaveType>("leave-types");
  const { rows: regularizations, reload: reloadRegs } = useCollection<AttendanceRegularization>("attendance-regularizations");

  const mine = (ref?: string) => !!ref && idOf(ref) === me.employee_id;
  // My correction requests (attendance-regularizations), newest first, so pending + decided are visible in one place.
  const myRegs = useMemo(
    () => regularizations.filter((r) => mine(r.employee)).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || (b.create_time ?? "").localeCompare(a.create_time ?? "")),
    [regularizations, me.employee_id],
  );
  async function cancelReg(r: AttendanceRegularization) {
    try {
      await invoke(`attendance-regularizations/${idOf(r.path)}`, "cancel", r.etag);
      toast({ title: "Request cancelled", variant: "success" });
      reloadRegs();
    } catch (e) {
      toast({ title: "Couldn't cancel", description: (e as Error).message, variant: "destructive" });
    }
  }
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "Employee");
  }, [employees]);

  const canApprove = me.capabilities.includes("attendance-regularizations.approve");
  const tz = sched.timezone;
  // "Today" in the org timezone, not UTC: punches are grouped by org-local day, so the history window,
  // today's totals and the Today marker must use the same calendar or early-morning punches vanish.
  const orgToday = localDay(new Date(now).toISOString(), tz);
  // The caller's join date: days before it aren't their attendance, so they're never flagged absent.
  const joinedYmd = useMemo(() => employees.find((e) => idOf(e.path) === me.employee_id)?.start_date, [employees, me.employee_id]);

  // The 30-day window for the current page (YYYY-MM-DD). Page 0 ends today; each older page steps back 30 days.
  const { fromYmd, toYmd } = useMemo(() => {
    const todayMs = Date.parse(orgToday + "T00:00:00Z");
    const toMs = todayMs - page * 30 * DAY;
    const fromMs = toMs - 29 * DAY;
    return { fromYmd: new Date(fromMs).toISOString().slice(0, 10), toYmd: new Date(toMs).toISOString().slice(0, 10) };
  }, [page, orgToday]);

  const toggleDay = useCallback((day: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(day) ? next.delete(day) : next.add(day);
      return next;
    });
  }, []);

  // Shared inputs for building per-day rows (holidays + my approved leave).
  const holidayByDay = useMemo(() => {
    const m = new Map<string, Holiday>();
    for (const h of holidays) if (!h.disabled) m.set(h.date, h);
    return m;
  }, [holidays]);
  const holidaySet = useMemo(() => new Set(holidayByDay.keys()), [holidayByDay]);
  const myApprovedLeaves = useMemo(
    () => leaves.filter((l) => mine(l.employee) && l.state?.toUpperCase() === "APPROVED"),
    [leaves, me.employee_id],
  );
  const leaveRanges = useMemo(() => myApprovedLeaves.map((l) => ({ start: l.start_date, end: l.end_date })), [myApprovedLeaves]);
  // The approved leave covering a given day (for the expanded "why no punches" detail).
  const leaveForDay = useCallback((day: string) => myApprovedLeaves.find((l) => l.start_date <= day && day <= l.end_date), [myApprovedLeaves]);
  const leaveTypeName = useMemo(() => {
    const m = new Map(leaveTypes.map((t) => [idOf(t.path), t]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [leaveTypes]);

  // Today's row (always today, independent of which history page the table shows) - built from a small recent
  // fetch so the My-clock punch log and the cumulative total stay put while you page through history.
  const todayRow = useMemo(() => {
    const summaries = summarizeByDay(recentSessions.filter((s) => mine(s.employee)), sched);
    return buildAttendanceRows({ fromYmd: orgToday, toYmd: orgToday, todayYmd: orgToday, sched, summaries, holidays: holidaySet, leaveRanges, joinedYmd })[0];
  }, [recentSessions, sched, holidaySet, leaveRanges, joinedYmd, me.employee_id, orgToday]);

  // The history table (last 30 days): punches + holidays + my approved leave, with absent-day detection.
  const rows = useMemo(() => {
    const summaries = summarizeByDay(pageSessions.filter((s) => mine(s.employee)), sched);
    return buildAttendanceRows({ fromYmd, toYmd, todayYmd: orgToday, sched, summaries, holidays: holidaySet, leaveRanges, joinedYmd });
  }, [pageSessions, sched, holidaySet, leaveRanges, fromYmd, toYmd, joinedYmd, me.employee_id, orgToday]);

  // At-a-glance health of the visible 30-day window, for the SummaryStrip above the history table.
  const windowStats = useMemo(() => {
    let worked = 0, late = 0, absent = 0, minutes = 0;
    for (const r of rows) {
      if (r.summary) { worked++; minutes += r.summary.workedMinutes; }
      if (r.status === "late" || r.status === "late_early") late++;
      else if (r.status === "absent") absent++;
    }
    return { worked, late, absent, minutes };
  }, [rows]);
  // Absent days in the visible window, surfaced above the table so a missed punch is one click from a fix.
  const absentRows = useMemo(() => rows.filter((r) => r.status === "absent"), [rows]);

  const myOpen = openSessions.find((s) => mine(s.employee));
  const openMin = myOpen ? Math.max(0, Math.round((now - +new Date(myOpen.clock_in)) / 60000)) : 0;
  // workedMinutes counts only closed sessions, so add the current open session's elapsed minutes for a live total.
  const todayWorked = (todayRow?.summary?.workedMinutes ?? 0) + openMin;

  // Static data: the open session, the last couple of days (for "today"), and the schedule.
  async function loadStatic() {
    try {
      const since = new Date(Date.now() - 2 * DAY).toISOString();
      const [o, r] = await Promise.all([
        get<{ results: AttendanceSession[] }>("attendance?open=true"),
        get<{ results: AttendanceSession[] }>(`attendance?from=${encodeURIComponent(since)}&max_page_size=200`),
      ]);
      setOpenSessions(o.results ?? []);
      setRecentSessions(r.results ?? []);
    } catch (e) {
      toast({ title: "Couldn't load attendance", description: (e as Error).message, variant: "destructive" });
    }
    try {
      const cfg = await get<{ value?: Partial<AttendanceSchedule> }>("settings/attendance");
      if (cfg.value) setSched({ ...DEFAULT_SCHEDULE, ...cfg.value });
    } catch {
      /* not configured -> defaults */
    }
  }
  // The history table's 30-day window (re-fetched when the page changes).
  const loadPage = useCallback(async () => {
    const from = `${fromYmd}T00:00:00.000Z`, to = `${toYmd}T23:59:59.999Z`;
    try {
      const r = await get<{ results: AttendanceSession[] }>(`attendance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max_page_size=500`);
      setPageSessions(r.results ?? []);
    } catch (e) {
      setPageSessions([]);
      toast({ title: "Couldn't load attendance history", description: (e as Error).message, variant: "destructive" });
    }
  }, [fromYmd, toYmd]);

  useEffect(() => { void loadStatic(); }, []);
  // Skeleton only when the window changes; the silent refresh after a clock action goes through loadPage directly.
  useEffect(() => {
    setPageLoading(true);
    void loadPage().finally(() => setPageLoading(false));
  }, [loadPage]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function clock(verb: "clockIn" | "clockOut") {
    setBusy(true);
    try {
      await invoke("attendance/me", verb);
      toast({ title: verb === "clockIn" ? "Clocked in" : "Clocked out", variant: "success" });
      await Promise.all([loadStatic(), loadPage()]);
    } catch (e) {
      toast({ title: verb === "clockIn" ? "Couldn't clock in" : "Couldn't clock out", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // A correction request is an attendance-regularization carrying the day's full intended in/out set. On
  // approval (manager/HR, via Approvals) the day's punches are superseded and these are written as the day's
  // sessions - no ticket, no manual data fixing. `pairs` are wall-clock "HH:MM"; [] means "remove all punches".
  async function submitCorrection(row: AttendanceRow, pairs: { in: string; out: string }[], reason: string) {
    setCorrectionBusy(true);
    try {
      const sessions = pairs.map((p) => ({ clock_in: zonedInstant(row.day, p.in, tz), clock_out: zonedInstant(row.day, p.out, tz) }));
      await create("attendance-regularizations", { date: row.day, sessions, reason: reason || undefined });
      toast({ title: "Correction requested", description: "Your manager or HR will review it - track it below and under Approvals.", variant: "success" });
      setCorrecting(null);
      reloadRegs();
    } catch (e) {
      toast({ title: "Couldn't request the correction", description: (e as Error).message, variant: "destructive" });
    } finally {
      setCorrectionBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Attendance" description={`Shift ${sched.shift_start}–${sched.shift_end} · ${sched.timezone}`} actions={<PageSettings me={me} host="attendance" />} />

      <div className="space-y-6">
        {/* Clock card: live status + clock button (records a session log), side by side */}
        <Card className={cn("overflow-hidden border-l-4 transition-colors", myOpen ? "border-l-success" : "border-l-muted-foreground/20")}>
          <CardContent className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between">
            {/* Live status */}
            <div className="flex items-center gap-4">
              <div className={cn("flex h-14 w-14 shrink-0 items-center justify-center rounded-full", myOpen ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
                {myOpen ? <CircleDot className="h-6 w-6 animate-pulse" /> : <Clock className="h-6 w-6" />}
              </div>
              <div className="min-w-0">
                <p className={cn("text-xs font-semibold uppercase tracking-wide", myOpen ? "text-success" : "text-muted-foreground")}>
                  {myOpen ? "Clocked in" : "Not clocked in"}
                </p>
                <p className="text-3xl font-bold leading-tight tabular-nums">{fmtDuration(myOpen ? openMin : todayWorked)}</p>
                <p className="text-xs text-muted-foreground">
                  {myOpen ? <>since {fmtHM(myOpen.clock_in, tz)} · {fmtDuration(todayWorked)} today</> : "worked today"}
                </p>
              </div>
            </div>

            {/* Action */}
            <div className="flex flex-col gap-1.5 sm:items-end">
              {myOpen ? (
                <AccessAction collection="attendance" verb="clockOut" label="Clock out">
                  <Button className="h-11 w-full px-6 text-base sm:w-auto" variant="destructive" loading={busy} onClick={() => clock("clockOut")}><LogOut className="h-4 w-4" /> Clock out</Button>
                </AccessAction>
              ) : (
                <AccessAction collection="attendance" verb="clockIn" label="Clock in">
                  <Button className="h-11 w-full px-6 text-base sm:w-auto" loading={busy} onClick={() => clock("clockIn")}><LogIn className="h-4 w-4" /> Clock in</Button>
                </AccessAction>
              )}
              <p className="text-xs text-muted-foreground sm:text-right">Clock out and back in to record a break.</p>
            </div>
          </CardContent>
        </Card>

        {/* The visible window at a glance: worked/late/absent days + total hours (live while clocked in on page 0) */}
        {!pageLoading && rows.length > 0 && (
          <SummaryStrip
            className="mb-0"
            items={[
              { label: "Days worked", value: windowStats.worked },
              { label: "Hours worked", value: fmtDuration(windowStats.minutes + (page === 0 ? openMin : 0)) },
              { label: "Late arrivals", value: windowStats.late, tone: windowStats.late > 0 ? "warning" : "muted" },
              { label: "Absent", value: windowStats.absent, tone: windowStats.absent > 0 ? "destructive" : "muted" },
            ]}
          />
        )}

        {/* Misses that need regularizing, pulled out of the table so they're impossible to overlook. */}
        {!pageLoading && absentRows.length > 0 && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <div className="min-w-0 space-y-2">
                <p className="text-sm font-medium">
                  {absentRows.length === 1 ? "1 working day in this period has" : `${absentRows.length} working days in this period have`} no punches
                </p>
                <p className="text-xs text-muted-foreground">
                  If you worked or forgot to clock, request a correction - your manager or HR approves it and the day is fixed.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {absentRows.map((r) => (
                    <button
                      key={r.day}
                      type="button"
                      onClick={() => setCorrecting(r)}
                      className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium hover:border-foreground/30 hover:bg-muted"
                      title={`Request a correction for ${formatDate(r.day)}`}
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" aria-hidden /> {fmtDay(r.day)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* My recent days: today's cumulative + paginated 30-day table (each day folds open to its punches) */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{page === 0 ? "My attendance · last 30 days" : "My attendance"}</CardTitle>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => p + 1)} aria-label="Older 30 days"><ChevronLeft className="h-4 w-4" /></Button>
              <span className="min-w-[12.5rem] text-center text-xs tabular-nums text-muted-foreground">{formatDate(fromYmd)} – {formatDate(toYmd)}</span>
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Newer 30 days"><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </CardHeader>
          <CardContent>
            {pageLoading ? (
              <div className="space-y-2 py-1">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{page === 0 ? "No attendance yet. Clock in above to record your first day." : "No attendance in this period."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left text-muted-foreground"><th className="w-7 py-2" /><th className="py-2 pr-3 font-medium">Day</th><th className="py-2 pr-3 font-medium">In</th><th className="py-2 pr-3 font-medium">Out</th><th className="py-2 pr-3 text-right font-medium">Worked</th><th className="py-2 font-medium">Status</th><th className="w-9 py-2" /></tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const d = r.summary;
                      const punches = d?.sessions ?? [];
                      const isOpen = expanded.has(r.day);
                      return (
                        <Fragment key={r.day}>
                          <tr
                            className={cn("group cursor-pointer border-b last:border-0", isOpen && "bg-muted/30")}
                            onClick={() => toggleDay(r.day)}
                          >
                            <td className="py-1.5 align-middle">
                              <button type="button" onClick={(e) => { e.stopPropagation(); toggleDay(r.day); }} className="text-muted-foreground hover:text-foreground" aria-label={isOpen ? `Collapse ${r.day}` : `Expand ${r.day}`} aria-expanded={isOpen}>
                                <ChevronRight className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")} />
                              </button>
                            </td>
                            <td className="py-1.5 pr-3 font-medium">
                              {fmtDay(r.day)}
                              {r.day === orgToday && <span className="ml-1.5 text-xs font-normal text-primary">Today</span>}
                            </td>
                            <td className="py-1.5 pr-3 tabular-nums">{d?.arrival ? fmtHM(d.arrival, tz) : "-"}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{d?.departure ? fmtHM(d.departure, tz) : d?.open ? "open" : "-"}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{d ? fmtDuration(d.workedMinutes) : "-"}</td>
                            <td className="py-1.5">
                              <StatusPill status={r.status} lateBy={d?.lateByMin} earlyBy={d?.earlyByMin} />
                            </td>
                            <td className="py-1.5 text-right">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setCorrecting(r); }}
                                className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                                title={`Request a correction for ${formatDate(r.day)}`}
                                aria-label={`Request a correction for ${formatDate(r.day)}`}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="border-b last:border-0 bg-muted/30">
                              <td />
                              <td colSpan={6} className="pb-3 pr-3">
                                <DayDetail
                                  row={r}
                                  punches={punches}
                                  now={now}
                                  tz={tz}
                                  leave={r.status === "on_leave" ? leaveForDay(r.day) : undefined}
                                  leaveType={r.status === "on_leave" ? leaveTypeName(leaveForDay(r.day)?.leave_type) : undefined}
                                  holiday={r.status === "holiday" ? holidayByDay.get(r.day) : undefined}
                                  onCorrect={() => setCorrecting(r)}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* My correction requests: the audit trail of what I've asked to fix + where each stands. */}
        {myRegs.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">My correction requests</CardTitle></CardHeader>
            <CardContent className="divide-y">
              {myRegs.map((r) => {
                const times = r.sessions.length === 0 ? "Remove all punches" : r.sessions.map((s) => `${fmtHM(s.clock_in, tz)}–${fmtHM(s.clock_out, tz)}`).join(", ");
                return (
                  <div key={r.path} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{formatDate(r.date)}</p>
                      <p className="truncate text-xs text-muted-foreground">{times}{r.reason ? ` · ${r.reason}` : ""}</p>
                    </div>
                    <RegStatePill state={r.state} />
                    {r.state?.toUpperCase() === "PENDING" && (r.access?.can ?? []).includes("cancel") && (
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={() => cancelReg(r)}>Cancel</Button>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Manager/HR: who's clocked in now */}
      {canApprove && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleDot className="h-4 w-4 text-success" /> Clocked in now
              {openSessions.length > 0 && <span className="text-sm font-normal text-muted-foreground">{openSessions.length} {openSessions.length === 1 ? "person" : "people"}</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {openSessions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nobody is clocked in.</p>
            ) : (
              <div className="divide-y">
                {[...openSessions]
                  .sort((a, b) => +new Date(a.clock_in) - +new Date(b.clock_in))
                  .map((s) => (
                    <div key={s.path} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <span className="truncate text-sm font-medium">{empName(s.employee)}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        since {fmtHM(s.clock_in, tz)} · {fmtDuration(Math.max(0, Math.round((now - +new Date(s.clock_in)) / 60000)))}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {correcting && (
        <CorrectionDialog
          key={correcting.day}
          row={correcting}
          tz={tz}
          busy={correctionBusy}
          onClose={() => setCorrecting(null)}
          onSubmit={(pairs, reason) => submitCorrection(correcting, pairs, reason)}
        />
      )}
    </div>
  );
}

function StatusPill({ status, lateBy, earlyBy }: { status: DayStatus; lateBy?: number; earlyBy?: number }) {
  switch (status) {
    case "open": return <Badge variant="success">Clocked in</Badge>;
    case "present": return <Badge variant="secondary">On time</Badge>;
    case "late": return <Badge variant="warning">Late {lateBy}m</Badge>;
    case "left_early": return <Badge variant="warning">Left early {earlyBy}m</Badge>;
    case "late_early": return <Badge variant="warning">Late {lateBy}m · early {earlyBy}m</Badge>;
    case "half_day": return <Badge variant="warning">Half day</Badge>;
    case "insufficient": return <Badge variant="destructive">Under hours</Badge>;
    case "on_leave": return <Badge variant="secondary">On leave</Badge>;
    case "on_event": return <Badge variant="secondary">On event</Badge>;
    case "holiday": return <Badge variant="muted">Holiday</Badge>;
    case "absent": return <Badge variant="destructive">Absent</Badge>;
  }
}

// State of one of my correction requests (attendance-regularization).
function RegStatePill({ state }: { state?: string }) {
  switch (state?.toUpperCase()) {
    case "APPROVED": return <Badge variant="success">Approved</Badge>;
    case "REJECTED": return <Badge variant="destructive">Rejected</Badge>;
    case "CANCELLED": return <Badge variant="muted">Cancelled</Badge>;
    default: return <Badge variant="warning">Pending</Badge>;
  }
}

// The unfolded detail for a day: its punch log when there are clock-ins, otherwise why there are none
// (the leave taken + its reason, the holiday's name, or a plain absent note).
function DayDetail({ row, punches, now, tz, leave, leaveType, holiday, onCorrect }: {
  row: AttendanceRow;
  punches: AttendanceSession[];
  now: number;
  tz: string;
  leave?: LeaveRequest;
  leaveType?: LeaveType;
  holiday?: Holiday;
  onCorrect?: () => void;
}) {
  if (punches.length > 0) {
    return (
      <div className="space-y-1.5">
        <div className="w-fit rounded-lg border bg-background px-4 py-1 text-sm tabular-nums">
          <div className="flex items-center gap-8 border-b py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="flex w-24 items-center gap-2"><span className="h-1.5 w-1.5 shrink-0" aria-hidden />In</span>
            <span className="flex w-24 items-center gap-2"><span className="h-1.5 w-1.5 shrink-0" aria-hidden />Out</span>
            <span className="w-16 text-right">Duration</span>
          </div>
          {punches.map((s, i) => {
            const mins = Math.max(0, Math.round(((s.clock_out ? +new Date(s.clock_out) : now) - +new Date(s.clock_in)) / 60000));
            return (
              <div key={i} className={cn("flex items-center gap-8 py-1.5", i > 0 && "border-t")}>
                <span className="flex w-24 items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                  {fmtHM(s.clock_in, tz)}
                </span>
                <span className="flex w-24 items-center gap-2">
                  {s.clock_out ? (
                    <>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                      {fmtHM(s.clock_out, tz)}
                    </>
                  ) : (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-success"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />Open</span>
                  )}
                </span>
                <span className={cn("w-16 text-right font-medium", s.clock_out ? "text-foreground" : "text-success")}>{fmtDuration(mins)}</span>
                {s.source === "correction" && <Badge variant="muted">Corrected</Badge>}
              </div>
            );
          })}
        </div>
        {onCorrect && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={onCorrect}>
            <Pencil className="h-3 w-3" /> Wrong times? Request a correction
          </Button>
        )}
      </div>
    );
  }

  if (row.status === "on_leave" && leave) {
    // For a multi-day leave that starts/ends on a half-day, only the boundary day is partial.
    const half =
      row.day === leave.start_date && leave.start_session === 2 ? "Second half (PM)"
      : row.day === leave.end_date && leave.end_session === 1 ? "First half (AM)"
      : leave.days % 1 !== 0 ? "Half day"
      : undefined;
    return (
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {leaveType?.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: leaveType.color }} aria-hidden />}
          <span className="font-medium">{leaveType?.display_name ?? "Leave"}</span>
          {leaveType && <Badge variant={leaveType.paid ? "secondary" : "muted"}>{leaveType.paid ? "Paid" : "Unpaid"}</Badge>}
          {half && <Badge variant="warning">{half}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {leave.start_date === leave.end_date ? leave.start_date : `${leave.start_date} – ${leave.end_date}`} · {leave.days} day{leave.days === 1 ? "" : "s"}
        </p>
        {leave.reason ? (
          <p className="text-muted-foreground"><span className="font-medium text-foreground">Reason:</span> {leave.reason}</p>
        ) : (
          <p className="text-xs italic text-muted-foreground">No reason provided.</p>
        )}
      </div>
    );
  }

  if (row.status === "holiday") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{holiday?.display_name ?? "Holiday"}</span>
        {holiday?.kind === "optional" && <Badge variant="muted">Optional</Badge>}
      </div>
    );
  }

  if (row.status === "absent") {
    // The one place a correction is most likely wanted, so the affordance is a visible button (not a hover pencil).
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>No punches recorded, and no approved leave or holiday on record for this day.</span>
        {onCorrect && (
          <Button variant="outline" size="sm" onClick={onCorrect}><Pencil className="h-3 w-3" /> Request correction</Button>
        )}
      </div>
    );
  }

  return <p className="text-sm text-muted-foreground">No punch detail for this day.</p>;
}

type PunchRow = { in: string; out: string };

// Correction request modal: seeded with the day's existing sessions (one row per punch), each editable, with
// add/remove. Submitting files an attendance-regularization carrying the FULL intended day; on approval the
// day's punches are superseded and these become the day's sessions. Removing every row clears the day.
function CorrectionDialog({ row, tz, busy, onClose, onSubmit }: {
  row: AttendanceRow;
  tz: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (pairs: PunchRow[], reason: string) => void;
}) {
  const seeded = (row.summary?.sessions ?? []).map((s) => ({ in: hhmm(s.clock_in, tz), out: s.clock_out ? hhmm(s.clock_out, tz) : "" }));
  const [punches, setPunches] = useState<PunchRow[]>(seeded.length ? seeded : [{ in: "", out: "" }]);
  const [reason, setReason] = useState("");

  const setRow = (i: number, patch: Partial<PunchRow>) => setPunches((p) => p.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setPunches((p) => [...p, { in: "", out: "" }]);
  const removeRow = (i: number) => setPunches((p) => p.filter((_, j) => j !== i));

  // Per-row error: a row must have both times, in order ("HH:MM" compares lexically). Fully-blank rows are dropped.
  const rowError = (r: PunchRow): string | undefined => {
    if (!r.in && !r.out) return undefined;
    if (!r.in || !r.out) return "Both times are required";
    if (r.out <= r.in) return "Clock-out must be after clock-in";
    return undefined;
  };
  const kept = punches.filter((r) => r.in || r.out); // rows the user actually filled
  const hasError = kept.some((r) => rowError(r));
  const canSubmit = !hasError; // an empty kept-set is valid: it clears the day
  const submit = () => canSubmit && onSubmit(kept, reason.trim());

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={submit}>
        <DialogHeader><DialogTitle>Correct attendance — {formatDate(row.day)}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Set the day's actual clock in/out times. Your manager or HR approves it, and the day is fixed. Remove every row to clear the day's punches.</p>
        <div className="space-y-2">
          {punches.map((r, i) => {
            const err = rowError(r);
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-end gap-4">
                  <Field label={i === 0 ? "Clock in" : ""} className="flex-1"><Input type="time" autoFocus={i === 0} value={r.in} onChange={(e) => setRow(i, { in: e.target.value })} /></Field>
                  <Field label={i === 0 ? "Clock out" : ""} className="flex-1"><Input type="time" aria-invalid={!!err} className={cn(err && "border-destructive focus-visible:ring-destructive")} value={r.out} onChange={(e) => setRow(i, { out: e.target.value })} /></Field>
                  <Button type="button" variant="ghost" size="icon" className="mb-0.5 h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removeRow(i)} aria-label="Remove this in/out"><Trash2 className="h-4 w-4" /></Button>
                </div>
                {err && <p className="text-xs font-medium text-destructive">{err}</p>}
              </div>
            );
          })}
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={addRow}><Plus className="h-3.5 w-3.5" /> Add another in/out</Button>
        </div>
        <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. forgot to clock in after lunch" /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!canSubmit} onClick={submit}>Submit request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
