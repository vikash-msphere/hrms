/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { ListScope } from "../src/domain/access";
import { approvalsSummary } from "../src/services/approvalsSummary";
import { approvalScopesFor } from "../src/middleware/authz";
import { grantFor } from "../src/domain/grants";
import { DEFAULT_POLICY } from "../src/domain/manifests";
import { app } from "../src/index";

// The approvals badge's contract: each queue's count equals what the caller would have counted from that
// collection's own list response filtered to the awaiting state (the SPA's old client-side filter), a queue the
// middleware did not scope contributes nothing, and the total is the sum of what is included.

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

const TABLES = [schema.accessRules, schema.users, schema.roles, schema.leaveRequests, schema.loans, schema.timeEntries, schema.expenses, schema.assetRequests, schema.projects, schema.leaveTypes, schema.employees];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const A = { uuid: genId(), code: "04-001-001" }; // in the manager's department
const B = { uuid: genId(), code: "07-001-001" }; // elsewhere

const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const dept = (deptCode: string): ListScope => ({ breadth: "dept", deptCode, ownerId: null, seeRestricted: true });
const denying = (code: string): ListScope => ({ ...all(), denies: [code] });

async function seed() {
  await deps.db.insert(schema.employees).values([
    { uuid: A.uuid, code: A.code, firstName: "A", lastName: "A", workEmail: "a@x.test", status: "active" },
    { uuid: B.uuid, code: B.code, firstName: "B", lastName: "B", workEmail: "b@x.test", status: "active" },
  ]);
  const lt = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: lt, code: "01-001", name: "Annual", accrualDaysPerYear: 12 });
  const leave = (owner: typeof A, suffix: string, state: "PENDING" | "APPROVED") => ({
    uuid: genId(),
    code: `${owner.code}-${suffix}`,
    employeeId: owner.uuid,
    leaveTypeId: lt,
    startDate: new Date("2026-03-02"),
    endDate: new Date("2026-03-03"),
    days: 2,
    state,
  });
  // A: 2 awaiting + 1 already decided. B: 1 awaiting, outside the manager's department.
  await deps.db.insert(schema.leaveRequests).values([leave(A, "l1", "PENDING"), leave(A, "l2", "PENDING"), leave(A, "l3", "APPROVED"), leave(B, "l1", "PENDING")]);
  // Loans: one awaiting, one awaiting but soft-deleted (out of the queue, like the list), one disbursed.
  await deps.db.insert(schema.loans).values([
    { uuid: genId(), code: `${A.code}-ln1`, employeeId: A.uuid, kind: "loan", principal: 1000, status: "PENDING" },
    { uuid: genId(), code: `${A.code}-ln2`, employeeId: A.uuid, kind: "loan", principal: 1000, status: "PENDING", deleteTime: new Date() },
    { uuid: genId(), code: `${A.code}-ln3`, employeeId: A.uuid, kind: "loan", principal: 1000, status: "DISBURSED" },
  ]);
  // Timesheets awaiting = SUBMITTED (not PENDING); a DRAFT entry is nobody's decision yet.
  const proj = genId();
  await deps.db.insert(schema.projects).values({ uuid: proj, code: "02-001", name: "Platform" });
  await deps.db.insert(schema.timeEntries).values([
    { uuid: genId(), code: `${A.code}-te1`, employeeId: A.uuid, projectId: proj, date: new Date("2026-03-02"), hours: 8, status: "SUBMITTED" },
    { uuid: genId(), code: `${A.code}-te2`, employeeId: A.uuid, projectId: proj, date: new Date("2026-03-03"), hours: 8, status: "DRAFT" },
  ]);
  // Expenses: one real claim awaiting, one RECURRING template also SUBMITTED (a template is never approved).
  await deps.db.insert(schema.expenses).values([
    { uuid: genId(), code: `${A.code}-ex1`, employeeId: A.uuid, description: "Taxi", amount: 500, incurredOn: new Date("2026-03-02"), state: "SUBMITTED" as const, isRecurring: false },
    { uuid: genId(), code: `${A.code}-ex2`, employeeId: A.uuid, description: "Rent", amount: 5000, incurredOn: new Date("2026-03-02"), state: "SUBMITTED" as const, isRecurring: true },
  ]);
}

