import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlarmClock, Check, ChevronLeft, ChevronRight, Clock, LogIn, LogOut } from "lucide-react";
import type { AttendanceSession, Employee, Holiday, LateEarlyRequest, LeaveRequest } from "@/types";
import { cn, idOf } from "@/lib/utils";
import { isCurrentEmployee } from "@/lib/employees";
import { useCollection } from "@/hooks/useCollection";
import { useScheduleView } from "@/hooks/useScheduleView";
import { excusalsByEmployee, usePunctualityPolicy } from "@/lib/lateEarly";
import { listAllSessionsPaged } from "@/lib/clock";
import { addDaysYmd, todayStr } from "@/lib/orgDay";
import { localDay, localMinutes, orgDaysWindow, weekdayOf, type AttendanceSchedule } from "@/lib/attendance";
import { fmtMinutes, judgeDay, leaveHalves, punchDays } from "../../../../src/domain/punctuality";
import { clockOf, graceOn, minOfDay, shiftSpanMinutes } from "../../../../src/domain/workSchedule";
import { navigate } from "@/router";
import { attendanceRoute } from "@/lib/resourceRoute";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { FilterChips } from "@/components/common/FilterChips";
import { AccessTarget } from "@/components/access/AccessTarget";

// Arrivals & departures (Dashboard widget). One org day, drawn as two strips:
//  - IN: every arrival, placed by how far it landed from the person's OWN shift start, so a 7:00 shift and a
//    10:00 shift share one axis and "late" always sits to the right of the same line.
//  - OUT: every departure, placed against the person's own shift end, mirrored, so leaving early sits left.
// Everybody who punched is a tick on the strip (the shape of the morning at a glance); the people the rule
// actually flags rise above it as avatars, ringed by how it judged them. The list underneath says it in words.
//
// THE JUDGEMENT IS THE PAYROLL BUILD'S, not a re-derivation: `punchDays` + `judgeDay` against the day the person
// was rostered for (`schedView.of(id)(day)`), skipping off days, holidays and full-day leave - the exact walk
// `punctualityOverPeriod` makes. A dot here that says "late" is a mark payroll counts (or excuses) too.

// The strips' windows, in minutes from the shift edge. Wide enough for an ordinary morning; anything past an
// edge pins to it (the tooltip still carries the real figure).
const IN_DOMAIN: [number, number] = [-30, 120];
const OUT_DOMAIN: [number, number] = [-120, 30];
const AVATAR = 28; // px - the flagged markers
const LEVEL = 22; // px - vertical step between stacked avatars (they overlap a little, like an avatar group)
const MAX_LEVELS = 4; // a fifth row would make the strip taller than the story; extras overlap the top row
const RUG = 12; // px - the tick strip everybody lands on
const LIST_CAP = 6;
// Zone tints. Dark mode lifts the late/severe ones a step: at the light theme's strength amber and red are a
// barely-there brown on the dark strip. Grace stays the muted surface in both.
const ZONE = {
  grace: "bg-muted",
  late: "bg-warning/10 dark:bg-warning/[0.18]",
  severe: "bg-destructive/10 dark:bg-destructive/[0.22]",
};
// A not-yet-punched person's avatar. Less faded on dark: at the light theme's 60% a desaturated avatar on a
// dark ground is all but gone, so it keeps more of itself there.
const GHOST = "opacity-60 grayscale dark:opacity-80";
const TIP_CLASS ="rounded-lg border bg-popover px-2.5 py-2 text-popover-foreground shadow-lg";

type Verdict = "late" | "severe" | "excused" | "pending";
type Person = { id: string; name: string; photo?: string };
type Mark = {
  person: Person;
  // Minutes from the shift edge (arrival: + is late; departure: - is early).
  arrOff: number;
  depOff: number | null;
  arrMin: number;
  depMin: number | null;
  open: boolean;
  startMin: number;
  endMin: number;
  inVerdict?: Verdict;
  outVerdict?: Verdict;
  lateBy: number;
  earlyBy: number;
  approvedIn?: string;
  approvedOut?: string;
};

// A request for the day that the punches have not caught up with: an arrival somebody asked to make late and
// has not made yet, a departure they asked to make early and have not made yet (or a future day's plan). Drawn
// as a ghost of their avatar at the time they gave. Once the punch exists it tells the story itself - judged,
// excused or not - and the ghost goes.
type Plan = { person: Person; kind: "late" | "early"; off: number; atMin: number; pending: boolean; startMin: number; endMin: number };
type Pin = { kind: "mark"; key: string; off: number; m: Mark; verdict: Verdict } | { kind: "plan"; key: string; off: number; p: Plan };

