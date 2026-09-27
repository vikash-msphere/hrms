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
import {
  createExpense, submitExpense, approveExpense, rejectExpense, cancelExpense, payExpense, listExpenses,
} from "../src/services/expenses";
import type { ListScope } from "../src/domain/access";
import { approvedUnpaidReimbursements } from "../src/services/reimbursements";
import { grantFor } from "../bootstrap/authz/grants";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";

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
  schema.expenses, schema.reimbursements, schema.expenseCategories, schema.vendors, schema.expenseBudgets,
  schema.notifications, schema.eventLog, schema.automationRuns, schema.auditLog, schema.settings,
  schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  // One actor submits and decides. The lifecycle is the subject here, not maker-checker
  // (test/decisionGuard.test.ts), so the org opts into self-approval.
  await deps.db.insert(schema.settings).values({ key: "approvals", value: JSON.stringify({ allow_self_approval: true }) });
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
async function seedCategory(name = "Software"): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.expenseCategories).values({ uuid, code: short("c"), name });
  return `expense-categories/${uuid}`;
}
async function seedVendor(name = "Acme"): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.vendors).values({ uuid, code: short("v"), name });
  return `vendors/${uuid}`;
}

describe("expenses workflow", () => {
  it("runs draft -> submit -> approve -> pay, guarded exactly-once", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory();

    const e = await createExpense(deps, actor, { category: cat, amount: 5000, description: "AWS" });
    expect(e.state).toBe("DRAFT");

    const submitted = await submitExpense(deps, actor, e.uuid);
    expect(submitted.state).toBe("SUBMITTED");

    const approved = await approveExpense(deps, actor, e.uuid);
    expect(approved.state).toBe("APPROVED");
    expect(approved.decidedBy).toBe(actor.uuid);

    const paid = await payExpense(deps, actor, e.uuid, { payment_method: "bank", payment_ref: "UTR123" });
    expect(paid.state).toBe("PAID");
    expect(paid.paymentRef).toBe("UTR123");
    expect(paid.paidBy).toBe(actor.uuid);

    // Second pay is refused (already PAID) - exactly-once.
    await expect(payExpense(deps, actor, e.uuid)).rejects.toThrow();
  });

  it("auto-approves on submit when the amount is at or below the configured threshold", async () => {
    await deps.db.insert(schema.settings).values({ key: "expenses", value: JSON.stringify({ auto_approve_threshold: 10000 }) });
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory();

    const e = await createExpense(deps, actor, { category: cat, amount: 4000 });
    const submitted = await submitExpense(deps, actor, e.uuid);
    expect(submitted.state).toBe("APPROVED"); // slid straight through
  });

  it("rejects only submitted expenses and cancels only draft/submitted", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory();

    const e = await createExpense(deps, actor, { category: cat, amount: 900 });
    // Cannot reject a DRAFT.
    await expect(rejectExpense(deps, actor, e.uuid)).rejects.toThrow();
    // Can cancel a DRAFT.
    const cancelled = await cancelExpense(deps, actor, e.uuid);
    expect(cancelled.state).toBe("CANCELLED");
    // Cannot cancel again (terminal).
    await expect(cancelExpense(deps, actor, e.uuid)).rejects.toThrow();

    const e2 = await createExpense(deps, actor, { category: cat, amount: 900 });
    await submitExpense(deps, actor, e2.uuid);
    const rejected = await rejectExpense(deps, actor, e2.uuid);
    expect(rejected.state).toBe("REJECTED");
  });

  it("keeps the rejection reason on the record and relays it to the submitter", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory();

    const e = await createExpense(deps, actor, { category: cat, amount: 4200 });
    await submitExpense(deps, actor, e.uuid);
    const rejected = await rejectExpense(deps, actor, e.uuid, "  Missing the vendor invoice  ");
    expect(rejected.decisionNote).toBe("Missing the vendor invoice"); // trimmed, not stored as typed
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.some((n) => n.type === "expense.rejected" && (n.body ?? "").includes("Missing the vendor invoice"))).toBe(true);

    // An empty reason is stored as absent, not as an empty string.
    const e2 = await createExpense(deps, actor, { category: cat, amount: 100 });
    await submitExpense(deps, actor, e2.uuid);
    expect((await rejectExpense(deps, actor, e2.uuid, "   ")).decisionNote).toBeNull();
  });

  it("bridges a reimbursable expense to an APPROVED reimbursement on the payroll queue, and refuses :pay", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Travel");

    const e = await createExpense(deps, actor, { category: cat, amount: 18500, reimbursable: true, description: "Client trip" });
    await submitExpense(deps, actor, e.uuid);
    const approved = await approveExpense(deps, actor, e.uuid);

    // A reimbursement was created and linked.
    expect(approved.reimbursementId).toBeTruthy();
    const reimb = (await deps.db.select().from(schema.reimbursements).where(eq(schema.reimbursements.uuid, approved.reimbursementId!)))[0]!;
    expect(reimb.state).toBe("APPROVED");
    expect(reimb.employeeId).toBe(emp);

    // It shows in the payroll payout queue (APPROVED + not yet paid).
    const queue = await approvedUnpaidReimbursements(deps, emp);
    expect(queue.map((r) => r.uuid)).toContain(reimb.uuid);

    // :pay is refused for a reimbursable expense (paid via payroll, not out-of-band).
    await expect(payExpense(deps, actor, e.uuid)).rejects.toThrow();

    // Approving again is a no-op flip guarded on SUBMITTED -> no second reimbursement.
    await expect(approveExpense(deps, actor, e.uuid)).rejects.toThrow();
    const all = await deps.db.select().from(schema.reimbursements);
    expect(all.length).toBe(1);
  });

  // The vendor filter is what lets a vendor's own dialog total its spend without downloading the ledger, so
  // it has to narrow SERVER-side like the category and cost-centre filters next to it.
  it("narrows a list to one vendor", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Hosting");
    const acme = await seedVendor("Acme");
    const other = await seedVendor("Other");

    await createExpense(deps, actor, { category: cat, vendor: acme, amount: 1000 });
    await createExpense(deps, actor, { category: cat, vendor: acme, amount: 2500 });
    await createExpense(deps, actor, { category: cat, vendor: other, amount: 700 });

    const scope = { breadth: "all", deptCode: null, ownerId: emp, seeRestricted: true } as ListScope;
    const mine = await listExpenses(deps, scope, 100, undefined, { vendor: acme });
    expect(mine.items.map((r) => r.amount).sort((a, b) => a - b)).toEqual([1000, 2500]);
    const everything = await listExpenses(deps, scope, 100, undefined, {});
    expect(everything.items.length).toBe(3);
  });
});

