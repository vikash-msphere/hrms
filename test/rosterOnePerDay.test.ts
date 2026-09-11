/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { crudService } from "../src/services/crud";
import { shiftAssignmentSpec, type ShiftAssignmentInput } from "../src/services/shiftAssignments";
import { isShiftAssignmentDuplicate } from "../src/lib/errors";

// ONE ROSTER ENTRY PER PERSON PER DAY.
//
// This is an invariant every reader already assumed and nothing enforced. The schedule grid keys its cells
// `(employee, date)` and keeps the last row it sees, so a second entry for the same cell is not a second shift
// on screen - it is an invisible one: editing the visible entry leaves the hidden one behind, the employee is
// notified twice, and the day's coverage count is one too many. It is reachable by ordinary use, because a
// scheduler working from a roster view that does not hold the entry (a truncated page, a stale tab) sees an
// empty cell and fills it.
//
// Two layers, and this pins both: the service explains the clash in words on the paths that can, and the
// partial unique index catches everything else - a restore, and any race that gets past the check.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const svc = crudService<ShiftAssignmentInput, typeof schema.shiftAssignments>(shiftAssignmentSpec);

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

let emp: string;
let other: string;
let shiftA: string;
let shiftB: string;
let actor: AppUser;

beforeEach(async () => {
  for (const t of [schema.notifications, schema.auditLog, schema.shiftAssignments, schema.shifts, schema.users, schema.employees]) {
    await deps.db.delete(t);
  }
  emp = genId();
  other = genId();
  await deps.db.insert(schema.employees).values([
    { uuid: emp, code: "04-001", firstName: "Ros", lastName: "Tered", workEmail: `${emp}@test.example`, status: "active" },
    { uuid: other, code: "04-002", firstName: "Some", lastName: "Body", workEmail: `${other}@test.example`, status: "active" },
  ]);
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const userId = genId();
  await deps.db.insert(schema.users).values({ uuid: userId, code: "u-1", email: `${userId}@test.example`, role: "employee", employeeId: emp });
  actor = { uuid: userId, email: `${userId}@test.example`, role: "employee", status: "active", employeeId: emp, employeeCode: "04-001" } as unknown as AppUser;
  shiftA = genId();
  shiftB = genId();
  await deps.db.insert(schema.shifts).values([
    { uuid: shiftA, code: "sh-a", name: "Morning", startTime: "09:00", endTime: "18:00" },
    { uuid: shiftB, code: "sh-b", name: "Night", startTime: "21:00", endTime: "06:00" },
  ]);
});

const assign = (employeeId: string, shiftId: string, date: string) =>
  svc.create(deps, actor, { employee: `employees/${employeeId}`, shift: `shifts/${shiftId}`, date });

const liveOn = async (employeeId: string, date: string) =>
  (await deps.db
    .select()
    .from(schema.shiftAssignments)
    .where(and(eq(schema.shiftAssignments.employeeId, employeeId), eq(schema.shiftAssignments.date, new Date(Date.parse(`${date}T00:00:00Z`))), isNull(schema.shiftAssignments.deleteTime))));

describe("the roster holds one entry per person per day", () => {
  it("refuses a second assignment for the same person on the same day, and says which day", async () => {
    await assign(emp, shiftA, "2026-03-02");
    await expect(assign(emp, shiftB, "2026-03-02")).rejects.toThrow(/already rostered on 2026-03-02/);
    expect(await liveOn(emp, "2026-03-02")).toHaveLength(1);
  });

  it("leaves the other axes alone: another day, and another person on the same day, are both fine", async () => {
    await assign(emp, shiftA, "2026-03-02");
    await assign(emp, shiftB, "2026-03-03");
    await assign(other, shiftA, "2026-03-02");
    expect(await liveOn(emp, "2026-03-02")).toHaveLength(1);
    expect(await liveOn(emp, "2026-03-03")).toHaveLength(1);
    expect(await liveOn(other, "2026-03-02")).toHaveLength(1);
  });

  it("refuses a patch that MOVES an entry onto an occupied day", async () => {
    await assign(emp, shiftA, "2026-03-02");
    const moving = await assign(emp, shiftB, "2026-03-04");
    await expect(svc.update(deps, actor, moving.uuid, { date: "2026-03-02" })).rejects.toThrow(/already rostered on 2026-03-02/);
    // The entry stayed where it was rather than half-moving.
    expect(await liveOn(emp, "2026-03-04")).toHaveLength(1);
    expect(await liveOn(emp, "2026-03-02")).toHaveLength(1);
  });

  it("allows a patch that rewrites an entry in place (its own day is not a clash with itself)", async () => {
    const a = await assign(emp, shiftA, "2026-03-02");
    const updated = await svc.update(deps, actor, a.uuid, { date: "2026-03-02", shift: `shifts/${shiftB}` });
    expect(updated.shiftId).toBe(shiftB);
    expect(await liveOn(emp, "2026-03-02")).toHaveLength(1);
  });

  it("frees the day again once the entry is soft-deleted - the index is partial on the live rows", async () => {
    const a = await assign(emp, shiftA, "2026-03-02");
    await svc.remove(deps, actor, a.uuid);
    const b2 = await assign(emp, shiftB, "2026-03-02");
    expect(b2.shiftId).toBe(shiftB);
    expect(await liveOn(emp, "2026-03-02")).toHaveLength(1);
    // ...and restoring the first one would put TWO live entries on that day, so the index refuses it. This is
    // the path the service check cannot cover (a restore names no date), which is why the index is the backstop
    // rather than a belt-and-braces duplicate of the check.
    await expect(svc.restore(deps, actor, a.uuid)).rejects.toSatisfy(isShiftAssignmentDuplicate);
    expect(await liveOn(emp, "2026-03-02")).toHaveLength(1);
  });
});
