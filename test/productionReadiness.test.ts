/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
// Glob every migration (ordered by filename) so squashing/renaming migrations never breaks this suite.
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { deleteRun } from "../src/services/payroll";
import { createLeaveRequest } from "../src/services/leaveRequests";

// Integration + service tests that lock in the production-readiness fixes: money release-on-delete, the
// conditional (no-overdraw) leave reserve, and a REAL HTTP request through the mounted app -> auth -> authz ->
// wire-id edge codec (the layer nothing else exercised end to end). Runs against a real miniflare D1.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // valid 32-byte base64 so makeDeps constructs
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

const CLEAR = [
  schema.loanRepayments, schema.leaveEncashments, schema.bonuses, schema.payrollRunItems, schema.payrollRuns,
  schema.payPeriods, schema.leaveRequests, schema.leaveBalances, schema.leaveTypes, schema.loans,
  schema.accessRules, schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
});

async function seedEmployee(over: Partial<typeof schema.employees.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({
    uuid, code: over.code ?? `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User",
    workEmail: `${uuid}@test.example`, status: "active", ...over,
  });
  return uuid;
}
async function seedUser(employeeId: string, role: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const uuid = genId();
  const email = `${uuid}@test.example`;
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role, employeeId });
  return { uuid, email, role, status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

describe("payroll deleteRun releases every paid-by-run payout", () => {
  it("resets bonuses/encashments and deletes loan_repayments so nothing is stranded on the deleted run", async () => {
    const emp = await seedEmployee();
    const actor = await seedUser(emp, "payroll_admin");
    // A pay period + a DRAFT run.
    const periodId = genId();
    await deps.db.insert(schema.payPeriods).values({ uuid: periodId, code: `pp-${genId().slice(0, 4)}`, label: "2099-06", periodStart: new Date("2099-06-01"), periodEnd: new Date("2099-06-30"), payDate: new Date("2099-07-01") });
    const runId = genId();
    await deps.db.insert(schema.payrollRuns).values({ uuid: runId, code: `pr-${genId().slice(0, 4)}`, payPeriodId: periodId, state: "DRAFT" });
    // A loan + a repayment linked to the run (the NOT-NULL FK that used to block the delete).
    const loanId = genId();
    await deps.db.insert(schema.loans).values({ uuid: loanId, code: `ln-${genId().slice(0, 4)}`, employeeId: emp, principal: 1000, installments: 1, monthlyAmount: 1000, repaid: 500, status: "DISBURSED" });
    await deps.db.insert(schema.loanRepayments).values({ loanId, runId, amount: 500, at: new Date() });
    // A bonus + an encashment both marked paid by this run.
    const bonusId = genId();
    await deps.db.insert(schema.bonuses).values({ uuid: bonusId, code: `bn-${genId().slice(0, 4)}`, employeeId: emp, amount: 200, awardDate: new Date(), scope: "individual", paidRunId: runId, paidAt: new Date() });
    const ltId = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: ltId, code: `lt-${genId().slice(0, 4)}`, name: "Annual", paid: true });
    const encId = genId();
    await deps.db.insert(schema.leaveEncashments).values({ uuid: encId, code: `le-${genId().slice(0, 4)}`, employeeId: emp, leaveTypeId: ltId, days: 2, ratePerDay: 100, amount: 200, state: "PAID", paidRunId: runId, paidAt: new Date() });

    await deleteRun(deps, actor, runId);

    // Run + items gone.
    expect((await deps.db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.uuid, runId))).length).toBe(0);
    // Loan repayment ledger row for the run is gone (FK cleared).
    expect((await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.runId, runId))).length).toBe(0);
    // Bonus released back to unpaid.
    const bonus = (await deps.db.select().from(schema.bonuses).where(eq(schema.bonuses.uuid, bonusId)))[0]!;
    expect(bonus.paidRunId).toBeNull();
    // Encashment released back to APPROVED + unpaid.
    const enc = (await deps.db.select().from(schema.leaveEncashments).where(eq(schema.leaveEncashments.uuid, encId)))[0]!;
    expect(enc.paidRunId).toBeNull();
    expect(enc.state).toBe("APPROVED");
  });
});

describe("leave reserve cannot overdraw the balance", () => {
  it("rejects a second request that exceeds the remaining balance and leaves no orphan request row", async () => {
    const emp = await seedEmployee();
    const actor = await seedUser(emp, "employee");
    const ltId = genId();
    await deps.db.insert(schema.leaveTypes).values({ uuid: ltId, code: `lt-${genId().slice(0, 4)}`, name: "Annual", paid: true, availableDuringProbation: true });
    await deps.db.insert(schema.leaveBalances).values({ uuid: genId(), employeeId: emp, leaveTypeId: ltId, balanceDays: 3 });

    // First request (2 days) succeeds -> balance 1 left.
    await createLeaveRequest(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${ltId}`, start_date: "2099-06-01", end_date: "2099-06-02" });
    // Second request (2 days) needs 2 but only 1 remains -> must be rejected.
    await expect(createLeaveRequest(deps, actor, { employee: `employees/${emp}`, leave_type: `leave-types/${ltId}`, start_date: "2099-07-01", end_date: "2099-07-02" })).rejects.toThrow();

    // Balance never went negative, and the rejected request left no row behind.
    const bal = (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, emp), eq(schema.leaveBalances.leaveTypeId, ltId))))[0]!;
    expect(bal.balanceDays).toBeGreaterThanOrEqual(0);
    expect(bal.balanceDays).toBe(1);
    expect((await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.employeeId, emp))).length).toBe(1);
  });
});

