// Operational-expense workflow (custom methods :submit/:approve/:reject/:cancel/:pay; PAID is set by :pay for
// vendor expenses, or mirrored from the linked reimbursement for employee-fronted ones - never by hand).
// Owner-embedded code on the submitter (like reimbursements), so a manager's dept breadth sees their reports'
// expenses and finance (all breadth) sees everything. `departmentId` is cost-centre attribution, not the scope key.
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { genId } from "../lib/idCodec";
import { eq, and, or, asc, lte, lt, gte, ne, inArray, notInArray, isNull, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import { scopeFor, type ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditUpdate, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { round2 } from "../domain/money";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { createApprovedReimbursementForExpense } from "./reimbursements";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { byIdChunks, runBatchChecked } from "../lib/dbBatch";
import { getSettingValue } from "./settings";
import { attachedObjectIds } from "./attachments";
import { orgToday, dayStartMs } from "./orgDay";
import { advanceRecurrence, seriesDrift, paymentDueOn, ratedAmount, categoryBreaches, allocationError, autoApproveBlocks, periodKeyFor, findDuplicateClaims, DUPLICATE_DAY_WINDOW, MAX_RATED_QUANTITY, type RecurrenceRule, type SeriesDrift, type PolicyBreach, type AllocationLine, type AutoApproveGuard, type AutoApproveBlock, type PeriodType, type DuplicateCandidate, type DuplicateMatch } from "../domain/expenses";
import { seriesAnchorDay } from "../domain/calendar";
// The budget half of the close checklist. expenseBudgets.ts queries `schema.expenses` directly and imports
// nothing from this file, so the dependency runs one way only.
import { budgetPhase, budgetProjection, computeBudgetSpendMany, computeBudgetSpend } from "./expenseBudgets";
import { unclaimedCardTotals } from "./cardStatements";
import type { CloseCheck } from "../domain/expenses";
import { visibleByDelete } from "./softDelete";
import { assertNotSubject, assertReviewedVersion, requireRejectReason } from "./decisionGuard";

export type ExpenseInput = {
  employee?: string | null;
  vendor?: string | null;
  category?: string | null;
  department?: string | null;
  amount?: number;
  tax_amount?: number | null;
  incurred_on?: string | null; // YYYY-MM-DD
  quantity?: number | null; // km or days, on a rated category (mileage / per diem)
  allocations?: AllocationLine[]; // split one invoice across cost centres; omitted leaves any existing split alone
  description?: string | null;
  invoice_number?: string | null;
  payment_method?: "bank" | "card" | "cash" | "upi" | "cheque" | null;
  reimbursable?: boolean;
  recurring?: boolean;
  recurrence_rule?: RecurrenceRule | null;
  next_occurrence_on?: string | null; // YYYY-MM-DD
  paused?: boolean; // recurring templates only: hold generation without ending the schedule
};
export type ExpensePayInput = { payment_method?: "bank" | "card" | "cash" | "upi" | "cheque" | null; payment_ref?: string | null };

type ExpenseSettings = {
  auto_approve_threshold?: number; // expenses at or below this (>0) auto-approve on submit
  auto_approve_requires?: AutoApproveGuard[]; // conditions a small claim must ALSO satisfy to skip the queue
  second_approval_threshold?: number; // expenses ABOVE this (>0) need two different approvers
  recurring_default_state?: "SUBMITTED" | "DRAFT"; // state of a cron-generated occurrence
  budget_alert_thresholds?: number[]; // percentages, e.g. [80, 100]
  default_payment_method?: "bank" | "card" | "cash" | "upi" | "cheque";
};
async function expenseSettings(deps: Deps): Promise<ExpenseSettings> {
  return getSettingValue<ExpenseSettings>(deps, "expenses", {});
}

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const dayDate = (s?: string | null) => { const ms = dayMs(s); return Number.isNaN(ms) ? null : new Date(ms); };

// List filters, all server-side so they reach past the page cap. `department`/`category` arrive as decoded
// refs ("departments/<id>"); `from`/`to` are inclusive-exclusive day bounds on the incurred date, which is
// what makes "the expenses inside this budget period" answerable without downloading the ledger.
export type ExpenseListFilters = { state?: string; department?: string; category?: string; vendor?: string; from?: string; to?: string; q?: string };

export async function listExpenses(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, filters: ExpenseListFilters = {}) {
  const conds = [applyScope(scope, schema.expenses.code, schema.expenses.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "expenses", filters.q, schema.expenses.uuid);
  if (textMatch) conds.push(textMatch);
  if (filters.state) conds.push(eq(schema.expenses.state, filters.state as typeof schema.expenses.$inferSelect.state));
  const deptId = idFromPath(filters.department);
  if (deptId) conds.push(eq(schema.expenses.departmentId, deptId));
  const catId = idFromPath(filters.category);
  if (catId) conds.push(eq(schema.expenses.categoryId, catId));
  const vendorId = idFromPath(filters.vendor);
  if (vendorId) conds.push(eq(schema.expenses.vendorId, vendorId));
  const from = dayDate(filters.from);
  if (from) conds.push(gte(schema.expenses.incurredOn, from));
  const to = dayDate(filters.to);
  if (to) conds.push(lt(schema.expenses.incurredOn, to));
  return keysetPage(deps, schema.expenses, "expenses", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
}

export async function getExpense(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, id)).limit(1))[0];
  if (!row) throw notFound("expense not found");
  return row;
}

// ---- Recurring series drift -----------------------------------------------------------------------------

/** How many prior occurrences a drift is measured against. Enough that one odd month cannot decide the
 *  baseline, few enough that a price rise eighteen months ago is not still arguing with today's invoice. */
const DRIFT_WINDOW = 6;

// An occurrence that never became real spend says nothing about what the series costs. A cancelled month and
// a rejected one are both somebody saying "not this", so neither belongs in the baseline.
const DRIFT_EXCLUDED_STATES = ["CANCELLED", "REJECTED"];

/**
 * For each row that a recurring template generated, how far its amount sits from what that series usually
 * costs. Rows with no template are absent from the map, as are series with nothing to compare against and
 * amounts inside the tolerance - `seriesDrift` owns those decisions.
 *
 * ONE QUERY FOR THE WHOLE PAGE, and it fetches two things at once: every occurrence of every template these
 * rows came from, and the templates themselves. Per-row derivation here would have been a query per expense on
 * a list, which is the shape this module already refused for budget spend.
 *
 * THE BASELINE IS PRIOR OCCURRENCES, not later ones. A drift is a statement about a charge against the
 * history that existed when it arrived; letting next month's invoice inform this month's baseline would make
 * the flag on a row change after the fact, so the same page would say different things on different days.
 *
 * The FIRST occurrence of a series has no priors, and falls back to the template's own amount. That is the
 * schedule's declared figure - what somebody wrote down that this would cost - which is exactly the right
 * thing for a first invoice to be checked against.
 */
export async function seriesDriftFor(deps: Deps, rows: readonly { uuid: string; templateId: string | null }[]): Promise<Map<string, SeriesDrift>> {
  const out = new Map<string, SeriesDrift>();
  const templateIds = [...new Set(rows.map((r) => r.templateId).filter((t): t is string => !!t))];
  if (!templateIds.length) return out;

  const related = await deps.db
    .select({
      uuid: schema.expenses.uuid,
      templateId: schema.expenses.templateId,
      amount: schema.expenses.amount,
      state: schema.expenses.state,
      incurredOn: schema.expenses.incurredOn,
      createdAt: schema.expenses.createdAt,
    })
    .from(schema.expenses)
    .where(or(inArray(schema.expenses.templateId, templateIds), inArray(schema.expenses.uuid, templateIds)));

  const templateAmount = new Map<string, number>();
  const bySeries = new Map<string, { uuid: string; amount: number; at: number }[]>();
  for (const r of related) {
    if (templateIds.includes(r.uuid)) templateAmount.set(r.uuid, r.amount);
    if (!r.templateId) continue;
    if (DRIFT_EXCLUDED_STATES.includes(r.state)) continue;
    const at = (r.incurredOn ?? r.createdAt)?.getTime();
    if (at === undefined) continue;
    const bucket = bySeries.get(r.templateId);
    const entry = { uuid: r.uuid, amount: r.amount, at };
    if (bucket) bucket.push(entry);
    else bySeries.set(r.templateId, [entry]);
  }
  // Oldest first, uuid breaking a tie so two occurrences sharing a date order the same way on every read.
  for (const occurrences of bySeries.values()) occurrences.sort((a, b) => a.at - b.at || a.uuid.localeCompare(b.uuid));

  for (const row of rows) {
    if (!row.templateId) continue;
    const occurrences = bySeries.get(row.templateId) ?? [];
    const self = occurrences.findIndex((o) => o.uuid === row.uuid);
    if (self < 0) continue; // an excluded state, or a row the read did not cover
    const priors = occurrences.slice(Math.max(0, self - DRIFT_WINDOW), self).map((o) => o.amount);
    const seed = templateAmount.get(row.templateId);
    const baseline = priors.length ? priors : (seed !== undefined ? [seed] : []);
    const drift = seriesDrift(occurrences[self]!.amount, baseline);
    if (drift) out.set(row.uuid, drift);
  }
  return out;
}

/**
 * Price a claim against a rated category, or leave the caller's amount alone.
 *
 * Returns the computed amount and the quantity to store. A category with no rate returns the amount as given,
 * which is every ordinary expense and the reason this can sit on the write path unconditionally.
 *
 * THE COMPUTED AMOUNT WINS over whatever the client sent. The client computes the same figure to show a
 * running total as somebody types, and trusting it would make the rate advisory - a caller could claim 400 km
 * and any amount they liked, and the approver would see a total that looks arithmetically sound. The server
 * holds the rate, so the server does the multiplication.
 *
 * A rated category with NO quantity is a usable state, not an error: a category can be given a rate after
 * claims already exist against it, and a claim mid-edit has not been filled in yet. Those keep the hand-entered
 * amount, which is what they had before the rate existed.
 */
async function pricedAmount(
  deps: Deps,
  categoryId: string | null,
  amount: number,
  quantity: number | null | undefined,
): Promise<{ amount: number; quantity: number | null }> {
  if (!categoryId || quantity === null || quantity === undefined) return { amount, quantity: null };
  const cat = (await deps.db
    .select({ rateKind: schema.expenseCategories.rateKind, rate: schema.expenseCategories.rate })
    .from(schema.expenseCategories)
    .where(eq(schema.expenseCategories.uuid, categoryId))
    .limit(1))[0];
  if (!cat?.rateKind) return { amount, quantity: null }; // a quantity on an unrated category means nothing
  const priced = ratedAmount(cat.rateKind, cat.rate, Number(quantity));
  if (priced === null) {
    throw invalidArgument(`quantity must be a positive number of ${cat.rateKind === "per_km" ? "kilometres" : "days"} (at most ${MAX_RATED_QUANTITY})`);
  }
  return { amount: priced, quantity: Number(quantity) };
}

/**
 * The category rules this claim does not satisfy, or an empty list.
 *
 * Reads the category's policy, whether a receipt is actually attached, and the ORG's today (services/orgDay.ts
 * - "today" is the organisation's day, never the server's timezone, or a claim filed late on the last allowed
 * evening would be refused for callers on one side of the date line and accepted on the other).
 *
 * Exported because the same answer has to be available before anybody presses submit: the route hands it to
 * the form, so the warning a claimant sees and the refusal the server issues come from one function and cannot
 * drift apart.
 */
export async function expensePolicyBreaches(deps: Deps, row: { uuid: string; categoryId: string | null; amount: number; incurredOn: Date | null }): Promise<PolicyBreach[]> {
  if (!row.categoryId) return [];
  const cat = (await deps.db
    .select({
      amountCap: schema.expenseCategories.amountCap,
      maxAgeDays: schema.expenseCategories.maxAgeDays,
      requiresReceipt: schema.expenseCategories.requiresReceipt,
      rateKind: schema.expenseCategories.rateKind,
    })
    .from(schema.expenseCategories)
    .where(eq(schema.expenseCategories.uuid, row.categoryId))
    .limit(1))[0];
  if (!cat) return [];
  // Only asked for when the category actually demands one, so an unrestricted category costs no extra read.
  const needsReceiptCheck = cat.requiresReceipt && cat.rateKind === null;
  const hasReceipt = needsReceiptCheck ? (await attachedObjectIds(deps, "expenses", "invoice", [row.uuid])).has(row.uuid) : true;
  return categoryBreaches(cat, { amount: row.amount, incurredOn: row.incurredOn, hasReceipt }, dayStartMs(await orgToday(deps)));
}

// Resolve an optional "<collection>/<id>" ref, validating the target exists and is not soft-deleted/disabled.
async function resolveRef(deps: Deps, table: any, path: string | null | undefined, label: string): Promise<string | null> {
  if (!path) return null;
  const id = idFromPath(path)!;
  const row = (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime || row.disabled) throw invalidArgument(`that ${label} is unavailable`);
  return id;
}

/**
 * May this caller file an expense owned by SOMEBODY ELSE?
 *
 * The same question `leave-requests` answers, for the same reason: `expenses: write` is the collection-level
 * grant that makes self-service filing work, so naming another employee in the payload decides nothing about
 * authority. A caller whose expense reach is `own` gets their own id regardless of what the body said.
 *
 * Defence in depth beside the `expenses` entry in OWNER_REFS (domain/manifests.ts), which makes the middleware
 * demand write on `expenses.<ownerCode>` before the body ever reaches here. A grant the decision engine cannot
 * read is not authority either, so the throwing case answers "own".
 */
function reachesBeyondOwnExpenses(actor: AppUser): boolean {
  if (!actor.grant) return false;
  try {
    return scopeFor(actor, "expenses").breadth !== "own";
  } catch {
    return false;
  }
}

/**
 * Claims by the same filer that look like this one.
 *
 * SCOPED TO THE FILER, always. The question is "did you already file this", so it is asked of their own
 * claims and nobody else's - which also means the warning can never surface a row the caller could not
 * otherwise read, whatever breadth they hold.
 *
 * Candidates are narrowed in SQL to the day window plus anything carrying the same invoice number, so the
 * matcher in `domain/expenses.ts` runs over a handful of rows rather than the filer's whole history. A
 * cancelled or rejected claim is excluded: re-filing something that was turned down is a correction, not a
 * double-submit, and warning about it would be wrong in the one case the filer is definitely right.
 */
export async function possibleDuplicates(deps: Deps, row: typeof schema.expenses.$inferSelect): Promise<DuplicateMatch[]> {
  const incurredMs = row.incurredOn ? +new Date(row.incurredOn) : null;
  const inv = (row.invoiceNumber ?? "").trim();
  const windowMs = DUPLICATE_DAY_WINDOW * 86_400_000;
  const near: SQL[] = [];
  if (incurredMs !== null) {
    near.push(and(
      gte(schema.expenses.incurredOn, new Date(incurredMs - windowMs)),
      lte(schema.expenses.incurredOn, new Date(incurredMs + windowMs)),
    )!);
  }
  if (inv) near.push(eq(schema.expenses.invoiceNumber, inv));
  // Neither a date nor an invoice number means nothing can match: the matcher requires one or the other, so
  // asking the database would be a read whose answer is already known.
  if (!near.length) return [];

  const rows = await deps.db
    .select({
      uuid: schema.expenses.uuid,
      amount: schema.expenses.amount,
      vendorId: schema.expenses.vendorId,
      categoryId: schema.expenses.categoryId,
      incurredOn: schema.expenses.incurredOn,
      invoiceNumber: schema.expenses.invoiceNumber,
    })
    .from(schema.expenses)
    .where(and(
      eq(schema.expenses.employeeId, row.employeeId),
      ne(schema.expenses.uuid, row.uuid),
      eq(schema.expenses.isRecurring, false), // a template is not a claim
      // `expenses` is hard-deleted, so there is no soft-delete predicate to add here.
      notInArray(schema.expenses.state, ["REJECTED", "CANCELLED"]),
      or(...near),
    ));

  const toCandidate = (r: { uuid: string; amount: number; vendorId: string | null; categoryId: string | null; incurredOn: Date | null; invoiceNumber: string | null }): DuplicateCandidate =>
    ({ id: r.uuid, amount: r.amount, vendorId: r.vendorId, categoryId: r.categoryId, incurredMs: r.incurredOn ? +new Date(r.incurredOn) : null, invoiceNumber: r.invoiceNumber });

  return findDuplicateClaims(
    { id: row.uuid, amount: row.amount, vendorId: row.vendorId, categoryId: row.categoryId, incurredMs, invoiceNumber: row.invoiceNumber },
    rows.map(toCandidate),
  );
}

/** The filer's own department, for the cost-centre default. Null when they have none, which is a real state
 *  (a new joiner before their team is set) and leaves the claim unattributed exactly as before. */
async function ownDepartmentId(deps: Deps, employeeId: string): Promise<string | null> {
  const row = (await deps.db
    .select({ departmentId: schema.employees.departmentId })
    .from(schema.employees)
    .where(eq(schema.employees.uuid, employeeId))
    .limit(1))[0];
  return row?.departmentId ?? null;
}

export async function createExpense(deps: Deps, actor: AppUser, input: ExpenseInput) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
  const named = idFromPath(input.employee);
  const employeeId = named && reachesBeyondOwnExpenses(actor) ? named : actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const tax = Number(input.tax_amount ?? 0);
  if (!Number.isFinite(tax) || tax < 0) throw invalidArgument("tax_amount must be zero or positive");

  const recurring = !!input.recurring;
  let nextOccurrenceOn: Date | null = null;
  if (recurring) {
    if (input.recurrence_rule !== "monthly" && input.recurrence_rule !== "quarterly" && input.recurrence_rule !== "yearly") {
      throw invalidArgument("recurrence_rule must be monthly, quarterly, or yearly for a recurring expense");
    }
    nextOccurrenceOn = dayDate(input.next_occurrence_on);
    if (!nextOccurrenceOn) throw invalidArgument("next_occurrence_on is required for a recurring expense");
  }

  // Allocated inside the retry (codeAlloc.ts): month end is everybody filing their expenses at once.
  // Resolved before the insert rather than inside it: a rated category prices the claim from its own rate, so
  // the category has to be known before the amount is final.
  const categoryId = await resolveRef(deps, schema.expenseCategories, input.category, "expense category");
  const priced = await pricedAmount(deps, categoryId, round2(amount), input.quantity);

  const row = (await withFreshCode(async () => deps.db
    .insert(schema.expenses)
    .values({
      code: await allocOwnedCode(deps, schema.expenses, schema.expenses.employeeId, employeeId),
      employeeId,
      vendorId: await resolveRef(deps, schema.vendors, input.vendor, "vendor"),
      categoryId,
      // Cost centre: what the caller sent, else the filer's OWN department. Almost every claim is charged to
      // the team the person is on, so asking for it every time is a question with a known answer - and a
      // blank cost centre is worse than a defaulted one, because it drops the claim out of every
      // department-scoped budget and rollup silently. An explicit value always wins, including an explicit
      // null: `resolveRef` returning null for an omitted field is indistinguishable from a cleared one here,
      // so the default applies only when the key was absent from the input entirely.
      departmentId: (await resolveRef(deps, schema.departments, input.department, "department"))
        ?? ("department" in input ? null : await ownDepartmentId(deps, employeeId)),
      amount: priced.amount,
      quantity: priced.quantity,
      taxAmount: round2(tax),
      incurredOn: dayDate(input.incurred_on),
      // Empty string clears, like an omitted field: the SPA sends "" for a text box the user left blank and
      // never sends null (see web/src/api.ts).
      description: input.description?.trim() || null,
      invoiceNumber: input.invoice_number?.trim() || null,
      paymentMethod: input.payment_method ?? null, // an enum: no empty-string form, so it is omitted instead
      reimbursable: !!input.reimbursable,
      state: "DRAFT",
      isRecurring: recurring,
      recurrenceRule: recurring ? input.recurrence_rule : null,
      nextOccurrenceOn,
    })
    .returning()))[0]!;
  // After the row, because a split line references the expense it divides. Validated against the amount that
  // was actually STORED, which on a rated category is the server's own multiplication rather than whatever the
  // caller sent.
  await replaceAllocations(deps, row.uuid, row.amount, input.allocations);
  await audit(deps, actor, "expense.create", "expenses", row.uuid, createdMeta(row, "expenses"), row);
  return row;
}

