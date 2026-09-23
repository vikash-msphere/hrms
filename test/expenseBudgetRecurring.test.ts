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
import { createExpense, updateExpense, submitExpense, approveExpense, cancelExpense, generateRecurringExpenses, seriesDriftFor, duplicateClaimOf, expenseTriageFor } from "../src/services/expenses";
import { createExpenseBudget, computeBudgetSpend, computeBudgetSpendMany, listExpenseBudgets, checkBudgetThresholds, openRecurringBudgetPeriods, budgetWithSpend, expenseBudgetSpec } from "../src/services/expenseBudgets";
import { crudService } from "../src/services/crud";
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
  // One actor submits and approves most claims here. Budgets and series are the subject, not maker-checker
  // (test/decisionGuard.test.ts), so the org opts into self-approval.
  await deps.db.insert(schema.settings).values({ key: "approvals", value: JSON.stringify({ allow_self_approval: true }) });
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
/** One expense charged to a cap: filed, submitted and (by default) approved, which is what `spent` counts. */
async function charged(actor: AppUser, cat: string, on: string, amount: number, approve = true) {
  const e = await createExpense(deps, actor, { category: `expense-categories/${cat}`, incurred_on: on, amount });
  await submitExpense(deps, actor, e.uuid);
  if (approve) await approveExpense(deps, actor, e.uuid);
  return e;
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

  it("holds while paused and rolls the due date forward on resume", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory();

    const tpl = await createExpense(deps, actor, {
      category: `expense-categories/${cat}`, amount: 120000, description: "Office rent",
      recurring: true, recurrence_rule: "monthly", next_occurrence_on: "2026-06-01",
    });
    await updateExpense(deps, actor, tpl.uuid, { paused: true });

    // Paused: the cron walks past it, however overdue it is.
    expect(await generateRecurringExpenses(deps, new Date(Date.UTC(2026, 7, 2)))).toBe(0);

    // Resuming skips the occurrences that fell during the pause instead of back-filing them all.
    const resumed = await updateExpense(deps, actor, tpl.uuid, { paused: false });
    expect(resumed.paused).toBe(false);
    expect(+new Date(resumed.nextOccurrenceOn!)).toBeGreaterThanOrEqual(+new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())));
  });

  it("stops generating once the template is cancelled", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory();

    const tpl = await createExpense(deps, actor, {
      category: `expense-categories/${cat}`, amount: 9900, description: "Monthly SaaS seat",
      recurring: true, recurrence_rule: "monthly", next_occurrence_on: "2026-06-01",
    });
    // :cancel on a template is how the UI stops a schedule - the cron must honour it.
    await cancelExpense(deps, actor, tpl.uuid);

    expect(await generateRecurringExpenses(deps, new Date(Date.UTC(2026, 5, 2)))).toBe(0);
    const clones = (await deps.db.select().from(schema.expenses)).filter((e) => e.templateId === tpl.uuid);
    expect(clones.length).toBe(0);
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

    // A submitted-but-unapproved expense in the period is PENDING: it must not move spend/utilization, but it
    // travels alongside so a cap can warn before the approval lands.
    const queued = await createExpense(deps, actor, { ...inPeriod, amount: 12000 });
    await submitExpense(deps, actor, queued.uuid);

    const budget = await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: periodKey, amount: 100000 });
    expect(budget.spent).toBe(30000);
    expect(budget.remaining).toBe(70000);
    expect(budget.pending).toBe(12000);

    const raw = (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, budget.uuid)))[0]!;
    // `months` is the same spend broken out per calendar month the period covers (it becomes `spendHistory`
    // on the wire). A monthly budget covers exactly one, so it restates the total - which is the case worth
    // pinning, because a breakdown that disagreed with its own total would be worse than no breakdown.
    expect(await computeBudgetSpend(deps, raw)).toEqual({ spent: 30000, pending: 12000, months: [{ period: "2026-06", spent: 30000 }] });
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

