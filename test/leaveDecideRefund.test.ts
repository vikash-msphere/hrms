/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { bustRef } from "../src/lib/refData";
import { createLeaveRequest, cancelLeaveRequest, rejectLeaveRequest } from "../src/services/leaveRequests";

// Deciding a leave request is TWO writes that have to be one: the state flip, and the refund of the days the
// request reserved. Held apart, a failure between them left the request CANCELLED with the days gone - and the
// exactly-once guard on the flip made that permanent, because a retry finds the row is no longer PENDING and
// refuses. Nothing reconciles leave balances; leave days are encashable, so they are money.
//
// Held together in one batch, the two outcomes are the only ones there are: decided AND refunded, or neither.

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

const TABLES = [schema.leaveRequests, schema.leaveBalances, schema.leaveTypes, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles, schema.codeSequences];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  // One actor files and decides; the refund is the subject, not maker-checker (test/decisionGuard.test.ts).
  await deps.db.insert(schema.settings).values({ key: "approvals", value: JSON.stringify({ allow_self_approval: true }) });
  deps.refCache?.clear();
  deps.clock = { now: () => new Date() };
});

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: `04-${genId().slice(0, 5)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", startDate: new Date(Date.parse("2026-01-01T00:00:00Z")),
  });
  return uuid;
}

async function seedLeaveType(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid, code: `lt-${genId().slice(0, 4)}`, name: "Annual", accrualDaysPerYear: 0, paid: true });
  bustRef(deps, "leave_types");
  return uuid;
}

async function seedActor(employeeId: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const balanceOf = (employeeId: string, leaveTypeId: string) =>
  deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1).then((r) => r[0]);

async function bookTwoDays() {
  const employeeId = await seedEmployee();
  const leaveTypeId = await seedLeaveType();
  const actor = await seedActor(employeeId);
  await deps.db.insert(schema.leaveBalances).values({ code: `04-${genId().slice(0, 5)}`, employeeId, leaveTypeId, balanceDays: 10 });
  const row = await createLeaveRequest(deps, actor, {
    employee: `employees/${employeeId}`,
    leave_type: `leave-types/${leaveTypeId}`,
    start_date: "2026-06-10", // a Wednesday + Thursday: two working days
    end_date: "2026-06-11",
  });
  expect((await balanceOf(employeeId, leaveTypeId))!.balanceDays).toBe(8); // reserved at request time
  return { employeeId, leaveTypeId, actor, id: row.uuid };
}

describe("deciding a leave request refunds the days with the flip, exactly once", () => {
  it("cancelling puts the reserved days back", async () => {
    const { employeeId, leaveTypeId, actor, id } = await bookTwoDays();

    await cancelLeaveRequest(deps, actor, id);

    expect((await balanceOf(employeeId, leaveTypeId))!.balanceDays).toBe(10);
    expect((await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, id)).limit(1))[0]!.state).toBe("CANCELLED");
  });

  it("rejecting puts them back too", async () => {
    const { employeeId, leaveTypeId, actor, id } = await bookTwoDays();

    await rejectLeaveRequest(deps, actor, id, "Team is short that week");

    expect((await balanceOf(employeeId, leaveTypeId))!.balanceDays).toBe(10);
  });

  it("two decisions on the same request refund ONE of them", async () => {
    // The whole reason the refund carries the flip's own precondition: a batch reports a short count, it does
    // not roll one statement back, so a refund that could apply on its own would pay a request somebody else
    // decided. One caller wins, the other is told it was already decided, and the days come back once.
    const { employeeId, leaveTypeId, actor, id } = await bookTwoDays();

    const outcomes = await Promise.allSettled([cancelLeaveRequest(deps, actor, id), rejectLeaveRequest(deps, actor, id, "Team is short that week")]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    expect((await balanceOf(employeeId, leaveTypeId))!.balanceDays).toBe(10);
  });

  it("approving changes no balance (the days were reserved when the request was made)", async () => {
    const { employeeId, leaveTypeId, actor, id } = await bookTwoDays();
    const { approveLeaveRequest } = await import("../src/services/leaveRequests");

    await approveLeaveRequest(deps, actor, id);

    expect((await balanceOf(employeeId, leaveTypeId))!.balanceDays).toBe(8);
  });
});