const RING: Record<Verdict, string> = {
  late: "ring-warning",
  severe: "ring-destructive",
  excused: "ring-success",
  // Dashed, not solid: flagged, but they asked - the request is waiting on someone.
  pending: "ring-0 outline outline-2 outline-dashed outline-offset-1 outline-warning",
};
const VERDICT_TEXT: Record<Verdict, string> = {
  late: "text-warning",
  severe: "text-destructive",
  excused: "text-success",
  pending: "text-warning",
};

type Filter = "all" | "late" | "early" | "excused" | "planned";
// How far ahead the stepper goes: far enough to see next week's planned late starts, no further.
const AHEAD_DAYS = 14;

// The org's previous / next working day by its own week and holidays - the stepper skips weekends so "back"
// from Monday lands on Friday rather than on a blank Sunday.
function stepWorkingDay(from: string, dir: -1 | 1, workDays: number[], holidays: Set<string>): string {
  let d = from;
  for (let i = 0; i < 14; i++) {
    d = addDaysYmd(d, dir);
    if (workDays.includes(weekdayOf(d)) && !holidays.has(d)) return d;
  }
  return addDaysYmd(from, dir);
}

// Width of an element, live - the avatar stacking needs pixels, not percentages, to know who overlaps whom.
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Beeswarm, one dimension: each avatar takes the lowest level whose previous occupant it clears by most of an
// avatar's width. Input sorted by x.
function stack<T>(items: { x: number; item: T }[], widthPx: number): { x: number; level: number; item: T }[] {
  const lastAt: number[] = [];
  const gap = AVATAR * 0.7;
  return items.map(({ x, item }) => {
    const px = (x / 100) * widthPx;
    let level = lastAt.findIndex((p) => px - p >= gap);
    if (level === -1) level = lastAt.length < MAX_LEVELS ? lastAt.length : MAX_LEVELS - 1;
    lastAt[level] = px;
    return { x, level, item };
  });
}