describe("budget spend attribution", () => {
  // Every budget on the page is derived from a CONSTANT number of reads. This asserts both halves: the numbers
  // match per-budget derivation, and the read count does not grow with the number of budgets.
  //
  // It used to assert exactly one read, which stopped being the invariant when allocation lines arrived: a
  // split invoice charges its lines, so the expenses read is followed by one read of the splits within the
  // same window. That is still O(1) in budgets, which is the property this protects - a page of fifty caps at
  // the Workers subrequest ceiling was the failure it was written for. So the assertion now measures the thing
  // it cares about directly, by counting the same work for ONE budget and for many, rather than pinning a
  // number that any future constant-cost read would have to come and edit.
  it("derives many budgets from a constant number of queries, matching per-budget derivation", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const travel = await seedCategory("Travel");
    const cloud = await seedCategory("Cloud");
    const deptId = genId();
    await deps.db.insert(schema.departments).values({ uuid: deptId, code: "01", name: "Sales" });

    const charge = async (cat: string, on: string, amount: number, dept?: string, approve = true) => {
      const e = await createExpense(deps, actor, { category: `expense-categories/${cat}`, department: dept ? `departments/${dept}` : undefined, incurred_on: on, amount });
      await submitExpense(deps, actor, e.uuid);
      if (approve) await approveExpense(deps, actor, e.uuid);
      return e;
    };
    await charge(travel, "2026-07-03", 10000);
    await charge(travel, "2026-07-28", 5000, deptId);
    await charge(travel, "2026-08-02", 9000); // next month: outside a July cap
    await charge(cloud, "2026-07-10", 3000);
    await charge(cloud, "2026-09-10", 1000, undefined, false); // pending, and in Q3 but not July

    const scopes = [
      { departmentId: null, categoryId: travel, periodType: "monthly", periodKey: "2026-07" },
      { departmentId: deptId, categoryId: travel, periodType: "monthly", periodKey: "2026-07" },
      { departmentId: null, categoryId: cloud, periodType: "quarterly", periodKey: "2026-Q3" },
      { departmentId: null, categoryId: null, periodType: "yearly", periodKey: "2026" },
    ] as const;

    const before = deps.db.select;
    let queries = 0;
    const count = () => {
      (deps.db as unknown as { select: typeof before }).select = ((...args: unknown[]) => { queries++; return (before as any).apply(deps.db, args); }) as typeof before;
    };
    const stop = () => { (deps.db as unknown as { select: typeof before }).select = before; };

    count();
    const many = await computeBudgetSpendMany(deps, scopes as any);
    stop();
    const forMany = queries;

    queries = 0;
    count();
    await computeBudgetSpendMany(deps, [scopes[0]] as any);
    stop();
    const forOne = queries;

    // THE PROPERTY: four budgets cost exactly what one does. A per-budget read would make this 4x.
    expect(forMany).toBe(forOne);
    // And that constant stays small - a guard against the "constant" quietly becoming a dozen reads.
    expect(forMany).toBeLessThanOrEqual(3);

    const key = (s: (typeof scopes)[number]) => `${s.departmentId ?? "-"}|${s.categoryId ?? "-"}|${s.periodType}|${s.periodKey}`;
    // `toMatchObject`, because the answer also carries the per-month breakdown `spend_history` is built from -
    // which has its own tests below. The totals are what this one is about.
    // Org-wide Travel, July: both July travel charges (the dept one included - an org-wide cap has no filter).
    expect(many.get(key(scopes[0]))).toMatchObject({ spent: 15000, pending: 0 });
    // Sales Travel, July: only the charge carrying that cost centre.
    expect(many.get(key(scopes[1]))).toMatchObject({ spent: 5000, pending: 0 });
    // Cloud, Q3: July approved + September submitted, split by commitment.
    expect(many.get(key(scopes[2]))).toMatchObject({ spent: 3000, pending: 1000 });
    // All categories, 2026: every charge in the year.
    expect(many.get(key(scopes[3]))).toMatchObject({ spent: 27000, pending: 1000 });

    // Same answers as the single-budget path.
    for (const s of scopes) expect(await computeBudgetSpend(deps, s as any)).toEqual(many.get(key(s)));
  });

  // `spend_history` on the wire is this breakdown. It is free - the attribution above already buckets every
  // charge by month in order to sum it - so what has to hold is that the series is COMPLETE (a month with no
  // charges is a real 0, not a missing point), IN ORDER, and reconciles: the points sum to `spent`. A
  // sparkline drawn from a series that silently drops its empty months draws a different shape.
  describe("per-month breakdown", () => {
    it("emits one point per month of the period, oldest first, summing to spent", async () => {
      const emp = await seedEmployee();
      const actor = await seedActor(emp);
      const cloud = await seedCategory("Cloud");
      await charged(actor, cloud, "2026-07-10", 3000);
      await charged(actor, cloud, "2026-09-10", 1500);

      const q3 = { departmentId: null, categoryId: cloud, periodType: "quarterly", periodKey: "2026-Q3" } as const;
      const { spent, months } = await computeBudgetSpend(deps, q3 as any);
      expect(months.map((m) => m.period)).toEqual(["2026-07", "2026-08", "2026-09"]);
      // August is a real zero: nothing was charged, and saying so is the point.
      expect(months.map((m) => m.spent)).toEqual([3000, 0, 1500]);
      expect(months.reduce((s, m) => s + m.spent, 0)).toBe(spent);
    });

    it("gives a monthly cap exactly one point, and a yearly cap twelve", async () => {
      const emp = await seedEmployee();
      const actor = await seedActor(emp);
      const cat = await seedCategory("Rent");
      await charged(actor, cat, "2026-03-01", 8000);

      const monthly = await computeBudgetSpend(deps, { departmentId: null, categoryId: cat, periodType: "monthly", periodKey: "2026-03" } as any);
      expect(monthly.months).toEqual([{ period: "2026-03", spent: 8000 }]);

      const yearly = await computeBudgetSpend(deps, { departmentId: null, categoryId: cat, periodType: "yearly", periodKey: "2026" } as any);
      expect(yearly.months).toHaveLength(12);
      expect(yearly.months[0]!.period).toBe("2026-01");
      expect(yearly.months[11]!.period).toBe("2026-12");
      expect(yearly.months.reduce((s, m) => s + m.spent, 0)).toBe(yearly.spent);
    });

    it("leaves submitted claims out of the series, as it leaves them out of spent", async () => {
      const emp = await seedEmployee();
      const actor = await seedActor(emp);
      const cat = await seedCategory("Events");
      await charged(actor, cat, "2026-04-05", 2000); // approved
      await charged(actor, cat, "2026-04-20", 7000, false); // submitted, still in the queue

      const { spent, pending, months } = await computeBudgetSpend(deps, { departmentId: null, categoryId: cat, periodType: "monthly", periodKey: "2026-04" } as any);
      expect(spent).toBe(2000);
      expect(pending).toBe(7000);
      // A queue is not history, so the sparkline never plots it.
      expect(months).toEqual([{ period: "2026-04", spent: 2000 }]);
    });

    it("is empty for a malformed period key rather than guessing a span", async () => {
      const cat = await seedCategory("Nonsense");
      const bad = await computeBudgetSpend(deps, { departmentId: null, categoryId: cat, periodType: "monthly", periodKey: "not-a-month" } as any);
      expect(bad).toEqual({ spent: 0, pending: 0, months: [] });
    });
  });

  it("charges an expense with no incurred date by its created date", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Misc");
    const e = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 4000 }); // no incurred_on
    await submitExpense(deps, actor, e.uuid);
    await approveExpense(deps, actor, e.uuid);
    const created = (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, e.uuid)))[0]!.createdAt!;

    const thisMonth = periodKeyFor("monthly", created);
    expect(await computeBudgetSpend(deps, { departmentId: null, categoryId: cat, periodType: "monthly", periodKey: thisMonth })).toEqual({ spent: 4000, pending: 0, months: [{ period: thisMonth, spent: 4000 }] });
    // ...and not against a month it was neither incurred nor created in.
    const other = periodKeyFor("monthly", new Date(Date.UTC(created.getUTCFullYear() - 1, 0, 15)));
    expect(await computeBudgetSpend(deps, { departmentId: null, categoryId: cat, periodType: "monthly", periodKey: other })).toEqual({ spent: 0, pending: 0, months: [{ period: other, spent: 0 }] });
  });
});

