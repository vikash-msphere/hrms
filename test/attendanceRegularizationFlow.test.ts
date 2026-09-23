/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createRegularization, approveRegularization } from "../src/services/attendanceRegularizations";
import { listSessions, clockIn, clockOut } from "../src/services/attendance";
import type { ListScope } from "../src/domain/access";
import { DEFAULT_ATTENDANCE, localDay } from "../src/domain/attendance";

// Real-D1 (miniflare) flow test for the reimagined attendance correction: a regularization carries the whole
// day's intended sessions; approving it supersedes that day's existing punches and writes the requested ones as
// `correction` sessions, so the derived day recomputes with no double-count and nothing to reconcile by hand.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.attendanceSessions, schema.attendanceRegularizations, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  // One actor files and approves; the attendance effect is the subject, not maker-checker
  // (test/decisionGuard.test.ts), so the org opts into self-approval.
  await deps.db.insert(schema.settings).values({ key: "approvals", value: JSON.stringify({ allow_self_approval: true }) });
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

async function punch(employeeId: string, clockIn: string, clockOut: string) {
  await deps.db.insert(schema.attendanceSessions).values({
    code: `04-${genId().slice(0, 6)}`, employeeId, clockIn: new Date(clockIn), clockOut: new Date(clockOut), source: "clock",
  });
}

const liveSessions = (employeeId: string) =>
  listSessions(deps, ALL, 100).then(({ items }) => items.filter((s) => s.employeeId === employeeId));

describe("attendance regularization: whole-day correction supersedes existing punches", () => {
  it("approving a multi-session correction replaces the day's punches (no double-count)", async () => {
    const actor = await seedActor();
    // A single wrong punch on 2026-07-14 IST (03:30Z = 09:00 IST .. 06:30Z = 12:00 IST).
    await punch(actor.employeeId!, "2026-07-14T03:30:00.000Z", "2026-07-14T06:30:00.000Z");

    const reg = await createRegularization(deps, actor, {
      date: "2026-07-14",
      sessions: [
        { clock_in: "2026-07-14T03:30:00.000Z", clock_out: "2026-07-14T07:30:00.000Z" }, // 09:00-13:00 IST
        { clock_in: "2026-07-14T08:30:00.000Z", clock_out: "2026-07-14T12:40:00.000Z" }, // 14:00-18:10 IST
      ],
      reason: "forgot to clock the afternoon",
    });
    expect(reg.state).toBe("PENDING");
    expect(reg.sessions).toHaveLength(2);

    await approveRegularization(deps, actor, reg.uuid);

    // The original clock punch is soft-superseded (still in the table for audit, but hidden from lists).
    const all = await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.employeeId, actor.employeeId!));
    const superseded = all.filter((s) => s.supersededBy === reg.uuid);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.source).toBe("clock");

    // The live view shows exactly the two requested correction sessions - the old punch is gone.
    const live = await liveSessions(actor.employeeId!);
    expect(live).toHaveLength(2);
    expect(live.every((s) => s.source === "correction")).toBe(true);
    expect(live.every((s) => s.supersededBy === null)).toBe(true);
  });

  it("an empty-sessions correction clears the day", async () => {
    const actor = await seedActor();
    await punch(actor.employeeId!, "2026-07-15T03:30:00.000Z", "2026-07-15T12:00:00.000Z");

    const reg = await createRegularization(deps, actor, { date: "2026-07-15", sessions: [], reason: "clocked the wrong day" });
    await approveRegularization(deps, actor, reg.uuid);

    const live = await liveSessions(actor.employeeId!);
    expect(live).toHaveLength(0);
  });

  // WEST OF UTC. `attendance_regularizations.date` is a date-only column anchored at UTC midnight, like every
  // other one in the schema, so the day it names is read in UTC. The approval read it with
  // `localDay(+row.date, tz)` instead: in a timezone behind UTC, midnight-Z on the requested day is the
  // PREVIOUS evening locally, so it superseded the wrong day's punches while writing the (correct, absolute)
  // corrected instants - two days wrong from one approval. Every other test here runs in the default
  // Asia/Kolkata, where midnight-Z is 05:30 the same morning and the bug cannot appear.
  it("corrects the requested day, not the day before, for an org behind UTC", async () => {
    const actor = await seedActor();
    await deps.db.insert(schema.settings).values({ key: "attendance", value: JSON.stringify({ ...DEFAULT_ATTENDANCE, timezone: "America/New_York" }) });

    // 2026-07-13, 09:00-17:00 New York (UTC-4). Must survive: it is not the day being corrected.
    await punch(actor.employeeId!, "2026-07-13T13:00:00.000Z", "2026-07-13T21:00:00.000Z");
    // 2026-07-14, 09:00-11:00 New York - the short punch the employee is asking to correct.
    await punch(actor.employeeId!, "2026-07-14T13:00:00.000Z", "2026-07-14T15:00:00.000Z");

    const reg = await createRegularization(deps, actor, {
      date: "2026-07-14",
      sessions: [{ clock_in: "2026-07-14T13:00:00.000Z", clock_out: "2026-07-14T21:00:00.000Z" }], // 09:00-17:00 NY
      reason: "forgot to clock out",
    });
    await approveRegularization(deps, actor, reg.uuid);

    const all = await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.employeeId, actor.employeeId!));
    const superseded = all.filter((s) => s.supersededBy === reg.uuid);
    expect(superseded, "exactly one punch - the 14th's - is replaced").toHaveLength(1);
    expect(+new Date(superseded[0]!.clockIn), "the 13th's punch must be untouched").toBe(Date.parse("2026-07-14T13:00:00.000Z"));

    const live = await liveSessions(actor.employeeId!);
    expect(live).toHaveLength(2); // the 13th's original punch + the 14th's correction
    expect(live.filter((s) => s.source === "clock")).toHaveLength(1);
    expect(live.filter((s) => s.source === "correction")).toHaveLength(1);
  });

  it("rejects overlapping or reversed sessions", async () => {
    const actor = await seedActor();
    await expect(createRegularization(deps, actor, { date: "2026-07-16", sessions: [{ clock_in: "2026-07-16T09:00:00.000Z", clock_out: "2026-07-16T08:00:00.000Z" }] })).rejects.toThrow();
    await expect(createRegularization(deps, actor, {
      date: "2026-07-16",
      sessions: [
        { clock_in: "2026-07-16T03:00:00.000Z", clock_out: "2026-07-16T07:00:00.000Z" },
        { clock_in: "2026-07-16T06:00:00.000Z", clock_out: "2026-07-16T09:00:00.000Z" },
      ],
    })).rejects.toThrow();
  });
});