// PATCH-style edit, allowed only while a DRAFT (or a recurring template, which never leaves DRAFT).
export async function updateExpense(deps: Deps, actor: AppUser, id: string, patch: ExpenseInput) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "DRAFT") throw failedPrecondition("only draft expenses can be edited");
  const set: SetOf<typeof schema.expenses> = { updatedAt: new Date() };
  const has = (k: keyof ExpenseInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("amount")) {
    const amount = Number(patch.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
    set.amount = round2(amount);
  }
  if (has("tax_amount")) {
    const tax = Number(patch.tax_amount ?? 0);
    if (!Number.isFinite(tax) || tax < 0) throw invalidArgument("tax_amount must be zero or positive");
    set.taxAmount = round2(tax);
  }
  if (has("vendor")) set.vendorId = await resolveRef(deps, schema.vendors, patch.vendor, "vendor");
  if (has("category")) set.categoryId = await resolveRef(deps, schema.expenseCategories, patch.category, "expense category");
  // Re-price when EITHER side of the calculation moved: a new quantity against the same category, or the same
  // quantity moved to a different one. Missing the second case would leave a mileage claim carrying the amount
  // it had under the old category, which is the arithmetic nobody would think to check.
  if (has("quantity") || has("category")) {
    const categoryId = has("category") ? (set.categoryId ?? null) : row.categoryId;
    const quantity = has("quantity") ? patch.quantity : row.quantity;
    const repriced = await pricedAmount(deps, categoryId, set.amount ?? row.amount, quantity);
    set.amount = repriced.amount;
    set.quantity = repriced.quantity;
  }
  if (has("department")) set.departmentId = await resolveRef(deps, schema.departments, patch.department, "department");
  if (has("incurred_on")) set.incurredOn = dayDate(patch.incurred_on);
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("invoice_number")) set.invoiceNumber = patch.invoice_number?.trim() || null;
  // An enum, so there is no empty-string form of it: a caller who has no value omits the field.
  if (has("payment_method")) set.paymentMethod = patch.payment_method ?? null;
  if (has("reimbursable")) set.reimbursable = !!patch.reimbursable;
  // Cadence is editable on a template (change rent from monthly to quarterly without rebuilding the schedule);
  // on a non-template it is meaningless and ignored, as is flipping `recurring` itself.
  if (has("recurrence_rule") && row.isRecurring) {
    const rule = patch.recurrence_rule;
    if (rule !== "monthly" && rule !== "quarterly" && rule !== "yearly") {
      throw invalidArgument("recurrence_rule must be monthly, quarterly, or yearly for a recurring expense");
    }
    set.recurrenceRule = rule;
  }
  if (has("next_occurrence_on") && row.isRecurring) {
    const d = dayDate(patch.next_occurrence_on);
    if (!d) throw invalidArgument("next_occurrence_on cannot be cleared on a recurring expense");
    set.nextOccurrenceOn = d;
  }
  // Pause / resume a schedule. Resuming rolls the due date forward to the next FUTURE occurrence: a template
  // paused for three months would otherwise file three back-dated expenses the moment it came back.
  if (has("paused") && row.isRecurring) {
    const paused = !!patch.paused;
    set.paused = paused;
    if (!paused && row.paused && row.recurrenceRule && !has("next_occurrence_on")) {
      let next = row.nextOccurrenceOn ? new Date(row.nextOccurrenceOn) : null;
      const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      // The template's own day of the month, resolved once and held for the whole catch-up. A template paused
      // over a February and resumed in the spring used to step 31 -> 28 -> 28 -> 28, so unpausing quietly moved
      // a monthly bill three days early for good. See domain/calendar.ts#seriesAnchorDay.
      const anchorDay = next ? seriesAnchorDay(next, row.recurrenceAnchorDay) : null;
      while (next && next < today) next = advanceRecurrence(next, row.recurrenceRule as RecurrenceRule, anchorDay);
      if (next) {
        set.nextOccurrenceOn = next;
        set.recurrenceAnchorDay = anchorDay;
      }
    }
  }
  const updated = (await deps.db.update(schema.expenses).set(set).where(eq(schema.expenses.uuid, id)).returning())[0]!;
  // A split is re-stated whole or left alone; and when the AMOUNT moved without the caller re-stating it, the
  // old split no longer sums to the invoice, so it is dropped rather than left silently wrong. Better to lose a
  // split somebody must redo than to charge cost centres a total the company never paid.
  if (patch.allocations !== undefined) await replaceAllocations(deps, id, updated.amount, patch.allocations);
  else if (updated.amount !== row.amount) await deps.db.delete(schema.expenseAllocations).where(eq(schema.expenseAllocations.expenseId, id));
  await auditUpdate(deps, actor, "expense.update", "expenses", id, diffMeta(row, updated, set, "expenses"), updated);
  return updated;
}