describe("budget list scoping and summary", () => {
  // The breadth the middleware would hand a finance caller for this flat catalog.
  const scopeAll = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true } as NonNullable<Parameters<typeof listExpenseBudgets>[1]>;
  const at = new Date(Date.UTC(2026, 6, 15)); // mid-July 2026

  async function seedCaps(actor: AppUser, cat: string) {
    // One cap per granularity around July 2026, plus a closed month and a future month.
    await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-06", amount: 1000 });
    await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-07", amount: 2000 });
    await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-08", amount: 3000 });
    await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "quarterly", period_key: "2026-Q3", amount: 4000 });
    await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "yearly", period_key: "2026", amount: 5000 });
  }

  it("resolves ?period=current against each row's own period type", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Cloud");
    await seedCaps(actor, cat);

    const current = await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { period: "current" }, at);
    expect(current.items.map((b) => b.periodKey).sort()).toEqual(["2026", "2026-07", "2026-Q3"]);
    expect(current.extra.phase_counts).toEqual({ current: 3, upcoming: 1, past: 1 });
    // The chips describe the whole scoped set, so every phase read agrees on them.
    const past = await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { period: "past" }, at);
    expect(past.items.map((b) => b.periodKey)).toEqual(["2026-06"]);
    expect(past.extra.phase_counts).toEqual({ current: 3, upcoming: 1, past: 1 });
    const upcoming = await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { period: "upcoming" }, at);
    expect(upcoming.items.map((b) => b.periodKey)).toEqual(["2026-08"]);
  });

  it("summarises the whole filtered set, not the returned page", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Travel");
    for (let i = 0; i < 60; i++) {
      await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-07", amount: 1000 });
    }
    const page = await listExpenseBudgets(deps, scopeAll, 25, undefined, false, { period: "current" }, at);
    expect(page.items.length).toBe(25);
    expect(page.nextPageToken).toBeTruthy();
    expect(page.extra.summary.count).toBe(60);
    expect(page.extra.summary.amount).toBe(60000);
  });

  it("filters by period key, type, year, category and derived status", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Legal");
    const other = await seedCategory("Rent");
    await seedCaps(actor, cat);
    await createExpenseBudget(deps, actor, { category: `expense-categories/${other}`, period_type: "monthly", period_key: "2025-07", amount: 900 });

    expect((await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { periodKey: "2026-07" }, at)).items.length).toBe(1);
    expect((await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { periodType: "monthly" }, at)).items.length).toBe(4);
    // A year covers every granularity inside it: three monthly + one quarterly + one yearly.
    expect((await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { year: "2026" }, at)).items.length).toBe(5);
    expect((await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { category: `expense-categories/${other}` }, at)).items.length).toBe(1);

    // Spend 1800 of the 2000 July cap: at risk (>= 80%) but not over.
    const e = await createExpense(deps, actor, { category: `expense-categories/${cat}`, incurred_on: "2026-07-04", amount: 1800 });
    await submitExpense(deps, actor, e.uuid);
    await approveExpense(deps, actor, e.uuid);
    const risky = await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { period: "current", status: "at_risk" }, at);
    expect(risky.items.map((b) => b.periodKey)).toEqual(["2026-07"]);
    expect(risky.extra.summary).toMatchObject({ count: 1, amount: 2000, spent: 1800, over: 0, at_risk: 1 });
    expect((await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { period: "current", status: "over" }, at)).items.length).toBe(0);
  });

  it("excludes deleted caps from the summary while show_deleted still lists them", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Ads");
    const keep = await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-07", amount: 1000 });
    const gone = await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-07", amount: 7000 });
    await deps.db.update(schema.expenseBudgets).set({ deleteTime: new Date() }).where(eq(schema.expenseBudgets.uuid, gone.uuid));

    const live = await listExpenseBudgets(deps, scopeAll, 50, undefined, false, { period: "current" }, at);
    expect(live.items.map((b) => b.uuid)).toEqual([keep.uuid]);
    expect(live.extra.summary.amount).toBe(1000);
    const withDeleted = await listExpenseBudgets(deps, scopeAll, 50, undefined, true, { period: "current" }, at);
    expect(withDeleted.items.length).toBe(2);
    expect(withDeleted.extra.summary.amount).toBe(1000); // a deleted cap is not part of the budget
  });
});

