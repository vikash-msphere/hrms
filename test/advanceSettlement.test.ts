/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// A claim filed against an advance discharges the advance instead of being paid out again.
//
// THE FAILURE THIS EXISTS TO STOP is a double payment, and it is silent: the employee takes a 50,000 travel
// float, files 45,000 of claims, the claims pay out in full, and payroll separately recovers the 50,000 from
// salary. Nothing errors, every row looks right on its own, and the org is 45,000 down.
//
// So the assertions here are mostly about money NOT moving twice - which is why several of them check a figure
// that stayed the same, and why the concurrency case matters more than the happy path. The happy path is one
// subtraction; the dangerous cases are the ones where the subtraction happens twice, or where the approval
// lands without the credit that justifies it.
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
  createReimbursement, approveReimbursement, rejectReimbursement,
  approvedUnpaidReimbursementsAll,
} from "../src/services/reimbursements";

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
  schema.loanRepayments, schema.reimbursements, schema.loans,
  schema.notifications, schema.eventLog, schema.automationRuns, schema.auditLog, schema.settings,
  schema.users, schema.employees, schema.roles,
];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  // One actor files and approves every claim here. The subject of these cases is the money, not maker-checker
  // (test/decisionGuard.test.ts), so the org opts into self-approval the way a one-person team would.
  await deps.db.insert(schema.settings).values({ key: "approvals", value: JSON.stringify({ allow_self_approval: true }) }).onConflictDoNothing();
});

const short = (p: string) => `${p}-${genId().slice(0, 6)}`;

async function seedEmployee(): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code: short("04"), firstName: "T", lastName: "U", workEmail: `${uuid}@t.example`, status: "active" });
  return uuid;
}
async function seedActor(employeeId: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: short("u"), email: `${uuid}@t.example`, role: "employee", employeeId });
  return { uuid, email: `${uuid}@t.example`, role: "employee", status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

/** A disbursed advance, written directly: the lifecycle (approve/disburse) is loans.ts's own tested business. */
async function seedAdvance(employeeId: string, principal: number, opts: { kind?: "loan" | "advance"; status?: "PENDING" | "APPROVED" | "DISBURSED" | "CLOSED"; repaid?: number } = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.loans).values({
    uuid, code: short("ln"), employeeId,
    kind: opts.kind ?? "advance",
    principal, installments: 1, monthlyAmount: principal, repaid: opts.repaid ?? 0,
    reason: "Travel float",
    status: opts.status ?? "DISBURSED",
  });
  return uuid;
}

const advance = async (id: string) => (await deps.db.select().from(schema.loans).where(eq(schema.loans.uuid, id)))[0]!;
const claim = async (id: string) => (await deps.db.select().from(schema.reimbursements).where(eq(schema.reimbursements.uuid, id)))[0]!;
/** What the payroll payout queue would actually pay this employee, which is the number the bug was in. */
const payable = async () =>
  (await approvedUnpaidReimbursementsAll(deps)).reduce((sum, r) => sum + Math.max(0, r.amount - (r.advanceSettled ?? 0)), 0);

