import { and, or, eq, ne, gte, lte, lt, inArray, isNull, isNotNull, sql, asc, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";
import { applyScope } from "./listScope";
import { byIdChunks } from "../lib/dbBatch";
import { STALE_AFTER_DAYS } from "../domain/goals";
import { getSettingValue } from "./settings";
import type { ListScope } from "../domain/access";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { chunk } from "../lib/dbBatch";
import { localDay } from "../domain/attendance";
import { excusalsByDay, judgeDay, type LateEarlyKind } from "../domain/punctuality";
import { punctualityPolicy } from "./lateEarlyRequests";
import {
  METRICS,
  METRIC_GROUPS,
  teamOnlyReportable,
  withoutTeamOnly,
  summarizeAttendance,
  expectedWorkingDays,
  hhmmToMin,
  localMinutes,
  type AttendanceDay,
  type MetricDef,
  type PunctualitySchedule,
} from "../domain/peopleAnalytics";

// One report, one row per person, every module that holds their work.
//
// NO ACCESS CONTROL HERE. The middleware already decided, per collection, whether the caller may list it and
// with what breadth, and handed the answers over `analyticsScopes` (collection -> ListScope) - built by the
// exact decide()/scopeFor() pair a real `GET /v1/<collection>` gets, exactly as dashboard-summary and global
// search are. A collection absent from the map contributes no measure, so a column the caller could not have
// read the rows behind is simply missing from the answer; `employees` absent means no rows at all.
//
// PARITY. Every aggregate's WHERE mirrors its collection's own list service binding - the same
// applyScope(code, owner) columns and the same soft-delete filter - plus the measure's own predicate, so a
// number here always equals what the caller would have counted from the list response.

const DAY = 86_400_000;
const MAX_WINDOW_DAYS = 92; // a quarter. Punctuality is derived from per-day punches, so the window is bounded.
const MAX_SERIES_DAYS = 400; // a year and a bit, for ONE person's calendar (see the cap check below).
const DEFAULT_PEOPLE = 100;
const MAX_PEOPLE = 200;

// The org schedule as settings/attendance holds it, with the shape punctuality needs. Same blob the Attendance
// page reads, same defaults (web/src/lib/attendance.ts#DEFAULT_SCHEDULE).
const DEFAULT_SCHEDULE: PunctualitySchedule = {
  timezone: "Asia/Kolkata",
  work_days: [1, 2, 3, 4, 5],
  shift_start: "09:00",
  shift_end: "18:00",
  grace_minutes: 15,
  full_day_minutes: 480,
  half_day_minutes: 240,
  flexible_hours: false,
};

export type AnalyticsQuery = {
  from: string; // "YYYY-MM-DD" inclusive
  to: string; // "YYYY-MM-DD" inclusive
  departmentId?: string; // internal uuid (the wire id was decoded at the edge)
  employeeId?: string; // one person's report (internal uuid), still gated by the caller's employees scope
  /**
   * The EXACT people to report on (internal uuids), for a caller that already has a page of them - the custom
   * grid's measure columns are the one such caller. Narrowing only, like `employeeId`: the scope predicate
   * still decides who may be seen, so naming somebody else's id returns nobody.
   *
   * Without it the roster is the first `maxPeople` employees in name order, chosen with no reference to the
   * page being rendered - so a grid showing people 201-300 of an org asked for measures about the first 200
   * and got a blank cell for every row it was actually displaying, with `truncated` (the one signal that
   * anything had been left out) discarded by the caller.
   */
  employeeIds?: readonly string[];
  maxPeople?: number;
  /** Also return that ONE person's day-by-day attendance - what a calendar heatmap draws. */
  series?: boolean;
};

/** One day of one person's attendance, for the calendar. Only ever returned for a single named employee. */
export type AttendanceSeriesDay = { day: string; worked_minutes: number; late: boolean };

export type PersonRow = {
  employee: string; // "employees/<id>" - encoded to a wire token on the way out
  name: string;
  employee_number: string | null;
  job_title: string | null;
  department: string | null; // "departments/<id>"
  manager: string | null; // "employees/<id>"
  values: Record<string, number | null>;
};

export type AnalyticsResult = {
  window: { from: string; to: string; timezone: string; working_days: number };
  groups: { key: string; label: string }[];
  metrics: MetricDef[];
  people: PersonRow[];
  team: Record<string, number | null>;
  truncated: boolean;
  /** Present only when ONE employee was asked for with `series`: their day-by-day attendance. */
  series?: AttendanceSeriesDay[];
};

/** UTC offset of `tz` at `at`, in ms. The report buckets punches into org-local days with one offset for the
 *  whole window (the alternative is a timezone database in SQL); a zone that changes offset mid-window can
 *  therefore misfile a punch within an hour of local midnight on the changeover day. */
function tzOffsetMs(tz: string, at: number): number {
  // `hourCycle: "h23"` is load-bearing here, not tidiness. `hour12: false` leaves the hour cycle to the locale,
  // and h24 renders midnight as `24:00:00` - which makes the string below `...T24:00:00Z`, which `Date.parse`
  // answers NaN to. The offset is then NaN and every day bucket in the report is built from it. Naming the
  // cycle keeps that off a runtime whose ICU resolves the other way.
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(at));
  return Date.parse(`${local.replace(" ", "T")}Z`) - at;
}

// The calendar day a DATE-ONLY column names. Every such column in the schema is anchored at UTC midnight, so
// this is read in UTC and nowhere else - see domain/attendance.ts#utcDay, which states the rule.
//
// NOT for an INSTANT. "Today" is an org-local question and comes from `localDay(ms, sched.timezone)` below;
// this used to answer it too, which put the report's own clock in UTC while it bucketed punches in the org's
// timezone a few lines later.
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseYmd = (s: string) => Date.parse(`${s}T00:00:00Z`);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Sum of an aggregate row's column, or 0 - D1 hands back nulls for an empty SUM and strings for reals. */
const num = (v: unknown): number => (v == null ? 0 : Number(v));

