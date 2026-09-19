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
import { createExpense, updateExpense, submitExpense, approveExpense, cancelExpense, generateRecurringExpenses } from "../src/services/expenses";
import { createExpenseBudget, computeBudgetSpend, computeBudgetSpendMany, listExpenseBudgets, checkBudgetThresholds, openRecurringBudgetPeriods } from "../src/services/expenseBudgets";
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
  // Every budget on the page is derived from ONE expenses read. This asserts both halves: the numbers match
  // per-budget derivation, and the read count does not grow with the number of budgets.
  it("derives many budgets from a single expenses query, matching per-budget derivation", async () => {
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
    (deps.db as unknown as { select: typeof before }).select = ((...args: unknown[]) => { queries++; return (before as any).apply(deps.db, args); }) as typeof before;
    const many = await computeBudgetSpendMany(deps, scopes as any);
    (deps.db as unknown as { select: typeof before }).select = before;
    expect(queries).toBe(1);

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
