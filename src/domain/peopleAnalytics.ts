// The people-analytics registry: WHAT can be measured about a person over a window, and which collection's
// list decision gates each measure. Pure (no db imports) so the authz middleware can build per-collection list
// scopes for the request without importing the service - exactly as DASHBOARD_SUMMARY_COLLECTIONS does for the
// KPI aggregates.
//
// One row per person, many measures across the modules that hold their work: attendance/punctuality, leave,
// tasks, goals, reviews, 1:1s, timesheets, overtime, remote work, recognition, support. A measure whose
// collection the caller may not list is absent from the answer - so an employee sees their own row, a manager
// their team's, and neither sees a column they could not have read the rows behind.

/** How a measure rolls up to the team line under the table. */
export type MetricAgg = "sum" | "avg";
/** What the number IS, so one formatter serves every column. `time_of_day` is minutes since local midnight. */
export type MetricUnit = "count" | "days" | "hours" | "minutes" | "percent" | "rating" | "time_of_day";
/** Which direction is good, for the column's tone. `none` = neither (a volume, not a verdict). */
export type MetricDirection = "higher" | "lower" | "none";

export type MetricDef = {
  key: string;
  label: string;
  /** Short column header for the table (the label is the tooltip / export header). */
  short: string;
  /** The measure's dimension - the table groups its columns by this. */
  group: string;
  /** The collection whose LIST decision gates this measure (the same decision a real GET /v1/<collection> gets). */
  collection: string;
  /** A derived measure also needs these collections; without them the number would lie, so it is omitted. */
  needs?: string[];
  unit: MetricUnit;
  agg: MetricAgg;
  direction: MetricDirection;
  /** One line explaining exactly what was counted, shown on the column header. */
  hint: string;
};

export const METRIC_GROUPS: { key: string; label: string }[] = [
  { key: "attendance", label: "Attendance & punctuality" },
  { key: "leave", label: "Leave" },
  { key: "remote", label: "Remote work" },
  { key: "work", label: "Tasks & goals" },
  { key: "performance", label: "Performance" },
  { key: "time", label: "Time & effort" },
];

