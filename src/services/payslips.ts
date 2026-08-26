import { eq } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound } from "../lib/errors";
import { keysetPage } from "./keysetPage";

export async function listPayslips(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  const where = applyScope(scope, schema.payslips.code, schema.payslips.employeeId);
  return keysetPage(deps, schema.payslips, "payslips", where, { max: maxPageSize, pageToken });
}

// Read the stored PDF for a payslip. Access (own vs hr/payroll/super) is enforced by the middleware on
// payslips/<code> plus the requested verb, so the two lanes below differ only in what the caller may DO with
// the bytes: `download` saves a copy, `preview` renders it in-app. Both scope the same way (self/dept/all).
async function payslipBytes(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.payslips).where(eq(schema.payslips.uuid, id)).limit(1))[0];
  if (!row) throw notFound("payslip not found");
  const bytes = await deps.docs.get(row.r2Key);
  if (!bytes) throw notFound("payslip file not found in storage");
  return { row, bytes };
}

export async function downloadPayslip(deps: Deps, _actor: AppUser, id: string) {
  const { bytes } = await payslipBytes(deps, id);
  return { bytes };
}

// `payslips/<id>:preview` - the same bytes, served for INLINE viewing. A separate custom method (not a flag on
// download) so "may look at it in the app" and "may keep a copy" are grantable independently, each with its own
// self / my-dept / org-wide scope.
export async function previewPayslip(deps: Deps, _actor: AppUser, id: string) {
  const { row, bytes } = await payslipBytes(deps, id);
  const day = row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : id;
  return { bytes, fileName: `payslip-${day}.pdf` };
}