// ---- Workflow transitions (all guarded exactly-once flips) ----------------------------------------------

// DRAFT -> SUBMITTED. A recurring template is a seed, never itself submitted. Auto-approves when the amount is
// at or below the configured threshold.
export async function submitExpense(deps: Deps, actor: AppUser, id: string) {
  const row = await getExpense(deps, actor, id);
  if (row.isRecurring) throw failedPrecondition("a recurring template is not submitted directly; the schedule generates expenses");
  if (row.state !== "DRAFT") throw failedPrecondition("only draft expenses can be submitted");
  // THE RULE LANDS HERE, not at the approver's desk three days later. Every one of these is something a claim
  // gets rejected for today, after somebody has read it and written a note - so stating it at the moment of
  // filing costs the same check and saves the round trip. The message names the limit, because a submitter who
  // is told "over the cap" and not what the cap is has to go and ask.
  const breaches = await expensePolicyBreaches(deps, row);
  if (breaches.length) throw failedPrecondition(breaches.map((b) => b.message).join(" "));
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "SUBMITTED", updatedAt: new Date() })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "DRAFT")))
    .returning();
  if (!updated) throw failedPrecondition("only draft expenses can be submitted");
  await audit(deps, actor, "expense.submit", "expenses", id, stateMeta(row.state, "SUBMITTED", { employee: `employees/${row.employeeId}` }), updated);
  await emitEvent(deps, actor, "expense.submitted", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, categoryId: row.categoryId, vendorId: row.vendorId, departmentId: row.departmentId } });
  await notifyManager(deps, row.employeeId, { type: "expense.requested", noun: "expense" });
  // Auto-approve small expenses when configured (threshold > 0).
  //
  // NEVER a claim that needs two approvers. The two thresholds are meant to bracket opposite ends - auto-approve
  // small, double-approve large - but nothing stops an org setting them so they overlap, and in that overlap
  // auto-approval would call `approveExpense` AS THE SUBMITTER and record them as the first of the two
  // approvals on their own claim. The stricter rule wins: a claim above the second-approval line is never
  // waved through, whatever the auto-approve line says.
  const settings = await expenseSettings(deps);
  const threshold = settings.auto_approve_threshold ?? 0;
  const twoApprovals = settings.second_approval_threshold ?? 0;
  const needsTwo = twoApprovals > 0 && updated.amount > twoApprovals;
  if (threshold > 0 && updated.amount <= threshold && !needsTwo) {
    // THE LANE. Amount gets a claim as far as being considered; the org's own guards decide whether it is
    // actually routine. Without them a duplicate under the threshold approves itself, and so does a claim that
    // puts its budget over - which is how an auto-approval rule quietly becomes the thing finance distrusts.
    //
    // A blocked claim is NOT rejected. It simply stays SUBMITTED and goes to a person, which is what would have
    // happened without a lane at all; the reason is recorded so the approver opening it knows why it is in
    // front of them.
    const blocks = await autoApproveDecision(deps, updated, settings.auto_approve_requires ?? []);
    // The lane is the ORG's decision, configured in advance, so it is not the submitter approving their own
    // claim - which is why it, and only it, passes the maker-checker guard (services/decisionGuard.ts).
    if (!blocks.length) return approve(deps, actor, id, undefined, true);
    await audit(deps, actor, "expense.auto_approve.held", "expenses", id, {
      amount: updated.amount,
      held_by: blocks.map((b) => b.guard),
      reason: blocks.map((b) => b.message).join("; "),
    }, updated);
  }
  return updated;
}