// Every measure. Order is the column order in the table.
export const METRICS: readonly MetricDef[] = [
  // ---- Attendance & punctuality (derived from the raw punches + the org schedule) ----
  { key: "days_present", label: "Days present", short: "Present", group: "attendance", collection: "attendance", unit: "days", agg: "sum", direction: "none", hint: "Days with at least one clock-in inside the window." },
  { key: "days_absent", label: "Days absent", short: "Absent", group: "attendance", collection: "attendance", needs: ["leave-requests"], unit: "days", agg: "sum", direction: "lower", hint: "Scheduled working days in the window with no punch, no approved leave and no holiday (clamped to their employment)." },
  { key: "days_late", label: "Late arrivals", short: "Late", group: "attendance", collection: "attendance", unit: "days", agg: "sum", direction: "lower", hint: "Days the first punch landed after the shift start plus the grace allowance." },
  { key: "days_left_early", label: "Early departures", short: "Left early", group: "attendance", collection: "attendance", unit: "days", agg: "sum", direction: "lower", hint: "Days the last punch-out landed before the shift end minus the grace allowance." },
  { key: "punctuality_pct", label: "Punctuality", short: "Punctual", group: "attendance", collection: "attendance", unit: "percent", agg: "avg", direction: "higher", hint: "Share of present days that were neither late nor an early departure." },
  { key: "late_minutes", label: "Minutes late", short: "Late by", group: "attendance", collection: "attendance", unit: "minutes", agg: "sum", direction: "lower", hint: "Total minutes past shift start across the late days." },
  { key: "avg_arrival_minute", label: "Average arrival", short: "Arrives", group: "attendance", collection: "attendance", unit: "time_of_day", agg: "avg", direction: "none", hint: "Mean wall-clock time of the first punch, in the org timezone." },
  { key: "days_short", label: "Under-hours days", short: "Short", group: "attendance", collection: "attendance", unit: "days", agg: "sum", direction: "lower", hint: "Present days that did not reach the configured full day of worked minutes." },
  { key: "avg_worked_minutes", label: "Average day length", short: "Day length", group: "attendance", collection: "attendance", unit: "minutes", agg: "avg", direction: "none", hint: "Mean worked minutes across present days (open sessions excluded)." },
  { key: "corrections_filed", label: "Corrections filed", short: "Corrections", group: "attendance", collection: "attendance-regularizations", unit: "count", agg: "sum", direction: "none", hint: "Attendance regularizations filed for a day inside the window." },

  // ---- Leave ----
  { key: "leave_days_taken", label: "Leave days taken", short: "Leave", group: "leave", collection: "leave-requests", unit: "days", agg: "sum", direction: "none", hint: "Days on approved leave requests that start inside the window." },
  { key: "leave_days_pending", label: "Leave days pending", short: "Pending", group: "leave", collection: "leave-requests", unit: "days", agg: "sum", direction: "none", hint: "Days on leave requests still awaiting a decision." },
  { key: "leave_late_notice", label: "Short-notice leave", short: "Short notice", group: "leave", collection: "leave-requests", unit: "count", agg: "sum", direction: "lower", hint: "Leave requests filed on or after the day the leave began." },

  // ---- Remote work. Its own dimension rather than a column under Leave: a remote day is a day WORKED, and
  // filing it beside absence reads as though working from home were a kind of time off.
  { key: "remote_days", label: "Remote days", short: "Remote", group: "remote", collection: "remote-work-requests", unit: "days", agg: "sum", direction: "none", hint: "Days of approved remote work overlapping the window." },
  { key: "remote_share_pct", label: "Share of days remote", short: "Remote share", group: "remote", collection: "remote-work-requests", unit: "percent", agg: "avg", direction: "none", hint: "Approved remote days as a share of the scheduled working days they could have used (clamped to their employment)." },
  { key: "remote_days_pending", label: "Remote days pending", short: "Pending", group: "remote", collection: "remote-work-requests", unit: "days", agg: "sum", direction: "none", hint: "Days on remote-work requests still awaiting a decision." },
  { key: "remote_requests", label: "Remote requests", short: "Requests", group: "remote", collection: "remote-work-requests", unit: "count", agg: "sum", direction: "none", hint: "Remote-work requests overlapping the window, whatever their state - how often they ask, not how long for." },
  { key: "remote_declined", label: "Remote declined", short: "Declined", group: "remote", collection: "remote-work-requests", unit: "count", agg: "sum", direction: "lower", hint: "Remote-work requests overlapping the window that were rejected." },

  // ---- Tasks & goals ----
  { key: "tasks_delivered", label: "Tasks delivered", short: "Delivered", group: "work", collection: "cards", unit: "count", agg: "sum", direction: "higher", hint: "Board cards assigned to them that reached a delivery column inside the window." },
  { key: "tasks_open", label: "Tasks open", short: "Open", group: "work", collection: "cards", unit: "count", agg: "sum", direction: "none", hint: "Cards assigned to them that are not delivered yet (as of now, not the window)." },
  { key: "tasks_overdue", label: "Tasks overdue", short: "Overdue", group: "work", collection: "cards", unit: "count", agg: "sum", direction: "lower", hint: "Open assigned cards whose due date has passed." },
  { key: "avg_cycle_days", label: "Average cycle time", short: "Cycle", group: "work", collection: "cards", unit: "days", agg: "avg", direction: "lower", hint: "Mean days from starting work to delivering it, over the cards delivered in the window." },
  { key: "goals_active", label: "Goals in flight", short: "Goals", group: "work", collection: "goals", unit: "count", agg: "sum", direction: "none", hint: "Goals not started or in progress right now." },
  { key: "goals_completed", label: "Goals completed", short: "Completed", group: "work", collection: "goals", unit: "count", agg: "sum", direction: "higher", hint: "Goals marked completed inside the window." },
  { key: "goals_overdue", label: "Goals overdue", short: "Slipped", group: "work", collection: "goals", unit: "count", agg: "sum", direction: "lower", hint: "Goals still in flight past their due date." },
  { key: "avg_goal_progress", label: "Average goal progress", short: "Progress", group: "work", collection: "goals", unit: "percent", agg: "avg", direction: "higher", hint: "Mean progress across their goals in flight." },

  // ---- Performance ----
  { key: "latest_rating", label: "Latest review rating", short: "Rating", group: "performance", collection: "reviews", unit: "rating", agg: "avg", direction: "higher", hint: "Overall rating on their most recently updated review carrying one." },
  { key: "reviews_open", label: "Reviews open", short: "Reviews", group: "performance", collection: "reviews", unit: "count", agg: "sum", direction: "none", hint: "Reviews of theirs not yet acknowledged." },
  { key: "checkins_held", label: "1:1s held", short: "1:1s", group: "performance", collection: "check-ins", unit: "count", agg: "sum", direction: "higher", hint: "Check-ins whose meeting date falls inside the window." },
  { key: "avg_pulse", label: "Average pulse", short: "Pulse", group: "performance", collection: "check-ins", unit: "rating", agg: "avg", direction: "higher", hint: "Mean of the 1-5 pulse they recorded on those check-ins." },
  { key: "kudos_received", label: "Kudos received", short: "Kudos", group: "performance", collection: "announcements", unit: "count", agg: "sum", direction: "higher", hint: "Recognition posts naming them, published inside the window." },

  // ---- Time & effort ----
  { key: "hours_logged", label: "Hours logged", short: "Logged", group: "time", collection: "time-entries", unit: "hours", agg: "sum", direction: "none", hint: "Timesheet hours dated inside the window (drafts included)." },
  { key: "billable_hours", label: "Billable hours", short: "Billable", group: "time", collection: "time-entries", unit: "hours", agg: "sum", direction: "higher", hint: "The billable share of those hours." },
  { key: "overtime_hours", label: "Overtime hours", short: "Overtime", group: "time", collection: "overtime-requests", unit: "hours", agg: "sum", direction: "none", hint: "Approved overtime worked on a day inside the window." },
  { key: "tickets_raised", label: "Tickets raised", short: "Tickets", group: "time", collection: "tickets", unit: "count", agg: "sum", direction: "none", hint: "Support tickets they opened inside the window." },
] as const;

