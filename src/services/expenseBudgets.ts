// Expense budgets: a spend cap for a (department?, category?, period). NULL dept = org-wide; NULL category =
// all. Spend is DERIVED (never stored) from APPROVED+PAID expenses whose incurred date falls in the period and
// whose dept/category match the budget's filters. Finance-only collection (no employee grant).
import { eq, and, or, gte, lt, like, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { audit } from "../lib/audit";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { round2 } from "../domain/money";
import { periodBounds, periodKeyFor, budgetUtilization, projectBudget, type BudgetProjection, type PeriodType } from "../domain/expenses";
import { allocFlatCode } from "./codeAlloc";
import { invalidArgument } from "../lib/errors";
import { visibleByDelete } from "./softDelete";
import { applyScope } from "./listScope";
import { paginate } from "../http/pagination";
import type { ListScope } from "../domain/access";
import type { AppUser } from "../env";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";

export type ExpenseBudgetInput = {
  department?: string | null; // "departments/<id>"
  category?: string | null;   // "expense-categories/<id>"
  period_type?: PeriodType;
  period_key?: string;
  amount?: number;
  recurring?: boolean;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

type BudgetRow = typeof schema.expenseBudgets.$inferSelect;

export type BudgetScope = Pick<BudgetRow, "departmentId" | "categoryId" | "periodType" | "periodKey">;
/**
 * `months` is `spent` broken out by the calendar months the period covers, oldest first - the shape this
 * module was already computing and discarding. The attribution below buckets every charge by month in order to
 * sum it, so a sparkline costs nothing extra; a month with no charges is emitted as 0 so the series is evenly
 * spaced and a reader can see the gap. `pending` is deliberately NOT broken out: it is a queue, not history.
 */
export type BudgetSpend = { spent: number; pending: number; months: { period: string; spent: number }[] };

// A spend-charging expense, reduced to the fields attribution needs.
type ChargeRow = { amount: number | null; state: string | null; incurredOn: Date | null; createdAt: Date | null; departmentId: string | null; categoryId: string | null };

const STATES_CHARGED = ["SUBMITTED", "APPROVED", "PAID"] as const;
const monthOf = (at: Date) => `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
// The date an expense is charged on. `incurredOn` decides the period; a row with no incurred date falls back to
// `createdAt`, which is what this module always documented. That fallback cannot be expressed in the range
// predicate (a NULL comparison drops the row silently), so charging is decided here, in memory.
const chargedOn = (e: ChargeRow): Date | null => e.incurredOn ?? e.createdAt;

// Spend for MANY budgets in ONE query. Listing budgets is the hot path and a query per row put a page of 50
// caps at the Workers subrequest ceiling; the nightly threshold sweep had the same shape. One read spanning
// every budget's period is bucketed by month and indexed by (department, category), so each cap sums a handful
// of buckets: a monthly cap reads one, quarterly three, yearly twelve.
//   `spent`   - APPROVED + PAID: money the org owes or has paid, and the only thing utilization counts.
//   `pending` - SUBMITTED and still in the approval queue: not spend, but already committed in practice.
// Keyed by the budget's own uuid where it has one, else by its scope (the create path derives before insert).
export async function computeBudgetSpendMany(deps: Deps, budgets: (BudgetScope & { uuid?: string })[]): Promise<Map<string, BudgetSpend>> {
  const out = new Map<string, BudgetSpend>();
  if (!budgets.length) return out;

  const bounds = budgets.map((b) => {
    try {
      return periodBounds(b.periodType as PeriodType, b.periodKey);
    } catch {
      return null; // a malformed key charges nothing rather than poisoning the span
    }
  });
  const spans = bounds.filter((r): r is { start: number; end: number } => !!r);
  const key = (b: BudgetScope & { uuid?: string }) => b.uuid ?? scopeKeyOf(b);
  if (!spans.length) {
    for (const b of budgets) out.set(key(b), { spent: 0, pending: 0, months: [] });
    return out;
  }

  // One read for the whole span. Both date columns are fetched because either can be the charging date, so the
  // window is widened by the range where they disagree; attribution below is exact regardless.
  const from = new Date(Math.min(...spans.map((s) => s.start)));
  const to = new Date(Math.max(...spans.map((s) => s.end)));
  const charged: (ChargeRow & { uuid: string })[] = await deps.db
    .select({
      uuid: schema.expenses.uuid,
      amount: schema.expenses.amount,
      state: schema.expenses.state,
      incurredOn: schema.expenses.incurredOn,
      createdAt: schema.expenses.createdAt,
      departmentId: schema.expenses.departmentId,
      categoryId: schema.expenses.categoryId,
    })
    .from(schema.expenses)
    .where(and(
      inArray(schema.expenses.state, [...STATES_CHARGED]),
      or(
        and(gte(schema.expenses.incurredOn, from), lt(schema.expenses.incurredOn, to)),
        and(isNull(schema.expenses.incurredOn), gte(schema.expenses.createdAt, from), lt(schema.expenses.createdAt, to)),
      ),
    ));

  // THE SPLIT IS APPLIED HERE AND NOWHERE ELSE. An invoice divided across cost centres charges its LINES, each
  // with its own department and category; an ordinary expense charges the row. Expanding into the same
  // `ChargeRow` shape means everything below - the month bucketing, the period edges, the per-cap filters - is
  // unchanged and cannot tell the difference, which is what keeps a split from needing to be understood twice.
  //
  // One extra read, over the same window, for every split in it. The lines carry the expense's state and dates
  // because those are facts about the invoice rather than about the share: half a cancelled invoice is not
  // spend, and a share is charged to the period its invoice falls in.
  type AllocRow = { expenseId: string; amount: number; departmentId: string | null; categoryId: string | null };
  // Skipped entirely when the window charged nothing: `inArray` with an empty list builds SQL that matches
  // nothing at best, and asking for it is a subrequest spent to learn what we already know.
  const allocations: AllocRow[] = charged.length
    ? await deps.db
        .select({
          expenseId: schema.expenseAllocations.expenseId,
          amount: schema.expenseAllocations.amount,
          departmentId: schema.expenseAllocations.departmentId,
          categoryId: schema.expenseAllocations.categoryId,
        })
        .from(schema.expenseAllocations)
        .where(inArray(schema.expenseAllocations.expenseId, charged.map((r) => r.uuid)))
    : [];
  const splitBy = new Map<string, AllocRow[]>();
  for (const a of allocations) {
    const held = splitBy.get(a.expenseId);
    if (held) held.push(a);
    else splitBy.set(a.expenseId, [a]);
  }
  const rows: ChargeRow[] = charged.flatMap((r): ChargeRow[] => {
    const split = splitBy.get(r.uuid);
    if (!split?.length) return [r];
    return split.map((a): ChargeRow => ({
      amount: a.amount,
      state: r.state,
      incurredOn: r.incurredOn,
      createdAt: r.createdAt,
      departmentId: a.departmentId,
      categoryId: a.categoryId,
    }));
  });

  // month -> charges in that month. A cap then sums only the months its period covers.
  const byMonth = new Map<string, ChargeRow[]>();
  for (const r of rows) {
    const at = chargedOn(r);
    if (!at) continue;
    const m = monthOf(at);
    const bucket = byMonth.get(m);
    if (bucket) bucket.push(r);
    else byMonth.set(m, [r]);
  }

  budgets.forEach((b, i) => {
    const range = bounds[i];
    if (!range) { out.set(key(b), { spent: 0, pending: 0, months: [] }); return; }
    let spent = 0;
    let pending = 0;
    const months: { period: string; spent: number }[] = [];
    for (const m of monthsBetween(range.start, range.end)) {
      // The month's own spend, kept as well as added to the running total. `monthsBetween` already walks the
      // period in order and emits every month in it, so the series comes out oldest-first and evenly spaced -
      // a month nothing was charged to is a real 0, not a missing point.
      let inMonth = 0;
      for (const r of byMonth.get(m) ?? []) {
        if (b.departmentId && r.departmentId !== b.departmentId) continue;
        if (b.categoryId && r.categoryId !== b.categoryId) continue;
        const at = chargedOn(r)!.getTime();
        if (at < range.start || at >= range.end) continue; // a month bucket can straddle the period edge
        if (r.state === "SUBMITTED") pending += r.amount ?? 0;
        else inMonth += r.amount ?? 0;
      }
      spent += inMonth;
      months.push({ period: m, spent: round2(inMonth) });
    }
    out.set(key(b), { spent: round2(spent), pending: round2(pending), months });
  });
  return out;
}

// The month keys a period covers, so bucket lookup is O(months) instead of a scan over every charge.
function monthsBetween(start: number, end: number): string[] {
  const out: string[] = [];
  const at = new Date(start);
  let cursor = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  while (cursor < end) {
    const d = new Date(cursor);
    out.push(monthOf(d));
    cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

export const scopeKeyOf = (b: BudgetScope) => `${b.departmentId ?? "-"}|${b.categoryId ?? "-"}|${b.periodType}|${b.periodKey}`;

// One budget's spend. Kept for the single-row callers (create, cron guards); it is the many-row path with a
// list of one, so there is exactly one derivation of "what counts as charged to a cap".
export async function computeBudgetSpend(deps: Deps, budget: BudgetScope): Promise<BudgetSpend> {
  const many = await computeBudgetSpendMany(deps, [budget]);
  return many.get(scopeKeyOf(budget)) ?? many.values().next().value ?? { spent: 0, pending: 0, months: [] };
}

// Where this cap lands at period end at the rate it has been spending. Null for anything the arithmetic
// cannot honestly extrapolate (a past or future period, too little elapsed, no spend) - see `projectBudget`,
// which owns every one of those decisions. A malformed period key projects nothing rather than throwing, the
// same way `budgetPhase` refuses to hide such a row: an unparseable key is a data problem to fix, not a reason
// for the page to fail.
export function budgetProjection(b: BudgetScope & { amount: number }, spent: number, now: number): BudgetProjection | null {
  let range: { start: number; end: number };
  try {
    range = periodBounds(b.periodType as PeriodType, b.periodKey);
  } catch {
    return null;
  }
  return projectBudget(b.amount, spent, range, now);
}

// A budget row plus its derived spend/pending/remaining/utilization, ready for the serializer.
export async function budgetWithSpend(deps: Deps, budget: BudgetRow, now: Date = new Date()) {
  const { spent, pending, months } = await computeBudgetSpend(deps, budget);
  return { ...budget, ...budgetUtilization(budget.amount, spent, pending), spendHistory: months, projection: budgetProjection(budget, spent, now.getTime()) };
}

// The same, for a whole page of budgets: one expenses read for all of them.
export async function budgetsWithSpend(deps: Deps, budgets: BudgetRow[], now: Date = new Date()) {
  const spends = await computeBudgetSpendMany(deps, budgets);
  const at = now.getTime();
  return budgets.map((b) => {
    const { spent, pending, months } = spends.get(b.uuid) ?? { spent: 0, pending: 0, months: [] };
    return { ...b, ...budgetUtilization(b.amount, spent, pending), spendHistory: months, projection: budgetProjection(b, spent, at) };
  });
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
  // Spend is derived, so every response - read OR write - carries it. One expenses read for the whole page:
  // per-row derivation made a list of N budgets cost N subrequests.
  decorate: (deps, _actor, rows) => budgetsWithSpend(deps, rows),
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
      recurring: !!input.recurring,
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
      set.projectionAlertedAt = null; // and the forecast guard, which is about the period it describes
    }
    if (has(patch, "amount")) {
      const amount = Number(patch.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
      set.amount = round2(amount);
      set.alertLevel = 0; // changing the cap re-arms alerts
      set.projectionAlertedAt = null; // raising a cap can un-breach a forecast, so the warning must be re-earnable
    }
    if (has(patch, "recurring")) set.recurring = !!patch.recurring;
    return set;
  },
};

// The service-level create, for callers that are not an HTTP request (the recurring-budget cron). It attaches
// the derived spend itself: on the HTTP path the factory applies `decorate`, and this answers the same shape.
const budgetSvc = crudService(expenseBudgetSpec);
export const createExpenseBudget = async (deps: Deps, actor: AppUser, input: ExpenseBudgetInput, id?: string) =>
  budgetWithSpend(deps, await budgetSvc.create(deps, actor, input, id));

// ---- List: server-side period scoping + an honest aggregate ---------------------------------------------
// A monthly cap per category per cost centre is hundreds of rows a year, and a page holds at most 100. Every
// number the page shows next to a paged table therefore has to be computed on the SERVER over the whole
// filtered set, or it is a statement about page one wearing the label of the collection.
export type BudgetListFilters = {
  period?: string;      // "current" | "upcoming" | "past" - resolved against each row's own period type
  periodKey?: string;   // exact key
  periodType?: string;  // monthly | quarterly | yearly
  year?: string;        // every period inside a calendar year (the year matrix reads this)
  department?: string;  // "departments/<id>" (decoded by the edge)
  category?: string;    // "expense-categories/<id>"
  status?: string;      // "over" | "at_risk" - derived, so a risk filter narrows the READ, not the page
};

export type BudgetSummary = { count: number; amount: number; spent: number; pending: number; over: number; at_risk: number };
export type BudgetPhaseCounts = { current: number; upcoming: number; past: number };

// Where a period sits relative to `now`, decided from the row's own type/key so one filter serves monthly,
// quarterly and yearly caps in a single read.
export function budgetPhase(b: BudgetScope, now: number): "current" | "upcoming" | "past" {
  let range: { start: number; end: number };
  try {
    range = periodBounds(b.periodType as PeriodType, b.periodKey);
  } catch {
    return "current"; // an unparseable key is never hidden behind a phase filter
  }
  if (now >= range.end) return "past";
  if (now < range.start) return "upcoming";
  return "current";
}

// The at-risk line is the threshold the alert cron fires on, so the server and the page never disagree about
// what amber means. Returns the lowest configured threshold below 100 (default 80).
export async function budgetWarnThreshold(deps: Deps): Promise<number> {
  const settings = await getSettingValue<{ budget_alert_thresholds?: number[] }>(deps, "expenses", {});
  const ts = (settings.budget_alert_thresholds ?? []).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  return ts.find((t) => t < 100) ?? 80;
}

// Budgets are a flat finance catalog: `applyScope` maps the breadth the middleware decided onto the table's
// code column exactly as the generic list does, and decides nothing itself.
export async function listExpenseBudgets(
  deps: Deps,
  scope: ListScope | undefined,
  maxPageSize: number,
  pageToken: string | undefined,
  showDeleted: boolean,
  filters: BudgetListFilters = {},
  now: Date = new Date(),
  deletedOnly = false,
): Promise<{ items: BudgetRow[]; nextPageToken?: string; extra: { summary: BudgetSummary; phase_counts: BudgetPhaseCounts } }> {
  const conds = [applyScope(scope, schema.expenseBudgets.code, undefined)];
  // The trash alone, when asked for: a "Deleted" view is its own fetch rather than a filter over a page of
  // mostly-live caps.
  if (deletedOnly) conds.push(isNotNull(schema.expenseBudgets.deleteTime));
  else if (!showDeleted) conds.push(isNull(schema.expenseBudgets.deleteTime));
  if (filters.periodType) conds.push(eq(schema.expenseBudgets.periodType, filters.periodType as PeriodType));
  if (filters.periodKey) conds.push(eq(schema.expenseBudgets.periodKey, filters.periodKey));
  // A calendar year covers "2026", "2026-Q3" and "2026-07" alike, so the prefix IS the filter.
  if (filters.year) conds.push(like(schema.expenseBudgets.periodKey, `${filters.year}%`));
  const deptId = idFromPath(filters.department);
  if (deptId) conds.push(eq(schema.expenseBudgets.departmentId, deptId));
  const catId = idFromPath(filters.category);
  if (catId) conds.push(eq(schema.expenseBudgets.categoryId, catId));

  const rows = (await deps.db
    .select()
    .from(schema.expenseBudgets)
    .where(and(...conds.filter(Boolean) as SQL[]))) as BudgetRow[];

  const at = now.getTime();
  const phased = filters.period ? rows.filter((b) => budgetPhase(b, at) === filters.period) : rows;

  // Spend for the FILTERED set (one expenses read), which is what both the derived status filter and the
  // summary are computed from - never the page. A status filter (the at-risk / over-budget metrics) has to be
  // applied to the whole scoped set to count the phase chips through it, so the one read covers `rows` then.
  const spends = await computeBudgetSpendMany(deps, filters.status ? rows : phased);
  const warnAt = await budgetWarnThreshold(deps);
  const pctOf = (b: BudgetRow) => {
    const spent = spends.get(b.uuid)?.spent ?? 0;
    return b.amount > 0 ? (spent / b.amount) * 100 : 0;
  };
  const hitsStatus = (b: BudgetRow) => (filters.status === "over" ? pctOf(b) >= 100 : pctOf(b) >= warnAt);
  const matched = filters.status ? phased.filter(hitsStatus) : phased;

  // Phase counts describe the scoped set with every OTHER filter applied (the status metric included) and only
  // the phase dimension left open, so each chip says how many rows picking it would show.
  const phase_counts: BudgetPhaseCounts = { current: 0, upcoming: 0, past: 0 };
  for (const b of rows) {
    if (b.deleteTime) continue;
    if (filters.status && !hitsStatus(b)) continue;
    phase_counts[budgetPhase(b, at)]++;
  }

  const summary: BudgetSummary = { count: 0, amount: 0, spent: 0, pending: 0, over: 0, at_risk: 0 };
  for (const b of matched) {
    if (b.deleteTime) continue; // a deleted cap is not part of the budget
    const s = spends.get(b.uuid) ?? { spent: 0, pending: 0 };
    summary.count++;
    summary.amount += b.amount || 0;
    summary.spent += s.spent;
    summary.pending += s.pending;
    const pct = pctOf(b);
    if (pct >= 100) summary.over++;
    else if (pct >= warnAt) summary.at_risk++;
  }
  summary.amount = round2(summary.amount);
  summary.spent = round2(summary.spent);
  summary.pending = round2(summary.pending);

  const { items, nextPageToken } = await paginate(
    matched,
    maxPageSize,
    pageToken,
    (b) => b.createdAt?.getTime() ?? 0,
    (b) => b.uuid,
    "desc",
    { codec: deps.idCodec, collection: "expense-budgets" },
  );
  return { items, nextPageToken, extra: { summary, phase_counts } };
}

// ---- Recurring budgets (daily cron) ---------------------------------------------------------------------
// A recurring cap re-opens itself once its period closes: the same scope and the same AMOUNT for the next
// period. Design decisions worth keeping straight:
//   - the cap carries over, never the unspent remainder (a rolling remainder quietly turns a monthly cap into
//     an annual one), and never the alert guard (the new period starts un-alerted);
//   - only ONE period ahead per row. The successor is itself recurring, so the chain continues at ITS rollover
//     instead of this tick opening 2030 for a yearly cap;
//   - existence is checked against ALL rows including soft-deleted ones. Deleting a period someone opened is
//     how a human says "not this one", and a cron that resurrects it is a cron nobody can overrule.
// Returns the number of periods opened.
export async function openRecurringBudgetPeriods(deps: Deps, now: Date = new Date()): Promise<number> {
  const all = await deps.db.select().from(schema.expenseBudgets);
  const claimed = new Set(all.map((b) => `${b.departmentId ?? "-"}|${b.categoryId ?? "-"}|${b.periodType}|${b.periodKey}`));
  let opened = 0;
  for (const b of all) {
    if (!b.recurring || b.deleteTime) continue;
    let end: number;
    try {
      end = periodBounds(b.periodType as PeriodType, b.periodKey).end;
    } catch {
      continue; // a malformed key cannot be advanced; leave it for a human
    }
    if (now.getTime() < end) continue; // period still live
    const nextKey = periodKeyFor(b.periodType as PeriodType, new Date(end));
    const key = `${b.departmentId ?? "-"}|${b.categoryId ?? "-"}|${b.periodType}|${nextKey}`;
    if (claimed.has(key)) continue;
    const row = (await deps.db
      .insert(schema.expenseBudgets)
      .values({
        code: await allocFlatCode(deps, schema.expenseBudgets),
        departmentId: b.departmentId,
        categoryId: b.categoryId,
        periodType: b.periodType,
        periodKey: nextKey,
        amount: b.amount,
        recurring: true,
      })
      .returning())[0]!;
    claimed.add(key);
    await audit(deps, "system", "expense_budget.open_period", "expense-budgets", row.uuid, { from: b.periodKey, period_key: nextKey, amount: b.amount });
    opened++;
  }
  return opened;
}

// ---- Budget alerts (daily cron) -------------------------------------------------------------------------
// Two warnings off ONE expenses read, because they are the same arithmetic asked in opposite directions and
// splitting them into two sweeps would double the read this module works hardest to keep singular.
//
//   BACKWARDS - `expense.budgetThreshold`. Spend has crossed a configured percentage of the cap higher than
//     the highest already alerted (`alertLevel`). True, and late: at 100% the money is gone.
//   FORWARDS - `expense.budgetProjectedBreach`. The rate the period has spent at so far lands it over the cap
//     by period end (`projectBudget`, which returns null for everything it cannot honestly extrapolate).
//     Guarded by `projectionAlertedAt` so it says so once per period rather than every night the forecast
//     stays bad.
//
// The two are INDEPENDENT. A cap forecast over in week one has not crossed any threshold yet, and a cap that
// crosses 80% in a quiet month may be forecast to land inside its cap; neither guard may suppress the other,
// which is why each budget is offered both checks and `continue` appears in neither.
//
// Returns the total number of alerts fired, of either kind. `now` is injectable because a forecast is a
// statement about a moment.
export async function checkBudgetThresholds(deps: Deps, now: Date = new Date()): Promise<number> {
  const settings = await getSettingValue<{ budget_alert_thresholds?: number[] }>(deps, "expenses", {});
  const thresholds = (settings.budget_alert_thresholds && settings.budget_alert_thresholds.length ? settings.budget_alert_thresholds : [80, 100])
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  const budgets = visibleByDelete(await deps.db.select().from(schema.expenseBudgets), false);
  // One expenses read for every budget in the org, not one per budget: this sweep sees the whole collection,
  // so per-row derivation was the worst offender of the lot.
  const spends = await computeBudgetSpendMany(deps, budgets);
  let fired = 0;
  for (const b of budgets) {
    const spent = spends.get(b.uuid)?.spent ?? 0;

    // Backwards: a threshold already crossed.
    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    const crossed = thresholds.filter((t) => pct >= t);
    const highest = crossed.length ? crossed[crossed.length - 1]! : 0;
    if (highest > b.alertLevel) {
      await deps.db.update(schema.expenseBudgets).set({ alertLevel: highest, updatedAt: now }).where(eq(schema.expenseBudgets.uuid, b.uuid));
      await emitEvent(deps, null, "expense.budgetThreshold", { subject: `expense-budgets/${b.uuid}`, payload: { level: highest, periodKey: b.periodKey, spent: round2(spent), budget: b.amount } });
      await audit(deps, "system", "expense_budget.alert", "expense-budgets", b.uuid, { level: highest, spent: round2(spent) });
      fired++;
    }

    // Forwards: a breach the rate makes inevitable but the spend has not reached.
    const projection = budgetProjection(b, spent, now.getTime());
    if (projection && projection.projectedOverBy > 0 && !b.projectionAlertedAt) {
      await deps.db.update(schema.expenseBudgets).set({ projectionAlertedAt: now, updatedAt: now }).where(eq(schema.expenseBudgets.uuid, b.uuid));
      await emitEvent(deps, null, "expense.budgetProjectedBreach", { subject: `expense-budgets/${b.uuid}`, payload: { periodKey: b.periodKey, spent: round2(spent), projected: projection.projected, budget: b.amount } });
      await audit(deps, "system", "expense_budget.projected_breach", "expense-budgets", b.uuid, { spent: round2(spent), projected: projection.projected, elapsed: projection.elapsed });
      fired++;
    }
  }
  return fired;
}
