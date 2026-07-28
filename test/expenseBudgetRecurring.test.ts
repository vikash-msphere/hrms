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
import { createExpense, submitExpense, approveExpense, generateRecurringExpenses } from "../src/services/expenses";
import { createExpenseBudget, computeBudgetSpend, checkBudgetThresholds } from "../src/services/expenseBudgets";
import { advanceRecurrence, periodKeyFor } from "../src/domain/expenses";

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
async function seedCategory(name = "Rent"): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.expenseCategories).values({ uuid, code: short("c"), name });
  return uuid;
}

describe("recurring expense generation", () => {
  it("clones a due template once, advances nextOccurrenceOn, and is idempotent", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory();
    const due = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01

    const tpl = await createExpense(deps, actor, {
      category: `expense-categories/${cat}`, amount: 450000, description: "Monthly rent",
      recurring: true, recurrence_rule: "monthly", next_occurrence_on: "2026-06-01",
    });
    expect(tpl.state).toBe("DRAFT");

    const now = new Date(Date.UTC(2026, 5, 2)); // day after due
    const generated = await generateRecurringExpenses(deps, now);
    expect(generated).toBe(1);

    // One clone, submitted (default), linked to the template, incurred on the occurrence date.
    const clones = (await deps.db.select().from(schema.expenses)).filter((e) => e.templateId === tpl.uuid);
    expect(clones.length).toBe(1);
    expect(clones[0]!.state).toBe("SUBMITTED");
    expect(clones[0]!.amount).toBe(450000);

    // Template advanced one month.
    const freshTpl = (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, tpl.uuid)))[0]!;
    expect(+new Date(freshTpl.nextOccurrenceOn!)).toBe(+advanceRecurrence(due, "monthly"));

    // Re-run same tick: template no longer due -> no new clone.
    const again = await generateRecurringExpenses(deps, now);
    expect(again).toBe(0);
    const clones2 = (await deps.db.select().from(schema.expenses)).filter((e) => e.templateId === tpl.uuid);
    expect(clones2.length).toBe(1);
  });
});

describe("expense budgets", () => {
  it("derives spend from approved+paid expenses in the period, and ignores drafts and other periods", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Software");
    const periodKey = periodKeyFor("monthly", new Date(Date.UTC(2026, 5, 15)));

    // Two expenses in June: one approved (counts), one still draft (excluded).
    const inPeriod = { category: `expense-categories/${cat}`, incurred_on: "2026-06-10" };
    const a = await createExpense(deps, actor, { ...inPeriod, amount: 30000 });
    await submitExpense(deps, actor, a.uuid);
    await approveExpense(deps, actor, a.uuid);
    await createExpense(deps, actor, { ...inPeriod, amount: 99999 }); // stays DRAFT -> excluded
    // One approved expense in a different month (excluded).
    const other = await createExpense(deps, actor, { category: `expense-categories/${cat}`, incurred_on: "2026-05-10", amount: 50000 });
    await submitExpense(deps, actor, other.uuid);
    await approveExpense(deps, actor, other.uuid);

    const budget = await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: periodKey, amount: 100000 });
    expect(budget.spent).toBe(30000);
    expect(budget.remaining).toBe(70000);

    const raw = (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, budget.uuid)))[0]!;
    expect(await computeBudgetSpend(deps, raw)).toBe(30000);
  });

  it("fires a budget-threshold alert once when spend crosses a level", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Marketing");
    const periodKey = periodKeyFor("monthly", new Date(Date.UTC(2026, 5, 15)));

    // Spend 90k of a 100k budget -> crosses the 80% threshold (default [80,100]).
    const e = await createExpense(deps, actor, { category: `expense-categories/${cat}`, incurred_on: "2026-06-10", amount: 90000 });
    await submitExpense(deps, actor, e.uuid);
    await approveExpense(deps, actor, e.uuid);
    const budget = await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: periodKey, amount: 100000 });

    const fired = await checkBudgetThresholds(deps);
    expect(fired).toBe(1);
    const raw = (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, budget.uuid)))[0]!;
    expect(raw.alertLevel).toBe(80);

    // A budgetThreshold event was emitted.
    const events = (await deps.db.select().from(schema.eventLog)).filter((ev) => ev.type === "expense.budgetThreshold");
    expect(events.length).toBe(1);

    // Re-run: 80% already alerted -> no re-fire.
    expect(await checkBudgetThresholds(deps)).toBe(0);
  });
});
