// Payroll budgets: a cap per (department?, period), with spend derived from what payroll actually paid.
//
// Salary is the largest line in the company and was the only one with no budget surface. The shape is
// `expense_budgets` deliberately - a scope, a period, a cap, a recurrence, and a spend that is DERIVED and
// never stored - so the two read the same way to whoever is looking at both.
//
// WHAT COUNTS AS SPEND, and the choice matters more here than it does for expenses: only FINALIZED runs
// (approved or published). A draft is somebody mid-build whose figures change on every rebuild, and counting
// it would make a department's budget move while a colleague works. A run that is approved is committed even
// if the money has not left, which is the same point `expense_budgets` charges an approved expense at.
//
// ATTRIBUTION IS THE RUN ITEM'S OWN `department_id`, stamped at build time (item 29), NOT the employee's
// department today. A transfer in March must not rewrite what February's budget consumed - and resolving
// through `employees` at read time would do exactly that, silently, every time somebody moved team.
import { and, eq, inArray, isNull, isNotNull, like, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { audit } from "../lib/audit";
import { round2 } from "../domain/money";
import { periodBounds, periodKeyFor, budgetUtilization, projectBudget, type BudgetProjection, type PeriodType } from "../domain/expenses";
import { allocFlatCode } from "./codeAlloc";
import { invalidArgument } from "../lib/errors";
import { applyScope } from "./listScope";
import { paginate } from "../http/pagination";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";
import { refPayPeriods } from "../lib/refData";

export type PayrollBudgetInput = {
  department?: string | null;
  period_type?: PeriodType;
  period_key?: string;
  amount?: number;
  recurring?: boolean;
};

type BudgetRow = typeof schema.payrollBudgets.$inferSelect;
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

/** A run that has committed. See the header: a draft's figures move under the reader. */
const FINALIZED = ["APPROVED", "PUBLISHED"] as const;

/**
 * Spend for MANY budgets in ONE read, the same shape `computeBudgetSpendMany` uses and for the same reason:
 * a page of caps must not cost a query per row.
 *
 * A run is charged to the period its PAY DATE falls in, not its period start - that is when the money is
 * committed, and it is the date every other payroll surface orders by.
 */
export async function computePayrollSpendMany(deps: Deps, budgets: readonly BudgetRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!budgets.length) return out;

  const bounds = budgets.map((b) => {
    try {
      return periodBounds(b.periodType as PeriodType, b.periodKey);
    } catch {
      return null; // a malformed key charges nothing rather than poisoning the span
    }
  });
  const spans = bounds.filter((r): r is { start: number; end: number } => !!r);
  if (!spans.length) {
    for (const b of budgets) out.set(b.uuid, 0);
    return out;
  }
  const from = Math.min(...spans.map((s) => s.start));
  const to = Math.max(...spans.map((s) => s.end));

  // The finalized runs whose pay date falls anywhere in the span, then their items. Two reads for the whole
  // page rather than two per cap. The periods themselves come from the memo every payroll surface shares, so
  // a page of caps adds no read for them at all.
  const periods = (await refPayPeriods(deps)).filter((p) => {
    if (p.deleteTime) return false;
    const at = p.payDate.getTime();
    return at >= from && at < to;
  });
  if (!periods.length) {
    for (const b of budgets) out.set(b.uuid, 0);
    return out;
  }
  const runs = await deps.db
    .select({ uuid: schema.payrollRuns.uuid, payPeriodId: schema.payrollRuns.payPeriodId })
    .from(schema.payrollRuns)
    .where(and(inArray(schema.payrollRuns.payPeriodId, periods.map((p) => p.uuid)), inArray(schema.payrollRuns.state, [...FINALIZED])));
  if (!runs.length) {
    for (const b of budgets) out.set(b.uuid, 0);
    return out;
  }
  const payDateOf = new Map(periods.map((p) => [p.uuid, p.payDate.getTime()]));
  const runAt = new Map(runs.map((r) => [r.uuid, payDateOf.get(r.payPeriodId) ?? 0]));

  const items = await deps.db
    .select({ runId: schema.payrollRunItems.runId, departmentId: schema.payrollRunItems.departmentId, gross: schema.payrollRunItems.gross })
    .from(schema.payrollRunItems)
    .where(inArray(schema.payrollRunItems.runId, runs.map((r) => r.uuid)));

  budgets.forEach((b, i) => {
    const range = bounds[i];
    if (!range) { out.set(b.uuid, 0); return; }
    let spent = 0;
    for (const it of items) {
      const at = runAt.get(it.runId);
      if (at === undefined || at < range.start || at >= range.end) continue;
      if (b.departmentId && it.departmentId !== b.departmentId) continue;
      spent += it.gross;
    }
    out.set(b.uuid, round2(spent));
  });
  return out;
}

