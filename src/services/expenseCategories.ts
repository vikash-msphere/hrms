// Expense categories: org-wide reference (mirrors reimbursement-categories). Configurable in Settings; expenses
// reference one. `requires_receipt` makes an invoice attachment mandatory; `gl_code` is the accounting code.
import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { assertNotLocked } from "./lifecycle";

export type ExpenseCategoryInput = { display_name?: string; requires_receipt?: boolean; gl_code?: string | null };

export async function listExpenseCategories(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.expenseCategories), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getExpenseCategory(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.uuid, id)).limit(1))[0];
  if (!row) throw notFound("expense category not found");
  return row;
}

export async function createExpenseCategory(deps: Deps, actor: AppUser, input: ExpenseCategoryInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  const row = (await deps.db
    .insert(schema.expenseCategories)
    .values({
      code: await allocFlatCode(deps, schema.expenseCategories),
      ...(id ? { id } : {}),
      name: input.display_name,
      requiresReceipt: input.requires_receipt ?? false,
      glCode: input.gl_code ?? null,
    })
    .returning())[0]!;
  await audit(deps, actor, "expense_category.create", "expense-categories", row.uuid, undefined, row);
  return row;
}

export async function updateExpenseCategory(deps: Deps, actor: AppUser, id: string, patch: ExpenseCategoryInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.uuid, id)).limit(1))[0];
  if (!row) throw notFound("expense category not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof ExpenseCategoryInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("requires_receipt")) set.requiresReceipt = patch.requires_receipt;
  if (has("gl_code")) set.glCode = patch.gl_code ?? null;
  const updated = (await deps.db.update(schema.expenseCategories).set(set).where(eq(schema.expenseCategories.uuid, id)).returning())[0]!;
  await audit(deps, actor, "expense_category.update", "expense-categories", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteExpenseCategory(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.expenseCategories, "expense_category", "expense-categories", id, ifMatch);
}
export async function restoreExpenseCategory(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.expenseCategories, "expense_category", "expense-categories", id);
}
export async function purgeExpenseCategory(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.expenseCategories, "expense_category", "expense-categories", id, ifMatch);
}
