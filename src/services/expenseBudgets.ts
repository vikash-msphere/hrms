// Expense budgets: a spend cap for a (department?, category?, period). NULL dept = org-wide; NULL category =
// all. Spend is DERIVED (never stored) from APPROVED+PAID expenses whose incurred date falls in the period and
// whose dept/category match the budget's filters. Finance-only collection (no employee grant).
import { eq, and, gte, lt, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { round2 } from "../domain/money";
import { periodBounds, budgetUtilization, type PeriodType } from "../domain/expenses";
import { invalidArgument } from "../lib/errors";
import { visibleByDelete } from "./softDelete";
import type { AppUser } from "../env";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";

export type ExpenseBudgetInput = {
  department?: string | null; // "departments/<id>"
  category?: string | null;   // "expense-categories/<id>"
  period_type?: PeriodType;
  period_key?: string;
  amount?: number;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

type BudgetRow = typeof schema.expenseBudgets.$inferSelect;

// Sum of APPROVED+PAID expense amounts charged to this budget in its period. One query per budget (budgets are
// few). `incurredOn` decides the period; rows with no incurred date fall back to `createdAt`.
export async function computeBudgetSpend(deps: Deps, budget: Pick<BudgetRow, "departmentId" | "categoryId" | "periodType" | "periodKey">): Promise<number> {
  const { start, end } = periodBounds(budget.periodType as PeriodType, budget.periodKey);
  const conds = [
    inArray(schema.expenses.state, ["APPROVED", "PAID"]),
    gte(schema.expenses.incurredOn, new Date(start)),
    lt(schema.expenses.incurredOn, new Date(end)),
  ];
  if (budget.departmentId) conds.push(eq(schema.expenses.departmentId, budget.departmentId));
  if (budget.categoryId) conds.push(eq(schema.expenses.categoryId, budget.categoryId));
  const rows = await deps.db.select({ amount: schema.expenses.amount }).from(schema.expenses).where(and(...conds));
  return round2(rows.reduce((sum, r) => sum + (r.amount ?? 0), 0));
}

// A budget row plus its derived spend/remaining/utilization, ready for the serializer.
export async function budgetWithSpend(deps: Deps, budget: BudgetRow) {
  const spent = await computeBudgetSpend(deps, budget);
  return { ...budget, ...budgetUtilization(budget.amount, spent) };
}

async function resolve(deps: Deps, table: any, path?: string | null, label = "reference"): Promise<string | null> {
  if (!path) return null;
  const id = idFromPath(path)!;
  const row = (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw invalidArgument(`that ${label} is unavailable`);
  return id;
}

function validatePeriod(type?: string, key?: string): asserts type is PeriodType {
  if (type !== "monthly" && type !== "quarterly" && type !== "yearly") throw invalidArgument("period_type must be monthly, quarterly, or yearly");
  if (!key) throw invalidArgument("period_key is required");
  periodBounds(type, key); // throws on a malformed key
}

export const expenseBudgetSpec: CrudSpec<ExpenseBudgetInput, typeof schema.expenseBudgets> = {
  table: schema.expenseBudgets,
  collection: "expense-budgets",
  auditName: "expense_budget",
  notFound: "expense budget not found",
  // Spend is derived, so every response - read OR write - carries it.
  decorate: (deps, _actor, rows) => Promise.all(rows.map((r) => budgetWithSpend(deps, r))),
  insert: async (input, deps) => {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
    validatePeriod(input.period_type, input.period_key);
    return {
      departmentId: await resolve(deps, schema.departments, input.department, "department"),
      categoryId: await resolve(deps, schema.expenseCategories, input.category, "expense category"),
      periodType: input.period_type,
      periodKey: input.period_key!,
      amount: round2(amount),
    };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.expenseBudgets> = {};
    if (has(patch, "department")) set.departmentId = await resolve(deps, schema.departments, patch.department, "department");
    if (has(patch, "category")) set.categoryId = await resolve(deps, schema.expenseCategories, patch.category, "expense category");
    if (has(patch, "period_type") || has(patch, "period_key")) {
      const type = has(patch, "period_type") ? patch.period_type : (row.periodType as PeriodType);
      const key = has(patch, "period_key") ? patch.period_key : row.periodKey;
      validatePeriod(type, key);
      set.periodType = type;
      set.periodKey = key;
      set.alertLevel = 0; // changing the period resets the alert guard
    }
    if (has(patch, "amount")) {
      const amount = Number(patch.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
      set.amount = round2(amount);
      set.alertLevel = 0; // changing the cap re-arms alerts
    }
    return set;
  },
};

// The service-level create, for callers that are not an HTTP request (the recurring-budget cron). It attaches
// the derived spend itself: on the HTTP path the factory applies `decorate`, and this answers the same shape.
const budgetSvc = crudService(expenseBudgetSpec);
export const createExpenseBudget = async (deps: Deps, actor: AppUser, input: ExpenseBudgetInput, id?: string) =>
  budgetWithSpend(deps, await budgetSvc.create(deps, actor, input, id));

// ---- Budget alerts (daily cron) -------------------------------------------------------------------------
// For each active budget whose spend crosses a configured threshold higher than the highest already alerted
// (`alertLevel`), emit `expense.budgetThreshold` (delivery is left to automation rules) and raise the guard so
// the same level fires once. Thresholds default to 80% and 100%. Returns the count of alerts fired.
export async function checkBudgetThresholds(deps: Deps): Promise<number> {
  const settings = await getSettingValue<{ budget_alert_thresholds?: number[] }>(deps, "expenses", {});
  const thresholds = (settings.budget_alert_thresholds && settings.budget_alert_thresholds.length ? settings.budget_alert_thresholds : [80, 100])
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  if (!thresholds.length) return 0;
  const budgets = visibleByDelete(await deps.db.select().from(schema.expenseBudgets), false);
  let fired = 0;
  for (const b of budgets) {
    const spent = await computeBudgetSpend(deps, b);
    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    const crossed = thresholds.filter((t) => pct >= t);
    const highest = crossed.length ? crossed[crossed.length - 1]! : 0;
    if (highest <= b.alertLevel) continue;
    await deps.db.update(schema.expenseBudgets).set({ alertLevel: highest, updatedAt: new Date() }).where(eq(schema.expenseBudgets.uuid, b.uuid));
    await emitEvent(deps, null, "expense.budgetThreshold", { subject: `expense-budgets/${b.uuid}`, payload: { level: highest, periodKey: b.periodKey, spent: round2(spent), budget: b.amount } });
    await audit(deps, "system", "expense_budget.alert", "expense-budgets", b.uuid, { level: highest, spent: round2(spent) });
    fired++;
  }
  return fired;
}