describe("recurring budget periods", () => {
  it("opens the next period once, carries the cap, and never resurrects a deleted period", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Cloud");
    const july = periodKeyFor("monthly", new Date(Date.UTC(2026, 6, 15)));
    const august = periodKeyFor("monthly", new Date(Date.UTC(2026, 7, 15)));
    const b = await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: july, amount: 50000, recurring: true });
    expect(b.recurring).toBe(true);

    // Mid-period: nothing to open yet.
    expect(await openRecurringBudgetPeriods(deps, new Date(Date.UTC(2026, 6, 20)))).toBe(0);

    // Period closed: August opens at the same cap, itself recurring, un-alerted - and only once.
    expect(await openRecurringBudgetPeriods(deps, new Date(Date.UTC(2026, 7, 2)))).toBe(1);
    const opened = (await deps.db.select().from(schema.expenseBudgets)).find((r) => r.periodKey === august)!;
    expect(opened.amount).toBe(50000);
    expect(opened.recurring).toBe(true);
    expect(opened.alertLevel).toBe(0);
    expect(opened.code).toBeTruthy();
    expect(await openRecurringBudgetPeriods(deps, new Date(Date.UTC(2026, 7, 2)))).toBe(0);

    // Someone deletes August: "not this period". The cron must not put it back.
    await deps.db.update(schema.expenseBudgets).set({ deleteTime: new Date() }).where(eq(schema.expenseBudgets.uuid, opened.uuid));
    expect(await openRecurringBudgetPeriods(deps, new Date(Date.UTC(2026, 7, 2)))).toBe(0);
  });

  it("advances only one period per tick, and leaves non-recurring caps alone", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Legal");
    const q1 = periodKeyFor("quarterly", new Date(Date.UTC(2026, 1, 10)));
    await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "quarterly", period_key: q1, amount: 20000, recurring: true });
    const other = await seedCategory("Stationery");
    await createExpenseBudget(deps, actor, { category: `expense-categories/${other}`, period_type: "quarterly", period_key: q1, amount: 1000 });

    // A year later: the recurring cap opens Q2 only (Q2 is itself recurring and rolls on the next tick), and
    // the non-recurring one opens nothing.
    expect(await openRecurringBudgetPeriods(deps, new Date(Date.UTC(2027, 0, 5)))).toBe(1);
    const keys = (await deps.db.select().from(schema.expenseBudgets)).map((r) => r.periodKey).sort();
    expect(keys).toEqual(["2026-Q1", "2026-Q1", "2026-Q2"]);
    expect(await openRecurringBudgetPeriods(deps, new Date(Date.UTC(2027, 0, 5)))).toBe(1); // Q3 next tick
  });
});

