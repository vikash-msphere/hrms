import { eq, and, isNull, type SQL } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { notify } from "./notifications";
import { checkEtag, updateAtVersion } from "./versionGuard";

type Status = typeof schema.taxDeclarations.$inferSelect.status;
export type TaxDeclarationInput = {
  employee?: string | null;
  financial_year?: string;
  section?: string;
  label?: string | null;
  declared_amount?: number;
  note?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

export async function listTaxDeclarations(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, financialYear?: string, status?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.taxDeclarations.code, schema.taxDeclarations.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.taxDeclarations.employeeId, empId));
  if (financialYear) conds.push(eq(schema.taxDeclarations.financialYear, financialYear));
  if (status) conds.push(eq(schema.taxDeclarations.status, status as Status));
  if (!showDeleted) conds.push(isNull(schema.taxDeclarations.deleteTime));
  // Paged in SQL (services/keysetPage.ts) on `createdAt` (the cursor's key). It used to read every matching
  // declaration into the isolate to slice one page - these accumulate a set per employee per financial year
  // and are never pruned, and D1 bills rows read, so an HR-scope list with no filters paid for every year the
  // org has ever run. The soft-delete filter rides in the WHERE for the same reason.
  //
  // Grouping by tax SECTION is how the page is READ, not how it is paged: sorting the set by section while
  // seeking on `createdAt` would be two different orders, and a declaration could disappear between pages.
  const page = await keysetPage<typeof schema.taxDeclarations.$inferSelect>(deps, schema.taxDeclarations, "tax-declarations", and(...(conds.filter(Boolean) as SQL[])), { dir: "desc", max: maxPageSize, pageToken });
  return {
    ...page,
    items: page.items.sort((a, b) => (a.section ?? "").localeCompare(b.section ?? "") || +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid)),
  };
}

export async function getTaxDeclaration(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.taxDeclarations).where(eq(schema.taxDeclarations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("declaration not found");
  return row;
}

export async function createTaxDeclaration(deps: Deps, actor: AppUser, input: TaxDeclarationInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  if (!input.financial_year?.trim()) throw invalidArgument("financial_year is required");
  if (!input.section?.trim()) throw invalidArgument("section is required");
  if (input.declared_amount != null && input.declared_amount < 0) throw invalidArgument("declared_amount must be >= 0");
  const row = (await deps.db.insert(schema.taxDeclarations).values({
    code: await allocOwnedCode(deps, schema.taxDeclarations, schema.taxDeclarations.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    financialYear: input.financial_year.trim(),
    section: input.section.trim(),
    label: input.label?.trim() || null,
    declaredAmount: input.declared_amount ?? 0,
    note: input.note?.trim() || null,
  }).returning())[0]!;
  await audit(deps, actor, "tax-declaration.create", "tax-declarations", row.uuid, createdMeta(row, "tax-declarations"), row);
  return row;
}

// Editable by the employee while DECLARED or REJECTED (not after it's verified). Re-editing a rejected item
// returns it to DECLARED so it's re-reviewed.
export async function updateTaxDeclaration(deps: Deps, actor: AppUser, id: string, patch: TaxDeclarationInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.taxDeclarations).where(eq(schema.taxDeclarations.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("declaration not found");
  if (row.status === "VERIFIED") throw failedPrecondition("a verified declaration can't be edited");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.taxDeclarations> = { updatedAt: new Date(), status: "DECLARED" };
  const has = (k: keyof TaxDeclarationInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("financial_year")) { if (!patch.financial_year?.trim()) throw invalidArgument("financial_year is required"); set.financialYear = patch.financial_year.trim(); }
  if (has("section")) { if (!patch.section?.trim()) throw invalidArgument("section is required"); set.section = patch.section.trim(); }
  if (has("label")) set.label = patch.label?.trim() || null;
  if (has("declared_amount")) { if ((patch.declared_amount ?? 0) < 0) throw invalidArgument("declared_amount must be >= 0"); set.declaredAmount = patch.declared_amount ?? 0; }
  if (has("note")) set.note = patch.note?.trim() || null;
  const updated = await updateAtVersion(deps, schema.taxDeclarations, "declaration", row, set);
  await audit(deps, actor, "tax-declaration.update", "tax-declarations", id, diffMeta(row, updated, set, "tax-declarations"), updated);
  return updated;
}

// Payroll/HR verify (accept an amount) or reject.
export async function verifyTaxDeclaration(deps: Deps, actor: AppUser, id: string, verifiedAmount?: number | null) {
  const row = (await deps.db.select().from(schema.taxDeclarations).where(eq(schema.taxDeclarations.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("declaration not found");
  if (verifiedAmount != null && verifiedAmount < 0) throw invalidArgument("verified_amount must be >= 0");
  const updated = (await deps.db.update(schema.taxDeclarations)
    .set({ status: "VERIFIED", verifiedAmount: verifiedAmount ?? row.declaredAmount, decidedBy: actor.uuid, updatedAt: new Date() })
    .where(eq(schema.taxDeclarations.uuid, id)).returning())[0]!;
  await audit(deps, actor, "tax-declaration.verify", "tax-declarations", id, stateMeta(row.status, "VERIFIED", { employee: `employees/${row.employeeId}`, diff: { status: { from: row.status, to: "VERIFIED" }, verifiedAmount: { from: row.verifiedAmount, to: updated.verifiedAmount } } }), updated);
  // Notify only on an actual status change so a re-verify (amount correction) doesn't re-spam the employee.
  if (row.status !== "VERIFIED")
    await notify(deps, { recipient: row.employeeId, type: "tax.verified", title: "Tax declaration verified", body: "Your investment/tax declaration was verified.", link: "tax-declarations", subject: `tax-declarations/${id}`, actorId: actor.employeeId });
  return updated;
}
export async function rejectTaxDeclaration(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.taxDeclarations).where(eq(schema.taxDeclarations.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("declaration not found");
  const updated = (await deps.db.update(schema.taxDeclarations).set({ status: "REJECTED", verifiedAmount: null, decidedBy: actor.uuid, updatedAt: new Date() }).where(eq(schema.taxDeclarations.uuid, id)).returning())[0]!;
  await audit(deps, actor, "tax-declaration.reject", "tax-declarations", id, stateMeta(row.status, "REJECTED", { employee: `employees/${row.employeeId}` }), updated);
  if (row.status !== "REJECTED")
    await notify(deps, { recipient: row.employeeId, type: "tax.rejected", title: "Tax declaration rejected", body: "Your investment/tax declaration was rejected - please review and resubmit.", link: "tax-declarations", subject: `tax-declarations/${id}`, actorId: actor.employeeId });
  return updated;
}

