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
import { bustRef } from "../src/lib/refData";
import { crudService } from "../src/services/crud";
import { DEFAULT_ATTENDANCE } from "../src/domain/attendance";
import { workPatternAssignmentSpec, type WorkPatternAssignmentInput } from "../src/services/workPatternAssignments";
import { scheduleCtxFor } from "../src/services/workSchedule";

// WHO IS ON WHICH SCHEDULE, AND WHEN - the service's own judgement, not the arithmetic.
//
// The day-by-day rule is workSchedule.test.ts and what it does to pay is attendanceLop.test.ts. What is left
// here is the thing that decides which of those rules applies to a given day: two live assignments for one
// person may not overlap, because a day resolving to two patterns has no answer. SQLite cannot express range
// overlap as an index, so this check IS the constraint - and the one overlap it accepts (moving somebody onto
// a new schedule, which closes the open-ended one they were on) is the ordinary way a schedule changes.
//
// The resolution half is asserted through `scheduleCtxFor`, so the test reads the same answer the payroll
// build does rather than a restatement of it.

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
  schema.workPatternAssignments, schema.workPatterns, schema.shiftAssignments, schema.shifts,
  schema.auditLog, schema.eventLog, schema.notifications,
  schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
  bustRef(deps, "settings");
});

// 2026-01-05 is a Monday.
const AYA = { id: genId(), code: "04-001-001" };
const HR = { id: genId(), code: "09-001-001" };
const MORNING = genId();
const MWF = genId();
let actor: AppUser;

const service = crudService<WorkPatternAssignmentInput, typeof schema.workPatternAssignments>(workPatternAssignmentSpec);

async function seed() {
  await deps.db.insert(schema.employees).values([
    { uuid: AYA.id, code: AYA.code, firstName: "Aya", lastName: "One", workEmail: "aya@x.test", status: "active" },
    { uuid: HR.id, code: HR.code, firstName: "Hana", lastName: "Two", workEmail: "hr@x.test", status: "active" },
  ]);
  await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: "u-1", email: "hr@x.test", role: "hr_admin", employeeId: HR.id });
  actor = { uuid, email: "hr@x.test", role: "hr_admin", status: "active", employeeId: HR.id, employeeCode: HR.code } as unknown as AppUser;

  await deps.db.insert(schema.shifts).values({ uuid: MORNING, code: "z001", name: "Morning", startTime: "09:00", endTime: "13:00", breakMinutes: 0 });
  // Mon/Wed/Fri mornings: the cycle is indexed weekday 0=Sun..6=Sat, so 1, 3 and 5 are the working slots.
  const days = [null, MORNING, null, MORNING, null, MORNING, null];
  await deps.db.insert(schema.workPatterns).values({ uuid: MWF, code: "z002", name: "MWF mornings", cycleWeeks: 1, daysJson: JSON.stringify(days) });

  // Days resolve per person, or none of the above decides anything (domain/workSchedule.ts ScheduleSource).
  await deps.db.insert(schema.settings).values({
    key: "attendance",
    value: JSON.stringify({ ...DEFAULT_ATTENDANCE, schedule_source: "resolved" }),
    updatedAt: new Date(),
  });
  deps.refCache?.clear();
  bustRef(deps, "settings");
}

const assign = (over: Partial<WorkPatternAssignmentInput> = {}) =>
  service.create(deps, actor, { employee: `employees/${AYA.id}`, pattern: `work-patterns/${MWF}`, start_date: "2026-01-05", ...over });

const live = () => deps.db.select().from(schema.workPatternAssignments).where(eq(schema.workPatternAssignments.employeeId, AYA.id));

describe("putting somebody on a schedule", () => {
  it("records the window, owner-embedded so the list scope can bind to it", async () => {
    await seed();
    const row = await assign();
    expect(row.employeeId).toBe(AYA.id);
    expect(row.patternId).toBe(MWF);
    // Open ended is the ordinary case: somebody is on a schedule until they are moved off it.
    expect(row.endDate).toBeNull();
    // The cycle counts from the start unless a rotation is deliberately offset.
    expect(row.anchorDate).toBeNull();
    expect(String(row.code).startsWith(AYA.code)).toBe(true);
  });

  it("refuses a window with no pattern, and one that ends before it starts", async () => {
    await seed();
    await expect(assign({ pattern: null })).rejects.toThrow(/pattern is required/);
    await expect(assign({ end_date: "2026-01-01" })).rejects.toThrow(/before start_date/);
  });
});