// ---------------------------------------------------------------------------------------------------------
// The two forward-looking signals, end to end. The arithmetic itself is held in test/budgetForecastDrift.test.ts;
// these assert the wiring - that the forecast reaches a budget read, that its alert fires once per period and
// re-arms when the cap changes, and that drift is measured against the occurrences a real series produced.
// ---------------------------------------------------------------------------------------------------------

describe("budget burn forecast", () => {
  it("projects a live period onto a budget read, and says nothing about a closed one", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Cloud");
    // Half of June spent by the 11th: 50% utilized, no threshold crossed, but the rate lands it over.
    await charged(actor, cat, "2026-06-05", 50000);
    const budget = await createExpenseBudget(deps, actor, {
      category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-06", amount: 100000,
    });

    const live = await budgetWithSpend(deps, (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, budget.uuid)))[0]!, new Date(Date.UTC(2026, 5, 11)));
    expect(live.utilization).toBeCloseTo(0.5, 2); // nothing has crossed 80%
    expect(live.projection).not.toBeNull();
    expect(live.projection!.projected).toBeGreaterThan(100000);
    expect(live.projection!.projectedOverBy).toBeGreaterThan(0);

    // The same budget read after the period closed: the spend is now a fact, so there is no forecast.
    const closed = await budgetWithSpend(deps, (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, budget.uuid)))[0]!, new Date(Date.UTC(2026, 7, 1)));
    expect(closed.projection).toBeNull();
    expect(closed.spent).toBe(50000);
  });

  it("fires a projected-breach alert once per period, and re-arms when the cap changes", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Travel");
    await charged(actor, cat, "2026-06-05", 50000);
    const budget = await createExpenseBudget(deps, actor, {
      category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-06", amount: 100000,
    });
    const reread = async () => (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, budget.uuid)))[0]!;
    const breaches = async () => (await deps.db.select().from(schema.eventLog)).filter((ev) => ev.type === "expense.budgetProjectedBreach");

    // Day 11 of 30: the forecast is over, the spend is only at 50%, so the threshold alert has NOT fired.
    const asOf = new Date(Date.UTC(2026, 5, 11));
    expect(await checkBudgetThresholds(deps, asOf)).toBe(1);
    expect((await reread()).alertLevel).toBe(0); // the backwards alert is independent and still silent
    expect((await reread()).projectionAlertedAt).not.toBeNull();
    expect((await breaches()).length).toBe(1);

    // Same forecast the next night: already said, so nothing is emitted.
    expect(await checkBudgetThresholds(deps, new Date(Date.UTC(2026, 5, 12)))).toBe(0);
    expect((await breaches()).length).toBe(1);

    // Raising the cap un-breaches the forecast AND re-arms the guard, so a later breach can be reported again.
    await crudService(expenseBudgetSpec).update(deps, actor, budget.uuid, { amount: 500000 });
    expect((await reread()).projectionAlertedAt).toBeNull();
    expect(await checkBudgetThresholds(deps, new Date(Date.UTC(2026, 5, 13)))).toBe(0); // 500k cap now holds
    expect((await breaches()).length).toBe(1);
  });

  it("leaves the backwards threshold alert alone", async () => {
    // The two guards must not suppress each other: a cap past 80% in a period too young to forecast still
    // fires its threshold alert, and stamps nothing on the projection guard.
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Legal");
    await charged(actor, cat, "2026-01-01", 90000);
    const budget = await createExpenseBudget(deps, actor, {
      category: `expense-categories/${cat}`, period_type: "yearly", period_key: "2026", amount: 100000,
    });
    // Two days into the year: 90% spent (threshold crossed) but far too early to project (15% minimum).
    expect(await checkBudgetThresholds(deps, new Date(Date.UTC(2026, 0, 2)))).toBe(1);
    const raw = (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, budget.uuid)))[0]!;
    expect(raw.alertLevel).toBe(80);
    expect(raw.projectionAlertedAt).toBeNull();
  });
});