// The date window and the page are both decided in SQL now. They used to be applied in JS over the whole
// scoped table - which for an HR caller (breadth `all`, so no scope predicate at all) meant reading every row
// of `attendance_sessions`, the app's highest-volume table, on every request, to keep about a month of it.
// The Attendance page asks three times per view and follows the cursor up to ten pages each time. These pin
// the behaviour the rewrite has to preserve: the same rows, in the same order, across a cursor.
describe("attendance list: the window and the page are bound in SQL", () => {
  it("returns only sessions whose punch falls inside [from, to]", async () => {
    const actor = await seedActor();
    await punch(actor.employeeId!, "2026-01-10T03:30:00.000Z", "2026-01-10T12:30:00.000Z");
    await punch(actor.employeeId!, "2026-02-10T03:30:00.000Z", "2026-02-10T12:30:00.000Z");
    await punch(actor.employeeId!, "2026-03-10T03:30:00.000Z", "2026-03-10T12:30:00.000Z");

    const { items } = await listSessions(deps, ALL, 100, undefined, {
      from: Date.parse("2026-02-01T00:00:00.000Z"),
      to: Date.parse("2026-02-28T23:59:59.999Z"),
    });
    expect(items.map((s) => new Date(s.clockIn).toISOString().slice(0, 10))).toEqual(["2026-02-10"]);

    // An open-ended window (the "last two days" call the top-bar clock makes) keeps everything at or after it.
    const { items: since } = await listSessions(deps, ALL, 100, undefined, { from: Date.parse("2026-02-01T00:00:00.000Z") });
    expect(since).toHaveLength(2);
  });

  it("pages newest-first through the window without dropping or repeating a row", async () => {
    const actor = await seedActor();
    for (const day of ["2026-04-01", "2026-04-02", "2026-04-03"]) {
      await punch(actor.employeeId!, `${day}T03:30:00.000Z`, `${day}T12:30:00.000Z`);
    }
    const window = { from: Date.parse("2026-04-01T00:00:00.000Z"), to: Date.parse("2026-04-30T00:00:00.000Z") };

    const first = await listSessions(deps, ALL, 2, undefined, window);
    expect(first.items.map((s) => new Date(s.clockIn).toISOString().slice(0, 10))).toEqual(["2026-04-03", "2026-04-02"]);
    expect(first.nextPageToken).toBeTruthy();

    const second = await listSessions(deps, ALL, 2, first.nextPageToken, window);
    expect(second.items.map((s) => new Date(s.clockIn).toISOString().slice(0, 10))).toEqual(["2026-04-01"]);
    expect(second.nextPageToken).toBeFalsy();
  });

  it("still hides a superseded punch, and still answers `open` on its own", async () => {
    const actor = await seedActor();
    await punch(actor.employeeId!, "2026-05-04T03:30:00.000Z", "2026-05-04T12:30:00.000Z");
    await deps.db.insert(schema.attendanceSessions).values({
      code: `04-${genId().slice(0, 6)}`, employeeId: actor.employeeId!, clockIn: new Date("2026-05-05T03:30:00.000Z"), source: "clock",
    });
    const { items: open } = await listSessions(deps, ALL, 100, undefined, { open: true });
    expect(open).toHaveLength(1);
    expect(open[0]!.clockOut).toBeNull();

    // `superseded_by` names the REGULARIZATION whose approval replaced the punch, so it has to be a real one.
    const reg = await createRegularization(deps, actor, { date: "2026-05-04", sessions: [], reason: "wrong day" });
    const supersede = (await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.employeeId, actor.employeeId!)))[0]!;
    await deps.db.update(schema.attendanceSessions).set({ supersededBy: reg.uuid }).where(eq(schema.attendanceSessions.uuid, supersede.uuid));
    const { items: live } = await listSessions(deps, ALL, 100);
    expect(live.map((s) => s.uuid)).not.toContain(supersede.uuid);
  });
});