describe("a claim against an advance", () => {
  it("discharges the advance instead of paying out again", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 50_000);

    const c = await createReimbursement(deps, actor, { amount: 12_000, advance: `loans/${adv}`, description: "Hotel" });
    await approveReimbursement(deps, actor, c.uuid);

    // The advance is credited...
    expect((await advance(adv)).repaid).toBe(12_000);
    // ...the claim records the split...
    expect((await claim(c.uuid)).advanceSettled).toBe(12_000);
    // ...and the payout queue pays NOTHING for it, which is the whole point.
    expect(await payable()).toBe(0);
    // The credit is in the ledger, so the outstanding can be reconciled by summing it.
    const ledger = await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.loanId, adv));
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.amount).toBe(12_000);
    expect(ledger[0]!.runId).toBeNull(); // not a payroll installment
  });

  it("pays only the excess when the claim overspends the advance", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 10_000);

    const c = await createReimbursement(deps, actor, { amount: 13_500, advance: `loans/${adv}` });
    await approveReimbursement(deps, actor, c.uuid);

    expect((await claim(c.uuid)).advanceSettled).toBe(10_000);
    expect(await payable()).toBe(3_500);
    // The advance is closed once it is fully discharged, so a later claim cannot settle against it again.
    expect((await advance(adv)).status).toBe("CLOSED");
  });

  it("settles several claims against one advance until it runs out", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 10_000);

    const first = await createReimbursement(deps, actor, { amount: 6_000, advance: `loans/${adv}` });
    await approveReimbursement(deps, actor, first.uuid);
    const second = await createReimbursement(deps, actor, { amount: 7_000, advance: `loans/${adv}` });
    await approveReimbursement(deps, actor, second.uuid);

    // 6,000 then the remaining 4,000; the second claim's other 3,000 is payable.
    expect((await claim(first.uuid)).advanceSettled).toBe(6_000);
    expect((await claim(second.uuid)).advanceSettled).toBe(4_000);
    expect((await advance(adv)).repaid).toBe(10_000);
    expect(await payable()).toBe(3_000);
  });

  it("credits the advance exactly once when two approvals race", async () => {
    // THE CASE THE BATCH EXISTS FOR. Two approvers press at the same moment: the state flip is the
    // exactly-once guard, and the credit rides in the same checked batch, so the advance must move once. If
    // the credit were a second await after the flip, the loser could still credit.
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 50_000);
    const c = await createReimbursement(deps, actor, { amount: 9_000, advance: `loans/${adv}` });

    const results = await Promise.allSettled([
      approveReimbursement(deps, actor, c.uuid),
      approveReimbursement(deps, actor, c.uuid),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);

    expect((await advance(adv)).repaid).toBe(9_000); // not 18,000
    expect((await claim(c.uuid)).advanceSettled).toBe(9_000);
    const ledger = await deps.db.select().from(schema.loanRepayments).where(eq(schema.loanRepayments.loanId, adv));
    expect(ledger.length).toBe(1);
  });

  it("pays the claim normally when the advance closed after it was filed", async () => {
    // Honest outcome rather than a refusal: the money was spent either way, so the claim is approved and paid.
    // What must NOT happen is a claim marked settled against an advance that took no credit.
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 5_000);
    const c = await createReimbursement(deps, actor, { amount: 4_000, advance: `loans/${adv}` });

    await deps.db.update(schema.loans).set({ status: "CLOSED" }).where(eq(schema.loans.uuid, adv));
    await approveReimbursement(deps, actor, c.uuid);

    expect((await claim(c.uuid)).advanceSettled).toBe(0);
    expect((await advance(adv)).repaid).toBe(0);
    expect(await payable()).toBe(4_000);
  });

  it("leaves the advance alone when the claim is rejected", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 50_000);
    const c = await createReimbursement(deps, actor, { amount: 9_000, advance: `loans/${adv}` });

    await rejectReimbursement(deps, actor, c.uuid, "Receipt is unreadable");
    expect((await advance(adv)).repaid).toBe(0);
    expect((await claim(c.uuid)).advanceSettled).toBe(0);
    expect(await payable()).toBe(0);
  });

  it("pays an ordinary claim in full", async () => {
    // The control: nothing about this feature may change a claim that names no advance.
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const c = await createReimbursement(deps, actor, { amount: 2_500 });
    await approveReimbursement(deps, actor, c.uuid);

    expect((await claim(c.uuid)).advanceId).toBeNull();
    expect((await claim(c.uuid)).advanceSettled).toBe(0);
    expect(await payable()).toBe(2_500);
  });
});

describe("what may fund a claim", () => {
  // Each of these is a way the money goes astray if the check is missing, so each is refused at FILING rather
  // than discovered at approval - by which point somebody has already been told the claim was accepted.
  it("refuses a loan, which is repaid rather than spent", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const loan = await seedAdvance(emp, 50_000, { kind: "loan" });
    await expect(createReimbursement(deps, actor, { amount: 1_000, advance: `loans/${loan}` })).rejects.toThrow(/only an advance/i);
  });

  it("refuses another employee's advance", async () => {
    const emp = await seedEmployee();
    const other = await seedEmployee();
    const actor = await seedActor(emp);
    const theirs = await seedAdvance(other, 50_000);
    await expect(createReimbursement(deps, actor, { amount: 1_000, advance: `loans/${theirs}` })).rejects.toThrow(/different employee/i);
  });

  it("refuses an advance that was never disbursed", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 50_000, { status: "APPROVED" });
    await expect(createReimbursement(deps, actor, { amount: 1_000, advance: `loans/${adv}` })).rejects.toThrow(/not been disbursed/i);
  });

  it("refuses an advance with nothing left on it", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const adv = await seedAdvance(emp, 5_000, { repaid: 5_000 });
    await expect(createReimbursement(deps, actor, { amount: 1_000, advance: `loans/${adv}` })).rejects.toThrow(/already fully settled/i);
  });
});