/** Every collection a measure reads, plus `employees` - the roster the rows themselves come from. The
 *  middleware scopes exactly these, and the service can query nothing else. */
export const ANALYTICS_COLLECTIONS = [
  "employees",
  ...Array.from(new Set(METRICS.flatMap((m) => [m.collection, ...(m.needs ?? [])]))),
] as const;

// ---- Punctuality derivation (pure) ---------------------------------------------------------------------
// The org work schedule as stored in settings/attendance. Mirrors web/src/lib/attendance.ts#AttendanceSchedule
// (the same blob), holding the fields punctuality is judged against.

export type PunctualitySchedule = {
  timezone: string;
  work_days: number[]; // 0=Sun .. 6=Sat
  shift_start: string; // "HH:MM"
  shift_end: string; // "HH:MM"
  grace_minutes: number;
  grace_exceptions?: { date: string; reason?: string; extra_grace_minutes?: number }[];
  full_day_minutes: number;
  half_day_minutes: number;
  flexible_hours?: boolean;
};

/** One person's punches for one org-local day, already collapsed by the query: the day's first punch-in, its
 *  last punch-out (null while a session is still open) and the minutes actually worked. */
export type AttendanceDay = {
  employeeId: string;
  day: string; // "YYYY-MM-DD" in the org timezone
  firstIn: number; // epoch ms
  lastOut: number | null; // epoch ms of the last punch-OUT; null when nothing closed yet
  workedMinutes: number; // closed sessions only
  open: boolean; // a session is still running, so the day has not finished
};

export type AttendanceStats = {
  days_present: number;
  days_late: number;
  days_left_early: number;
  late_minutes: number;
  avg_arrival_minute: number | null;
  days_short: number;
  avg_worked_minutes: number | null;
  punctuality_pct: number | null;
};