describe("recurring series drift", () => {
  /** A template plus `amounts.length` generated occurrences, each edited to the amount given. */
  async function series(actor: AppUser, cat: string, templateAmount: number, amounts: number[]) {
    const tpl = await createExpense(deps, actor, {
      category: `expense-categories/${cat}`, amount: templateAmount, description: "Subscription",
      recurring: true, recurrence_rule: "monthly", next_occurrence_on: "2026-01-01",
    });
    const clones: string[] = [];
    for (let i = 0; i < amounts.length; i++) {
      // The cron generates an occurrence at the template's amount; the real invoice figure arrives as an edit.
      await generateRecurringExpenses(deps, new Date(Date.UTC(2026, i, 2)));
      const fresh = (await deps.db.select().from(schema.expenses)).filter((e) => e.templateId === tpl.uuid && !clones.includes(e.uuid));
      const clone = fresh[0]!;
      await deps.db.update(schema.expenses).set({ state: "DRAFT" }).where(eq(schema.expenses.uuid, clone.uuid));
      await updateExpense(deps, actor, clone.uuid, { amount: amounts[i]! });
      clones.push(clone.uuid);
    }
    return { tpl, clones };
  }

  it("flags the occurrence whose amount left the series, and stays quiet about the rest", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Software");
    // Four months at 1000, then a price rise to 1300.
    const { clones } = await series(actor, cat, 1000, [1000, 1000, 1000, 1300]);
    const rows = await deps.db.select().from(schema.expenses);
    const drift = await seriesDriftFor(deps, rows);

    // The steady months say nothing; the rise does, measured against the median of what came before it.
    for (const id of clones.slice(0, 3)) expect(drift.get(id)).toBeUndefined();
    const flagged = drift.get(clones[3]!)!;
    expect(flagged.direction).toBe("up");
    expect(flagged.baseline).toBe(1000);
    expect(flagged.deltaFraction).toBeCloseTo(0.3, 5);
    expect(flagged.samples).toBe(3);
  });

  it("measures the first occurrence against the template's own declared amount", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Hosting");
    // The schedule says 1000 a month; the very first invoice arrives at 1400.
    const { clones } = await series(actor, cat, 1000, [1400]);
    const drift = await seriesDriftFor(deps, await deps.db.select().from(schema.expenses));
    const first = drift.get(clones[0]!)!;
    expect(first.baseline).toBe(1000);
    expect(first.samples).toBe(1);
    expect(first.direction).toBe("up");
  });

  it("does not let a later occurrence change an earlier one's baseline", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Telecoms");
    // Two steady months, a spike, then a return to normal. The spike is flagged; the month AFTER it is judged
    // against a median that the spike cannot move, so the correction is not reported as a second problem.
    const { clones } = await series(actor, cat, 1000, [1000, 1000, 2000, 1000]);
    const drift = await seriesDriftFor(deps, await deps.db.select().from(schema.expenses));
    expect(drift.get(clones[2]!)!.direction).toBe("up");
    expect(drift.get(clones[3]!)).toBeUndefined();
  });

  it("ignores cancelled occurrences when deciding what the series costs", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Utilities");
    // Two cancelled months at 5000 sit between the good ones. They are chosen so that INCLUDING them would
    // move the median all the way to 5000 and the final 1040 would read as a 79% collapse - so this test
    // fails loudly if the exclusion is ever dropped, rather than passing on a median that happens to agree.
    const { clones } = await series(actor, cat, 1000, [1000, 5000, 5000, 1040]);
    for (const id of [clones[1]!, clones[2]!]) {
      await deps.db.update(schema.expenses).set({ state: "CANCELLED" }).where(eq(schema.expenses.uuid, id));
    }
    const drift = await seriesDriftFor(deps, await deps.db.select().from(schema.expenses));
    expect(drift.get(clones[1]!)).toBeUndefined(); // excluded, so not judged either
    expect(drift.get(clones[2]!)).toBeUndefined();
    expect(drift.get(clones[3]!)).toBeUndefined(); // 1040 against a median of 1000 is 4%, inside tolerance
  });

  it("says nothing about an expense that came from no series", async () => {
    const emp = await seedEmployee();
    const actor = await seedActor(emp);
    const cat = await seedCategory("Sundries");
    const one = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 999, incurred_on: "2026-06-01" });
    const drift = await seriesDriftFor(deps, await deps.db.select().from(schema.expenses));
    expect(drift.get(one.uuid)).toBeUndefined();
    expect(drift.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Two approvals above a threshold. The rule is about WHICH PERSON, not how many presses, so every case here is
// really about identity: the same approver twice, the submitter auto-approving their own large claim, and two
// approvers racing.
// ---------------------------------------------------------------------------------------------------------

describe("second approval threshold", () => {
  async function setThreshold(v: { auto?: number; second?: number }) {
    await deps.db.insert(schema.settings).values({
      key: "expenses",
      value: JSON.stringify({ auto_approve_threshold: v.auto ?? 0, second_approval_threshold: v.second ?? 0 }),
    }).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify({ auto_approve_threshold: v.auto ?? 0, second_approval_threshold: v.second ?? 0 }) },
    });
  }
  const reread = async (id: string) => (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, id)))[0]!;

  it("takes one approval below the line and two above it", async () => {
    const emp = await seedEmployee();
    const a = await seedActor(emp);
    const b = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    await setThreshold({ second: 50_000 });

    const small = await createExpense(deps, a, { category: `expense-categories/${cat}`, amount: 10_000, incurred_on: "2026-06-01" });
    await submitExpense(deps, a, small.uuid);
    await approveExpense(deps, a, small.uuid);
    expect((await reread(small.uuid)).state).toBe("APPROVED");

    const big = await createExpense(deps, a, { category: `expense-categories/${cat}`, amount: 80_000, incurred_on: "2026-06-01" });
    await submitExpense(deps, a, big.uuid);
    await approveExpense(deps, a, big.uuid);
    // Still SUBMITTED, so it stays in the approval queue - which is true, and is why this needed no new state.
    const held = await reread(big.uuid);
    expect(held.state).toBe("SUBMITTED");
    expect(held.firstApprovedBy).toBe(a.uuid);

    await approveExpense(deps, b, big.uuid);
    expect((await reread(big.uuid)).state).toBe("APPROVED");
  });

  it("refuses the same person as both approvals", async () => {
    // THE ENTIRE POINT. Counting presses instead of people would let one approver satisfy "two approvals" by
    // pressing twice, and the control would be decorative.
    const a = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    await setThreshold({ second: 50_000 });
    const big = await createExpense(deps, a, { category: `expense-categories/${cat}`, amount: 80_000, incurred_on: "2026-06-01" });
    await submitExpense(deps, a, big.uuid);
    await approveExpense(deps, a, big.uuid);
    await expect(approveExpense(deps, a, big.uuid)).rejects.toThrow(/already approved it/i);
    expect((await reread(big.uuid)).state).toBe("SUBMITTED");
  });

  it("never auto-approves a claim that needs two people", async () => {
    // The overlap case. The two thresholds are meant to bracket opposite ends, but nothing stops an org
    // setting them so they cross - and in that overlap auto-approval would call approve AS THE SUBMITTER and
    // record them as the first of their own two approvals.
    const a = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    await setThreshold({ auto: 100_000, second: 50_000 });
    const big = await createExpense(deps, a, { category: `expense-categories/${cat}`, amount: 80_000, incurred_on: "2026-06-01" });
    await submitExpense(deps, a, big.uuid);
    const row = await reread(big.uuid);
    expect(row.state).toBe("SUBMITTED");
    expect(row.firstApprovedBy).toBeNull(); // the submitter did NOT become their own first approver
  });

  it("does nothing at all when no threshold is set", async () => {
    const a = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    await setThreshold({});
    const big = await createExpense(deps, a, { category: `expense-categories/${cat}`, amount: 900_000, incurred_on: "2026-06-01" });
    await submitExpense(deps, a, big.uuid);
    await approveExpense(deps, a, big.uuid);
    const row = await reread(big.uuid);
    expect(row.state).toBe("APPROVED");
    expect(row.firstApprovedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// The duplicate check behind the straight-through lane. It is narrowed in SQL rather than filtered in memory,
// so these pin the two things a narrowing can silently lose: a match it should still find, and a non-match it
// must not invent.
// ---------------------------------------------------------------------------------------------------------

describe("duplicateClaimOf", () => {
  const raw = async (id: string) => (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, id)))[0]!;

  it("finds the same invoice number whatever case it was typed in", async () => {
    // THE CASE THE PRE-FILTER NEARLY BROKE. The in-memory confirmation compares case-insensitively; a
    // case-sensitive SQL narrowing would have decided the answer before it got there.
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    const first = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 1000, incurred_on: "2026-06-01", invoice_number: "INV-1001" });
    const second = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 4242, incurred_on: "2026-09-09", invoice_number: "inv-1001" });
    expect(await duplicateClaimOf(deps, await raw(second.uuid))).toBe((await raw(first.uuid)).code);
  });

  it("finds the same payee and amount within a couple of days", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    const first = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 2500, incurred_on: "2026-06-01" });
    const retyped = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 2500, incurred_on: "2026-06-02" });
    expect(await duplicateClaimOf(deps, await raw(retyped.uuid))).toBe((await raw(first.uuid)).code);
  });

  it("does not reach past the date window or the amount", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 2500, incurred_on: "2026-06-01" });
    const farOff = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 2500, incurred_on: "2026-06-20" });
    const different = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 2501, incurred_on: "2026-06-01" });
    expect(await duplicateClaimOf(deps, await raw(farOff.uuid))).toBeNull();
    expect(await duplicateClaimOf(deps, await raw(different.uuid))).toBeNull();
  });

  it("is not a duplicate of somebody else's claim", async () => {
    // Same amount, same day, two different people who both bought lunch. Matching on amount and date alone
    // would call one of them a copy of the other.
    const a = await seedActor(await seedEmployee());
    const b = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    await createExpense(deps, a, { category: `expense-categories/${cat}`, amount: 400, incurred_on: "2026-06-01" });
    const theirs = await createExpense(deps, b, { category: `expense-categories/${cat}`, amount: 400, incurred_on: "2026-06-01" });
    expect(await duplicateClaimOf(deps, await raw(theirs.uuid))).toBeNull();
  });

  it("ignores a claim somebody already said no to", async () => {
    // Filing a corrected version after a rejection is what the submitter was told to do next.
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    const rejected = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 700, incurred_on: "2026-06-01" });
    await deps.db.update(schema.expenses).set({ state: "REJECTED" }).where(eq(schema.expenses.uuid, rejected.uuid));
    const corrected = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount: 700, incurred_on: "2026-06-01" });
    expect(await duplicateClaimOf(deps, await raw(corrected.uuid))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Approver triage: which claims in a queue are not routine. Batched over the page, so the cases that matter
// are the ones a page-local check gets wrong - a duplicate of a row the page does not hold, a budget nobody
// loaded - plus the one a naive batch gets wrong, which is two copies inside the same queue.
// ---------------------------------------------------------------------------------------------------------

describe("expenseTriageFor", () => {
  const submitted = async (actor: AppUser, cat: string, amount: number, on: string, invoice?: string) => {
    const e = await createExpense(deps, actor, { category: `expense-categories/${cat}`, amount, incurred_on: on, ...(invoice ? { invoice_number: invoice } : {}) });
    await submitExpense(deps, actor, e.uuid);
    return (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, e.uuid)))[0]!;
  };

  it("says nothing about a routine queue", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    const a = await submitted(actor, cat, 100, "2026-06-01");
    const b = await submitted(actor, cat, 250, "2026-06-02");
    const t = await expenseTriageFor(deps, [a, b]);
    expect(t.size).toBe(0);
  });

  it("flags a duplicate of a claim the page does not even hold", async () => {
    // THE CASE A PAGE-LOCAL CHECK CANNOT ANSWER. The earlier claim is not in the array being triaged; a client
    // filtering its own loaded rows would see nothing wrong.
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    const earlier = await submitted(actor, cat, 900, "2026-06-01");
    const copy = await submitted(actor, cat, 900, "2026-06-02");
    const t = await expenseTriageFor(deps, [copy]);
    expect(t.get(copy.uuid)?.map((s) => s.kind)).toEqual(["duplicate"]);
    expect(t.get(copy.uuid)?.[0]!.message).toContain(earlier.code!);
  });

  it("reports a duplicate pair inside one queue only once", async () => {
    // Telling an approver that each of two rows is a copy of the other says the same thing twice and names
    // neither as the original. The later filing carries the signal; the earlier one is the original.
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    const first = await submitted(actor, cat, 1200, "2026-06-01");
    const second = await submitted(actor, cat, 1200, "2026-06-01");
    const t = await expenseTriageFor(deps, [first, second]);
    const flagged = [first, second].filter((r) => t.get(r.uuid)?.some((s) => s.kind === "duplicate"));
    expect(flagged.length).toBe(1);
  });

  it("flags a claim whose approval would put its budget over", async () => {
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Travel");
    await charged(actor, cat, "2026-06-05", 90_000); // approved, so it is spend
    await createExpenseBudget(deps, actor, { category: `expense-categories/${cat}`, period_type: "monthly", period_key: "2026-06", amount: 100_000 });
    const big = await submitted(actor, cat, 20_000, "2026-06-10");
    expect(t2(await expenseTriageFor(deps, [big]), big.uuid)).toContain("over_budget");
  });

  it("flags a missing receipt its category demands", async () => {
    const actor = await seedActor(await seedEmployee());
    const uuid = genId();
    await deps.db.insert(schema.expenseCategories).values({ uuid, code: short("c"), name: "Client entertainment", requiresReceipt: true });
    // Filed BEFORE the rule existed is the interesting case, so the row is submitted and the flag still lands.
    const e = await createExpense(deps, actor, { category: `expense-categories/${uuid}`, amount: 500, incurred_on: "2026-06-01" });
    await deps.db.update(schema.expenseCategories).set({ requiresReceipt: false }).where(eq(schema.expenseCategories.uuid, uuid));
    await submitExpense(deps, actor, e.uuid);
    await deps.db.update(schema.expenseCategories).set({ requiresReceipt: true }).where(eq(schema.expenseCategories.uuid, uuid));
    const row = (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, e.uuid)))[0]!;
    expect(t2(await expenseTriageFor(deps, [row]), row.uuid)).toContain("missing_receipt");
  });

  it("ignores rows that are not awaiting a decision", async () => {
    // A ledger page of paid rows must cost nothing and say nothing: the decision is already made.
    const actor = await seedActor(await seedEmployee());
    const cat = await seedCategory("Kit");
    await submitted(actor, cat, 900, "2026-06-01");
    const copy = await submitted(actor, cat, 900, "2026-06-02");
    await deps.db.update(schema.expenses).set({ state: "PAID" }).where(eq(schema.expenses.uuid, copy.uuid));
    const paid = (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, copy.uuid)))[0]!;
    expect((await expenseTriageFor(deps, [paid])).size).toBe(0);
  });
});

const t2 = (m: Map<string, { kind: string }[]>, id: string) => (m.get(id) ?? []).map((s) => s.kind);
