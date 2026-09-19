/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { ListScope } from "../src/domain/access";
import { listSessions } from "../src/services/attendance";

// `GET /v1/attendance?employee=` - the read behind the per-employee attendance log (an employee's record, and
// the manager's drill-in from the team table).
//
// It is a FILTER, never a widening: `listSessions` ANDs the caller's scope predicate in regardless, so asking
// for somebody the caller cannot see answers with nothing rather than with their punches. That is the
// property worth pinning - a narrowing parameter that quietly became an access path would be the whole point
// of the scope binder lost to one query string.

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

const TABLES = [schema.attendanceSessions, schema.attendanceRegularizations, schema.employees, schema.departments, schema.codeSequences];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.refCache?.clear();
});

// Two people in two departments, so "outside the caller's scope" is expressible.
const AYA = { id: genId(), code: "04-001-001" }; // dept 04
const BEN = { id: genId(), code: "07-001-001" }; // dept 07

async function seed() {
  await deps.db.insert(schema.employees).values([
    { uuid: AYA.id, code: AYA.code, firstName: "Aya", lastName: "One", workEmail: "aya@x.test", status: "active" },
    { uuid: BEN.id, code: BEN.code, firstName: "Ben", lastName: "Two", workEmail: "ben@x.test", status: "active" },
  ]);
  // Two closed punches each, on two days, so a filter that silently matched nothing is distinguishable from
  // one that matched everything.
  const punch = (emp: { id: string; code: string }, n: number, day: string) => ({
    uuid: genId(),
    code: `${emp.code}-${n}`,
    employeeId: emp.id,
    clockIn: new Date(`${day}T09:00:00.000Z`),
    clockOut: new Date(`${day}T17:00:00.000Z`),
  });
  await deps.db.insert(schema.attendanceSessions).values([
    punch(AYA, 1, "2026-06-01"), punch(AYA, 2, "2026-06-02"),
    punch(BEN, 3, "2026-06-01"), punch(BEN, 4, "2026-06-02"),
  ]);
}

const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const dept = (code: string): ListScope => ({ breadth: "dept", deptCode: code, ownerId: null, seeRestricted: true });
const own = (employeeId: string): ListScope => ({ breadth: "own", deptCode: null, ownerId: employeeId, seeRestricted: true });

const list = (scope: ListScope, employeeId?: string) =>
  listSessions(deps, scope, 100, undefined, { employeeId });

describe("attendance list narrows to one employee", () => {
  it("returns that person's punches and nobody else's", async () => {
    await seed();
    const { items } = await list(all(), AYA.id);
    expect(items.map((r) => r.employeeId).sort()).toEqual([AYA.id, AYA.id]);
  });

  it("returns everyone the caller can see when no employee is named", async () => {
    await seed();
    const { items } = await list(all());
    expect(items).toHaveLength(4);
  });
});

describe("the filter never widens what the caller may read", () => {
  it("answers empty for somebody outside a dept-scoped caller's scope", async () => {
    await seed();
    // A manager of dept 04 asking for Ben, in dept 07. The scope predicate is still ANDed in, so this is
    // empty - not Ben's two days.
    const { items } = await list(dept("04"), BEN.id);
    expect(items).toEqual([]);
    // Same caller, somebody they CAN see: the filter works normally within the scope.
    const mine = await list(dept("04"), AYA.id);
    expect(mine.items).toHaveLength(2);
  });

  it("answers empty for a self-scoped caller asking about anybody else", async () => {
    await seed();
    const { items } = await list(own(AYA.id), BEN.id);
    expect(items).toEqual([]);
  });

  it("still hides superseded punches, whoever is asked for", async () => {
    await seed();
    // A correction supersedes a day's punches; every reader of this table filters them, and naming an
    // employee must not step around that. `superseded_by` points at the regularization whose approval
    // replaced the punch, so one is filed here to point at.
    const reg = genId();
    await deps.db.insert(schema.attendanceRegularizations).values({
      uuid: reg, code: `${AYA.code}-r1`, employeeId: AYA.id,
      date: new Date("2026-06-01T00:00:00.000Z"), sessions: [], state: "APPROVED",
    });
    const mine = await deps.db.select().from(schema.attendanceSessions).where(eq(schema.attendanceSessions.employeeId, AYA.id));
    const [first, second] = mine;
    await deps.db
      .update(schema.attendanceSessions)
      .set({ supersededBy: reg })
      .where(eq(schema.attendanceSessions.uuid, first!.uuid));
    const { items } = await list(all(), AYA.id);
    expect(items.map((r) => r.uuid)).toEqual([second!.uuid]);
  });
});