// ---- Correcting a day you are still clocked in on must not lock the clock ------------------------------------
//
// A regularization supersedes the day's punches selected by `clock_in`, an OPEN session among them included,
// and writes only CLOSED corrected pairs in their place - so the superseded row keeps `clock_out` null for
// good. `openSessionFor` gates both punches and was the one reader of this table that did not filter
// `superseded_by` (every other one does: `listSessions` here, compOff, peopleAnalytics, and the loss-of-pay
// assemblers in payroll and settlements). Counted as open, that dead row meant:
//
//   - `clockIn` answered "already clocked in" FOREVER - the person could never punch again,
//   - and loss of pay is derived from punches, so every subsequent working day was docked as a full absence,
//   - while `clockOut` appeared to release it only by writing `clock_out` onto a row every derived reader
//     ignores, discarding the punch.
//
// No race is needed to reach it: correcting today's morning punch while still at work is enough.
describe("attendance: a superseded open session does not count as being clocked in", () => {
  const noFence = { ip: null, allowList: undefined };

  it("lets the employee clock in again after a correction supersedes their open session", async () => {
    const actor = await seedActor();
    const open = await clockIn(deps, actor, noFence);
    expect(open.clockOut).toBeNull();

    // The day the punch BELONGS to is its org-local one, which is what the supersede query matches on
    // (`localDay`) - a punch late in the UTC evening is already tomorrow in Asia/Kolkata, so reading its UTC
    // day here would target a day with nothing on it. Same distinction domain/attendance.ts#utcDay sets out.
    const day = localDay(+new Date(open.clockIn), DEFAULT_ATTENDANCE.timezone);
    const reg = await createRegularization(deps, actor, {
      date: day,
      sessions: [{ clock_in: `${day}T03:30:00.000Z`, clock_out: `${day}T07:30:00.000Z` }],
      reason: "clocked in at the wrong time",
    });
    await approveRegularization(deps, actor, reg.uuid);

    // The open punch was superseded and still carries a null clock_out - that is the shape of the trap.
    const dead = (await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.uuid, open.uuid)))[0]!;
    expect(dead.supersededBy).toBe(reg.uuid);
    expect(dead.clockOut).toBeNull();

    // ...and it must not read as "clocked in". Before the filter this threw "already clocked in", permanently.
    const again = await clockIn(deps, actor, noFence);
    expect(again.uuid).not.toBe(open.uuid);
    expect(again.supersededBy).toBeNull();
  });

  it("refuses a second concurrent punch instead of leaving two open sessions", async () => {
    // `clockIn` reads "is anything open" and then inserts, which is two statements - a double-tapped button
    // (or a phone and a laptop) passes the same check twice. `att_open_emp_idx` is what stops both rows
    // existing; without it the second row is orphaned the moment the first is clocked out, and the employee
    // is in the same permanent lockout as above. The answer is the one the pre-read gives in words, not a 500.
    const actor = await seedActor();
    const [first, second] = await Promise.allSettled([clockIn(deps, actor, noFence), clockIn(deps, actor, noFence)]);
    const settled = [first, second];
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason?.message ?? refused.reason)).toContain("already clocked in");

    const rows = await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.employeeId, actor.employeeId!));
    expect(rows.filter((s) => s.clockOut === null && s.supersededBy === null)).toHaveLength(1);

    // And the survivor is a real, closable session rather than an orphan.
    const closed = await clockOut(deps, actor);
    expect(closed.clockOut).not.toBeNull();
  });
});