// SUBMITTED -> APPROVED. Employee-fronted expenses spawn an APPROVED reimbursement so payroll pays the employee.
/**
 * Does this claim need a second pair of hands, and has it had them?
 *
 * Above the configured threshold an expense takes TWO approvals from TWO people. Off by default (a threshold
 * of 0 or absent), for the reason every other separation-of-duties rule in this app is off by default: a
 * finance team of one has nobody to be the second approver, and a control they cannot satisfy is one they
 * route around.
 *
 * The same person cannot be both approvals. That is the entire point of the rule, so it is checked on the
 * identity rather than on the count - without it, a single approver pressing the button twice would satisfy
 * "two approvals" and the control would be decorative.
 */
async function secondApprovalGate(deps: Deps, actor: AppUser, row: { amount: number; firstApprovedBy: string | null }): Promise<{ needsAnother: boolean }> {
  const threshold = (await expenseSettings(deps)).second_approval_threshold ?? 0;
  if (!(threshold > 0) || row.amount <= threshold) return { needsAnother: false };
  if (!row.firstApprovedBy) return { needsAnother: true };
  if (row.firstApprovedBy === actor.uuid) {
    throw failedPrecondition("this claim needs a second approver - you have already approved it");
  }
  return { needsAnother: false };
}

export const approveExpense = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => approve(deps, actor, id, ifMatch, false);

async function approve(deps: Deps, actor: AppUser, id: string, ifMatch: string | undefined, autoLane: boolean) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "SUBMITTED") throw failedPrecondition("only submitted expenses can be approved");
  assertReviewedVersion(row, ifMatch);
  if (!autoLane) await assertNotSubject(deps, actor, row.employeeId, "approve", "expense");

  // A large claim's FIRST approval records who gave it and stops there. The row stays SUBMITTED, so it is
  // still in everybody's approval queue - which is true, and is what keeps the queue counts right without a
  // new state for them to learn about.
  const gate = await secondApprovalGate(deps, actor, row);
  if (gate.needsAnother) {
    const [held] = await deps.db
      .update(schema.expenses)
      .set({ firstApprovedBy: actor.uuid, firstApprovedAt: new Date(), updatedAt: new Date() })
      // Guarded on the column still being empty, so two approvers pressing at once cannot both be recorded as
      // the first - the loser gets no row back and is told to try again, by which time they are the second.
      .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "SUBMITTED"), isNull(schema.expenses.firstApprovedBy)))
      .returning();
    if (!held) throw failedPrecondition("this claim was just approved by somebody else - reload and try again");
    await audit(deps, actor, "expense.approve.first", "expenses", id, { amount: row.amount, awaiting: "second approval" }, held);
    await notifyManager(deps, row.employeeId, { type: "expense.requested", noun: "expense (second approval)" });
    return held;
  }

  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "APPROVED", decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "SUBMITTED")))
    .returning();
  if (!updated) throw failedPrecondition("only submitted expenses can be approved");
  // Bridge to payroll if an employee fronted it (guarded above => runs exactly once).
  if (updated.reimbursable && !updated.reimbursementId) {
    let catName: string | null = null;
    if (updated.categoryId) {
      const cat = (await deps.db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.uuid, updated.categoryId)).limit(1))[0];
      catName = cat?.name ?? null;
    }
    const reimb = await createApprovedReimbursementForExpense(deps, actor, {
      employeeId: updated.employeeId,
      amount: updated.amount,
      incurredOn: updated.incurredOn,
      description: updated.description ?? `Expense ${updated.code}`,
      expenseCategoryName: catName,
    });
    await deps.db.update(schema.expenses).set({ reimbursementId: reimb.uuid, updatedAt: new Date() }).where(eq(schema.expenses.uuid, id));
  }
  await audit(deps, actor, "expense.approve", "expenses", id, stateMeta(row.state, "APPROVED", { employee: `employees/${row.employeeId}` }), updated);
  await notify(deps, { recipient: row.employeeId, type: "expense.approved", title: "Expense approved", body: "Your expense was approved.", link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.approved", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, reimbursable: row.reimbursable } });
  return (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, id)).limit(1))[0]!;
}

// A rejection carries its reason: the submitter is told WHY (in the notification and on the record), so the
// next attempt can fix the thing that was wrong instead of guessing.
export async function rejectExpense(deps: Deps, actor: AppUser, id: string, rawReason: string, ifMatch?: string) {
  const reason = requireRejectReason(rawReason);
  const row = await getExpense(deps, actor, id);
  if (row.state !== "SUBMITTED") throw failedPrecondition("only submitted expenses can be rejected");
  assertReviewedVersion(row, ifMatch);
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "REJECTED", decidedBy: actor.uuid, decisionNote: reason, updatedAt: new Date() })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "SUBMITTED")))
    .returning();
  if (!updated) throw failedPrecondition("only submitted expenses can be rejected");
  await audit(deps, actor, "expense.reject", "expenses", id, stateMeta(row.state, "REJECTED", { employee: `employees/${row.employeeId}`, reason }), updated);
  await notify(deps, { recipient: row.employeeId, type: "expense.rejected", title: "Expense rejected", body: `Your expense was rejected: ${reason}`, link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.rejected", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, note: reason } });
  return updated;
}

// Cancel withdraws a draft or a submitted expense, and also an APPROVED one nobody has paid yet - the spend is
// no longer needed. Paying is what makes it final: a PAID expense, an employee-fronted one whose payroll claim
// a run or a settlement has already paid, or one a company-card charge is matched to (that money is already
// spent) stays as it is. Cancelling an approved recurring template stops its schedule, as it does a draft one.
//
// `settledExpenseIds` answers the "already settled" half for a page of rows, so the list can hide Cancel on the
// approved rows this would refuse. Only APPROVED rows are asked about, in one query per page; a page without
// any costs no read.
export async function settledExpenseIds(deps: Deps, rows: readonly { uuid: string; state: string }[]): Promise<Set<string>> {
  const ids = rows.filter((r) => r.state === "APPROVED").map((r) => r.uuid);
  const e = schema.expenses;
  const hits = await byIdChunks(ids, (group) => deps.db
    .select({ uuid: e.uuid })
    .from(e)
    .where(and(inArray(e.uuid, group), sql`(
      exists (select 1 from ${schema.cardTransactions} where ${schema.cardTransactions.expenseId} = ${e.uuid})
      or exists (select 1 from ${schema.reimbursements} where ${schema.reimbursements.uuid} = ${e.reimbursementId} and ${schema.reimbursements.state} = 'PAID')
    )`)));
  return new Set(hits.map((h) => h.uuid));
}

export async function cancelExpense(deps: Deps, actor: AppUser, id: string) {
  const row = await getExpense(deps, actor, id);
  const stuck = "only draft, submitted or unpaid approved expenses can be cancelled";
  if (row.state !== "DRAFT" && row.state !== "SUBMITTED" && row.state !== "APPROVED") throw failedPrecondition(stuck);
  if (row.state === "APPROVED") {
    const charge = (await deps.db.select({ uuid: schema.cardTransactions.uuid }).from(schema.cardTransactions).where(eq(schema.cardTransactions.expenseId, id)).limit(1))[0];
    if (charge) throw failedPrecondition("a company card charge is matched to this expense, so the money is already spent");
  }
  const at = new Date();
  // An approved employee-fronted expense became an APPROVED reimbursement (the payroll payout). It is withdrawn
  // WITH the expense, in one batch. A batch reports a short count, it does not roll an earlier statement back,
  // so each half carries the other's condition: the expense flips only while the payout is still unpaid, and
  // the payout flips only once the expense has. A run that claimed the payout in between leaves both untouched,
  // never an expense cancelled under a claim that still pays out, nor the reverse.
  const payoutId = row.state === "APPROVED" ? row.reimbursementId : null;
  const r = schema.reimbursements;
  const flip = {
    stmt: deps.db
      .update(schema.expenses)
      .set({ state: "CANCELLED", updatedAt: at })
      .where(and(
        eq(schema.expenses.uuid, id),
        eq(schema.expenses.state, row.state),
        ...(payoutId ? [sql`exists (select 1 from ${r} where ${r.uuid} = ${payoutId} and ${r.state} = 'APPROVED' and ${r.paidRunId} is null)`] : []),
      ))
      .returning(),
    expect: 1,
    label: "cancel the expense",
  };
  const payout = payoutId
    ? [{
        stmt: deps.db
          .update(r)
          .set({ state: "CANCELLED", decidedBy: actor.uuid, updatedAt: at })
          .where(and(
            eq(r.uuid, payoutId),
            eq(r.state, "APPROVED"),
            isNull(r.paidRunId),
            sql`exists (select 1 from ${schema.expenses} where ${schema.expenses.uuid} = ${id} and ${schema.expenses.state} = 'CANCELLED')`,
          ))
          .returning({ uuid: r.uuid }),
        expect: 1,
        label: "withdraw the payroll payout",
      }]
    : [];
  if ((await runBatchChecked(deps.db, [flip, ...payout])).length) {
    // Tell the two apart only when it matters to the caller: a payout that has been paid is a different answer
    // from an expense somebody else already moved.
    const paid = payoutId && (await deps.db.select({ state: r.state }).from(r).where(eq(r.uuid, payoutId)).limit(1))[0]?.state === "PAID";
    throw failedPrecondition(paid ? "the payroll payout for this expense has already been paid, so it cannot be cancelled" : stuck);
  }
  const updated = (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, id)).limit(1))[0]!;
  await audit(deps, actor, "expense.cancel", "expenses", id, stateMeta(row.state, "CANCELLED", { employee: `employees/${row.employeeId}`, ...(payoutId ? { reimbursement: `reimbursements/${payoutId}` } : {}) }), updated);
  return updated;
}

