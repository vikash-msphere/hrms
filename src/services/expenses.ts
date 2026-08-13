// Operational-expense workflow (custom methods :submit/:approve/:reject/:cancel/:pay; PAID is set by :pay for
// vendor expenses, or mirrored from the linked reimbursement for employee-fronted ones - never by hand).
// Owner-embedded code on the submitter (like reimbursements), so a manager's dept breadth sees their reports'
// expenses and finance (all breadth) sees everything. `departmentId` is cost-centre attribution, not the scope key.
import { allocOwnedCode } from "./codeAlloc";
import { eq, and, lte } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
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

export async function listExpenses(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, departmentId?: string, q?: string) {
  const conds = [applyScope(scope, schema.expenses.code, schema.expenses.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "expenses", q, schema.expenses.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.expenses.state, stateFilter as typeof schema.expenses.$inferSelect.state));
  if (departmentId) conds.push(eq(schema.expenses.departmentId, departmentId));
  return keysetPage(deps, schema.expenses, "expenses", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
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

  const row = (await deps.db
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
      description: input.description ?? null,
      invoiceNumber: input.invoice_number ?? null,
      paymentMethod: input.payment_method ?? null,
      reimbursable: !!input.reimbursable,
      state: "DRAFT",
      isRecurring: recurring,
      recurrenceRule: recurring ? input.recurrence_rule : null,
      nextOccurrenceOn,
    })
    .returning())[0]!;
  await audit(deps, actor, "expense.create", "expenses", row.uuid, undefined, row);
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
  if (has("description")) set.description = patch.description ?? null;
  if (has("invoice_number")) set.invoiceNumber = patch.invoice_number ?? null;
  if (has("payment_method")) set.paymentMethod = patch.payment_method ?? null;
  if (has("reimbursable")) set.reimbursable = !!patch.reimbursable;
  if (has("next_occurrence_on") && row.isRecurring) {
    const d = dayDate(patch.next_occurrence_on);
    if (!d) throw invalidArgument("next_occurrence_on cannot be cleared on a recurring expense");
    set.nextOccurrenceOn = d;
  }
  const updated = (await deps.db.update(schema.expenses).set(set).where(eq(schema.expenses.uuid, id)).returning())[0]!;
  await audit(deps, actor, "expense.update", "expenses", id, diffMeta(row, updated, set), updated);
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
  await audit(deps, actor, "expense.submit", "expenses", id);
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
  await audit(deps, actor, "expense.approve", "expenses", id);
  await notify(deps, { recipient: row.employeeId, type: "expense.approved", title: "Expense approved", body: "Your expense was approved.", link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.approved", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount, reimbursable: row.reimbursable } });
  return (await deps.db.select().from(schema.expenses).where(eq(schema.expenses.uuid, id)).limit(1))[0]!;
}

export async function rejectExpense(deps: Deps, actor: AppUser, id: string) {
  const row = await getExpense(deps, actor, id);
  if (row.state !== "SUBMITTED") throw failedPrecondition("only submitted expenses can be rejected");
  const [updated] = await deps.db
    .update(schema.expenses)
    .set({ state: "REJECTED", decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.expenses.uuid, id), eq(schema.expenses.state, "SUBMITTED")))
    .returning();
  if (!updated) throw failedPrecondition("only submitted expenses can be rejected");
  await audit(deps, actor, "expense.reject", "expenses", id);
  await notify(deps, { recipient: row.employeeId, type: "expense.rejected", title: "Expense rejected", body: "Your expense was rejected.", link: "expenses", subject: `expenses/${id}`, actorId: actor.employeeId });
  await emitEvent(deps, actor, "expense.rejected", { subject: `expenses/${id}`, employeeId: row.employeeId, payload: { amount: row.amount } });
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
  await audit(deps, actor, "expense.cancel", "expenses", id);
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
  await audit(deps, actor, "expense.pay", "expenses", id);
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
  const templates = await deps.db
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.isRecurring, true), lte(schema.expenses.nextOccurrenceOn, now)));
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
      const clone = (await deps.db
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
        .returning())[0]!;
      await audit(deps, "system", "expense.generate", "expenses", clone.uuid);
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
