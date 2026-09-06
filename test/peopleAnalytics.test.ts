/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { ListScope } from "../src/domain/access";
import { peopleAnalytics } from "../src/services/peopleAnalytics";
import { ANALYTICS_COLLECTIONS, METRICS, summarizeAttendance, expectedWorkingDays } from "../src/domain/peopleAnalytics";

// The people report's contract: every measure equals what the caller would have counted from the collection
// it came from (same scope binding, same filters), a collection the middleware did not scope contributes no
// column at all, and punctuality is judged by the same rules the Attendance page shows a day by.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [
  schema.attendanceSessions, schema.attendanceRegularizations, schema.leaveRequests, schema.leaveTypes,
  schema.remoteWorkRequests, schema.overtimeRequests, schema.timeEntries, schema.projects,
  schema.cards, schema.boards, schema.goals, schema.reviews, schema.reviewCycles, schema.checkIns,
  schema.announcements, schema.tickets, schema.holidays, schema.employees, schema.departments,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const A = { uuid: genId(), code: "04-001-001" };
const B = { uuid: genId(), code: "04-001-002" };

const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const own = (ownerId: string): ListScope => ({ breadth: "own", deptCode: null, ownerId, seeRestricted: false });
const allScopes = () => new Map<string, ListScope>(ANALYTICS_COLLECTIONS.map((c) => [c, all()]));