/** Minutes since midnight of a "HH:MM" wall clock. */
export const hhmmToMin = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Minutes since midnight of an instant read in `tz` - so 09:05 IST is 545 whatever the server's own zone is. */
export function localMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * A person's days -> their punctuality numbers, by the same rules the Attendance page shows them by
 * (web/src/lib/attendance.ts): late when the first punch is past shift start plus that day's grace, left
 * early when the last punch-out is before shift end minus it, and neither when the schedule is flexible. A
 * grace exception widens the day's allowance for everyone, or waives the judgement entirely when it names no
 * extra minutes - so a transit strike does not read as forty people being late.
 */
export function summarizeAttendance(days: AttendanceDay[], sched: PunctualitySchedule): AttendanceStats {
  const startMin = hhmmToMin(sched.shift_start);
  const endMin = hhmmToMin(sched.shift_end);
  const exceptions = new Map((sched.grace_exceptions ?? []).map((e) => [e.date, e]));
  let late = 0, early = 0, lateMinutes = 0, short = 0, arrivalSum = 0, workedSum = 0, closed = 0;
  for (const d of days) {
    const ex = exceptions.get(d.day);
    const grace = ex ? (ex.extra_grace_minutes == null ? Infinity : sched.grace_minutes + ex.extra_grace_minutes) : sched.grace_minutes;
    const arrMin = localMinutes(d.firstIn, sched.timezone);
    arrivalSum += arrMin;
    // A day still running is judged on its arrival only: somebody who is at their desk right now has neither
    // left early nor come up short, and counting them as either would make every report of today wrong.
    if (!d.open) {
      if (d.workedMinutes < sched.full_day_minutes) short++;
      workedSum += d.workedMinutes;
      closed++;
    }
    if (sched.flexible_hours) continue; // judged by minutes worked only
    if (arrMin > startMin + grace) { late++; lateMinutes += arrMin - startMin; }
    if (!d.open && d.lastOut !== null && localMinutes(d.lastOut, sched.timezone) < endMin - grace) early++;
  }
  const present = days.length;
  return {
    days_present: present,
    days_late: late,
    days_left_early: early,
    late_minutes: lateMinutes,
    avg_arrival_minute: present ? Math.round(arrivalSum / present) : null,
    days_short: short,
    avg_worked_minutes: closed ? Math.round(workedSum / closed) : null,
    // Both flags on one day is still one unpunctual day: this is the share of days that went cleanly, not a
    // count of infractions.
    punctuality_pct: present ? Math.round(((present - Math.max(late, early)) / present) * 100) : null,
  };
}

/** Weekday (0=Sun..6=Sat) of a "YYYY-MM-DD". */
export const weekdayOf = (ymd: string): number => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** Inclusive "YYYY-MM-DD" list from `from` to `to`. */
export function enumerateDays(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${fromYmd}T00:00:00Z`); t <= Date.parse(`${toYmd}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Scheduled working days in `[from, to]` that fall inside this person's employment and are not holidays. The
 * denominator every absence number needs: a joiner three weeks in has not been absent for the fortnight
 * before they started, and neither has a leaver for the month after they left.
 */
export function expectedWorkingDays(opts: {
  fromYmd: string;
  toYmd: string;
  workDays: number[];
  holidays: Set<string>;
  joinedYmd?: string | null;
  leftYmd?: string | null;
  todayYmd: string;
}): number {
  const from = opts.joinedYmd && opts.joinedYmd > opts.fromYmd ? opts.joinedYmd : opts.fromYmd;
  // A future day cannot be an absence, so the window closes at today wherever it was asked to run past it.
  let to = opts.toYmd > opts.todayYmd ? opts.todayYmd : opts.toYmd;
  if (opts.leftYmd && opts.leftYmd < to) to = opts.leftYmd;
  if (from > to) return 0;
  let n = 0;
  for (const day of enumerateDays(from, to)) {
    if (!opts.workDays.includes(weekdayOf(day))) continue;
    if (opts.holidays.has(day)) continue;
    n++;
  }
  return n;
}