export async function peopleAnalytics(deps: Deps, scopes: Map<string, ListScope>, q: AnalyticsQuery): Promise<AnalyticsResult> {
  const from = parseYmd(q.from);
  const to = parseYmd(q.to);
  if (Number.isNaN(from) || Number.isNaN(to)) throw invalidArgument("from and to must be YYYY-MM-DD dates");
  if (to < from) throw invalidArgument("to must not precede from");
  // The quarter cap is about WIDTH, not length: it bounds people times days, and the punches behind it are
  // read per day per person. One named person is a single row of days, so their own calendar may run a year -
  // which is the span a heatmap exists to show, and 365 rows to read rather than tens of thousands.
  const windowCap = q.employeeId ? MAX_SERIES_DAYS : MAX_WINDOW_DAYS;
  if ((to - from) / DAY + 1 > windowCap) throw invalidArgument(`the window may not exceed ${windowCap} days`);
  const limit = Math.min(Math.max(1, q.maxPeople ?? DEFAULT_PEOPLE), MAX_PEOPLE);
  const toExclusive = to + DAY; // instants are compared against the exclusive end of the last day

  const sched = await getSettingValue<PunctualitySchedule>(deps, "attendance", DEFAULT_SCHEDULE);
  const groups = METRIC_GROUPS;

  // Which measures this caller may see: their own collection listable, and every collection a derived measure
  // leans on listable too (an absence count computed without leave would read as absence when it is leave).
  const metrics = METRICS.filter((m) => scopes.has(m.collection) && (m.needs ?? []).every((c) => scopes.has(c)));
  const wants = (collection: string) => metrics.some((m) => m.collection === collection);

  const empScope = scopes.get("employees");
  if (!empScope) return { window: { from: q.from, to: q.to, timezone: sched.timezone, working_days: 0 }, groups, metrics, people: [], team: {}, truncated: false };

  const t = schema;
  const db = deps.db;
  const now = deps.clock.now();
  // ORG-LOCAL, not UTC. `now` is an instant and "today" is a calendar day, so which day it is depends on the
  // org's timezone - the same timezone this function already buckets punches into a few lines below
  // (`offsetMs`), and the one services/orgDay.ts exists to keep every such decision on. Read in UTC it was
  // wrong for part of every day, in both directions: `expectedWorkingDays` clamps its window at this value, so
  // west of UTC each evening counted the not-yet-started local day as a working day and charged an absence for
  // it to everyone in the report, while the overdue counts below (`dueDate < today`) called a task overdue a
  // day early. The schedule is already loaded, so this costs no read.
  const todayYmd = localDay(now.getTime(), sched.timezone);

  // ---- The roster: the people this caller may list, in the window ----------------------------------------
  // Somebody who left before the window opened is not in this report; somebody who joins after it closes is
  // not either. Both are still employees - they simply have no work inside these dates.
  const rosterCols = {
    uuid: t.employees.uuid,
    firstName: t.employees.firstName,
    lastName: t.employees.lastName,
    employeeNumber: t.employees.employeeNumber,
    jobTitle: t.employees.jobTitle,
    departmentId: t.employees.departmentId,
    managerId: t.employees.managerId,
    startDate: t.employees.startDate,
    endDate: t.employees.endDate,
    trackedFrom: t.employees.trackedFrom,
  };
  const rosterWhere = (extra?: SQL) => and(...([
    applyScope(empScope, t.employees.code, t.employees.uuid),
    isNull(t.employees.deleteTime),
    q.departmentId ? eq(t.employees.departmentId, q.departmentId) : undefined,
    // Naming one person NARROWS the report; it never widens it. The scope predicate above still decides
    // whether this caller may see them at all, so asking for somebody else's id returns nobody.
    q.employeeId ? eq(t.employees.uuid, q.employeeId) : undefined,
    extra,
    or(isNull(t.employees.endDate), gte(t.employees.endDate, new Date(from))),
    or(isNull(t.employees.startDate), lt(t.employees.startDate, new Date(toExclusive))),
  ].filter(Boolean) as SQL[]));

  // A NAMED roster is exact, so it is neither capped nor truncated: the caller is asking about the people it
  // already has, and `limit` exists to bound a report that chose its own. Chunked because an id list spends one
  // bound parameter each and the scope predicate binds alongside it (lib/dbBatch.ts#PARAM_CAP).
  const named = q.employeeIds ?? null;
  const roster = named
    ? (await byIdChunks([...new Set(named)], (ids) =>
        db.select(rosterCols).from(t.employees).where(rosterWhere(inArray(t.employees.uuid, ids))),
      )).sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
    : await db.select(rosterCols).from(t.employees).where(rosterWhere())
        .orderBy(asc(t.employees.firstName), asc(t.employees.lastName))
        .limit(limit + 1);

  const truncated = !named && roster.length > limit;
  const people = named ? roster : roster.slice(0, limit);
  const allIds = people.map((p) => p.uuid);
  if (allIds.length === 0) {
    return { window: { from: q.from, to: q.to, timezone: sched.timezone, working_days: 0 }, groups, metrics, people: [], team: {}, truncated: false };
  }

  // ---- The aggregates: one statement per collection, all in one D1 batch ---------------------------------
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const toExclusiveDate = new Date(toExclusive);
  const today = new Date(parseYmd(todayYmd));
  const offsetMs = tzOffsetMs(sched.timezone, from + (to - from) / 2);
  // The org-local day a punch belongs to, as a day number (local midnight / a day of ms).
  const dayNo = sql<number>`((${t.attendanceSessions.clockIn} + ${offsetMs}) / 86400000)`;
  // Every computed column is ALIASED, and each helper takes the alias as its first argument. D1 answers a
  // batched statement with objects keyed by column NAME, so two selected expressions that render identically
  // (the same `case when` counted under two names) collapse into one and the second silently comes back
  // undefined - which is a wrong number, not an error. An alias per field makes that impossible.
  const cond = (name: string, c: SQL) => sql<number>`coalesce(sum(case when ${c} then 1 else 0 end), 0)`.as(name);
  const expr = (name: string, s: SQL<number>) => s.as(name);

  // Ids per statement. Well under D1's 100-parameter cap, because every aggregate also binds its window dates
  // and whatever its access scope adds - the roster is the only part that grows with the org.
  const ID_CHUNK = 80;

  type Stmt = { id: string; sql: unknown };
  const stmts: Stmt[] = [];
  const add = (id: string, builder: unknown) => stmts.push({ id, sql: builder });
  // Which (code, owner) columns each collection's own list binds its scope to - the parity the comment at the
  // top promises, named once so no aggregate can drift from the list it must agree with.
  const SCOPE_COLUMNS: Record<string, [AnySQLiteColumn, AnySQLiteColumn]> = {
    attendance: [t.attendanceSessions.code, t.attendanceSessions.employeeId],
    "attendance-regularizations": [t.attendanceRegularizations.code, t.attendanceRegularizations.employeeId],
    "leave-requests": [t.leaveRequests.code, t.leaveRequests.employeeId],
    "remote-work-requests": [t.remoteWorkRequests.code, t.remoteWorkRequests.employeeId],
    "overtime-requests": [t.overtimeRequests.code, t.overtimeRequests.employeeId],
    "late-early-requests": [t.lateEarlyRequests.code, t.lateEarlyRequests.employeeId],
    "time-entries": [t.timeEntries.code, t.timeEntries.employeeId],
    cards: [t.cards.code, t.cards.employeeId],
    goals: [t.goals.code, t.goals.employeeId],
    reviews: [t.reviews.code, t.reviews.employeeId],
    "check-ins": [t.checkIns.code, t.checkIns.employeeId],
    // No `announcements` entry: the one measure over that table counts kudos RECEIVED, and this map is the
    // owner-scope parity - `author_employee_id` for announcements - which is the wrong column for it. Binding
    // it here was the whole of that bug; see the `kudos` aggregate below for what replaced it.
    tickets: [t.tickets.code, t.tickets.employeeId],
    // The SUBMITTER, which is the column `expenses` own list scopes on (its code is owner-embedded on the
    // person who filed the claim). `department_id` on the same row is cost-centre attribution and is
    // deliberately NOT the scope key - binding to it here would let a manager's dept breadth pull in a claim
    // somebody else filed against their cost centre, which is the mistake the announcements entry above
    // records having made with a different column.
    expenses: [t.expenses.code, t.expenses.employeeId],
  };
  const scoped = (collection: string, ...conds: (SQL | undefined)[]) => {
    const [code, owner] = SCOPE_COLUMNS[collection]!;
    return and(...([applyScope(scopes.get(collection), code, owner), ...conds].filter(Boolean) as SQL[]));
  };

  // Every aggregate below binds one parameter per person, and D1 caps a statement at 100 of them (PARAM_CAP),
  // so a single IN list over a real roster takes the whole report down with `too many SQL variables`. The same
  // aggregates are therefore built once per chunk of ids and merged by aggregate id after the batch - chunked
  // statements inside one batch still cost the one subrequest. `ids` shadows the full list on purpose: each
  // pass sees only its own chunk, so no aggregate can accidentally bind them all.
  for (const idChunk of chunk(allIds, ID_CHUNK)) {
  const ids = idChunk;

  if (wants("attendance")) {
    // Per (person, org-local day): the first punch in, the last punch out, whether anything is still open and
    // the minutes closed sessions account for. The punctuality rules are applied to these in the domain, by
    // the same code path (and the same grace exceptions) the Attendance page shows a day by.
    add("attendance", db
      .select({
        employeeId: t.attendanceSessions.employeeId,
        day: dayNo.as("day"),
        firstIn: sql<number>`min(${t.attendanceSessions.clockIn})`.as("firstIn"),
        lastOut: sql<number | null>`max(${t.attendanceSessions.clockOut})`.as("lastOut"),
        openCount: cond("openCount", isNull(t.attendanceSessions.clockOut)),
        workedMs: expr("workedMs", sql<number>`coalesce(sum(case when ${t.attendanceSessions.clockOut} is not null then ${t.attendanceSessions.clockOut} - ${t.attendanceSessions.clockIn} else 0 end), 0)`),
      })
      .from(t.attendanceSessions)
      .where(scoped("attendance",
        isNull(t.attendanceSessions.supersededBy),
        gte(t.attendanceSessions.clockIn, fromDate),
        lt(t.attendanceSessions.clockIn, toExclusiveDate),
        inArray(t.attendanceSessions.employeeId, ids)))
      .groupBy(t.attendanceSessions.employeeId, dayNo));
  }

  if (wants("attendance-regularizations")) {
    add("corrections", db
      .select({ employeeId: t.attendanceRegularizations.employeeId, filed: sql<number>`count(*)`.as("filed") })
      .from(t.attendanceRegularizations)
      .where(scoped("attendance-regularizations",
        gte(t.attendanceRegularizations.date, fromDate),
        lte(t.attendanceRegularizations.date, toDate),
        inArray(t.attendanceRegularizations.employeeId, ids)))
      .groupBy(t.attendanceRegularizations.employeeId));
  }

  if (wants("leave-requests")) {
    // Days TAKEN are the days on requests that start in the window (a request is a unit; splitting its days
    // across a window boundary would double-count against the next report). `overlapDays` is a different
    // question - how many of the window's own days were leave - and only the absence arithmetic uses it.
    add("leave", db
      .select({
        employeeId: t.leaveRequests.employeeId,
        taken: expr("taken", sql<number>`coalesce(sum(case when ${t.leaveRequests.state} = 'APPROVED' and ${t.leaveRequests.startDate} >= ${from} and ${t.leaveRequests.startDate} <= ${to} then ${t.leaveRequests.days} else 0 end), 0)`),
        pending: expr("pending", sql<number>`coalesce(sum(case when ${t.leaveRequests.state} = 'PENDING' and ${t.leaveRequests.startDate} >= ${from} and ${t.leaveRequests.startDate} <= ${to} then ${t.leaveRequests.days} else 0 end), 0)`),
        lateNotice: expr("lateNotice", sql<number>`coalesce(sum(case when ${t.leaveRequests.state} in ('APPROVED', 'PENDING') and ${t.leaveRequests.startDate} >= ${from} and ${t.leaveRequests.startDate} <= ${to} and ${t.leaveRequests.createdAt} >= ${t.leaveRequests.startDate} then 1 else 0 end), 0)`),
        overlapDays: expr("overlapDays", sql<number>`coalesce(sum(case when ${t.leaveRequests.state} = 'APPROVED' then (min(${t.leaveRequests.endDate}, ${to}) - max(${t.leaveRequests.startDate}, ${from})) / 86400000 + 1 else 0 end), 0)`),
      })
      .from(t.leaveRequests)
      .where(scoped("leave-requests",
        gte(t.leaveRequests.endDate, fromDate),
        lte(t.leaveRequests.startDate, toDate),
        inArray(t.leaveRequests.employeeId, ids)))
      .groupBy(t.leaveRequests.employeeId));
  }

  if (wants("remote-work-requests")) {
    add("remote", db
      .select({
        employeeId: t.remoteWorkRequests.employeeId,
        // Overlap days, split by state: an approved day is a day worked remotely, a pending one is a day
        // somebody is still waiting on. A rejected request has no days at all - only a count.
        days: expr("days", sql<number>`coalesce(sum(case when ${t.remoteWorkRequests.state} = 'APPROVED' then (min(${t.remoteWorkRequests.endDate}, ${to}) - max(${t.remoteWorkRequests.startDate}, ${from})) / 86400000 + 1 else 0 end), 0)`),
        pendingDays: expr("pendingDays", sql<number>`coalesce(sum(case when ${t.remoteWorkRequests.state} = 'PENDING' then (min(${t.remoteWorkRequests.endDate}, ${to}) - max(${t.remoteWorkRequests.startDate}, ${from})) / 86400000 + 1 else 0 end), 0)`),
        requests: cond("requests", inArray(t.remoteWorkRequests.state, ["APPROVED", "PENDING", "REJECTED"])),
        declined: cond("declined", eq(t.remoteWorkRequests.state, "REJECTED")),
      })
      .from(t.remoteWorkRequests)
      .where(scoped("remote-work-requests",
        ne(t.remoteWorkRequests.state, "CANCELLED"),
        gte(t.remoteWorkRequests.endDate, fromDate),
        lte(t.remoteWorkRequests.startDate, toDate),
        inArray(t.remoteWorkRequests.employeeId, ids)))
      .groupBy(t.remoteWorkRequests.employeeId));
  }

  if (wants("overtime-requests")) {
    add("overtime", db
      .select({
        employeeId: t.overtimeRequests.employeeId,
        hours: expr("hours", sql<number>`coalesce(sum(${t.overtimeRequests.endTime} - ${t.overtimeRequests.startTime}), 0) / 3600000.0`),
      })
      .from(t.overtimeRequests)
      .where(scoped("overtime-requests",
        eq(t.overtimeRequests.state, "APPROVED"),
        gte(t.overtimeRequests.date, fromDate),
        lte(t.overtimeRequests.date, toDate),
        inArray(t.overtimeRequests.employeeId, ids)))
      .groupBy(t.overtimeRequests.employeeId));
  }

  if (wants("late-early-requests")) {
    // The approved requests themselves, not a count: the same rows move the punctuality measures' windows (an
    // approved 10:30 start is on time at 10:30), and the count is taken from them afterwards.
    add("lateEarly", db
      .select({ employeeId: t.lateEarlyRequests.employeeId, date: t.lateEarlyRequests.date, kind: t.lateEarlyRequests.kind, at: t.lateEarlyRequests.at })
      .from(t.lateEarlyRequests)
      .where(scoped("late-early-requests",
        eq(t.lateEarlyRequests.state, "APPROVED"),
        gte(t.lateEarlyRequests.date, fromDate),
        lte(t.lateEarlyRequests.date, toDate),
        inArray(t.lateEarlyRequests.employeeId, ids))));
  }

  if (wants("expenses")) {
    // What this person put through as company spend. SUBMITTED is excluded deliberately: a claim awaiting a
    // decision is not spend, and counting it would make a measure move when somebody presses a button rather
    // than when money is committed - the same line `computeBudgetSpendMany` draws between `spent` and
    // `pending`.
    add("expenses", db
      .select({
        employeeId: t.expenses.employeeId,
        claimed: expr("claimed", sql<number>`coalesce(sum(${t.expenses.amount}), 0)`),
        claims: expr("claims", sql<number>`count(*)`),
      })
      .from(t.expenses)
      .where(scoped("expenses",
        inArray(t.expenses.state, ["APPROVED", "PAID"]),
        eq(t.expenses.isRecurring, false),
        gte(t.expenses.incurredOn, fromDate),
        lte(t.expenses.incurredOn, toDate),
        inArray(t.expenses.employeeId, ids)))
      .groupBy(t.expenses.employeeId));
  }

  if (wants("time-entries")) {
    add("time", db
      .select({
        employeeId: t.timeEntries.employeeId,
        hours: expr("hours", sql<number>`coalesce(sum(${t.timeEntries.hours}), 0)`),
        billable: expr("billable", sql<number>`coalesce(sum(case when ${t.timeEntries.billable} = 1 then ${t.timeEntries.hours} else 0 end), 0)`),
      })
      .from(t.timeEntries)
      .where(scoped("time-entries",
        isNull(t.timeEntries.deleteTime),
        gte(t.timeEntries.date, fromDate),
        lte(t.timeEntries.date, toDate),
        inArray(t.timeEntries.employeeId, ids)))
      .groupBy(t.timeEntries.employeeId));
  }

  if (wants("cards")) {
    // Grouped by ASSIGNEE - the person doing the work, which is what a report about people is asking. Open and
    // overdue are as of now rather than of the window: a task still open is open today, whenever it was made.
    add("cards", db
      .select({
        employeeId: t.cards.assigneeId,
        delivered: cond("delivered", and(isNotNull(t.cards.deliveredAt), gte(t.cards.deliveredAt, fromDate), lt(t.cards.deliveredAt, toExclusiveDate))!),
        open: cond("open", isNull(t.cards.deliveredAt)),
        overdue: cond("overdue", and(isNull(t.cards.deliveredAt), isNotNull(t.cards.dueDate), lt(t.cards.dueDate, today))!),
        cycleMs: expr("cycleMs", sql<number>`coalesce(sum(case when ${t.cards.deliveredAt} is not null and ${t.cards.deliveredAt} >= ${from} and ${t.cards.deliveredAt} < ${toExclusive} and ${t.cards.startedAt} is not null then ${t.cards.deliveredAt} - ${t.cards.startedAt} else 0 end), 0)`),
        cycleCount: expr("cycleCount", sql<number>`coalesce(sum(case when ${t.cards.deliveredAt} is not null and ${t.cards.deliveredAt} >= ${from} and ${t.cards.deliveredAt} < ${toExclusive} and ${t.cards.startedAt} is not null then 1 else 0 end), 0)`),
      })
      .from(t.cards)
      .where(scoped("cards", isNull(t.cards.deleteTime), inArray(t.cards.assigneeId, ids)))
      .groupBy(t.cards.assigneeId));
  }

  if (wants("goals")) {
    add("goals", db
      .select({
        employeeId: t.goals.employeeId,
        active: cond("active", inArray(t.goals.status, ["not_started", "in_progress"])),
        completed: cond("completed", and(eq(t.goals.status, "completed"), gte(t.goals.updatedAt, fromDate), lt(t.goals.updatedAt, toExclusiveDate))!),
        overdue: cond("overdue", and(inArray(t.goals.status, ["not_started", "in_progress"]), isNotNull(t.goals.dueDate), lt(t.goals.dueDate, today))!),
        progressSum: expr("progressSum", sql<number>`coalesce(sum(case when ${t.goals.status} in ('not_started', 'in_progress') then ${t.goals.progress} else 0 end), 0)`),
        // Attainment: what the window ASKED for (goals due inside it) against what was delivered, weighted the
        // same way a review scores it - see domain/performance.ts#goalAttainment. Cancelled goals are out
        // whole; the unweighted pair is the fallback for an org that leaves weights at zero.
        //
        // `dueUnweighted` is what makes it the SAME rule rather than a similar one: the weighted arithmetic
        // applies only when every goal in the window carries a weight. `goals.weight` defaults to 0, and a
        // weight-0 goal adds nothing to either side of Σ(weight x progress) / Σweight - so on a `dueWeight > 0`
        // test it vanished from the report exactly as it used to vanish from the review score, and one weighted
        // goal beside five untouched ones reported that goal's progress as the person's attainment.
        // Written with the window as RAW literals rather than bound values, and that is deliberate rather than
        // stylistic: the roster chunk is sized at 80 ids against D1's 100-parameter ceiling, and the margin is
        // what every aggregate's own window dates spend. Three more bound parameters on this statement put a
        // 122-person report over the cap (test/peopleAnalytics.test.ts pins exactly that), so this aggregate
        // adds none. The values are epoch milliseconds this function computed - never caller text - so there
        // is nothing here that interpolation could subvert.
        dueUnweighted: expr("dueUnweighted", sql<number>`coalesce(sum(case when ${t.goals.status} <> 'cancelled' and ${t.goals.dueDate} >= ${sql.raw(String(+fromDate))} and ${t.goals.dueDate} < ${sql.raw(String(+toExclusiveDate))} and max(${t.goals.weight}, 0) <= 0 then 1 else 0 end), 0)`),
        dueWeight: expr("dueWeight", sql<number>`coalesce(sum(case when ${t.goals.status} <> 'cancelled' and ${t.goals.dueDate} >= ${+fromDate} and ${t.goals.dueDate} < ${+toExclusiveDate} then max(${t.goals.weight}, 0) else 0 end), 0)`),
        dueEarned: expr("dueEarned", sql<number>`coalesce(sum(case when ${t.goals.status} <> 'cancelled' and ${t.goals.dueDate} >= ${+fromDate} and ${t.goals.dueDate} < ${+toExclusiveDate} then max(${t.goals.weight}, 0) * min(max(${t.goals.progress}, 0), 100) else 0 end), 0)`),
        dueCount: cond("dueCount", and(ne(t.goals.status, "cancelled"), gte(t.goals.dueDate, fromDate), lt(t.goals.dueDate, toExclusiveDate))!),
        dueProgress: expr("dueProgress", sql<number>`coalesce(sum(case when ${t.goals.status} <> 'cancelled' and ${t.goals.dueDate} >= ${+fromDate} and ${t.goals.dueDate} < ${+toExclusiveDate} then min(max(${t.goals.progress}, 0), 100) else 0 end), 0)`),
        // The two early signals, as of NOW rather than the window (like tasks_open): a goal 25 points behind
        // the straight line from when it was set to when it is due - or one its owner has flagged - and a goal
        // nobody has touched in three weeks. Mirrors domain/goals.ts#goalPace / #staleDays, in SQL because
        // this counts every person's goals in one grouped statement.
        atRisk: expr("atRisk", sql<number>`coalesce(sum(case
          when ${t.goals.status} in ('not_started', 'in_progress') and (
            ${t.goals.confidence} in ('at_risk', 'off_track')
            or (${t.goals.dueDate} is not null and (${t.goals.dueDate} + 86400000) > ${t.goals.createdAt}
              and min(max(${t.goals.progress}, 0), 100)
                - (min(max((${+now} - ${t.goals.createdAt}) * 1.0 / ((${t.goals.dueDate} + 86400000) - ${t.goals.createdAt}), 0), 1) * 100) <= -25)
          ) then 1 else 0 end), 0)`),
        stale: expr("stale", sql<number>`coalesce(sum(case
          when ${t.goals.status} in ('not_started', 'in_progress') and (${+now} - ${t.goals.updatedAt}) >= ${STALE_AFTER_DAYS} * 86400000
          then 1 else 0 end), 0)`),
      })
      .from(t.goals)
      .where(scoped("goals", isNull(t.goals.deleteTime), inArray(t.goals.employeeId, ids)))
      .groupBy(t.goals.employeeId));
  }

  if (wants("reviews")) {
    // A rating is a standing fact about a person, not an event inside the window, so the latest one is the
    // latest one. SQLite hands back the other columns of the max() row, which is exactly "the newest review
    // that carries a rating" - and the open count needs its own statement because that filter would skew it.
    add("rating", db
      .select({
        employeeId: t.reviews.employeeId,
        latest: sql<number>`max(${t.reviews.updatedAt})`.as("latest"),
        rating: t.reviews.overallRating,
      })
      .from(t.reviews)
      // Only a review the employee has actually been shown counts: a manager's rating is hidden until SHARED,
      // and a report that surfaced it earlier would leak the draft verdict out of the review it belongs to.
      .where(scoped("reviews", isNotNull(t.reviews.overallRating), inArray(t.reviews.state, ["SHARED", "ACKNOWLEDGED"]), inArray(t.reviews.employeeId, ids)))
      .groupBy(t.reviews.employeeId));
    add("reviewsOpen", db
      .select({ employeeId: t.reviews.employeeId, open: cond("open", ne(t.reviews.state, "ACKNOWLEDGED")) })
      .from(t.reviews)
      .where(scoped("reviews", inArray(t.reviews.employeeId, ids)))
      .groupBy(t.reviews.employeeId));
  }

  if (wants("check-ins")) {
    add("checkins", db
      .select({
        employeeId: t.checkIns.employeeId,
        held: sql<number>`count(*)`.as("held"),
        pulseSum: expr("pulseSum", sql<number>`coalesce(sum(case when ${t.checkIns.pulse} is not null then ${t.checkIns.pulse} else 0 end), 0)`),
        pulseCount: cond("pulseCount", isNotNull(t.checkIns.pulse)),
      })
      .from(t.checkIns)
      .where(scoped("check-ins",
        isNull(t.checkIns.deleteTime),
        isNotNull(t.checkIns.meetingDate),
        gte(t.checkIns.meetingDate, fromDate),
        lte(t.checkIns.meetingDate, toDate),
        inArray(t.checkIns.employeeId, ids)))
      .groupBy(t.checkIns.employeeId));
  }

  if (wants("announcements")) {
    // Recognition received: kudos posts naming the person. A department kudo credits nobody (it carries no
    // per-head points), so it is not counted here either - same rule the leaderboard uses.
    //
    // SCOPED BY THE RECIPIENT, WHICH IS WHY THIS ONE DOES NOT GO THROUGH `scoped()`. Every other aggregate here
    // is about rows the subject OWNS, and `SCOPE_COLUMNS` binds announcements to `author_employee_id` - correct
    // for "posts you wrote", which is what visibleWhere uses it for, and wrong for this measure, which is about
    // who the kudos was FOR. Bound to the author, "Recognition received" counted the kudos the VIEWER gave,
    // filed under each recipient's name (own breadth), or the kudos authored inside the viewer's department
    // (dept breadth); only an `all`-breadth caller ever saw the number the label claims.
    //
    // What bounds it instead is the subject list: `ids` is the set of people this report may be run over, gated
    // before we get here, and a published, non-disabled kudos post is visible to every reader of the board. So
    // the honest predicate is "kudos naming these people, that anyone may see" - which is the announcements
    // visibility rule (services/announcements.ts visibleWhere) minus the author scope: published, not
    // moderated out, not deleted. `disabled` is the half that was also missing - a kudos an editor had
    // moderated out still counted toward recognition for a caller who could not see it.
    add("kudos", db
      .select({ employeeId: t.announcements.recipientEmployeeId, received: sql<number>`count(*)`.as("received") })
      .from(t.announcements)
      .where(and(
        eq(t.announcements.kind, "kudos"),
        eq(t.announcements.published, true),
        eq(t.announcements.disabled, false),
        isNull(t.announcements.deleteTime),
        gte(sql`coalesce(${t.announcements.publishTime}, ${t.announcements.createdAt})`, from),
        lt(sql`coalesce(${t.announcements.publishTime}, ${t.announcements.createdAt})`, toExclusive),
        inArray(t.announcements.recipientEmployeeId, ids),
      ))
      .groupBy(t.announcements.recipientEmployeeId));
  }

  if (wants("tickets")) {
    add("tickets", db
      .select({ employeeId: t.tickets.employeeId, raised: sql<number>`count(*)`.as("raised") })
      .from(t.tickets)
      .where(scoped("tickets",
        isNull(t.tickets.deleteTime),
        gte(t.tickets.createdAt, fromDate),
        lt(t.tickets.createdAt, toExclusiveDate),
        inArray(t.tickets.employeeId, ids)))
      .groupBy(t.tickets.employeeId));
  }
  }

  // The absence denominator: the company calendar over the window, which the window's own working-day count
  // needs too. Read directly (like payroll's LOP does) - it is the schedule, not somebody's rows, and the
  // measure it feeds is already gated by leave + attendance.
  const holidayRows = await db
    .select({ date: t.holidays.date, location: t.holidays.location })
    .from(t.holidays)
    .where(and(isNull(t.holidays.deleteTime), eq(t.holidays.disabled, false), eq(t.holidays.kind, "fixed"), gte(t.holidays.date, fromDate), lte(t.holidays.date, toDate)));
  // Company-wide closures only: a regional holiday depends on the person's posted location, which this report
  // does not resolve, and treating one as everybody's day off would hide real absences elsewhere.
  const holidays = new Set(holidayRows.filter((h) => !h.location).map((h) => ymd(+new Date(h.date))));

  const results = stmts.length === 0
    ? []
    : stmts.length === 1
      ? [await (stmts[0]!.sql as PromiseLike<unknown>)]
      : ((await db.batch(stmts.map((s) => s.sql) as unknown as Parameters<typeof db.batch>[0])) as unknown as unknown[]);
  // One aggregate is now several statements (one per id chunk), so its rows are concatenated rather than
  // assigned - the last chunk must not replace the people counted in the first.
  const byId = new Map<string, any[]>();
  stmts.forEach((s, i) => {
    const rows = (results[i] as any[]) ?? [];
    const held = byId.get(s.id);
    if (held) held.push(...rows);
    else byId.set(s.id, [...rows]);
  });

  /** Index an aggregate's rows by employee. */
  const index = (id: string): Map<string, any> => {
    const out = new Map<string, any>();
    for (const row of byId.get(id) ?? []) if (row.employeeId) out.set(String(row.employeeId), row);
    return out;
  };

  const attendanceByEmp = new Map<string, AttendanceDay[]>();
  for (const row of byId.get("attendance") ?? []) {
    const id = String(row.employeeId);
    const list = attendanceByEmp.get(id) ?? attendanceByEmp.set(id, []).get(id)!;
    list.push({
      employeeId: id,
      day: ymd(Number(row.day) * DAY),
      firstIn: Number(row.firstIn),
      lastOut: row.lastOut == null ? null : Number(row.lastOut),
      workedMinutes: Math.round(num(row.workedMs) / 60000),
      open: num(row.openCount) > 0,
    });
  }

  // Approved late arrivals / early departures, per person and day, under the org's policy for how an approved
  // window is judged (grace on top or not). Empty for a caller who may not list the requests.
  const policy = (await punctualityPolicy(deps)).attendance;
  const lateEarlyByEmp = new Map<string, { date: string; kind: LateEarlyKind; at: string }[]>();
  for (const row of byId.get("lateEarly") ?? []) {
    const id = String(row.employeeId);
    (lateEarlyByEmp.get(id) ?? lateEarlyByEmp.set(id, []).get(id)!).push({ date: ymd(+new Date(row.date)), kind: row.kind as LateEarlyKind, at: String(row.at) });
  }
  const excusalsOf = (id: string) => {
    const reqs = lateEarlyByEmp.get(id);
    return reqs?.length ? excusalsByDay(reqs) : undefined;
  };

  const corrections = index("corrections");
  const leave = index("leave");
  const remote = index("remote");
  const overtime = index("overtime");
  const time = index("time");
  const expenses = index("expenses");
  const cards = index("cards");
  const goals = index("goals");
  const rating = index("rating");
  const reviewsOpen = index("reviewsOpen");
  const checkins = index("checkins");
  const kudos = index("kudos");
  const tickets = index("tickets");

  const keys = new Set(metrics.map((m) => m.key));
  const rows: PersonRow[] = people.map((p) => {
    const values: Record<string, number | null> = {};
    const put = (key: string, v: number | null) => { if (keys.has(key)) values[key] = v; };

    const att = summarizeAttendance(attendanceByEmp.get(p.uuid) ?? [], sched, excusalsOf(p.uuid), policy);
    put("late_early_approved", lateEarlyByEmp.get(p.uuid)?.length ?? 0);
    put("days_present", att.days_present);
    put("days_late", att.days_late);
    put("days_left_early", att.days_left_early);
    put("late_minutes", att.late_minutes);
    put("avg_arrival_minute", att.avg_arrival_minute);
    put("days_short", att.days_short);
    put("avg_worked_minutes", att.avg_worked_minutes);
    put("punctuality_pct", att.punctuality_pct);
    put("corrections_filed", num(corrections.get(p.uuid)?.filed));

    const lv = leave.get(p.uuid);
    put("leave_days_taken", round1(num(lv?.taken)));
    put("leave_days_pending", round1(num(lv?.pending)));
    put("leave_late_notice", num(lv?.lateNotice));

    // The days this person could have worked at all: the window's scheduled working days, clamped to their
    // employment and to today. Both the absence count and the remote share are shares of THIS, not of the
    // calendar - a joiner halfway through the month has not been absent for the half before they started, and
    // has not been "20% remote" for it either. Clamped to when HRMS records start as well (`tracked_from`):
    // nobody can punch into a system they were not in yet, so those days are not absences either.
    const joinedYmd = p.startDate ? ymd(+new Date(p.startDate)) : null;
    const trackedYmd = p.trackedFrom ? ymd(+new Date(p.trackedFrom)) : null;
    const expected = expectedWorkingDays({
      fromYmd: q.from,
      toYmd: q.to,
      workDays: sched.work_days,
      holidays,
      joinedYmd: trackedYmd && (!joinedYmd || trackedYmd > joinedYmd) ? trackedYmd : joinedYmd,
      leftYmd: p.endDate ? ymd(+new Date(p.endDate)) : null,
      todayYmd,
    });
    put("days_absent", Math.max(0, round1(expected - att.days_present - num(lv?.overlapDays))));

    const rw = remote.get(p.uuid);
    put("remote_days", num(rw?.days));
    put("remote_days_pending", num(rw?.pendingDays));
    put("remote_requests", num(rw?.requests));
    put("remote_declined", num(rw?.declined));
    // A share of no working days is not zero percent, it is unanswerable - so it stays null rather than
    // planting a 0% against somebody the window does not cover.
    put("remote_share_pct", expected ? Math.min(100, Math.round((num(rw?.days) / expected) * 100)) : null);

    const ex = expenses.get(p.uuid);
    put("expense_claimed", num(ex?.claimed) || null);
    put("expense_claims", num(ex?.claims) || null);

    const c = cards.get(p.uuid);
    put("tasks_delivered", num(c?.delivered));
    put("tasks_open", num(c?.open));
    put("tasks_overdue", num(c?.overdue));
    put("avg_cycle_days", num(c?.cycleCount) ? round1(num(c?.cycleMs) / num(c?.cycleCount) / DAY) : null);

    const g = goals.get(p.uuid);
    put("goals_active", num(g?.active));
    put("goals_completed", num(g?.completed));
    put("goals_overdue", num(g?.overdue));
    // Averaged over the goals in flight - the same set `progressSum` added up, so `active` is its denominator.
    put("avg_goal_progress", num(g?.active) ? Math.round(num(g?.progressSum) / num(g?.active)) : null);
    // Weighted attainment over the goals the window was FOR, falling back to their plain mean when the org
    // sets no weights - the same two-step a review scores with, so the report and the review agree.
    put("goal_attainment",
      num(g?.dueWeight) && !num(g?.dueUnweighted) ? Math.round(num(g?.dueEarned) / num(g?.dueWeight))
        : num(g?.dueCount) ? Math.round(num(g?.dueProgress) / num(g?.dueCount))
        : null);
    put("goals_at_risk", num(g?.atRisk));
    put("goals_stale", num(g?.stale));

    const r = rating.get(p.uuid);
    put("latest_rating", r?.rating == null ? null : Number(r.rating));
    put("reviews_open", num(reviewsOpen.get(p.uuid)?.open));
    const ci = checkins.get(p.uuid);
    put("checkins_held", num(ci?.held));
    put("avg_pulse", num(ci?.pulseCount) ? round1(num(ci?.pulseSum) / num(ci?.pulseCount)) : null);
    put("kudos_received", num(kudos.get(p.uuid)?.received));

    const tm = time.get(p.uuid);
    put("hours_logged", round1(num(tm?.hours)));
    put("billable_hours", round1(num(tm?.billable)));
    put("overtime_hours", round1(num(overtime.get(p.uuid)?.hours)));
    put("tickets_raised", num(tickets.get(p.uuid)?.raised));

    return {
      employee: `employees/${p.uuid}`,
      name: `${p.firstName} ${p.lastName}`.trim(),
      employee_number: p.employeeNumber ?? null,
      job_title: p.jobTitle ?? null,
      department: p.departmentId ? `departments/${p.departmentId}` : null,
      manager: p.managerId ? `employees/${p.managerId}` : null,
      values,
    };
  });

  // The team line: a sum where the measure is a count and a mean where it is a rate, over the people who have
  // a number at all (averaging a null arrival time as zero would put the team's average start at midnight).
  //
  // Computed BEFORE the team-only measures are stripped from the person rows below, because the group total
  // is the one form in which they may be reported. The order is load-bearing: strip first and the team line
  // would have nothing to sum.
  const team: Record<string, number | null> = {};
  const bigEnough = teamOnlyReportable(rows.length);
  for (const m of metrics) {
    // A roster too small to hide anybody gets no team-only figure at all. Absent rather than null-because-
    // empty: both read as "no number", and the distinction costs a reader nothing here.
    if (m.teamOnly && !bigEnough) continue;
    const vals = rows.map((r) => r.values[m.key]).filter((v): v is number => v != null);
    if (!vals.length) { team[m.key] = null; continue; }
    const total = vals.reduce((a, b) => a + b, 0);
    team[m.key] = m.agg === "sum" ? round1(total) : Math.round((total / vals.length) * 10) / 10;
  }

  // THE CLOSURE. A team-only measure leaves no per-person trace, whatever the request asked for - one named
  // employee, an explicit id list, or the whole roster. Done here, on the way out, rather than at any of the
  // places a person row is built: there is one exit and several constructions, so this is the spot where
  // "no request shape returns it for an individual" is a property of the code rather than a claim about it.
  for (const r of rows) r.values = withoutTeamOnly(r.values, metrics);

  const workingDays = expectedWorkingDays({ fromYmd: q.from, toYmd: q.to, workDays: sched.work_days, holidays, todayYmd });

  // The calendar: one named person's days, in date order, each with what they worked and whether they were
  // late by the same rule the rest of the report uses. Only ever for ONE person - a series per head is a
  // different (and much dearer) request than a table of totals.
  let series: AttendanceSeriesDay[] | undefined;
  if (q.series && q.employeeId && people.length === 1 && wants("attendance")) {
    const days = attendanceByEmp.get(q.employeeId) ?? [];
    const startMin = hhmmToMin(sched.shift_start);
    const endMin = hhmmToMin(sched.shift_end);
    const graceOf = new Map((sched.grace_exceptions ?? []).map((e) => [e.date, e.extra_grace_minutes == null ? Infinity : sched.grace_minutes + e.extra_grace_minutes]));
    const excusals = excusalsOf(q.employeeId);
    series = [...days]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({
        day: d.day,
        worked_minutes: d.workedMinutes,
        // Arrival only, as it always was here; judged by the rule the table above uses, approved window and all.
        late: judgeDay({
          arrMin: localMinutes(d.firstIn, sched.timezone), depMin: null, open: d.open, startMin, endMin,
          grace: graceOf.get(d.day) ?? sched.grace_minutes, flexible: sched.flexible_hours, excusal: excusals?.get(d.day), policy,
        }).late,
      }));
  }

  return {
    window: { from: q.from, to: q.to, timezone: sched.timezone, working_days: workingDays },
    groups,
    metrics,
    people: rows,
    team,
    truncated,
    ...(series ? { series } : {}),
  };
}