// APPROVED -> PAID (out-of-band vendor payment). Reimbursable expenses are paid via payroll (their linked
// reimbursement), so :pay is refused for them.
export async function payExpense(deps: Deps, actor: AppUser, id: string, input: ExpensePayInput = {}, ifMatch?: string) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "APPROVED") throw failedPrecondition("only approved expenses can be marked paid");
  assertReviewedVersion(row, ifMatch);
  await assertNotSubject(deps, actor, row.employeeId, "mark paid", "expense");
  if (row.reimbursable) throw failedPrecondition("a reimbursable expense is paid to the employee via payroll, not marked paid here");
  const now = new Date();
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "PAID", paidBy: actor.uuid, paidAt: now, paymentMethod: input.payment_method ?? row.paymentMethod, paymentRef: input.payment_ref ?? row.paymentRef, updatedAt: now })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "APPROVED")))
    .returning();
  if (!updated) throw failedPrecondition("only approved expenses can be marked paid");
  await audit(deps, actor, "expense.pay", "expenses", id, stateMeta(row.state, "PAID", { employee: `employees/${row.employeeId}` }), updated);
  await notify(deps, { recipient: row.employeeId, type: "expense.paid", title: "Expense paid", body: "An approved expense was paid.", link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.paid", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, paymentMethod: updated.paymentMethod } });
  return updated;
}

// ---- Recurring generation (daily cron) ------------------------------------------------------------------
// For each due recurring template (isRecurring, nextOccurrenceOn <= now), clone one concrete expense and
// advance the template. Claim-first (advance the template's nextOccurrenceOn guarded on its current value)
// so a concurrent tick / retry can't double-generate; the clone is inserted only after the claim succeeds.
// Best-effort per template (a failure on one never aborts the batch). Returns the count generated.

/** How many due templates one tick files. See the note on the slice below for why there is a cap at all. */
const MAX_RECURRING_PER_TICK = 25;

export async function generateRecurringExpenses(deps: Deps, now: Date = new Date()): Promise<number> {
  const defaultState = ((await expenseSettings(deps)).recurring_default_state === "DRAFT") ? "DRAFT" : "SUBMITTED";
  // A stopped or paused schedule must stop: a CANCELLED template is done for good (:cancel is how the UI ends
  // a schedule) and a `paused` one is on hold, so neither generates. Without this a template kept filing
  // expenses forever, whatever the UI said.
  const due = await deps.db
    .select()
    .from(schema.expenses)
    .where(and(
      eq(schema.expenses.isRecurring, true),
      lte(schema.expenses.nextOccurrenceOn, now),
      ne(schema.expenses.state, "CANCELLED"),
      eq(schema.expenses.paused, false),
    ))
    .orderBy(asc(schema.expenses.nextOccurrenceOn), asc(schema.expenses.uuid));
  // CAPPED PER TICK. Each template below costs roughly seven subrequests - the claim, an owned-code allocation,
  // the clone, an audit row, an event and a manager notification - and they cannot be batched, because each one
  // is a guarded claim whose outcome decides whether the clone is written at all. Unbounded, a payables
  // schedule that grew past a few dozen templates would spend the invocation's whole subrequest budget
  // (lib/dbBatch.ts) in the nightly tick shared with twenty-one other subtasks, and every subtask after it
  // would fail too. A deferred template is NOT lost: its `nextOccurrenceOn` is untouched, so it is still due
  // and the next tick takes it - the same self-healing the year-end rollover relies on (src/cron.ts
  // CARRY_FORWARD_JOB). Oldest due date first, so nothing can be starved by a steady stream of newer ones.
  const templates = due.slice(0, MAX_RECURRING_PER_TICK);
  const deferred = due.length - templates.length;
  if (deferred > 0) console.warn(`[expenses] ${deferred} recurring template(s) deferred to the next tick (cap ${MAX_RECURRING_PER_TICK})`);
  let generated = 0;
  let failed = 0;
  for (const t of templates) {
    if (!t.nextOccurrenceOn || !t.recurrenceRule) continue;
    const occurrenceOn = new Date(t.nextOccurrenceOn);
    // The template's day of the month, stamped back with the advance so every later step reads it. Without it
    // a rent or retainer template written for the 31st filed on the 28th from its first February onwards, and
    // nothing about it ever came back to the 31st.
    const anchorDay = seriesAnchorDay(occurrenceOn, t.recurrenceAnchorDay);
    const advanced = advanceRecurrence(occurrenceOn, t.recurrenceRule as RecurrenceRule, anchorDay);
    // Claim this occurrence: advance the template guarded on the unchanged nextOccurrenceOn (0 rows => taken).
    const claimed = await deps.db
      .update(schema.expenses)
      .set({ nextOccurrenceOn: advanced, recurrenceAnchorDay: anchorDay, lastGeneratedOn: now, updatedAt: now })
      .where(and(eq(schema.expenses.uuid, t.uuid), eq(schema.expenses.nextOccurrenceOn, occurrenceOn)))
      .returning();
    if (!claimed.length) continue;
    try {
      const clone = (await withFreshCode(async () => deps.db
        .insert(schema.expenses)
        .values({
          code: await allocOwnedCode(deps, schema.expenses, schema.expenses.employeeId, t.employeeId),
          employeeId: t.employeeId,
          vendorId: t.vendorId,
          categoryId: t.categoryId,
          departmentId: t.departmentId,
          amount: t.amount,
          taxAmount: t.taxAmount,
          incurredOn: occurrenceOn,
          description: t.description,
          paymentMethod: t.paymentMethod,
          reimbursable: t.reimbursable,
          state: defaultState,
          templateId: t.uuid,
        })
        .returning()))[0]!;
      await audit(deps, "system", "expense.generate", "expenses", clone.uuid, createdMeta(clone, "expenses"), clone);
      if (defaultState === "SUBMITTED") {
        await emitEvent(deps, null, "expense.submitted", { subject: `expenses/${clone.uuid}`, employeeId: clone.employeeId, payload: { amount: clone.amount, categoryId: clone.categoryId, vendorId: clone.vendorId, departmentId: clone.departmentId } });
        await notifyManager(deps, clone.employeeId, { type: "expense.requested", noun: "recurring expense" });
      }
      generated++;
    } catch (err) {
      // The clone failed AFTER the claim advanced the template, so put the claim back: this occurrence is
      // retried on the next tick instead of being skipped for good. Advancing and then swallowing the failure
      // meant a recurring expense the org is committed to simply never existed, with nothing anywhere saying
      // so - money missing, silently, which is the one outcome a payables schedule must not have.
      //
      // Guarded on the value this run wrote, so releasing cannot stamp over a claim somebody else has since
      // taken (the same guard shape as the claim itself).
      await deps.db
        .update(schema.expenses)
        .set({ nextOccurrenceOn: occurrenceOn, lastGeneratedOn: t.lastGeneratedOn, updatedAt: now })
        .where(and(eq(schema.expenses.uuid, t.uuid), eq(schema.expenses.nextOccurrenceOn, advanced)));
      failed++;
      console.error(`[expenses] recurring generation failed for template ${t.uuid}; claim released for retry`, err);
    }
  }
  // Loudly, not in a log nobody reads: the cron's subtask wrapper turns a throw into a `cron_runs` failure, so
  // a night that could not file an expense shows as a failed tick in the Operations UI rather than a green one.
  if (failed) throw new Error(`${failed} recurring expense(s) could not be generated (${generated} succeeded); each claim was released for the next tick`);
  return generated;
}

/**
 * When each of these expenses is payable, from its vendor's agreed terms.
 *
 * One query for the whole page, like `seriesDriftFor` beside it. Rows with no vendor, a vendor with no agreed
 * terms, or no invoice date get nothing - `paymentDueOn` owns those decisions, and its null means "do not
 * invent a date" rather than "due now".
 *
 * Computed on read rather than stamped on the row. The terms are the VENDOR's and they get renegotiated; a
 * stored due date would keep answering with the terms that applied the day somebody filed the invoice, and
 * nothing would ever correct it.
 */
export async function paymentDueFor(deps: Deps, rows: readonly { uuid: string; vendorId: string | null; incurredOn: Date | null }[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((v): v is string => !!v))];
  if (!vendorIds.length) return out;
  const terms = new Map(
    (await deps.db
      .select({ uuid: schema.vendors.uuid, days: schema.vendors.paymentTermsDays })
      .from(schema.vendors)
      .where(inArray(schema.vendors.uuid, vendorIds))
    ).map((v) => [v.uuid, v.days]),
  );
  for (const r of rows) {
    if (!r.vendorId) continue;
    const due = paymentDueOn(r.incurredOn, terms.get(r.vendorId) ?? null);
    if (due) out.set(r.uuid, due);
  }
  return out;
}