describe("HTTP integration: auth + middleware chain + wire-id edge", () => {
  it("serves a real /v1/users/me under dev auth and encodes the employee ref as a wire-id token", async () => {
    const emp = await seedEmployee({ code: "04-777", firstName: "Ada", lastName: "Lovelace" });
    const devUser = await seedUser(emp, "super_admin");
    // Seed the compiled super grant (** / admin) for the role so the fail-closed authz middleware admits the
    // request; this bare DB has no bootstrap access_rules. This is the real grant shape the app compiles.
    await deps.db.insert(schema.accessRules).values({ subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" });
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = devUser.email;
    (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";

    // A real request through the mounted app: requestId + auth (dev bypass) + the /v1 chain. /users/me is the
    // identity endpoint (no collection-grant needed), so this validates wiring without seeding access_rules.
    const res = await app.request("/v1/users/me", { headers: { "X-Requested-By": "hrms-spa" } }, b as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy(); // requestId middleware ran on the response

    const me = (await res.json()) as { email: string; employee?: string };
    expect(me.email).toBe(devUser.email);
    // The wire-id edge must have encoded the employee ref: token present and NOT the raw internal uuid.
    expect(me.employee).toBeTruthy();
    const token = me.employee!.split("/")[1]!;
    expect(token).not.toBe(emp);
    expect(token.length).toBeGreaterThan(emp.length);
  });
});

describe("codeAlloc backstop: `code` is UNIQUE per table", () => {
  it("rejects a second row that reuses an existing code (a lost alloc race fails safe, not silently duplicated)", async () => {
    await deps.db.insert(schema.employees).values({ uuid: genId(), code: "04-dup", firstName: "A", lastName: "B", workEmail: `${genId()}@t.example`, status: "active" });
    // Same code, different row -> the UNIQUE index must reject it (errorHandler maps this to a retryable 409).
    await expect(
      deps.db.insert(schema.employees).values({ uuid: genId(), code: "04-dup", firstName: "C", lastName: "D", workEmail: `${genId()}@t.example`, status: "active" }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});

describe("auth: ALLOWED_EMAIL_DOMAINS gates first-login auto-provisioning", () => {
  const setEnv = (o: Record<string, string | undefined>) => Object.assign(b as Record<string, unknown>, o);
  const userByEmail = async (email: string) => (await deps.db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
  const req = () => app.request("/v1/users/me", { headers: { "X-Requested-By": "hrms-spa" } }, b as unknown as Record<string, unknown>);

  it("rejects a first-login email outside the allow-list and creates NO user row", async () => {
    setEnv({ ALLOW_DEV_AUTH: "true", ALLOWED_EMAIL_DOMAINS: "example.com", DEV_FAKE_EMAIL: "intruder@evil.example" });
    try {
      const res = await req();
      expect(res.status).toBe(403);
      expect(await userByEmail("intruder@evil.example")).toBeUndefined(); // never provisioned
    } finally {
      setEnv({ ALLOWED_EMAIL_DOMAINS: undefined, DEV_FAKE_EMAIL: undefined, ALLOW_DEV_AUTH: undefined });
    }
  });

  it("admits (provisions) a first-login email inside the allow-list", async () => {
    await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing(); // provisioning assigns this role (FK)
    setEnv({ ALLOW_DEV_AUTH: "true", ALLOWED_EMAIL_DOMAINS: "example.com", DEV_FAKE_EMAIL: "ada@example.com" });
    try {
      await req(); // authz may 403 (a fresh employee has no seeded grant) — the point is the user row IS created
      expect(await userByEmail("ada@example.com")).toBeDefined();
    } finally {
      setEnv({ ALLOWED_EMAIL_DOMAINS: undefined, DEV_FAKE_EMAIL: undefined, ALLOW_DEV_AUTH: undefined });
    }
  });
});
