// Operational-expense workflow (custom methods :submit/:approve/:reject/:cancel/:pay; PAID is set by :pay for
// vendor expenses, or mirrored from the linked reimbursement for employee-fronted ones - never by hand).
// Owner-embedded code on the submitter (like reimbursements), so a manager's dept breadth sees their reports'
// expenses and finance (all breadth) sees everything. `departmentId` is cost-centre attribution, not the scope key.
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { eq, and, lte, lt, gte, ne } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { round2 } from "../domain/money";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { createApprovedReimbursementForExpense } from "./reimbursements";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { getSettingValue } from "./settings";
import { advanceRecurrence, type RecurrenceRule } from "../domain/expenses";

export type ExpenseInput = {
  employee?: string | null;
  vendor?: string | null;
  category?: string | null;
  department?: string | null;
  amount?: number;
  tax_amount?: number | null;
  incurred_on?: string | null; // YYYY-MM-DD
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

// Resolve an optional "<collection>/<id>" ref, validating the target exists and is not soft-deleted/disabled.
async function resolveRef(deps: Deps, table: any, path: string | null | undefined, label: string): Promise<string | null> {
  if (!path) return null;
  const id = idFromPath(path)!;
  const row = (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime || row.disabled) throw invalidArgument(`that ${label} is unavailable`);
  return id;
}

export async function createExpense(deps: Deps, actor: AppUser, input: ExpenseInput) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw invalidArgument("amount must be a positive number");
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
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
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.expenses)
    .values({
      code: await allocOwnedCode(deps, schema.expenses, schema.expenses.employeeId, employeeId),
      employeeId,
      vendorId: await resolveRef(deps, schema.vendors, input.vendor, "vendor"),
      categoryId: await resolveRef(deps, schema.expenseCategories, input.category, "expense category"),
      departmentId: await resolveRef(deps, schema.departments, input.department, "department"),
      amount: round2(amount),
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
      while (next && next < today) next = advanceRecurrence(next, row.recurrenceRule as RecurrenceRule);
      if (next) set.nextOccurrenceOn = next;
    }
  }
  const updated = (await deps.db.update(schema.expenses).set(set).where(eq(schema.expenses.uuid, id)).returning())[0]!;
  await audit(deps, actor, "expense.update", "expenses", id, diffMeta(row, updated, set, "expenses"), updated);
  return updated;
}

// ---- Workflow transitions (all guarded exactly-once flips) ----------------------------------------------

// DRAFT -> SUBMITTED. A recurring template is a seed, never itself submitted. Auto-approves when the amount is
// at or below the configured threshold.
export async function submitExpense(deps: Deps, actor: AppUser, id: string) {
  const row = await getExpense(deps, actor, id);
  if (row.isRecurring) throw failedPrecondition("a recurring template is not submitted directly; the schedule generates expenses");
  if (row.state !== "DRAFT") throw failedPrecondition("only draft expenses can be submitted");
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "SUBMITTED", updatedAt: new Date() })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "DRAFT")))
    .returning();
  if (!updated) throw failedPrecondition("only draft expenses can be submitted");
  await audit(deps, actor, "expense.submit", "expenses", id, stateMeta(row.state, "SUBMITTED", { employee: `employees/` }), updated);
  await emitEvent(deps, actor, "expense.submitted", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, categoryId: row.categoryId, vendorId: row.vendorId, departmentId: row.departmentId } });
  await notifyManager(deps, row.employeeId, { type: "expense.requested", noun: "expense" });
  // Auto-approve small expenses when configured (threshold > 0).
  const threshold = (await expenseSettings(deps)).auto_approve_threshold ?? 0;
  if (threshold > 0 && updated.amount <= threshold) return approveExpense(deps, actor, id);
  return updated;
}

// SUBMITTED -> APPROVED. Employee-fronted expenses spawn an APPROVED reimbursement so payroll pays the employee.
export async function approveExpense(deps: Deps, actor: AppUser, id: string) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "SUBMITTED") throw failedPrecondition("only submitted expenses can be approved");
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
  await audit(deps, actor, "expense.approve", "expenses", id, stateMeta(row.state, "APPROVED", { employee: `employees/` }), updated);
  await notify(deps, { recipient: row.employeeId, type: "expense.approved", title: "Expense approved", body: "Your expense was approved.", link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.approved", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, reimbursable: row.reimbursable } });
  return (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, id)).limit(1))[0]!;
}