// ---- Month-end close -------------------------------------------------------------------------------------



/**
 * What is unfinished about this month, assembled from queries that already existed separately.
 *
 * SERVER-SIDE, and that is the whole reason it is an endpoint rather than a panel computed from what the page
 * has already loaded. A list is capped at 100 rows, so a checklist derived client-side would be a statement
 * about page one wearing the label of the collection - the same argument `listExpenseBudgets` makes for its own
 * summary.
 *
 * Every count is bound by `scopes`, which the middleware resolved per collection. A caller who may not list
 * expenses gets no expense checks rather than a 403, so one endpoint serves a department manager closing their
 * own cost centre and finance closing the org.
 */
export async function monthEndClose(deps: Deps, scopes: Map<string, ListScope>, asOf: Date = new Date()): Promise<CloseCheck[]> {
  const out: CloseCheck[] = [];
  const expenseScope = scopes.get("expenses");

  if (expenseScope) {
    const bound = (extra: SQL | undefined) => and(applyScope(expenseScope, schema.expenses.code, schema.expenses.employeeId), extra);
    const rows = await deps.db
      .select({
        uuid: schema.expenses.uuid,
        state: schema.expenses.state,
        amount: schema.expenses.amount,
        vendorId: schema.expenses.vendorId,
        incurredOn: schema.expenses.incurredOn,
        categoryId: schema.expenses.categoryId,
      })
      .from(schema.expenses)
      // APPROVED and SUBMITTED only: a draft is somebody still typing, and a paid or cancelled one is finished.
      // Everything below is a slice of this one read rather than a query per check.
      .where(bound(inArray(schema.expenses.state, ["SUBMITTED", "APPROVED"])));

    const approved = rows.filter((r) => r.state === "APPROVED");
    const sum = (rs: typeof rows) => round2(rs.reduce((t, r) => t + r.amount, 0));
    if (approved.length) out.push({ key: "approved_unpaid", count: approved.length, amount: sum(approved), filter: "state=APPROVED" });

    const waiting = rows.filter((r) => r.state === "SUBMITTED");
    if (waiting.length) out.push({ key: "awaiting_approval", count: waiting.length, amount: sum(waiting), filter: "state=SUBMITTED" });

    // Past its agreed payment terms and still not paid. Only answerable since vendors carry a number of days
    // rather than the words "Net 30" - before that the app could not say what was late, only what was unpaid.
    const vendorIds = [...new Set(approved.map((r) => r.vendorId).filter((v): v is string => !!v))];
    if (vendorIds.length) {
      // UNSCOPED ON PURPOSE, and the reason has to stay next to it: `vendorIds` was drawn from expenses this
      // caller can already see, and the select is the payment term alone. No vendor row reaches the caller and
      // no vendor they cannot already infer is named. That safety is a property of THESE TWO columns, not of
      // the read - widen the select and it stops being true.
      const terms = new Map(
        (await deps.db
          .select({ uuid: schema.vendors.uuid, days: schema.vendors.paymentTermsDays })
          .from(schema.vendors)
          .where(inArray(schema.vendors.uuid, vendorIds))
        ).map((v) => [v.uuid, v.days]),
      );
      const overdue = approved.filter((r) => {
        const due = paymentDueOn(r.incurredOn, r.vendorId ? terms.get(r.vendorId) ?? null : null);
        return due !== null && due.getTime() < asOf.getTime();
      });
      if (overdue.length) out.push({ key: "overdue", count: overdue.length, amount: sum(overdue), filter: "state=APPROVED" });
    }

    // Filed without the invoice its category demands. Checked here rather than trusted from the submit gate,
    // because a category can be made receipt-required AFTER claims were filed against it - those rows passed a
    // rule that did not exist yet, and this is the surface that says so.
    // Also unscoped, and safe for a different reason: expense categories are an ORG-WIDE catalogue every
    // caller may list, and this reads uuids only to decide which rows to check. Nothing about a category is
    // returned. Same caveat as the vendors read above - the argument is about the columns, not the query.
    const needReceipt = new Set(
      (await deps.db
        .select({ uuid: schema.expenseCategories.uuid })
        .from(schema.expenseCategories)
        .where(and(eq(schema.expenseCategories.requiresReceipt, true), isNull(schema.expenseCategories.rateKind)))
      ).map((c) => c.uuid),
    );
    const couldNeed = rows.filter((r) => r.categoryId && needReceipt.has(r.categoryId));
    if (couldNeed.length) {
      const attached = await attachedObjectIds(deps, "expenses", "invoice", couldNeed.map((r) => r.uuid));
      const missing = couldNeed.filter((r) => !attached.has(r.uuid));
      if (missing.length) out.push({ key: "missing_receipt", count: missing.length, amount: sum(missing) });
    }

    // A schedule that should have filed by now and has not. `generateRecurringExpenses` defers work past its
    // per-tick cap and self-heals on the next run, so a day or two behind is normal and only a template whose
    // due date has properly passed is worth a line.
    const overdueTemplates = await deps.db
      .select({ uuid: schema.expenses.uuid })
      .from(schema.expenses)
      .where(bound(and(
        eq(schema.expenses.isRecurring, true),
        eq(schema.expenses.paused, false),
        ne(schema.expenses.state, "CANCELLED"),
        lt(schema.expenses.nextOccurrenceOn, new Date(asOf.getTime() - 2 * 86_400_000)),
      )));
    if (overdueTemplates.length) out.push({ key: "recurring_not_generated", count: overdueTemplates.length });
  }

  // Charges on a company card that nobody has filed a claim for. This is the half of the month-end picture
  // that did not exist before the statement was imported: an unclaimed charge used to be invisible, because
  // the app only knew about spending somebody remembered to file.
  //
  // Gated on `card-transactions` like everything else here, so a caller who may not list them sees no such
  // check rather than a count they cannot drill into.
  if (scopes.get("card-transactions")) {
    const stale = await unclaimedCardTotals(deps, UNCLAIMED_GRACE_DAYS, asOf);
    if (stale.count) out.push({ key: "unclaimed_card_charges", count: stale.count, amount: stale.amount });
  }

  const budgetScope = scopes.get("expense-budgets");
  if (budgetScope) {
    const budgets = visibleByDelete(
      await deps.db.select().from(schema.expenseBudgets).where(applyScope(budgetScope, schema.expenseBudgets.code, undefined)),
      false,
    );
    const current = budgets.filter((b) => budgetPhase(b, asOf.getTime()) === "current");
    if (current.length) {
      const spends = await computeBudgetSpendMany(deps, current);
      let over = 0;
      let trending = 0;
      for (const b of current) {
        const spent = spends.get(b.uuid)?.spent ?? 0;
        if (b.amount > 0 && spent > b.amount) { over++; continue; }
        // Counted separately, and only when it is not ALREADY over: a cap that has blown is a fact, and listing
        // it again as a forecast would double-count the same budget in a checklist somebody is working through.
        const projection = budgetProjection(b, spent, asOf.getTime());
        if (projection && projection.projectedOverBy > 0) trending++;
      }
      if (over) out.push({ key: "budgets_over", count: over });
      if (trending) out.push({ key: "budgets_trending_over", count: trending });
    }
  }
  return out;
}