// WHOSE EXPENSE IS THIS? A behavioural test, because the answer has already been mis-read once from the source
// alone - a review pass retracted this defect after reading the very guard that closed it and taking it for
// something that had always been there.
//
// The trap `leave-requests` documents, one collection over: `expenses: write` is the collection-level grant
// that makes self-service filing work, so it decides nothing about WHOSE expense is being filed. Naming
// another employee in the payload is something any caller can do. Before the guard, an ordinary employee could
// POST `{ "employee": "employees/<colleague>", "amount": 50000 }` and the row was created OWNED BY the
// colleague - code-allocated under their code, so it landed in their expense list and their manager's queue,
// `:submit` notified THEIR manager and drove automations against them, and the creator's own `own`-scoped list
// could not see it afterwards. Plant and forget.
//
// TWO INDEPENDENT DEFENCES, and this exercises the service half. The other is the `expenses` entry in
// `OWNER_REFS` (domain/manifests.ts), which makes the middleware demand write on `expenses.<ownerCode>` before
// the body reaches the service at all; `test/ownerOnCreateDrift.test.ts` is what holds that one.
describe("an expense is owned by the caller unless they may reach past their own rows", () => {
  const withGrant = (actor: AppUser, role: string): AppUser =>
    ({ ...actor, role, grant: grantFor(role), policy: DEFAULT_POLICY }) as AppUser;

  it("forces self when an ordinary employee names a colleague", async () => {
    const me = await seedEmployee();
    const colleague = await seedEmployee();
    const actor = withGrant(await seedActor(me), "employee");

    const row = await createExpense(deps, actor, { employee: `employees/${colleague}`, amount: 50_000, description: "planted" });
    expect(row.employeeId).toBe(me);
    // And the code is allocated under the CALLER, so it cannot surface in the colleague's scoped list either.
    expect(row.employeeId).not.toBe(colleague);
  });

  it("still lets that employee file their own, which is what the collection grant is for", async () => {
    const me = await seedEmployee();
    const actor = withGrant(await seedActor(me), "employee");

    const named = await createExpense(deps, actor, { employee: `employees/${me}`, amount: 100, description: "mine, named" });
    const omitted = await createExpense(deps, actor, { amount: 200, description: "mine, implied" });
    expect([named.employeeId, omitted.employeeId]).toEqual([me, me]);
  });

  it("lets finance file on behalf, which is the case the field exists for", async () => {
    // A vendor invoice arrives at finance, not at the employee who ordered it - `hr_admin` holds `expenses` at
    // all breadth, so its reach genuinely extends past its own rows.
    const someone = await seedEmployee();
    const finance = withGrant(await seedActor(await seedEmployee()), "hr_admin");

    const row = await createExpense(deps, finance, { employee: `employees/${someone}`, amount: 9_000, description: "vendor invoice" });
    expect(row.employeeId).toBe(someone);
  });

  it("refuses when there is nobody to own it - it never falls back to the named employee", async () => {
    // A caller with no employee record and only `own` reach: the honest answer is a refusal, not the colleague
    // the body asked for. This is the branch that would quietly re-open the hole if it fell back.
    const colleague = await seedEmployee();
    const actor = { ...(await seedActor(await seedEmployee())), employeeId: null, role: "employee", grant: grantFor("employee"), policy: DEFAULT_POLICY } as unknown as AppUser;
    await expect(createExpense(deps, actor, { employee: `employees/${colleague}`, amount: 10 })).rejects.toThrow(/employee is required/);
  });
});