export function PunctualityPulse({ employees, holidays, schedule, selfId, refreshKey = 0 }: {
  employees: Employee[];
  selfId: string | null; // the caller's employee id: their own row opens the Attendance page, not a profile tab
  holidays: Holiday[];
  schedule: AttendanceSchedule;
  refreshKey?: number; // bumped by the dashboard clock, so the caller's own punch shows up straight away
}) {
  const tz = schedule.timezone;
  const today = todayStr();
  const [day, setDay] = useState(today);
  const [filter, setFilter] = useState<Filter>("all");
  const [showAll, setShowAll] = useState(false);
  const workDays = useMemo(() => (schedule.work_days?.length ? schedule.work_days : [1, 2, 3, 4, 5]), [schedule.work_days]);
  // `applies === false` is another office's regional holiday - an ordinary day here.
  const holSet = useMemo(() => new Set(holidays.filter((h) => !h.disabled && h.applies !== false).map((h) => h.date.slice(0, 10))), [holidays]);
  const holidayToday = holidays.find((h) => h.date.slice(0, 10) === day && !h.disabled && h.applies !== false);

  // The day's punches, cursor followed (a bare page would stop at 50 sessions - a few dozen people). Scoped
  // server-side to whoever the caller may see.
  const [sessions, setSessions] = useState<AttendanceSession[] | null>(null);
  useEffect(() => {
    // A day that has not happened has no punches to read - only the requests below.
    if (day > today) { setSessions([]); return; }
    let live = true;
    setSessions(null);
    listAllSessionsPaged(`attendance?${orgDaysWindow(day, day, tz)}`)
      .then((r) => { if (live) setSessions(r.sessions); })
      .catch(() => { if (live) setSessions([]); });
    return () => { live = false; };
  }, [day, today, tz, refreshKey]);

  // Every late/early request touching the day: approved ones move the day's edges (judgeDay), pending ones are
  // worth saying out loud - "late, but they asked" reads very differently from plain late.
  const { rows: requests } = useCollection<LateEarlyRequest>("late-early-requests", { all: true, params: { from: day, to: day } });
  const excusals = useMemo(() => excusalsByEmployee(requests), [requests]);
  const pendingBy = useMemo(() => {
    const m = new Map<string, { late?: string; early?: string }>();
    for (const r of requests) {
      if ((r.state ?? "").toUpperCase() !== "PENDING" || !r.employee || r.date?.slice(0, 10) !== day || !r.at) continue;
      const k = idOf(r.employee);
      const e = m.get(k) ?? {};
      if (r.kind === "late_arrival") e.late = r.at; else e.early = r.at;
      m.set(k, e);
    }
    return m;
  }, [requests, day]);
  // Approved leave on the day: a morning off is not a late arrival, an afternoon off is not an early departure.
  const { rows: leaves } = useCollection<LeaveRequest>("leave-requests", { all: true, params: { from: day, to: day } });
  const leaveBy = useMemo(() => {
    const m = new Map<string, { start: string; end: string; startSession?: number; endSession?: number }[]>();
    for (const l of leaves) {
      if ((l.state ?? "").toUpperCase() !== "APPROVED" || !l.employee) continue;
      const k = idOf(l.employee);
      (m.get(k) ?? m.set(k, []).get(k)!).push({ start: l.start_date.slice(0, 10), end: l.end_date.slice(0, 10), startSession: l.start_session ?? undefined, endSession: l.end_session ?? undefined });
    }
    return m;
  }, [leaves]);
  const policy = usePunctualityPolicy();
  const schedView = useScheduleView(schedule, day, day);

  const people = useMemo(() => new Map(employees.filter(isCurrentEmployee).map((e) => [idOf(e.path), { id: idOf(e.path), name: `${e.first_name} ${e.last_name}`, photo: e.photo }] as const)), [employees]);

  // One judged day per person who punched. Off days, holidays and full-day leave are not owed, so they are not
  // judged - the same three exits `punctualityOverPeriod` takes before calling judgeDay.
  const marks = useMemo<Mark[]>(() => {
    if (!sessions || holSet.has(day)) return [];
    const byEmp = new Map<string, AttendanceSession[]>();
    for (const s of sessions) if (s.employee) (byEmp.get(idOf(s.employee)) ?? byEmp.set(idOf(s.employee), []).get(idOf(s.employee))!).push(s);
    const out: Mark[] = [];
    const severe = policy.penalties.enabled ? policy.penalties.severe_minutes : null;
    for (const [eid, ss] of byEmp) {
      const person = people.get(eid);
      if (!person) continue;
      const p = punchDays(ss.map((s) => ({ clockInMs: Date.parse(s.clock_in), clockOutMs: s.clock_out ? Date.parse(s.clock_out) : null })), (ms) => localDay(new Date(ms).toISOString(), tz)).get(day);
      if (!p) continue;
      const ds = schedView.of(eid)(day);
      if (ds.off || ds.flexible) continue;
      const halves = leaveHalves(day, leaveBy.get(eid) ?? []);
      if (halves.am && halves.pm) continue;
      const excusal = excusals.get(eid)?.get(day);
      const arrMin = localMinutes(new Date(p.arrMs).toISOString(), tz);
      const depMin = p.depMs != null ? localMinutes(new Date(p.depMs).toISOString(), tz) : null;
      const j = judgeDay({ arrMin, depMin, open: p.open, startMin: ds.startMin, endMin: ds.endMin, grace: ds.graceMinutes, flexible: ds.flexible, excusal, halves, policy: policy.attendance });
      // A shift past midnight is one run on a linear line (judgeDay does the same), so a 2 AM clock-out on a
      // 10 PM - 6 AM shift reads as four hours early, not twenty.
      const endN = ds.startMin + shiftSpanMinutes(ds.startMin, ds.endMin);
      const norm = (m: number) => (endN > 1440 && m < ds.startMin ? m + 1440 : m);
      const pend = pendingBy.get(eid);
      const verdict = (flagged: boolean, by: number, excused: boolean, pending?: string): Verdict | undefined =>
        flagged ? (pending ? "pending" : severe != null && by > severe ? "severe" : "late") : excused ? "excused" : undefined;
      out.push({
        person,
        arrMin,
        depMin,
        open: p.open,
        startMin: ds.startMin,
        endMin: ds.endMin,
        arrOff: norm(arrMin) - ds.startMin,
        depOff: depMin != null && !p.open ? norm(depMin) - endN : null,
        inVerdict: halves.am ? undefined : verdict(j.late, j.lateByMin, j.excusedLate, pend?.late),
        outVerdict: halves.pm ? undefined : verdict(j.leftEarly, j.earlyByMin, j.excusedEarly, pend?.early),
        lateBy: j.lateByMin,
        earlyBy: j.earlyByMin,
        approvedIn: excusal?.lateUntil != null ? clockOf(excusal.lateUntil) : undefined,
        approvedOut: excusal?.earlyFrom != null ? clockOf(excusal.earlyFrom) : undefined,
      });
    }
    return out;
  }, [sessions, holSet, day, people, schedView, leaveBy, excusals, pendingBy, policy, tz]);

  // Live requests (approved or pending) the day's punches have not answered yet - see `Plan`. The same exits as
  // the judged days above: a day the person is not owed is a day there is nothing to plan around.
  const plans = useMemo<Plan[]>(() => {
    if (sessions === null || holSet.has(day)) return [];
    const byId = new Map(marks.map((m) => [m.person.id, m] as const));
    const out: Plan[] = [];
    for (const r of requests) {
      const st = (r.state ?? "").toUpperCase();
      if ((st !== "APPROVED" && st !== "PENDING") || !r.employee || r.date?.slice(0, 10) !== day || !r.at || !r.kind) continue;
      const eid = idOf(r.employee);
      const person = people.get(eid);
      if (!person) continue;
      const ds = schedView.of(eid)(day);
      if (ds.off || ds.flexible) continue;
      const halves = leaveHalves(day, leaveBy.get(eid) ?? []);
      if (halves.am && halves.pm) continue;
      const late = r.kind === "late_arrival";
      const m = byId.get(eid);
      if (late ? !!m : !!m && !m.open) continue;
      const endN = ds.startMin + shiftSpanMinutes(ds.startMin, ds.endMin);
      const norm = (x: number) => (endN > 1440 && x < ds.startMin ? x + 1440 : x);
      const atMin = minOfDay(r.at);
      out.push({ person, kind: late ? "late" : "early", atMin, off: late ? norm(atMin) - ds.startMin : norm(atMin) - endN, pending: st === "PENDING", startMin: ds.startMin, endMin: ds.endMin });
    }
    return out;
  }, [sessions, holSet, day, marks, requests, people, schedView, leaveBy]);

  const late = marks.filter((m) => m.inVerdict && m.inVerdict !== "excused");
  const early = marks.filter((m) => m.outVerdict && m.outVerdict !== "excused");
  const excused = marks.filter((m) => m.inVerdict === "excused" || m.outVerdict === "excused");
  const stillIn = marks.filter((m) => m.open).length;

  // When everybody shares a shift (the common case), the axis can speak in clock times; otherwise it speaks in
  // offsets, since "9:30 AM" means different things to the 7:00 and the 10:00 shift.
  const shifts = [...marks, ...plans];
  const uniform = (key: "startMin" | "endMin") => shifts.length > 0 && shifts.every((m) => m[key] === shifts[0]![key]) ? shifts[0]![key] : null;
  // The org's grace for the day (a grace exception widens it, or waives lateness outright: Infinity). A shift
  // with its own grace still judges by its own - this only draws the band and names the rule.
  const graceNow = graceOn(day, schedule);
  const severe = policy.penalties.enabled ? policy.penalties.severe_minutes : null;
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : null; };
  const medIn = median(marks.map((m) => m.arrOff));
  const departed = marks.filter((m) => m.depOff != null);
  const medOut = median(departed.map((m) => m.depOff!));

  const rel = (off: number) => (off === 0 ? "on the dot" : off > 0 ? `${fmtMinutes(off)} after start` : `${fmtMinutes(-off)} before start`);
  const relOut = (off: number) => (off === 0 ? "on the dot" : off > 0 ? `${fmtMinutes(off)} after end` : `${fmtMinutes(-off)} before end`);
  const isToday = day === today;
  const isFuture = day > today;
  const dayLabel = isToday ? "Today" : day === addDaysYmd(today, -1) ? "Yesterday" : day === addDaysYmd(today, 1) ? "Tomorrow" : new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const lastDay = addDaysYmd(today, AHEAD_DAYS);
  const go = (d: string) => { setDay(d); setFilter("all"); setShowAll(false); };
  const nowMin = localMinutes(new Date().toISOString(), tz);

  // One row per person, carrying whatever the day says about them: the judged punch and any request it has not
  // answered yet. Worst first (severe, late, asked-and-late), then requests, then the approved.
  type Row = { person: Person; m?: Mark; plans: Plan[] };
  const rowsFor = (f: Filter): Row[] => {
    const rows = new Map<string, Row>();
    const row = (person: Person) => rows.get(person.id) ?? rows.set(person.id, { person, plans: [] }).get(person.id)!;
    const ms = f === "late" ? late : f === "early" ? early : f === "excused" ? excused : f === "planned" ? [] : [...late, ...early, ...excused];
    for (const m of ms) row(m.person).m = m;
    // A planned early departure belongs to somebody who is in: their punch rides along for the detail line.
    if (f === "all" || f === "planned") for (const p of plans) { const r = row(p.person); r.plans.push(p); r.m ??= marks.find((m) => m.person.id === p.person.id); }
    const weight = (r: Row) => {
      const v = (x?: Verdict) => (x === "severe" ? 4 : x === "late" ? 3 : x === "pending" ? 2 : 0);
      return Math.max(v(r.m?.inVerdict), v(r.m?.outVerdict), r.plans.length ? 1 : 0);
    };
    return [...rows.values()].sort((a, b) => weight(b) - weight(a) || ((b.m?.lateBy ?? 0) + (b.m?.earlyBy ?? 0)) - ((a.m?.lateBy ?? 0) + (a.m?.earlyBy ?? 0)));
  };
  const listed = rowsFor(filter);
  const everyone = filter === "all" ? listed : rowsFor("all");

  // What a ghost says about where its owner is: nothing on a day still to come, the gap on today, the outcome
  // on a day that has gone.
  const planStatus = (p: Plan): { text: string; warn: boolean } | null => {
    if (isFuture) return null;
    if (!isToday) return { text: p.kind === "late" ? "No punch on the day" : "Never clocked out", warn: true };
    if (p.kind === "late") return nowMin > p.atMin ? { text: "Not in yet - past the time they gave", warn: true } : { text: "Not in yet", warn: false };
    return { text: "Still in", warn: false };
  };
  const planText = (p: Plan) => `${p.kind === "late" ? "In by" : "Leaving at"} ${clockOf(p.atMin)}`;

  const open = (id: string) => navigate(attendanceRoute(id, selfId));

  return (
    <TooltipProvider delayDuration={120}>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlarmClock className="h-4 w-4 text-warning" /> Arrivals &amp; departures
              <AccessTarget target={{ collection: "attendance", label: "Attendance" }} />
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each person against their own shift · {Number.isFinite(graceNow) ? `${fmtMinutes(graceNow)} grace` : "lateness waived for the day"}
              {severe != null && <> · past {fmtMinutes(severe)} counts as a half day</>}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Previous working day" onClick={() => go(stepWorkingDay(day, -1, workDays, holSet))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {/* On today the label is just a label; on any other day it is the way back, and is named for that. */}
            {isToday ? (
              <span className="min-w-[6rem] px-2 py-1 text-center text-sm font-medium">{dayLabel}</span>
            ) : (
              <button type="button" className="min-w-[6rem] rounded-md px-2 py-1 text-center text-sm font-medium hover:bg-accent" onClick={() => go(today)} aria-label={`${dayLabel}, back to today`} title="Back to today">
                {dayLabel}
              </button>
            )}
            {/* Forward into the planned days (requests only - nothing has been punched there), up to two weeks
                out. Past the last one the slot stays, so the label stays centred. */}
            <Button variant="ghost" size="icon" className={cn("h-7 w-7", day >= lastDay && "invisible")} aria-label="Next working day" onClick={() => { const n = stepWorkingDay(day, 1, workDays, holSet); go(n > lastDay ? lastDay : n); }}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        {/* MASKED from session replay: other people's names beside the minute they clocked in and out. */}
        <CardContent className="space-y-4" data-sentry-mask>
          {sessions === null ? (
            <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
          ) : holidayToday ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{holidayToday.display_name} - nobody was expected in.</p>
          ) : marks.length === 0 && plans.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {isFuture ? "No late arrivals or early departures planned." : isToday ? "Nobody has clocked in yet today." : "No punches on this day."}
            </p>
          ) : (
            <>
              <Strip
                icon={LogIn}
                label="In"
                domain={IN_DOMAIN}
                marks={marks.map((m) => ({ m, off: m.arrOff, verdict: m.inVerdict }))}
                plans={plans.filter((p) => p.kind === "late")}
                planTip={(p) => <PlanTip p={p} text={planText(p)} status={planStatus(p)} />}
                zones={[{ from: 0, to: graceNow, cls: ZONE.grace }, { from: graceNow, to: severe ?? IN_DOMAIN[1], cls: ZONE.late }, ...(severe != null ? [{ from: severe, to: IN_DOMAIN[1], cls: ZONE.severe }] : [])]}
                tickLabel={(off) => { const s = uniform("startMin"); return s != null ? clockOf(s + off) : off === 0 ? "Start" : `${off > 0 ? "+" : "-"}${fmtMinutes(Math.abs(off))}`; }}
                ticks={[-30, 0, 30, 60, 120]}
                now={isToday && uniform("startMin") != null ? localMinutes(new Date().toISOString(), tz) - uniform("startMin")! : null}
                summary={medIn != null ? `Typical arrival ${uniform("startMin") != null ? clockOf(uniform("startMin")! + medIn) : rel(medIn)}` : null}
                tip={(m) => (
                  <TipBody m={m} verdict={m.inVerdict} line={`In at ${clockOf(m.arrMin)} · ${rel(m.arrOff)}`} detail={m.inVerdict && m.inVerdict !== "excused" ? `${fmtMinutes(m.lateBy)} late` : null} approved={m.approvedIn ? `Approved to arrive by ${m.approvedIn}` : null} />
                )}
                onOpen={open}
              />
              <Strip
                icon={LogOut}
                label="Out"
                domain={OUT_DOMAIN}
                marks={marks.filter((m) => m.depOff != null).map((m) => ({ m, off: m.depOff!, verdict: m.outVerdict }))}
                plans={plans.filter((p) => p.kind === "early")}
                planTip={(p) => <PlanTip p={p} text={planText(p)} status={planStatus(p)} />}
                zones={[{ from: -graceNow, to: 0, cls: ZONE.grace }, { from: severe != null ? -severe : OUT_DOMAIN[0], to: -graceNow, cls: ZONE.late }, ...(severe != null ? [{ from: OUT_DOMAIN[0], to: -severe, cls: ZONE.severe }] : [])]}
                tickLabel={(off) => { const e = uniform("endMin"); return e != null ? clockOf(e + off) : off === 0 ? "End" : `${off > 0 ? "+" : "-"}${fmtMinutes(Math.abs(off))}`; }}
                ticks={[-120, -60, -30, 0, 30]}
                now={null}
                summary={[medOut != null ? `Typical departure ${uniform("endMin") != null ? clockOf(uniform("endMin")! + medOut) : relOut(medOut)}` : null, stillIn ? `${stillIn} still clocked in` : null].filter(Boolean).join(" · ") || null}
                tip={(m) => (
                  <TipBody m={m} verdict={m.outVerdict} line={`Out at ${clockOf(m.depMin!)} · ${relOut(m.depOff!)}`} detail={m.outVerdict && m.outVerdict !== "excused" ? `left ${fmtMinutes(m.earlyBy)} early` : null} approved={m.approvedOut ? `Approved to leave at ${m.approvedOut}` : null} />
                )}
                onOpen={open}
              />

              {everyone.length === 0 ? (
                <p className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
                  <Check className="h-4 w-4" /> {isToday ? "Everyone is on time so far." : "Everyone was on time."}
                </p>
              ) : (
                <div className="space-y-2">
                  {/* Only the filters this day has anything under: a planned day has requests and nothing else. */}
                  <FilterChips<Filter>
                    value={filter}
                    onChange={(v) => { setFilter(v); setShowAll(false); }}
                    clearTo="all"
                    options={([
                      { value: "all", label: "All", count: everyone.length },
                      { value: "late", label: "Late in", count: late.length },
                      { value: "early", label: "Left early", count: early.length },
                      { value: "excused", label: "Approved", count: excused.length },
                      { value: "planned", label: isFuture ? "Planned" : "Requests", count: plans.length },
                    ] satisfies { value: Filter; label: string; count: number }[]).filter((o) => o.value === "all" || o.count > 0 || o.value === filter)}
                  />
                  <div className="divide-y">
                    {(showAll ? listed : listed.slice(0, LIST_CAP)).map(({ person, m, plans: ps }) => (
                      <button key={person.id} type="button" onClick={() => open(person.id)} className="flex w-full items-center gap-3 py-2 text-left first:pt-0 last:pb-0 hover:opacity-80">
                        <PhotoAvatar employeeId={person.id} name={person.name} photo={person.photo} className={cn("h-8 w-8 shrink-0 text-[11px]", !m && GHOST)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{person.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {m
                              ? <>In {clockOf(m.arrMin)}{m.depMin != null && !m.open ? ` · out ${clockOf(m.depMin)}` : " · still in"}</>
                              : planStatus(ps[0]!)?.text ?? "Planned"}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-wrap justify-end gap-1">
                          {m?.inVerdict && <VerdictChip v={m.inVerdict} text={m.inVerdict === "excused" ? "Approved late" : `${fmtMinutes(m.lateBy)} late`} />}
                          {m?.outVerdict && <VerdictChip v={m.outVerdict} text={m.outVerdict === "excused" ? "Approved early" : `${fmtMinutes(m.earlyBy)} early`} />}
                          {ps.map((p) => <PlanChip key={p.kind} p={p} text={planText(p)} />)}
                        </span>
                      </button>
                    ))}
                  </div>
                  {listed.length > LIST_CAP && (
                    <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => setShowAll((v) => !v)}>
                      {showAll ? "Show fewer" : `Show all ${listed.length}`}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

function VerdictChip({ v, text }: { v: Verdict; text: string }) {
  const tone = v === "severe" ? "bg-destructive/10 text-destructive" : v === "excused" ? "bg-success/10 text-success" : "bg-warning/15 text-warning";
  return (
    <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", tone, v === "pending" && "border border-dashed border-warning")} title={v === "pending" ? "A request for this is waiting on approval" : undefined}>
      {text}{v === "pending" ? " · asked" : ""}
    </span>
  );
}

// A request the day has not answered yet: neutral when approved (it is the plan), dashed when still asked.
function PlanChip({ p, text }: { p: Plan; text: string }) {
  return (
    <span
      className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", p.pending ? "border border-dashed border-warning text-warning" : "bg-muted text-foreground")}
      title={p.pending ? "Waiting on approval" : "Approved"}
    >
      {text}{p.pending ? " · asked" : ""}
    </span>
  );
}

function PlanTip({ p, text, status }: { p: Plan; text: string; status: { text: string; warn: boolean } | null }) {
  return (
    <div className="min-w-[10rem] max-w-[16rem] space-y-0.5 text-xs">
      <div className="text-[13px] font-semibold text-foreground">{p.person.name}</div>
      <div className="text-muted-foreground">{p.kind === "late" ? "Late arrival" : "Early departure"} · {text}</div>
      <div className={p.pending ? "text-warning" : "text-success"}>{p.pending ? "Waiting on approval" : "Approved"}</div>
      {status && <div className={cn("font-medium", status.warn ? "text-warning" : "text-muted-foreground")}>{status.text}</div>}
    </div>
  );
}

function TipBody({ m, verdict, line, detail, approved }: { m: Mark; verdict?: Verdict; line: string; detail: string | null; approved: string | null }) {
  return (
    <div className="min-w-[10rem] max-w-[16rem] space-y-0.5 text-xs">
      <div className="text-[13px] font-semibold text-foreground">{m.person.name}</div>
      <div className="text-muted-foreground">{line}</div>
      {detail && <div className={cn("font-medium", verdict ? VERDICT_TEXT[verdict] : undefined)}>{detail}{verdict === "severe" ? " - counts as a half day" : ""}</div>}
      {verdict === "pending" && <div className="text-muted-foreground">Request waiting on approval</div>}
      {approved && <div className="text-success">{approved}</div>}
    </div>
  );
}

// One strip: the zones, the shift edge, everybody as a tick, the flagged rising above as avatars, and the
// requests not yet answered as ghosts at the time they gave - one stack, so a ghost and a real arrival at the
// same minute climb past each other rather than overlap.
function Strip({ icon: Icon, label, domain, marks, plans, zones, ticks, tickLabel, now, summary, tip, planTip, onOpen }: {
  icon: typeof LogIn;
  label: string;
  domain: [number, number];
  marks: { m: Mark; off: number; verdict?: Verdict }[];
  plans: Plan[];
  zones: { from: number; to: number; cls: string }[];
  ticks: number[];
  tickLabel: (off: number) => string;
  now: number | null;
  summary: string | null;
  tip: (m: Mark) => ReactNode;
  planTip: (p: Plan) => ReactNode;
  onOpen: (id: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [lo, hi] = domain;
  const pct = (off: number) => ((Math.min(hi, Math.max(lo, off)) - lo) / (hi - lo)) * 100;
  const flagged = useMemo(() => {
    const pins: Pin[] = [
      ...marks.flatMap((x): Pin[] => (x.verdict ? [{ kind: "mark", key: `m${x.m.person.id}`, off: x.off, m: x.m, verdict: x.verdict }] : [])),
      ...plans.map((p): Pin => ({ kind: "plan", key: `p${p.person.id}`, off: p.off, p })),
    ];
    return stack(pins.sort((a, b) => a.off - b.off).map((x) => ({ x: pct(x.off), item: x })), width);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, plans, width, lo, hi]);
  const levels = flagged.reduce((n, f) => Math.max(n, f.level + 1), 0);
  const height = RUG + 6 + Math.max(1, levels) * LEVEL + (AVATAR - LEVEL);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-foreground"><Icon className="h-3.5 w-3.5 text-muted-foreground" /> {label}</span>
        {summary && <span className="truncate text-muted-foreground">{summary}</span>}
      </div>
      {/* A recessed well: the page ground inside the card. In dark mode the stock border is the same step as the
          grace band, so the strip edge takes a faint foreground hairline instead. */}
      <div ref={ref} className="relative overflow-hidden rounded-md border bg-background dark:border-foreground/10" style={{ height }}>
        {zones.filter((z) => z.to > z.from).map((z, i) => (
          <span key={i} aria-hidden className={cn("absolute inset-y-0", z.cls)} style={{ left: `${pct(z.from)}%`, width: `${pct(z.to) - pct(z.from)}%` }} />
        ))}
        {/* The shift edge. */}
        <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: `${pct(0)}%` }} />
        {now != null && now > lo && now < hi && (
          <span aria-hidden className="absolute inset-y-0 w-px border-l border-dashed border-primary" style={{ left: `${pct(now)}%` }} title="Now" />
        )}
        {/* Everybody: one tick per person, so the crowd's shape shows even when nobody is flagged. */}
        {marks.map(({ m, off, verdict }) => (
          <span
            key={m.person.id}
            aria-hidden
            className={cn("absolute bottom-1 w-0.5 rounded-full", verdict ? "bg-foreground/50" : "bg-success/60")}
            style={{ left: `calc(${pct(off)}% - 1px)`, height: RUG - 2 }}
          />
        ))}
        {flagged.map(({ x, level, item }) => {
          const person = item.kind === "mark" ? item.m.person : item.p.person;
          const ghost = item.kind === "plan";
          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpen(person.id)}
                  aria-label={ghost
                    ? `${person.name}: ${item.p.kind === "late" ? "late arrival" : "early departure"} ${item.p.pending ? "requested" : "approved"}`
                    : `${person.name}: ${item.verdict === "excused" ? "approved" : item.verdict}`}
                  // The 1px offset in the strip's own ground keeps each ring off its avatar and off the avatar
                  // stacked behind it - without it, dark avatars in dark mode run into one blob.
                  className={cn(
                    "absolute rounded-full ring-offset-1 ring-offset-background transition-transform hover:z-20 hover:scale-110 focus-visible:z-20 focus-visible:outline-hidden",
                    ghost
                      ? item.p.pending ? "outline outline-2 outline-dashed outline-offset-1 outline-warning" : "ring-2 ring-muted-foreground/50 dark:ring-muted-foreground/80"
                      : cn("ring-2", RING[item.verdict]),
                  )}
                  style={{ left: `calc(${x}% - ${AVATAR / 2}px)`, bottom: RUG + 4 + level * LEVEL, zIndex: 10 - level }}
                >
                  <PhotoAvatar employeeId={person.id} name={person.name} photo={person.photo} className={cn("h-7 w-7 text-[10px]", ghost && GHOST)} />
                  {!ghost && item.verdict === "excused" && (
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-success text-success-foreground"><Check className="h-2 w-2" /></span>
                  )}
                  {ghost && (
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-muted-foreground text-background"><Clock className="h-2 w-2" /></span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className={TIP_CLASS}>{ghost ? planTip(item.p) : tip(item.m)}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="relative mt-1 h-3.5 text-[10px] text-muted-foreground">
        {ticks.map((t) => (
          <span key={t} className={cn("absolute whitespace-nowrap", t === lo ? "" : t === hi ? "-translate-x-full" : "-translate-x-1/2", t === 0 && "font-medium text-foreground")} style={{ left: `${pct(t)}%` }}>
            {tickLabel(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