// A rejection carries its reason: the submitter is told WHY (in the notification and on the record), so the
// next attempt can fix the thing that was wrong instead of guessing.
export async function rejectExpense(deps: Deps, actor: AppUser, id: string, note?: string | null) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "SUBMITTED") throw failedPrecondition("only submitted expenses can be rejected");
  const reason = (note ?? "").trim() || null;
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "REJECTED", decidedBy: actor.uuid, decisionNote: reason, updatedAt: new Date() })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "SUBMITTED")))
    .returning();
  if (!updated) throw failedPrecondition("only submitted expenses can be rejected");
  await audit(deps, actor, "expense.reject", "expenses", id, stateMeta(row.state, "REJECTED", { employee: `employees/`, ...(reason ? { reason } : {}) }), updated);
  await notify(deps, { recipient: row.employeeId, type: "expense.rejected", title: "Expense rejected", body: reason ? `Your expense was rejected: ${reason}` : "Your expense was rejected.", link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.rejected", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, note: reason } });
  return updated;
}

export async function cancelExpense(deps: Deps, actor: AppUser, id: string) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "DRAFT" && row.state !== "SUBMITTED") throw failedPrecondition("only draft or submitted expenses can be cancelled");
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, row.state)))
    .returning();
  if (!updated) throw failedPrecondition("only draft or submitted expenses can be cancelled");
  await audit(deps, actor, "expense.cancel", "expenses", id, stateMeta(row.state, "CANCELLED", { employee: `employees/` }), updated);
  return updated;
}

// APPROVED -> PAID (out-of-band vendor payment). Reimbursable expenses are paid via payroll (their linked
// reimbursement), so :pay is refused for them.
export async function payExpense(deps: Deps, actor: AppUser, id: string, input: ExpensePayInput = {}) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "APPROVED") throw failedPrecondition("only approved expenses can be marked paid");
  if (row.reimbursable) throw failedPrecondition("a reimbursable expense is paid to the employee via payroll, not marked paid here");
  const now = new Date();
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "PAID", paidBy: actor.uuid, paidAt: now, paymentMethod: input.payment_method ?? row.paymentMethod, paymentRef: input.payment_ref ?? row.paymentRef, updatedAt: now })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "APPROVED")))
    .returning();
  if (!updated) throw failedPrecondition("only approved expenses can be marked paid");
  await audit(deps, actor, "expense.pay", "expenses", id, stateMeta(row.state, "PAID", { employee: `employees/` }), updated);
  await notify(deps, { recipient: row.employeeId, type: "expense.paid", title: "Expense paid", body: "An approved expense was paid.", link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.paid", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, paymentMethod: updated.paymentMethod } });
  return updated;
}

// ---- Recurring generation (daily cron) ------------------------------------------------------------------
// For each due recurring template (isRecurring, nextOccurrenceOn <= now), clone one concrete expense and
// advance the template. Claim-first (advance the template's nextOccurrenceOn guarded on its current value)
// so a concurrent tick / retry can't double-generate; the clone is inserted only after the claim succeeds.
// Best-effort per template (a failure on one never aborts the batch). Returns the count generated.
export async function generateRecurringExpenses(deps: Deps, now: Date = new Date()): Promise<number> {
  const defaultState = ((await expenseSettings(deps)).recurring_default_state === "DRAFT") ? "DRAFT" : "SUBMITTED";
  // A stopped or paused schedule must stop: a CANCELLED template is done for good (:cancel is how the UI ends
  // a schedule) and a `paused` one is on hold, so neither generates. Without this a template kept filing
  // expenses forever, whatever the UI said.
  const templates = await deps.db
    .select()
    .from(schema.expenses)
    .where(and(
      eq(schema.expenses.isRecurring, true),
      lte(schema.expenses.nextOccurrenceOn, now),
      ne(schema.expenses.state, "CANCELLED"),
      eq(schema.expenses.paused, false),
    ));
  let generated = 0;
  for (const t of templates) {
    if (!t.nextOccurrenceOn || !t.recurrenceRule) continue;
    const occurrenceOn = new Date(t.nextOccurrenceOn);
    const advanced = advanceRecurrence(occurrenceOn, t.recurrenceRule as RecurrenceRule);
    // Claim this occurrence: advance the template guarded on the unchanged nextOccurrenceOn (0 rows => taken).
    const claimed = await deps.db
      .update(schema.expenses)
      .set({ nextOccurrenceOn: advanced, lastGeneratedOn: now, updatedAt: now })
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
    } catch {
      // clone failed after the claim advanced the template: skip (next tick handles the following occurrence).
    }
  }
  return generated;
}
