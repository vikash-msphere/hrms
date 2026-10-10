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
import { createOvertimeRequest, approveOvertimeRequest, cancelOvertimeRequest, approvedUnpaidOvertime, markOvertimeSettledStmt } from "../src/services/overtimeRequests";
import { createRemoteWorkRequest, approveRemoteWorkRequest, rejectRemoteWorkRequest, cancelRemoteWorkRequest } from "../src/services/remoteWorkRequests";
import { createReimbursement, approveReimbursement, cancelReimbursement, approvedUnpaidReimbursements } from "../src/services/reimbursements";

// A requester who no longer needs what they asked for can call it off after it was approved, up to the point
// where the approval has been acted on: the money paid, the day begun. Leave, encashments, late/early, asset and
// expense requests are pinned beside their own flows; these are the three whose line is drawn only here.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let base: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  base = makeDeps(b);
});

const TABLES = [
  schema.loanRepayments, schema.reimbursements, schema.loans, schema.overtimeRequests, schema.remoteWorkRequests,
  schema.notifications, schema.eventLog, schema.automationRuns, schema.auditLog, schema.settings,
  schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await base.db.delete(t);
});

// Thursday 1 March 2099, 10:00 in Asia/Kolkata (the default org zone).
const NOW = "2099-03-01T04:30:00.000Z";
const at = (iso: string): Deps => ({ ...makeDeps(b), clock: { now: () => new Date(iso) } });

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function person(): Promise<AppUser> {
  const employeeId = genId();
  await base.db.insert(schema.employees).values({ uuid: employeeId, code: short("04"), firstName: "T", lastName: "U", workEmail: `${employeeId}@t.example`, status: "active" });
  await base.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await base.db.insert(schema.users).values({ uuid, code: short("u"), email: `${uuid}@t.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@t.example`, role: "employee", roles: ["employee"], status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

describe("overtime", () => {
  it("is withdrawn after approval until payroll or an exit settlement pays it", async () => {
    const deps = at(NOW);
    const me = await person();
    const boss = await person();
    const unneeded = await createOvertimeRequest(deps, me, { start_time: "2099-02-27T13:00:00Z", end_time: "2099-02-27T15:00:00Z" });
    await approveOvertimeRequest(deps, boss, unneeded.uuid);
    expect((await cancelOvertimeRequest(deps, me, unneeded.uuid)).state).toBe("CANCELLED");
    // Out of the payout queue, so no run pays it.
    expect(await approvedUnpaidOvertime(deps, me.employeeId!)).toEqual([]);

    const settled = await createOvertimeRequest(deps, me, { start_time: "2099-02-28T13:00:00Z", end_time: "2099-02-28T15:00:00Z" });
    await approveOvertimeRequest(deps, boss, settled.uuid);
    await markOvertimeSettledStmt(deps, [settled.uuid], new Date(NOW));
    await expect(cancelOvertimeRequest(deps, me, settled.uuid)).rejects.toThrow(/already in a payroll run/);
    expect((await deps.db.select().from(schema.overtimeRequests).where(eq(schema.overtimeRequests.uuid, settled.uuid)))[0]!.state).toBe("APPROVED");
  });
});

describe("remote work", () => {
  it("is withdrawn after approval until the day it starts, and a rejected one is not", async () => {
    const deps = at(NOW);
    const me = await person();
    const boss = await person();
    const later = await createRemoteWorkRequest(deps, me, { start_date: "2099-03-05", end_date: "2099-03-06" });
    await approveRemoteWorkRequest(deps, boss, later.uuid);
    expect((await cancelRemoteWorkRequest(deps, me, later.uuid)).state).toBe("CANCELLED");

    // Approved, then read on its first day: it is where somebody is working, no longer a plan.
    const begun = await createRemoteWorkRequest(deps, me, { start_date: "2099-03-08", end_date: "2099-03-09" });
    await approveRemoteWorkRequest(deps, boss, begun.uuid);
    await expect(cancelRemoteWorkRequest(at("2099-03-08T04:30:00.000Z"), me, begun.uuid)).rejects.toThrow(/already started/);

    const rejected = await createRemoteWorkRequest(deps, me, { start_date: "2099-03-12", end_date: "2099-03-12" });
    await rejectRemoteWorkRequest(deps, boss, rejected.uuid, "Team offsite that day");
    await expect(cancelRemoteWorkRequest(deps, me, rejected.uuid)).rejects.toThrow(/only pending or upcoming approved/);
  });
});

describe("reimbursements", () => {
  it("are withdrawn after approval while unpaid, except one set against an advance", async () => {
    const deps = at(NOW);
    const me = await person();
    const boss = await person();
    const plain = await createReimbursement(deps, me, { amount: 1500, description: "Taxi" });
    await approveReimbursement(deps, boss, plain.uuid);
    expect((await cancelReimbursement(deps, me, plain.uuid)).state).toBe("CANCELLED");
    expect(await approvedUnpaidReimbursements(deps, me.employeeId!)).toEqual([]);

    // Approving it already discharged part of the advance, so withdrawing it is not a one-sided act.
    const adv = genId();
    await deps.db.insert(schema.loans).values({ uuid: adv, code: short("ln"), employeeId: me.employeeId!, kind: "advance", principal: 5000, installments: 1, monthlyAmount: 5000, repaid: 0, reason: "Travel float", status: "DISBURSED" });
    const spent = await createReimbursement(deps, me, { amount: 2000, advance: `loans/${adv}`, description: "Hotel" });
    await approveReimbursement(deps, boss, spent.uuid);
    await expect(cancelReimbursement(deps, me, spent.uuid)).rejects.toThrow(/set against your advance/);

    // PAID is final.
    const paid = await createReimbursement(deps, me, { amount: 900, description: "Lunch" });
    await approveReimbursement(deps, boss, paid.uuid);
    await deps.db.update(schema.reimbursements).set({ state: "PAID", paidAt: new Date(NOW) }).where(eq(schema.reimbursements.uuid, paid.uuid));
    await expect(cancelReimbursement(deps, me, paid.uuid)).rejects.toThrow(/only pending or unpaid approved/);
  });
});