describe("approvals summary counts", () => {
  it("counts each queue by its own awaiting state, excluding decided, deleted and template rows", async () => {
    await seed();
    const scopes = new Map<string, ListScope>([
      ["leave-requests", all()],
      ["loans", all()],
      ["time-entries", all()],
      ["expenses", all()],
    ]);
    const out = await approvalsSummary(deps, scopes, false);
    expect(out.counts).toEqual({ "leave-requests": 3, loans: 1, "time-entries": 1, expenses: 1 });
    expect(out.total).toBe(6);
  });

  it("binds a dept-breadth approve scope, so a manager's queue stops at their department", async () => {
    await seed();
    const out = await approvalsSummary(deps, new Map([["leave-requests", dept("04-001")]]), false);
    expect(out.counts).toEqual({ "leave-requests": 2 }); // A's two; B's request is another department's
    expect(out.total).toBe(2);
  });

  it("honours a per-object deny even against an all-breadth approve scope", async () => {
    await seed();
    const out = await approvalsSummary(deps, new Map([["leave-requests", denying(`${A.code}-l1`)]]), false);
    expect(out.counts).toEqual({ "leave-requests": 2 }); // A's other request + B's
  });

  it("omits every queue the middleware did not scope", async () => {
    await seed();
    const out = await approvalsSummary(deps, new Map(), false);
    expect(out).toEqual({ counts: {}, total: 0 });
  });

  it("counts the prior-employer verification queue off the plaintext status, without decrypting", async () => {
    await seed();
    await deps.db.update(schema.employees).set({ taxVerificationStatus: "DECLARED" }).where(eq(schema.employees.uuid, A.uuid));
    await deps.db.update(schema.employees).set({ taxVerificationStatus: "VERIFIED" }).where(eq(schema.employees.uuid, B.uuid));
    const out = await approvalsSummary(deps, new Map(), true);
    expect(out.counts["tax-verifications"]).toBe(1); // only the one awaiting a decision
    expect(out.total).toBe(1);
  });

  it("leaves the verification queue out entirely for a caller who may not read it", async () => {
    await seed();
    const out = await approvalsSummary(deps, new Map(), false);
    expect(out.counts["tax-verifications"]).toBeUndefined();
  });
});

// The gate itself: which queues reach the service at all. This is the whole point of the endpoint - an ordinary
// employee's badge costs one request that queries nothing, instead of ten collection reads on every page.
describe("approvals summary gating (middleware)", () => {
  const actor = (role: string, employeeCode: string | null): AppUser =>
    ({ uuid: genId(), role, employeeCode, employeeId: A.uuid, grant: grantFor(role), policy: DEFAULT_POLICY } as unknown as AppUser);

  it("scopes exactly the queues a role may approve in, at that role's breadth", async () => {
    const mgr = await approvalScopesFor(deps, actor("manager", "04-001-001"));
    expect([...mgr.keys()].sort()).toEqual(
      ["asset-requests", "attendance-regularizations", "expenses", "leave-requests", "overtime-requests", "remote-work-requests", "time-entries"],
    );
    expect(mgr.get("leave-requests")!.breadth).toBe("dept");
    const hr = await approvalScopesFor(deps, actor("hr_admin", "07-001-001"));
    expect(hr.get("leave-requests")!.breadth).toBe("all");
    expect(hr.has("loans")).toBe(false); // hr doesn't decide money advances; payroll does
    expect((await approvalScopesFor(deps, actor("payroll_admin", "07-001-002"))).has("loans")).toBe(true);
  });

  it("gives an ordinary employee no queues at all, so the badge queries nothing", async () => {
    expect((await approvalScopesFor(deps, actor("employee", "04-001-001"))).size).toBe(0);
  });
});

// End to end through the real app: the envelope is allowed for any authenticated caller (it owns no data), the
// middleware resolves the per-queue approve scopes, and the response is counts - never rows.
describe("GET /v1/approvals-summary", () => {
  const DEV_EMAIL = "dev@example.com"; // the suite-wide dev-auth bypass (vitest.config.ts)

  async function seedSuper() {
    await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }, { name: "employee", label: "Employee" }]).onConflictDoNothing();
    // Super's `**` compiles to two rows: the level row (standard methods) and the verb row that feeds every
    // custom method - including the `approve` this endpoint decides with.
    await deps.db.insert(schema.accessRules).values([
      { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
      { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
    ]);
    await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin", status: "active" });
  }

  it("answers a super caller with a count per queue and their total", async () => {
    await deps.db.delete(schema.accessRules);
    await deps.db.delete(schema.users);
    await seed();
    await seedSuper();
    const res = await app.request("/v1/approvals-summary", {}, b as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number>; total: number };
    expect(body.counts["leave-requests"]).toBe(3);
    expect(body.counts.loans).toBe(1);
    expect(body.counts.expenses).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(5);
    // Counts only: no queue rows ride this response.
    expect(JSON.stringify(body)).not.toContain("employees/");
  });

  it("answers a caller who can approve nothing with an empty envelope, not a 403", async () => {
    await deps.db.delete(schema.accessRules);
    await deps.db.delete(schema.users);
    await seed();
    await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
    await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "employee", status: "active" });
    const res = await app.request("/v1/approvals-summary", {}, b as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: {}, total: 0 });
  });
});