// ---- Allocation lines ------------------------------------------------------------------------------------

/**
 * Replace an expense's split, or clear it.
 *
 * REPLACE RATHER THAN MERGE, and deliberately: a split is one statement about how an invoice divides, so
 * editing it means saying the whole thing again. Merging lines would make a partial edit leave a split that
 * sums to the wrong total, which is the one failure `allocationError` exists to prevent.
 *
 * Validated against the amount the expense ACTUALLY has, not the one the caller sent - on a rated category the
 * server recomputes the amount from its own rate, so validating against the request would let a split agree
 * with a figure that was never stored.
 */
export async function replaceAllocations(deps: Deps, expenseId: string, amount: number, lines: AllocationLine[] | undefined): Promise<void> {
  if (lines === undefined) return; // absent means "leave the split alone", which is not the same as clearing it
  const problem = allocationError(lines, amount);
  if (problem) throw invalidArgument(problem);
  await deps.db.delete(schema.expenseAllocations).where(eq(schema.expenseAllocations.expenseId, expenseId));
  if (!lines.length) return;
  await deps.db.insert(schema.expenseAllocations).values(
    await Promise.all(lines.map(async (l) => ({
      uuid: genId(),
      expenseId,
      departmentId: await resolveRef(deps, schema.departments, l.department, "department"),
      categoryId: await resolveRef(deps, schema.expenseCategories, l.category, "expense category"),
      amount: round2(l.amount),
    }))),
  );
}

/** Every split line for a page of expenses, in one read. Rows with no split are simply absent from the map,
 *  which is what the serializer and the budget attribution both treat as "charge the row itself". */
export async function allocationsFor(deps: Deps, expenseIds: readonly string[]): Promise<Map<string, { department: string | null; category: string | null; amount: number }[]>> {
  const out = new Map<string, { department: string | null; category: string | null; amount: number }[]>();
  if (!expenseIds.length) return out;
  const rows = await byIdChunks([...new Set(expenseIds)], (group) =>
    deps.db
      .select({
        expenseId: schema.expenseAllocations.expenseId,
        departmentId: schema.expenseAllocations.departmentId,
        categoryId: schema.expenseAllocations.categoryId,
        amount: schema.expenseAllocations.amount,
      })
      .from(schema.expenseAllocations)
      .where(inArray(schema.expenseAllocations.expenseId, group)),
  );
  for (const r of rows) {
    const line = { department: r.departmentId, category: r.categoryId, amount: r.amount };
    const held = out.get(r.expenseId);
    if (held) held.push(line);
    else out.set(r.expenseId, [line]);
  }
  return out;
}

// ---- Straight-through approval --------------------------------------------------------------------------

/** How close two dates have to be before two claims of the same amount to the same payee look like one claim
 *  filed twice. Two days either side: an invoice re-keyed the next morning is the common case. */
const DUPLICATE_DAYS = 2;

/** How long a card charge may sit unclaimed before the close checklist asks about it. A charge from yesterday
 *  is not a delinquency, it is a charge from yesterday; two weeks is long enough that the claim would have
 *  been filed if it were going to be. */
const UNCLAIMED_GRACE_DAYS = 14;

/**
 * An existing claim this one looks like a second copy of, by CODE, or null.
 *
 * Deterministic and narrow on purpose: the same invoice number, or the same payee and amount within a couple
 * of days. It is a statement about two documents and never about the person who filed them - which is the line
 * `ai-rollout-plan.md` Decision 3 draws, and the reason this reports a neighbouring code rather than a verdict.
 *
 * Cancelled and rejected claims are not duplicates of anything: somebody already said no to them, and filing a
 * corrected version is exactly what they were supposed to do next.
 */
export async function duplicateClaimOf(deps: Deps, row: typeof schema.expenses.$inferSelect): Promise<string | null> {
  const invoice = (row.invoiceNumber ?? "").trim();
  const at = row.incurredOn ?? row.createdAt;

  // NARROWED IN SQL, and it has to be: the two things that make a duplicate are a matching invoice number or a
  // matching amount within a few days, and both are expressible as predicates. Read whole and filtered in
  // memory, this grew with the org's entire expense HISTORY rather than with anything about the claim - so it
  // was invisible on a fresh database, unbounded on a real one, and paid on every auto-approve. The same
  // defect services/bankFile.ts and services/payroll.ts each call out having fixed.
  //
  // The amount comparison is a narrow RANGE because the column is a float and equality on one is not a thing
  // to rely on; the date window is the same two days the in-memory check then confirms exactly.
  const window = at ? { from: new Date(at.getTime() - DUPLICATE_DAYS * 86_400_000), to: new Date(at.getTime() + DUPLICATE_DAYS * 86_400_000) } : null;
  const looksLike: (SQL | undefined)[] = [];
  // LOWERED on both sides, because the in-memory confirmation below compares case-insensitively and a
  // case-sensitive pre-filter would decide the answer before it ever got there - "INV-1001" would stop being a
  // duplicate of "inv-1001", silently, with the narrowing as the only reason.
  if (invoice) looksLike.push(sql`lower(${schema.expenses.invoiceNumber}) = ${invoice.toLowerCase()}`);
  if (window) {
    looksLike.push(and(
      gte(schema.expenses.amount, row.amount - 0.005),
      lte(schema.expenses.amount, row.amount + 0.005),
      or(
        and(gte(schema.expenses.incurredOn, window.from), lte(schema.expenses.incurredOn, window.to)),
        and(isNull(schema.expenses.incurredOn), gte(schema.expenses.createdAt, window.from), lte(schema.expenses.createdAt, window.to)),
      ),
    ));
  }
  // Nothing to match on at all - no invoice number and no date - cannot have a duplicate by either rule.
  if (!looksLike.length) return null;

  const candidates = await deps.db
    .select({ code: schema.expenses.code, invoiceNumber: schema.expenses.invoiceNumber, amount: schema.expenses.amount, vendorId: schema.expenses.vendorId, employeeId: schema.expenses.employeeId, incurredOn: schema.expenses.incurredOn, createdAt: schema.expenses.createdAt })
    .from(schema.expenses)
    .where(and(
      ne(schema.expenses.uuid, row.uuid),
      eq(schema.expenses.isRecurring, false),
      inArray(schema.expenses.state, ["DRAFT", "SUBMITTED", "APPROVED", "PAID"]),
      or(...looksLike),
    ));

  for (const c of candidates) {
    // An invoice number is an identifier, so a match on it is a duplicate whatever else differs.
    if (invoice && (c.invoiceNumber ?? "").trim().toLowerCase() === invoice.toLowerCase()) return c.code;
  }
  if (!at) return null;
  for (const c of candidates) {
    if (Math.abs(c.amount - row.amount) > 0.005) continue;
    // Same payee: the vendor where there is one, else the person who fronted it.
    const samePayee = row.vendorId ? c.vendorId === row.vendorId : (!c.vendorId && c.employeeId === row.employeeId);
    if (!samePayee) continue;
    const cAt = c.incurredOn ?? c.createdAt;
    if (!cAt) continue;
    if (Math.abs(cAt.getTime() - at.getTime()) <= DUPLICATE_DAYS * 86_400_000) return c.code;
  }
  return null;
}

/**
 * Would approving this claim put its budget over?
 *
 * Null when no cap covers it, which is a third answer rather than a yes or a no - see `autoApproveBlocks`,
 * which treats it as satisfied. The cap chosen is the most specific one that matches, the same precedence the
 * expenses page uses when it warns a submitter before they file.
 */
async function withinBudget(deps: Deps, row: typeof schema.expenses.$inferSelect): Promise<boolean | null> {
  const at = row.incurredOn ?? row.createdAt;
  if (!at) return null;
  const caps = visibleByDelete(await deps.db.select().from(schema.expenseBudgets), false)
    .filter((b) => (b.categoryId ? b.categoryId === row.categoryId : true))
    .filter((b) => (b.departmentId ? b.departmentId === row.departmentId : true))
    .filter((b) => { try { return b.periodKey === periodKeyFor(b.periodType as PeriodType, at); } catch { return false; } })
    // Most specific first: a (category + cost centre) cap beats a category cap beats an org-wide one.
    .sort((a, b) => (Number(!!b.categoryId) + Number(!!b.departmentId)) - (Number(!!a.categoryId) + Number(!!a.departmentId)));
  const cap = caps[0];
  if (!cap || !(cap.amount > 0)) return null;
  const { spent } = await computeBudgetSpend(deps, cap);
  // `spent` already counts this claim once it is SUBMITTED, so it is not added again.
  return spent <= cap.amount;
}

