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
import { etagOf } from "../src/http/serialize";
import { createOvertimeRequest, approveOvertimeRequest, rejectOvertimeRequest } from "../src/services/overtimeRequests";
import { createLoan, approveLoan, disburseLoan, recordLoanRepayment, updateLoan } from "../src/services/loans";
import { createExpense, submitExpense, approveExpense } from "../src/services/expenses";

// Maker-checker on every decision that moves money or excuses time: the person a request is ABOUT may not be
// the person who approves, pays or disburses it (services/decisionGuard.ts). And a decision is bound to the
// version the approver looked at, when the client says which one that was (If-Match).

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
  schema.loanRepayments, schema.loans, schema.overtimeRequests, schema.expenses, schema.reimbursements, schema.expenseCategories,
  schema.notifications, schema.eventLog, schema.automationRuns, schema.auditLog, schema.settings, schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function person(): Promise<AppUser> {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: short("04"), firstName: "T", lastName: "U", workEmail: `${employeeId}@t.example`, status: "active" });
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email: `${uuid}@t.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@t.example`, role: "employee", roles: ["employee"], status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const allowSelf = () => deps.db.insert(schema.settings).values({ key: "approvals", value: JSON.stringify({ allow_self_approval: true }) });

describe("maker-checker", () => {
  it("refuses the subject approving their own overtime, and lets somebody else do it", async () => {
    const me = await person();
    const boss = await person();
    const ot = await createOvertimeRequest(deps, me, { start_time: "2099-01-01T18:00:00Z", end_time: "2099-01-01T20:00:00Z" });
    await expect(approveOvertimeRequest(deps, me, ot.uuid)).rejects.toThrow(/your own/);
    // Rejecting or cancelling your own request moves no money in your favour, so it is not refused.
    const approved = await approveOvertimeRequest(deps, boss, ot.uuid);
    expect(approved.state).toBe("APPROVED");
  });

  it("refuses a borrower approving, disbursing or recording repayments on their own loan", async () => {
    const me = await person();
    const payroll = await person();
    const loan = await createLoan(deps, me, { principal: 12000, installments: 12 });
    await expect(approveLoan(deps, me, loan.uuid)).rejects.toThrow(/your own/);
    await approveLoan(deps, payroll, loan.uuid);
    await expect(disburseLoan(deps, me, loan.uuid)).rejects.toThrow(/your own/);
    await disburseLoan(deps, payroll, loan.uuid);
    await expect(recordLoanRepayment(deps, me, loan.uuid, 1000)).rejects.toThrow(/your own/);
    const after = await recordLoanRepayment(deps, payroll, loan.uuid, 1000);
    expect(after.repaid).toBe(1000);
  });

  it("the org setting lifts the rule (a one-person team has nobody else to ask)", async () => {
    const me = await person();
    await allowSelf();
    const ot = await createOvertimeRequest(deps, me, { start_time: "2099-01-01T18:00:00Z", end_time: "2099-01-01T20:00:00Z" });
    expect((await approveOvertimeRequest(deps, me, ot.uuid)).state).toBe("APPROVED");
  });

  it("the expense auto-approve lane still approves a small claim for its submitter", async () => {
    const me = await person();
    await deps.db.insert(schema.settings).values({ key: "expenses", value: JSON.stringify({ auto_approve_threshold: 1000 }) });
    const cat = genId();
    await deps.db.insert(schema.expenseCategories).values({ uuid: cat, code: short("c"), name: "Travel" });
    const e = await createExpense(deps, me, { category: `expense-categories/${cat}`, amount: 500, description: "Cab" });
    const submitted = await submitExpense(deps, me, e.uuid);
    expect(submitted.state).toBe("APPROVED");
    // ...but pressing Approve by hand on your own claim is still refused.
    const big = await createExpense(deps, me, { category: `expense-categories/${cat}`, amount: 5000, description: "Hotel" });
    await submitExpense(deps, me, big.uuid);
    await expect(approveExpense(deps, me, big.uuid)).rejects.toThrow(/your own/);
  });
});

describe("decisions bound to the reviewed version", () => {
  it("a loan edited after the approver read it is not approved on a stale If-Match", async () => {
    const me = await person();
    const payroll = await person();
    const loan = await createLoan(deps, me, { principal: 10000, installments: 10 });
    const seen = etagOf(+new Date(loan.updatedAt));
    // The borrower raises the principal after the approver opened the request.
    await new Promise((r) => setTimeout(r, 5));
    await updateLoan(deps, me, loan.uuid, { principal: 1_000_000 });
    await expect(approveLoan(deps, payroll, loan.uuid, seen)).rejects.toThrow(/etag|changed/);
    const row = (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, loan.uuid)))[0]!;
    expect(row.status).toBe("PENDING");
    // With the current version, approval goes through and the instalment is priced off the principal approved.
    const fresh = etagOf(+new Date(row.updatedAt));
    const approved = await approveLoan(deps, payroll, loan.uuid, fresh);
    expect(approved.monthlyAmount).toBe(100000);
  });

  it("a stale If-Match on an overtime decision is refused", async () => {
    const me = await person();
    const boss = await person();
    const ot = await createOvertimeRequest(deps, me, { start_time: "2099-01-01T18:00:00Z", end_time: "2099-01-01T20:00:00Z" });
    await expect(rejectOvertimeRequest(deps, boss, ot.uuid, "Not budgeted", 'W/"1"')).rejects.toThrow(/etag/);
  });
});