// A settled month in the past, so "today" never clips the window and nothing is still in flight.
const WINDOW = { from: "2026-06-01", to: "2026-06-30" };
const at = (iso: string) => new Date(Date.parse(iso));
const day = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`));

async function seed() {
  await deps.db.insert(schema.employees).values([
    { uuid: A.uuid, code: A.code, firstName: "Aya", lastName: "One", workEmail: "a@x.test", employeeNumber: "EMP-0001", jobTitle: "Engineer", status: "active", startDate: day("2024-01-01") },
    { uuid: B.uuid, code: B.code, firstName: "Bo", lastName: "Two", workEmail: "b@x.test", status: "active", startDate: day("2024-01-01") },
  ]);

  // Punches, in Asia/Kolkata (the default schedule: 09:00-18:00, 15 minutes of grace).
  await deps.db.insert(schema.attendanceSessions).values([
    // A, Jun 1: in 09:05 IST (inside grace), out 18:15 IST -> 550 worked minutes, on time.
    { uuid: genId(), code: `${A.code}-s1`, employeeId: A.uuid, clockIn: at("2026-06-01T03:35:00Z"), clockOut: at("2026-06-01T12:45:00Z") },
    // A, Jun 2: in 10:30 IST (90 minutes late), out 17:30 IST (30 early) -> 420 worked minutes, under a full day.
    { uuid: genId(), code: `${A.code}-s2`, employeeId: A.uuid, clockIn: at("2026-06-02T05:00:00Z"), clockOut: at("2026-06-02T12:00:00Z") },
    // B, Jun 1: in 08:30 IST and never clocked out - the day is still open, so it is judged on arrival only.
    { uuid: genId(), code: `${B.code}-s1`, employeeId: B.uuid, clockIn: at("2026-06-01T03:00:00Z") },
    // Outside the window: must not count.
    { uuid: genId(), code: `${A.code}-s3`, employeeId: A.uuid, clockIn: at("2026-05-20T05:00:00Z"), clockOut: at("2026-05-20T12:00:00Z") },
  ]);
  await deps.db.insert(schema.attendanceRegularizations).values({
    uuid: genId(), code: `${A.code}-r1`, employeeId: A.uuid, date: day("2026-06-02"), sessions: [], state: "PENDING",
  });

  const lt = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: "01", name: "Annual" });
  await deps.db.insert(schema.leaveRequests).values([
    { uuid: genId(), code: `${A.code}-l1`, employeeId: A.uuid, leaveTypeId: lt, startDate: day("2026-06-10"), endDate: day("2026-06-12"), days: 3, state: "APPROVED", createdAt: at("2026-06-01T00:00:00Z") },
    { uuid: genId(), code: `${A.code}-l2`, employeeId: A.uuid, leaveTypeId: lt, startDate: day("2026-06-18"), endDate: day("2026-06-19"), days: 2, state: "PENDING", createdAt: at("2026-06-01T00:00:00Z") },
    // Filed the day after it began: short notice.
    { uuid: genId(), code: `${A.code}-l3`, employeeId: A.uuid, leaveTypeId: lt, startDate: day("2026-06-15"), endDate: day("2026-06-15"), days: 1, state: "APPROVED", createdAt: at("2026-06-16T00:00:00Z") },
  ]);
  await deps.db.insert(schema.remoteWorkRequests).values([
    { uuid: genId(), code: `${A.code}-w1`, employeeId: A.uuid, startDate: day("2026-06-08"), endDate: day("2026-06-09"), state: "APPROVED" },
    { uuid: genId(), code: `${A.code}-w2`, employeeId: A.uuid, startDate: day("2026-06-22"), endDate: day("2026-06-24"), state: "PENDING" },
    { uuid: genId(), code: `${A.code}-w3`, employeeId: A.uuid, startDate: day("2026-06-25"), endDate: day("2026-06-25"), state: "REJECTED" },
    // Withdrawn before anyone decided: not a request they made of anybody.
    { uuid: genId(), code: `${A.code}-w4`, employeeId: A.uuid, startDate: day("2026-06-26"), endDate: day("2026-06-26"), state: "CANCELLED" },
  ]);
  await deps.db.insert(schema.overtimeRequests).values([
    { uuid: genId(), code: `${A.code}-o1`, employeeId: A.uuid, date: day("2026-06-03"), startTime: at("2026-06-03T13:00:00Z"), endTime: at("2026-06-03T15:00:00Z"), state: "APPROVED" },
    { uuid: genId(), code: `${A.code}-o2`, employeeId: A.uuid, date: day("2026-06-04"), startTime: at("2026-06-04T13:00:00Z"), endTime: at("2026-06-04T15:00:00Z"), state: "PENDING" },
  ]);

  const proj = genId();
  await deps.db.insert(schema.projects).values({ uuid: proj, code: "01", name: "Platform" });
  await deps.db.insert(schema.timeEntries).values([
    { uuid: genId(), code: `${A.code}-t1`, employeeId: A.uuid, projectId: proj, date: day("2026-06-03"), hours: 8, billable: true, status: "APPROVED" },
    { uuid: genId(), code: `${A.code}-t2`, employeeId: A.uuid, projectId: proj, date: day("2026-06-04"), hours: 2, billable: false, status: "DRAFT" },
  ]);

  const board = genId();
  await deps.db.insert(schema.boards).values({ uuid: board, code: "01", name: "Board" });
  await deps.db.insert(schema.cards).values([
    { uuid: genId(), code: `${A.code}-c1`, boardId: board, employeeId: A.uuid, assigneeId: A.uuid, columnKey: "done", rank: 1, title: "shipped", startedAt: at("2026-06-02T00:00:00Z"), deliveredAt: at("2026-06-05T00:00:00Z") },
    { uuid: genId(), code: `${A.code}-c2`, boardId: board, employeeId: A.uuid, assigneeId: A.uuid, columnKey: "doing", rank: 2, title: "late", dueDate: day("2026-06-20") },
    { uuid: genId(), code: `${A.code}-c3`, boardId: board, employeeId: A.uuid, assigneeId: A.uuid, columnKey: "done", rank: 3, title: "old", startedAt: at("2026-05-01T00:00:00Z"), deliveredAt: at("2026-05-03T00:00:00Z") },
  ]);

  await deps.db.insert(schema.goals).values([
    { uuid: genId(), code: `${A.code}-g1`, employeeId: A.uuid, title: "in flight", status: "in_progress", progress: 60 },
    { uuid: genId(), code: `${A.code}-g2`, employeeId: A.uuid, title: "slipped", status: "not_started", progress: 0, dueDate: day("2026-06-10") },
    { uuid: genId(), code: `${A.code}-g3`, employeeId: A.uuid, title: "done", status: "completed", progress: 100, updatedAt: at("2026-06-20T00:00:00Z") },
  ]);

  const cycle = genId();
  await deps.db.insert(schema.reviewCycles).values({ uuid: cycle, code: "01", name: "H1 2026", state: "ACTIVE" });
  await deps.db.insert(schema.reviews).values([
    { uuid: genId(), code: `${A.code}-v1`, cycleId: cycle, employeeId: A.uuid, state: "SHARED", overallRating: 4, updatedAt: at("2026-06-25T00:00:00Z") },
    // Not shared yet: it must not become the person's rating, but it is still an open review.
    { uuid: genId(), code: `${A.code}-v2`, cycleId: cycle, employeeId: A.uuid, state: "MANAGER", overallRating: 2, updatedAt: at("2026-06-26T00:00:00Z") },
  ]);

  await deps.db.insert(schema.checkIns).values([
    { uuid: genId(), code: `${A.code}-k1`, employeeId: A.uuid, meetingDate: day("2026-06-05"), pulse: 4 },
    { uuid: genId(), code: `${A.code}-k2`, employeeId: A.uuid, meetingDate: day("2026-06-19"), pulse: 5 },
    { uuid: genId(), code: `${A.code}-k3`, employeeId: A.uuid, meetingDate: day("2026-05-19"), pulse: 1 }, // before the window
  ]);

  await deps.db.insert(schema.announcements).values([
    { uuid: genId(), code: `${B.code}-a1`, kind: "kudos", title: "", body: "nice work", authorEmployeeId: B.uuid, recipientEmployeeId: A.uuid, published: true, publishTime: at("2026-06-11T00:00:00Z") },
    { uuid: genId(), code: `${B.code}-a2`, kind: "post", title: "notice", body: "hello", authorEmployeeId: B.uuid, published: true, publishTime: at("2026-06-11T00:00:00Z") },
  ]);

  await deps.db.insert(schema.tickets).values([
    { uuid: genId(), code: `${A.code}-i1`, employeeId: A.uuid, subject: "laptop", priority: "medium", state: "OPEN", createdAt: at("2026-06-07T00:00:00Z") },
    { uuid: genId(), code: `${A.code}-i2`, employeeId: A.uuid, subject: "old", priority: "medium", state: "OPEN", createdAt: at("2026-05-07T00:00:00Z") },
  ]);
}

const rowFor = (out: { people: { employee: string; values: Record<string, number | null> }[] }, id: string) =>
  out.people.find((p) => p.employee === `employees/${id}`)!;

describe("people analytics", () => {
  it("reports every measure for a person the caller may see in full", async () => {
    await seed();
    const out = await peopleAnalytics(deps, allScopes(), WINDOW);
    expect(out.people).toHaveLength(2);
    expect(out.window.working_days).toBe(22); // June 2026, Mon-Fri, no holidays seeded
    const a = rowFor(out, A.uuid).values;

    // Attendance + punctuality
    expect(a.days_present).toBe(2);
    expect(a.days_late).toBe(1);
    expect(a.days_left_early).toBe(1);
    expect(a.late_minutes).toBe(90);
    expect(a.days_short).toBe(1);
    expect(a.avg_worked_minutes).toBe(485);
    expect(a.avg_arrival_minute).toBe(588); // mean of 09:05 and 10:30, in the org timezone
    expect(a.punctuality_pct).toBe(50);
    expect(a.corrections_filed).toBe(1);

    // Leave: 3 + 1 approved days start in the window, 2 pending, one filed after it began.
    expect(a.leave_days_taken).toBe(4);
    expect(a.leave_days_pending).toBe(2);
    expect(a.leave_late_notice).toBe(1);

    // Remote work
    expect(a.remote_days).toBe(2); // the approved pair; pending and rejected days are not days worked remotely
    expect(a.remote_days_pending).toBe(3);
    expect(a.remote_requests).toBe(3); // approved + pending + rejected; the cancelled one is not a request of anybody
    expect(a.remote_declined).toBe(1);
    expect(a.remote_share_pct).toBe(9); // 2 of the window's 22 working days
    // 22 scheduled working days, 2 of them worked, 4 covered by approved leave.
    expect(a.days_absent).toBe(16);

    // Tasks + goals
    expect(a.tasks_delivered).toBe(1); // the May delivery is outside the window
    expect(a.tasks_open).toBe(1);
    expect(a.tasks_overdue).toBe(1);
    expect(a.avg_cycle_days).toBe(3);
    expect(a.goals_active).toBe(2);
    expect(a.goals_completed).toBe(1);
    expect(a.goals_overdue).toBe(1);
    expect(a.avg_goal_progress).toBe(30); // 60 and 0 across the two in flight

    // Performance
    expect(a.latest_rating).toBe(4); // the unshared 2 is not this person's rating
    expect(a.reviews_open).toBe(2);
    expect(a.checkins_held).toBe(2);
    expect(a.avg_pulse).toBe(4.5);
    expect(a.kudos_received).toBe(1);

    // Time & effort
    expect(a.hours_logged).toBe(10);
    expect(a.billable_hours).toBe(8);
    expect(a.overtime_hours).toBe(2); // the pending request is not counted
    expect(a.tickets_raised).toBe(1);
  });

  it("judges an unfinished day on its arrival alone", async () => {
    await seed();
    const out = await peopleAnalytics(deps, allScopes(), WINDOW);
    const b2 = rowFor(out, B.uuid).values;
    expect(b2.days_present).toBe(1);
    expect(b2.days_late).toBe(0);
    expect(b2.days_left_early).toBe(0); // still clocked in - not an early departure
    expect(b2.days_short).toBe(0); // and not an under-hours day either
    expect(b2.avg_worked_minutes).toBe(null);
    expect(b2.punctuality_pct).toBe(100);
  });

  it("rolls the team line up by each measure's own aggregation", async () => {
    await seed();
    const out = await peopleAnalytics(deps, allScopes(), WINDOW);
    expect(out.team.days_present).toBe(3); // summed across both people
    expect(out.team.punctuality_pct).toBe(75); // averaged: 50 and 100
    expect(out.team.avg_worked_minutes).toBe(485); // B has no closed day, so it is not averaged in as zero
  });

  it("omits a measure whose collection the middleware did not scope", async () => {
    await seed();
    const scopes = new Map<string, ListScope>([["employees", all()], ["attendance", all()]]);
    const out = await peopleAnalytics(deps, scopes, WINDOW);
    expect(out.metrics.map((m) => m.key)).toEqual(
      METRICS.filter((m) => m.collection === "attendance" && !m.needs).map((m) => m.key),
    );
    const a = rowFor(out, A.uuid).values;
    expect(a.days_present).toBe(2);
    expect(a.leave_days_taken).toBeUndefined();
    // Absence leans on leave as well as attendance; without it the number would call leave an absence.
    expect(a.days_absent).toBeUndefined();
  });

  it("returns no rows at all when the caller may not list employees", async () => {
    await seed();
    const out = await peopleAnalytics(deps, new Map<string, ListScope>([["attendance", all()]]), WINDOW);
    expect(out.people).toEqual([]);
  });

  it("binds an own-breadth scope to the owner column, per collection", async () => {
    await seed();
    // Sees themselves in the directory, and only their own leave - the same rows their own lists would give.
    const scopes = new Map<string, ListScope>([
      ["employees", own(B.uuid)], ["leave-requests", own(B.uuid)], ["attendance", own(B.uuid)],
    ]);
    const out = await peopleAnalytics(deps, scopes, WINDOW);
    expect(out.people.map((p) => p.employee)).toEqual([`employees/${B.uuid}`]);
    expect(rowFor(out, B.uuid).values.leave_days_taken).toBe(0); // A's leave is not theirs to count
  });

  it("filters the roster by department", async () => {
    await seed();
    const dept = genId();
    await deps.db.insert(schema.departments).values({ uuid: dept, code: "04-002", name: "Ops" });
    await deps.db.update(schema.employees).set({ departmentId: dept });
    const out = await peopleAnalytics(deps, allScopes(), { ...WINDOW, departmentId: dept });
    expect(out.people).toHaveLength(2);
    const none = await peopleAnalytics(deps, allScopes(), { ...WINDOW, departmentId: genId() });
    expect(none.people).toEqual([]);
  });

  it("returns one person's day-by-day attendance when their calendar is asked for", async () => {
    await seed();
    const out = await peopleAnalytics(deps, allScopes(), { ...WINDOW, employeeId: A.uuid, series: true });
    expect(out.people.map((p) => p.employee)).toEqual([`employees/${A.uuid}`]);
    expect(out.series).toEqual([
      { day: "2026-06-01", worked_minutes: 550, late: false },
      { day: "2026-06-02", worked_minutes: 420, late: true },
    ]);
  });

  it("gives no series for a whole roster - a calendar per head is a different question", async () => {
    await seed();
    const out = await peopleAnalytics(deps, allScopes(), { ...WINDOW, series: true });
    expect(out.series).toBeUndefined();
  });

  it("narrows by employee without widening: an id outside the caller's scope returns nobody", async () => {
    await seed();
    const scopes = new Map<string, ListScope>([["employees", own(B.uuid)], ["attendance", own(B.uuid)]]);
    const out = await peopleAnalytics(deps, scopes, { ...WINDOW, employeeId: A.uuid, series: true });
    expect(out.people).toEqual([]);
    expect(out.series).toBeUndefined();
  });

  it("lets ONE person's calendar run a year, while a roster stays capped at a quarter", async () => {
    await seed();
    const year = { from: "2025-09-01", to: "2026-06-30" };
    await expect(peopleAnalytics(deps, allScopes(), { ...year, employeeId: A.uuid, series: true })).resolves.toBeTruthy();
    await expect(peopleAnalytics(deps, allScopes(), year)).rejects.toThrow(/92 days/);
    await expect(peopleAnalytics(deps, allScopes(), { from: "2024-01-01", to: "2026-06-30", employeeId: A.uuid })).rejects.toThrow(/400 days/);
  });

  it("refuses a window it cannot derive punctuality over", async () => {
    await seed();
    await expect(peopleAnalytics(deps, allScopes(), { from: "2026-01-01", to: "2026-12-31" })).rejects.toThrow(/92 days/);
    await expect(peopleAnalytics(deps, allScopes(), { from: "2026-06-30", to: "2026-06-01" })).rejects.toThrow(/precede/);
  });

  it("caps the roster and says so", async () => {
    await seed();
    const out = await peopleAnalytics(deps, allScopes(), { ...WINDOW, maxPeople: 1 });
    expect(out.people).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  // Every aggregate binds one parameter per person and D1 refuses a statement with more than 100 of them, so
  // a roster larger than the cap used to take the whole report down with `too many SQL variables` - the
  // report worked in testing and failed at the first real org. The ids are chunked; this is the size that
  // proves it, and that each chunk's rows survive the merge rather than the last one replacing the first.
  it("reports on a roster larger than D1's parameter cap", async () => {
    await seed();
    const extra = Array.from({ length: 120 }, (_, i) => ({
      uuid: genId(),
      code: `04-001-${String(i + 100).padStart(3, "0")}`,
      firstName: `Zed${String(i).padStart(3, "0")}`,
      lastName: "Bulk",
      workEmail: `bulk${i}@x.test`,
      status: "active" as const,
      startDate: day("2024-01-01"),
    }));
    // Inserted a few at a time for the same reason the report chunks its reads: one statement, 100 parameters.
    for (let i = 0; i < extra.length; i += 3) await deps.db.insert(schema.employees).values(extra.slice(i, i + 3));
    // One punch for the last person of the roster: their numbers come from a later chunk than A's, and both
    // have to be in the answer.
    await deps.db.insert(schema.attendanceSessions).values({
      uuid: genId(), code: `${extra[119]!.code}-s1`, employeeId: extra[119]!.uuid,
      clockIn: at("2026-06-01T03:35:00Z"), clockOut: at("2026-06-01T12:45:00Z"),
    });

    const out = await peopleAnalytics(deps, allScopes(), { ...WINDOW, maxPeople: 500 });
    expect(out.people).toHaveLength(122);
    expect(out.truncated).toBe(false);
    expect(rowFor(out, A.uuid).values.days_present).toBe(2);
    expect(rowFor(out, extra[119]!.uuid).values.days_present).toBe(1);
  });
});

describe("punctuality rules (pure)", () => {
  const sched = {
    timezone: "Asia/Kolkata", work_days: [1, 2, 3, 4, 5], shift_start: "09:00", shift_end: "18:00",
    grace_minutes: 15, full_day_minutes: 480, half_day_minutes: 240,
  };
  const dayAt = (d: string, inIso: string, outIso: string | null) => ({
    employeeId: "e", day: d, firstIn: Date.parse(inIso), lastOut: outIso ? Date.parse(outIso) : null,
    workedMinutes: outIso ? Math.round((Date.parse(outIso) - Date.parse(inIso)) / 60000) : 0, open: !outIso,
  });

  it("forgives lateness on a grace-exception day", async () => {
    const days = [dayAt("2026-06-02", "2026-06-02T05:00:00Z", "2026-06-02T12:45:00Z")];
    expect(summarizeAttendance(days, sched).days_late).toBe(1);
    const waived = summarizeAttendance(days, { ...sched, grace_exceptions: [{ date: "2026-06-02", reason: "transit strike" }] });
    expect(waived.days_late).toBe(0);
    const widened = summarizeAttendance(days, { ...sched, grace_exceptions: [{ date: "2026-06-02", extra_grace_minutes: 120 }] });
    expect(widened.days_late).toBe(0);
  });

  it("flags nothing on punctuality when the schedule is flexible", () => {
    const days = [dayAt("2026-06-02", "2026-06-02T05:00:00Z", "2026-06-02T09:00:00Z")];
    const out = summarizeAttendance(days, { ...sched, flexible_hours: true });
    expect(out.days_late).toBe(0);
    expect(out.days_left_early).toBe(0);
    expect(out.days_short).toBe(1); // minutes still decide whether the day was a full one
  });

  it("counts a person's expected working days inside their employment only", () => {
    const args = { fromYmd: "2026-06-01", toYmd: "2026-06-30", workDays: [1, 2, 3, 4, 5], holidays: new Set<string>(), todayYmd: "2026-08-26" };
    expect(expectedWorkingDays(args)).toBe(22);
    expect(expectedWorkingDays({ ...args, joinedYmd: "2026-06-15" })).toBe(12);
    expect(expectedWorkingDays({ ...args, leftYmd: "2026-06-12" })).toBe(10);
    expect(expectedWorkingDays({ ...args, holidays: new Set(["2026-06-03"]) })).toBe(21);
    // A window that runs past today stops at today: tomorrow is not an absence.
    expect(expectedWorkingDays({ ...args, toYmd: "2026-06-30", todayYmd: "2026-06-10" })).toBe(8);
  });
});
