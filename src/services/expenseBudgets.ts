// Expense budgets: a spend cap for a (department?, category?, period). NULL dept = org-wide; NULL category =
// all. Spend is DERIVED (never stored) from APPROVED+PAID expenses whose incurred date falls in the period and
// whose dept/category match the budget's filters. Finance-only collection (no employee grant).
import { eq, and, gte, lt, inArray } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { round2 } from "../domain/money";
import { periodBounds, budgetUtilization, type PeriodType } from "../domain/expenses";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";

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

export async function listExpenseBudgets(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.expenseBudgets), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const items = await Promise.all(slice.map((b) => budgetWithSpend(deps, b)));
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items, nextPageToken };
}

export async function getExpenseBudget(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("expense budget not found");
  return budgetWithSpend(deps, row);
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

export async function createExpenseBudget(deps: Deps, actor: AppUser, input: ExpenseBudgetInput) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
  validatePeriod(input.period_type, input.period_key);
  const row = (await deps.db
    .insert(schema.expenseBudgets)
    .values({
      code: await allocFlatCode(deps, schema.expenseBudgets),
      departmentId: await resolve(deps, schema.departments, input.department, "department"),
      categoryId: await resolve(deps, schema.expenseCategories, input.category, "expense category"),
      periodType: input.period_type,
      periodKey: input.period_key!,
      amount: round2(amount),
    })
    .returning())[0]!;
  await audit(deps, actor, "expense_budget.create", "expense-budgets", row.uuid, undefined, row);
  return budgetWithSpend(deps, row);
}

export async function updateExpenseBudget(deps: Deps, actor: AppUser, id: string, patch: ExpenseBudgetInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.expenseBudgets).where(eq(schema.expenseBudgets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("expense budget not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof ExpenseBudgetInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("department")) set.departmentId = await resolve(deps, schema.departments, patch.department, "department");
  if (has("category")) set.categoryId = await resolve(deps, schema.expenseCategories, patch.category, "expense category");
  if (has("period_type") || has("period_key")) {
    const type = has("period_type") ? patch.period_type : (row.periodType as PeriodType);
    const key = has("period_key") ? patch.period_key : row.periodKey;
    validatePeriod(type, key);
    set.periodType = type;
    set.periodKey = key;
    set.alertLevel = 0; // changing the period resets the alert guard
  }
  if (has("amount")) {
    const amount = Number(patch.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
    set.amount = round2(amount);
    set.alertLevel = 0; // changing the cap re-arms alerts
  }
  const updated = (await deps.db.update(schema.expenseBudgets).set(set).where(eq(schema.expenseBudgets.uuid, id)).returning())[0]!;
  await audit(deps, actor, "expense_budget.update", "expense-budgets", id, diffMeta(row, updated, set), updated);
  return budgetWithSpend(deps, updated);
}

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

export async function deleteExpenseBudget(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.expenseBudgets, "expense_budget", "expense-budgets", id, ifMatch);
}
export async function restoreExpenseBudget(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.expenseBudgets, "expense_budget", "expense-budgets", id);
}
export async function purgeExpenseBudget(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.expenseBudgets, "expense_budget", "expense-budgets", id, ifMatch);
}