/** A budget row plus its derived spend and forecast, ready for the serializer. */
export async function payrollBudgetsWithSpend(deps: Deps, budgets: BudgetRow[], now: Date = new Date()) {
  const spends = await computePayrollSpendMany(deps, budgets);
  const at = now.getTime();
  return budgets.map((b) => {
    const spent = spends.get(b.uuid) ?? 0;
    let projection: BudgetProjection | null = null;
    try {
      // The SAME forecast an expense budget gets (item 15), with the same refusals - a closed period, one
      // too early to call, or one with no spend answers null rather than a number nobody can support.
      projection = projectBudget(b.amount, spent, periodBounds(b.periodType as PeriodType, b.periodKey), at);
    } catch {
      projection = null;
    }
    return { ...b, ...budgetUtilization(b.amount, spent, 0), projection };
  });
}

function validatePeriod(type?: string, key?: string): asserts type is PeriodType {
  if (type !== "monthly" && type !== "quarterly" && type !== "yearly") throw invalidArgument("period_type must be monthly, quarterly, or yearly");
  if (!key) throw invalidArgument("period_key is required");
  periodBounds(type, key); // throws on a malformed key
}

async function resolveDepartment(deps: Deps, path?: string | null): Promise<string | null> {
  if (!path) return null;
  const id = idFromPath(path)!;
  const row = (await deps.db.select().from(schema.departments).where(eq(schema.departments.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw invalidArgument("that department is unavailable");
  return id;
}

export const payrollBudgetSpec: CrudSpec<PayrollBudgetInput, typeof schema.payrollBudgets> = {
  table: schema.payrollBudgets,
  collection: "payroll-budgets",
  auditName: "payroll_budget",
  notFound: "payroll budget not found",
  // Spend is derived, so every response - read OR write - carries it, in one read for the whole page.
  decorate: (deps, _actor, rows) => payrollBudgetsWithSpend(deps, rows),
  insert: async (input, deps) => {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
    validatePeriod(input.period_type, input.period_key);
    return {
      departmentId: await resolveDepartment(deps, input.department),
      periodType: input.period_type,
      periodKey: input.period_key!,
      amount: round2(amount),
      recurring: !!input.recurring,
    };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.payrollBudgets> = {};
    if (has(patch, "department")) set.departmentId = await resolveDepartment(deps, patch.department);
    if (has(patch, "period_type") || has(patch, "period_key")) {
      const type = has(patch, "period_type") ? patch.period_type : (row.periodType as PeriodType);
      const key = has(patch, "period_key") ? patch.period_key : row.periodKey;
      validatePeriod(type, key);
      set.periodType = type;
      set.periodKey = key;
    }
    if (has(patch, "amount")) {
      const amount = Number(patch.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
      set.amount = round2(amount);
    }
    if (has(patch, "recurring")) set.recurring = !!patch.recurring;
    return set;
  },
};

const svc = crudService(payrollBudgetSpec);
export const createPayrollBudget = async (deps: Deps, actor: AppUser, input: PayrollBudgetInput, id?: string) =>
  (await payrollBudgetsWithSpend(deps, [await svc.create(deps, actor, input, id)]))[0]!;

export type PayrollBudgetFilters = {
  period?: string;     // "current" | "upcoming" | "past" - resolved against each row's own period type
  periodKey?: string;
  periodType?: string;
  year?: string;       // every period inside a calendar year
  department?: string; // "departments/<id>" (decoded by the edge)
};

export type PayrollBudgetSummary = { count: number; amount: number; spent: number; over: number };

// Every number printed beside a paged table is computed over the WHOLE filtered set, not the page - the same
// rule `listExpenseBudgets` documents, and for the same reason: a summary of page one wearing the label of the
// collection is worse than no summary.
export async function listPayrollBudgets(
  deps: Deps,
  scope: ListScope | undefined,
  maxPageSize: number,
  pageToken: string | undefined,
  showDeleted: boolean,
  filters: PayrollBudgetFilters = {},
  now: Date = new Date(),
  deletedOnly = false,
): Promise<{ items: BudgetRow[]; nextPageToken?: string; extra: { summary: PayrollBudgetSummary } }> {
  const conds: (SQL | undefined)[] = [applyScope(scope, schema.payrollBudgets.code, undefined)];
  if (deletedOnly) conds.push(isNotNull(schema.payrollBudgets.deleteTime));
  else if (!showDeleted) conds.push(isNull(schema.payrollBudgets.deleteTime));
  if (filters.periodType) conds.push(eq(schema.payrollBudgets.periodType, filters.periodType as PeriodType));
  if (filters.periodKey) conds.push(eq(schema.payrollBudgets.periodKey, filters.periodKey));
  // A calendar year covers "2026", "2026-Q3" and "2026-07" alike, so the prefix IS the filter.
  if (filters.year) conds.push(like(schema.payrollBudgets.periodKey, `${filters.year}%`));
  const deptId = idFromPath(filters.department);
  if (deptId) conds.push(eq(schema.payrollBudgets.departmentId, deptId));

  const rows = (await deps.db
    .select()
    .from(schema.payrollBudgets)
    .where(and(...(conds.filter(Boolean) as SQL[])))) as BudgetRow[];

  const at = now.getTime();
  const matched = filters.period ? rows.filter((b) => payrollBudgetPhase(b, at) === filters.period) : rows;

  const spends = await computePayrollSpendMany(deps, matched);
  const summary: PayrollBudgetSummary = { count: 0, amount: 0, spent: 0, over: 0 };
  for (const b of matched) {
    if (b.deleteTime) continue; // a deleted cap is not part of the budget
    const spent = spends.get(b.uuid) ?? 0;
    summary.count++;
    summary.amount += b.amount || 0;
    summary.spent += spent;
    if (b.amount > 0 && spent >= b.amount) summary.over++;
  }
  summary.amount = round2(summary.amount);
  summary.spent = round2(summary.spent);

  const { items, nextPageToken } = await paginate(
    matched,
    maxPageSize,
    pageToken,
    (b) => b.createdAt?.getTime() ?? 0,
    (b) => b.uuid,
    "desc",
    { codec: deps.idCodec, collection: "payroll-budgets" },
  );
  return { items, nextPageToken, extra: { summary } };
}

/** Where a period sits relative to `now`, from the row's own type/key so one filter serves monthly, quarterly
 *  and yearly caps in a single read. An unparseable key is never hidden behind a phase filter. */
export function payrollBudgetPhase(b: Pick<BudgetRow, "periodType" | "periodKey">, now: number): "current" | "upcoming" | "past" {
  let range: { start: number; end: number };
  try {
    range = periodBounds(b.periodType as PeriodType, b.periodKey);
  } catch {
    return "current";
  }
  if (now >= range.end) return "past";
  if (now < range.start) return "upcoming";
  return "current";
}

/** Open the next period for every recurring cap whose own period has closed, the same self-healing rollover
 *  `openRecurringBudgetPeriods` does for expenses. One period ahead per tick: the successor is itself
 *  recurring, so the chain continues at ITS rollover rather than this tick opening next decade. */
export async function openRecurringPayrollBudgets(deps: Deps, now: Date = new Date()): Promise<number> {
  const all = await deps.db.select().from(schema.payrollBudgets);
  const claimed = new Set(all.map((b) => `${b.departmentId ?? "-"}|${b.periodType}|${b.periodKey}`));
  let opened = 0;
  for (const b of all) {
    if (!b.recurring || b.deleteTime) continue;
    let end: number;
    try {
      end = periodBounds(b.periodType as PeriodType, b.periodKey).end;
    } catch {
      continue;
    }
    if (now.getTime() < end) continue;
    const nextKey = periodKeyFor(b.periodType as PeriodType, new Date(end));
    const key = `${b.departmentId ?? "-"}|${b.periodType}|${nextKey}`;
    // Checked against ALL rows including soft-deleted ones: deleting a period somebody opened is how a human
    // says "not this one", and a cron that resurrects it is a cron nobody can overrule.
    if (claimed.has(key)) continue;
    const row = (await deps.db
      .insert(schema.payrollBudgets)
      .values({
        code: await allocFlatCode(deps, schema.payrollBudgets),
        departmentId: b.departmentId,
        periodType: b.periodType,
        periodKey: nextKey,
        amount: b.amount,
        recurring: true,
      })
      .returning())[0]!;
    claimed.add(key);
    await audit(deps, "system", "payroll_budget.open_period", "payroll-budgets", row.uuid, { from: b.periodKey, period_key: nextKey, amount: b.amount });
    opened++;
  }
  return opened;
}