/** Everything the straight-through lane needs to know about this claim, gathered only when a claim is actually
 *  eligible on amount - these are several reads and none of them is worth paying for on a claim that is going
 *  to a human anyway. */
export async function autoApproveDecision(deps: Deps, row: typeof schema.expenses.$inferSelect, required: readonly AutoApproveGuard[]): Promise<AutoApproveBlock[]> {
  if (!required.length) return [];
  const needs = new Set(required);
  const [inBudget, duplicateOf, hasReceipt] = await Promise.all([
    needs.has("in_budget") ? withinBudget(deps, row) : Promise.resolve(null),
    needs.has("not_duplicate") ? duplicateClaimOf(deps, row) : Promise.resolve(null),
    needs.has("has_receipt") ? attachedObjectIds(deps, "expenses", "invoice", [row.uuid]).then((s) => s.has(row.uuid)) : Promise.resolve(true),
  ]);
  return autoApproveBlocks(required, { inBudget, duplicateOf, knownVendor: !!row.vendorId, hasReceipt });
}

// ---- Approver triage -------------------------------------------------------------------------------------

/** One reason a claim in the approval queue is worth a second look. `kind` is for a client that wants to
 *  group or filter; `message` is the sentence, written for the approver rather than about the submitter. */
export type ClaimSignal = { kind: "duplicate" | "over_budget" | "missing_receipt" | "policy"; message: string };

/**
 * Why these claims are worth reading, for the approver looking at a queue of them.
 *
 * The queue says "14 waiting". What an approver needs is which three of the fourteen are not routine, and the
 * app already knows: the policy rule from item 14, the budget forecast from item 15, the duplicate match from
 * item 17. None of it was reaching the surface where a decision gets made.
 *
 * SERVER-SIDE AND BATCHED, which is the whole difficulty and the reason this is not a page-local computation
 * like the one the SPA does today. Every signal is a statement about the whole collection - a duplicate filed
 * by somebody else, a budget the page has not loaded - and a client that only holds a page can only answer
 * from that page. Four reads for any number of rows: the duplicate candidates for every row at once, the
 * receipt-demanding categories, the attachments, and the budgets.
 *
 * Only SUBMITTED rows are examined. A draft is somebody still typing and an approved claim's decision is
 * already made; asking these questions of a ledger page would be several reads to answer a question nobody on
 * that page is asking.
 */
export async function expenseTriageFor(deps: Deps, rows: readonly (typeof schema.expenses.$inferSelect)[]): Promise<Map<string, ClaimSignal[]>> {
  const out = new Map<string, ClaimSignal[]>();
  const queue = rows.filter((r) => r.state === "SUBMITTED" && !r.isRecurring);
  if (!queue.length) return out;
  const add = (id: string, s: ClaimSignal) => {
    const held = out.get(id);
    if (held) held.push(s);
    else out.set(id, [s]);
  };

  // ONE read of duplicate candidates for the whole page: the per-row predicate from `duplicateClaimOf`, OR-ed
  // across every row. A query per row would be a page of a hundred claims costing a hundred subrequests,
  // which is the shape this module refuses everywhere else.
  const predicates: (SQL | undefined)[] = [];
  for (const r of queue) {
    const invoice = (r.invoiceNumber ?? "").trim();
    if (invoice) predicates.push(sql`lower(${schema.expenses.invoiceNumber}) = ${invoice.toLowerCase()}`);
    const at = r.incurredOn ?? r.createdAt;
    if (!at) continue;
    predicates.push(and(
      gte(schema.expenses.amount, r.amount - 0.005),
      lte(schema.expenses.amount, r.amount + 0.005),
      or(
        and(gte(schema.expenses.incurredOn, new Date(at.getTime() - DUPLICATE_DAYS * 86_400_000)), lte(schema.expenses.incurredOn, new Date(at.getTime() + DUPLICATE_DAYS * 86_400_000))),
        and(isNull(schema.expenses.incurredOn), gte(schema.expenses.createdAt, new Date(at.getTime() - DUPLICATE_DAYS * 86_400_000)), lte(schema.expenses.createdAt, new Date(at.getTime() + DUPLICATE_DAYS * 86_400_000))),
      ),
    ));
  }
  const queueIds = new Set(queue.map((r) => r.uuid));
  const candidates = predicates.length
    ? await deps.db
        .select({ uuid: schema.expenses.uuid, code: schema.expenses.code, invoiceNumber: schema.expenses.invoiceNumber, amount: schema.expenses.amount, vendorId: schema.expenses.vendorId, employeeId: schema.expenses.employeeId, incurredOn: schema.expenses.incurredOn, createdAt: schema.expenses.createdAt })
        .from(schema.expenses)
        .where(and(
          eq(schema.expenses.isRecurring, false),
          inArray(schema.expenses.state, ["DRAFT", "SUBMITTED", "APPROVED", "PAID"]),
          or(...predicates),
        ))
    : [];

  for (const r of queue) {
    const invoice = (r.invoiceNumber ?? "").trim();
    const at = r.incurredOn ?? r.createdAt;
    const hit = candidates.find((c) => {
      if (c.uuid === r.uuid) return false;
      if (invoice && (c.invoiceNumber ?? "").trim().toLowerCase() === invoice.toLowerCase()) return true;
      if (!at) return false;
      if (Math.abs(c.amount - r.amount) > 0.005) return false;
      const samePayee = r.vendorId ? c.vendorId === r.vendorId : (!c.vendorId && c.employeeId === r.employeeId);
      if (!samePayee) return false;
      const cAt = c.incurredOn ?? c.createdAt;
      return !!cAt && Math.abs(cAt.getTime() - at.getTime()) <= DUPLICATE_DAYS * 86_400_000;
    });
    // A claim that matches ANOTHER ROW OF THIS SAME QUEUE is reported once, on the later of the two: telling
    // an approver that each of two rows is a copy of the other says the same thing twice and names neither as
    // the original.
    if (!hit) continue;
    // Codes are allocated in order, so the lower one is the earlier filing. Compared as strings with a null
    // falling back to the uuid, which is stable rather than meaningful - it only has to pick the SAME one of
    // the pair every time, so the message does not alternate between two rows on successive reads.
    const mine = r.code ?? r.uuid;
    const theirs = hit.code ?? hit.uuid;
    if (queueIds.has(hit.uuid) && theirs < mine) continue;
    add(r.uuid, { kind: "duplicate", message: `looks like ${theirs}` });
  }

  // Filed without the invoice its category demands. Checked again here rather than trusted from the submit
  // gate, because a category can be made receipt-required AFTER claims were filed against it.
  const needReceipt = new Set(
    (await deps.db
      .select({ uuid: schema.expenseCategories.uuid })
      .from(schema.expenseCategories)
      .where(and(eq(schema.expenseCategories.requiresReceipt, true), isNull(schema.expenseCategories.rateKind)))
    ).map((c) => c.uuid),
  );
  const couldNeed = queue.filter((r) => r.categoryId && needReceipt.has(r.categoryId));
  if (couldNeed.length) {
    const attached = await attachedObjectIds(deps, "expenses", "invoice", couldNeed.map((r) => r.uuid));
    for (const r of couldNeed) if (!attached.has(r.uuid)) add(r.uuid, { kind: "missing_receipt", message: "no receipt, and its category needs one" });
  }

  // The cap this claim charges, and whether approving it takes that cap past its own line. `spent` already
  // counts a SUBMITTED claim as pending rather than spend, so the comparison adds this claim's amount to what
  // is already committed rather than double-counting it.
  const caps = visibleByDelete(await deps.db.select().from(schema.expenseBudgets), false);
  if (caps.length) {
    const spends = await computeBudgetSpendMany(deps, caps);
    for (const r of queue) {
      const at = r.incurredOn ?? r.createdAt;
      if (!at) continue;
      const cap = caps
        .filter((b) => (b.categoryId ? b.categoryId === r.categoryId : true))
        .filter((b) => (b.departmentId ? b.departmentId === r.departmentId : true))
        .filter((b) => { try { return b.periodKey === periodKeyFor(b.periodType as PeriodType, at); } catch { return false; } })
        .sort((a, b) => (Number(!!b.categoryId) + Number(!!b.departmentId)) - (Number(!!a.categoryId) + Number(!!a.departmentId)))[0];
      if (!cap || !(cap.amount > 0)) continue;
      const spent = spends.get(cap.uuid)?.spent ?? 0;
      if (round2(spent + r.amount) > cap.amount) add(r.uuid, { kind: "over_budget", message: "approving it puts its budget over" });
    }
  }
  return out;
}
