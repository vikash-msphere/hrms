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
import { changeRole } from "../src/services/positions";

// `positions` is the same effective-dated shape as `compensation` - close the open row, open a new one - and
// it shipped with NEITHER of the two guards that table has. The close was unconditional and unchecked, and
// there was no partial unique index behind it, so two concurrent role changes both closed the same row and
// both inserted, leaving two "current" positions.
//
// That is not a cosmetic duplicate. `location` is read off the open row last-wins for the regional holiday
// calendar (services/holidays.ts), leave (services/leaveRequests.ts) and comp-off credit (services/compOff.ts),
// so which office an employee is in becomes nondeterministic; and the `employees.department_id` copy written
// alongside can end up matching neither row, which is a SCOPE key - a wrong one is an access-control fact.
//
// The write is also one atomic batch now: close, insert and the denormalized sync are one row change described
// three ways, and a failure between them left an employee with every position row closed - no current role.

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

const CLEAR = [schema.auditLog, schema.positions, schema.users, schema.employees, schema.departments, schema.roles];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function seedEmployee(over: Partial<typeof schema.employees.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: over.code ?? short("04"), firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", ...over,
  });
  return uuid;
}
async function seedActor(employeeId: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email, role: "employee", employeeId });
  return { uuid, email, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}
const positionsOf = (employeeId: string) =>
  deps.db.select().from(schema.positions).where(eq(schema.positions.employeeId, employeeId));
const openRows = async (employeeId: string) => (await positionsOf(employeeId)).filter((r) => r.effectiveTo === null);

describe("positions: one current role, always", () => {
  it("closes the previous row exactly where the new one starts", async () => {
    const emp = await seedEmployee({ jobTitle: "Engineer" });
    const actor = await seedActor(emp);

    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Engineer", effective_from: "2025-01-01" });
    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Senior Engineer", effective_from: "2025-07-01" });

    const rows = await positionsOf(emp);
    expect(rows).toHaveLength(2);
    const open = rows.filter((r) => r.effectiveTo === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.jobTitle).toBe("Senior Engineer");
    // Half-open: the closed row ends exactly where the open one begins, so there is no instant with no role
    // and none with two.
    const closed = rows.find((r) => r.effectiveTo !== null)!;
    expect(+new Date(closed.effectiveTo!)).toBe(+new Date(open[0]!.effectiveFrom));
  });

  it("refuses the loser of a concurrent role change instead of opening a second current row", async () => {
    const emp = await seedEmployee({ jobTitle: "Engineer" });
    const actor = await seedActor(emp);
    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Engineer", effective_from: "2025-01-01" });

    // Both read the same open row, both try to close it and open their own. This is a double-clicked Promote
    // button, or a client retrying a request that had in fact landed.
    const results = await Promise.allSettled([
      changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Staff Engineer", effective_from: "2025-07-01" }),
      changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Principal Engineer", effective_from: "2025-08-01" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // The loser is told what happened, in the retryable lane - not handed whatever a raw UNIQUE constraint
    // failure surfaces as. Both orderings land here: the short row count when our guarded close matched
    // nothing, and the index when the close matched but the insert collided.
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loser.reason)).toMatch(/changed concurrently/i);

    // Whichever won: one current role, and the loser wrote nothing at all.
    expect(await openRows(emp)).toHaveLength(1);
    expect(await positionsOf(emp)).toHaveLength(2);
  });

  it("keeps the employee's denormalized title/department agreeing with the open row", async () => {
    const deptA = genId();
    const deptB = genId();
    await deps.db.insert(schema.departments).values([
      { uuid: deptA, code: short("d"), name: "Platform" },
      { uuid: deptB, code: short("d"), name: "Payments" },
    ]);
    const emp = await seedEmployee({ jobTitle: "Engineer", departmentId: deptA });
    const actor = await seedActor(emp);

    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Engineer", department: `departments/${deptA}`, effective_from: "2025-01-01" });
    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Senior Engineer", department: `departments/${deptB}`, effective_from: "2025-07-01" });

    // The sync rides the SAME atomic batch as the insert, so the copy can never name a department no position
    // row mentions. `employees.department_id` is a scope key - a stale one is an access-control fact.
    const open = (await openRows(emp))[0]!;
    const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, emp)).limit(1))[0]!;
    expect(row.departmentId).toBe(open.departmentId);
    expect(row.jobTitle).toBe(open.jobTitle);
    expect(row.departmentId).toBe(deptB);
  });

  it("carries forward the fields a change does not mention", async () => {
    const emp = await seedEmployee({ jobTitle: "Engineer" });
    const actor = await seedActor(emp);
    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Engineer", location: "Mumbai", effective_from: "2025-01-01" });
    // A promotion that only changes the title keeps the office.
    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Senior Engineer", effective_from: "2025-07-01" });
    expect((await openRows(emp))[0]!.location).toBe("Mumbai");
  });

  it("still refuses a date at or before the current role's start", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    await changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Engineer", effective_from: "2025-07-01" });
    await expect(
      changeRole(deps, actor, { employee: `employees/${emp}`, job_title: "Backdated", effective_from: "2025-01-01" }),
    ).rejects.toThrow();
    expect(await positionsOf(emp)).toHaveLength(1);
  });
});