describe("two live assignments for one person may not overlap", () => {
  it("refuses a window inside a closed one, naming the dates that clash", async () => {
    await seed();
    await assign({ start_date: "2026-01-05", end_date: "2026-03-31" });
    await expect(assign({ start_date: "2026-02-01", end_date: "2026-02-28" }))
      .rejects.toThrow(/overlaps a schedule they are already on \(2026-01-05 to 2026-03-31\)/);
  });

  it("refuses two schedules starting on the same day", async () => {
    await seed();
    await assign({ start_date: "2026-01-05" });
    // Not a change of schedule - two schedules. The open-ended arm below needs the new one to start AFTER.
    await expect(assign({ start_date: "2026-01-05" })).rejects.toThrow(/overlaps a schedule/);
  });

  it("allows a window that starts the day the previous one ended", async () => {
    await seed();
    await assign({ start_date: "2026-01-05", end_date: "2026-01-31" });
    const next = await assign({ start_date: "2026-02-01" });
    expect(next.uuid).toBeTruthy();
    expect((await live()).length).toBe(2);
  });

  // THE ONE OVERLAP THAT IS ACCEPTED, and the reason it is: "Aya moves to the night rotation from March" is
  // how a schedule changes, and refusing it would make the common case a two-step chore whose first step
  // leaves somebody on no schedule at all.
  it("closes an open-ended schedule the day before a new one starts", async () => {
    await seed();
    const first = await assign({ start_date: "2026-01-05" });
    await assign({ start_date: "2026-03-02" });
    const rows = await live();
    expect(rows.length).toBe(2);
    const closed = rows.find((r) => r.uuid === first.uuid)!;
    // The day BEFORE the new one starts, so no day belongs to both.
    expect(closed.endDate && new Date(closed.endDate).toISOString().slice(0, 10)).toBe("2026-03-01");
  });

  // A PATCH does not get the truncation: closing somebody's other assignment is a decision about a different
  // row, and it belongs to the deliberate act of putting them on a new schedule rather than to an edit.
  it("refuses a PATCH that moves a window onto another live one", async () => {
    await seed();
    await assign({ start_date: "2026-01-05", end_date: "2026-01-31" });
    const second = await assign({ start_date: "2026-03-02" });
    await expect(service.update(deps, actor, second.uuid, { start_date: "2026-01-20" }))
      .rejects.toThrow(/overlaps a schedule/);
  });

  // A soft-deleted assignment is not a live one, so the day it covered is free again.
  it("ignores a withdrawn assignment when checking the overlap", async () => {
    await seed();
    const first = await assign({ start_date: "2026-01-05", end_date: "2026-03-31" });
    await service.remove(deps, actor, first.uuid);
    const again = await assign({ start_date: "2026-02-01", end_date: "2026-02-28" });
    expect(again.uuid).toBeTruthy();
  });
});

describe("what the assignment means for a day", () => {
  it("gives the person the pattern's days, and the org's week once it ends", async () => {
    await seed();
    await assign({ start_date: "2026-01-05", end_date: "2026-01-09" });
    const sched = (await scheduleCtxFor(deps, "2026-01-05", "2026-01-16", [AYA.id]))(AYA.id);

    // Inside the window: Monday is a four-hour morning, Tuesday is a rest day the org would have worked.
    expect(sched("2026-01-05")).toMatchObject({ off: false, shiftName: "Morning", fullDayMinutes: 240, halfDayMinutes: 120 });
    expect(sched("2026-01-06").off).toBe(true);
    expect(sched("2026-01-07").off).toBe(false);

    // The day AFTER it ends they are on nothing, which is the org's own week - a full Tuesday again.
    expect(sched("2026-01-13")).toMatchObject({ off: false, fullDayMinutes: 480 });
  });

  it("decides nothing at all while the org reads days from its own blob", async () => {
    await seed();
    await assign({ start_date: "2026-01-05" });
    // The gate: an org keeping a roster as a planning grid must not find it deciding pay.
    await deps.db.update(schema.settings)
      .set({ value: JSON.stringify({ ...DEFAULT_ATTENDANCE, schedule_source: "org" }) })
      .where(eq(schema.settings.key, "attendance"));
    deps.refCache?.clear();
    bustRef(deps, "settings");

    const sched = (await scheduleCtxFor(deps, "2026-01-05", "2026-01-09", [AYA.id]))(AYA.id);
    // Tuesday is a working day again, on the org's own eight-hour day.
    expect(sched("2026-01-06")).toMatchObject({ off: false, fullDayMinutes: 480 });
  });

  it("lets a roster entry beat the pattern, in either direction", async () => {
    await seed();
    await assign({ start_date: "2026-01-05" });
    await deps.db.insert(schema.shiftAssignments).values([
      // Cover on a rest day...
      { uuid: genId(), code: `${AYA.code}-a`, employeeId: AYA.id, shiftId: MORNING, kind: "shift", date: new Date("2026-01-06T00:00:00Z") },
      // ...and a day off on a working one.
      { uuid: genId(), code: `${AYA.code}-b`, employeeId: AYA.id, shiftId: null, kind: "off", date: new Date("2026-01-07T00:00:00Z") },
    ]);
    const sched = (await scheduleCtxFor(deps, "2026-01-05", "2026-01-09", [AYA.id]))(AYA.id);
    expect(sched("2026-01-06")).toMatchObject({ off: false, shiftName: "Morning" });
    expect(sched("2026-01-07").off).toBe(true);
  });
});
