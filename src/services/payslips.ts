import { and, eq } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound } from "../lib/errors";
import { keysetPage } from "./keysetPage";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

export async function listPayslips(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns. The
  // optional `?employee=` narrows WITHIN that visibility - it is a filter, never a widening: a caller scoped to
  // their own slips who asks for somebody else's gets an empty page rather than a 403, the same way every other
  // per-employee list on a profile behaves (bonuses, loans, compensation). `payslip_emp_idx` covers it.
  const conds = [applyScope(scope, schema.payslips.code, schema.payslips.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.payslips.employeeId, empId));
  return keysetPage(deps, schema.payslips, "payslips", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
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

/** What the slip is called, off the period it was issued for. One derivation, because the two verbs below are
 *  the SAME bytes and a copy saved from one should not be named differently from a copy saved from the other. */
const payslipFileName = (row: { createdAt?: Date | number | null }, id: string) =>
  `payslip-${row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : id}.pdf`;

// `download` is the verb whose whole purpose is KEEPING a copy, and it was the one that named nothing: it
// returned bytes alone, so routes/payslips.ts answered `application/octet-stream` with no
// `Content-Disposition` at all, and a caller outside the SPA saved an extensionless file named after the
// request URL. `preview` - which is not saving anything - carried the name the whole time.
export async function downloadPayslip(deps: Deps, _actor: AppUser, id: string) {
  const { row, bytes } = await payslipBytes(deps, id);
  return { bytes, fileName: payslipFileName(row, id) };
}

// `payslips/<id>:preview` - the same bytes, served for INLINE viewing. A separate custom method (not a flag on
// download) so "may look at it in the app" and "may keep a copy" are grantable independently, each with its own
// self / my-dept / org-wide scope.
export async function previewPayslip(deps: Deps, _actor: AppUser, id: string) {
  const { row, bytes } = await payslipBytes(deps, id);
  return { bytes, fileName: payslipFileName(row, id) };
}
