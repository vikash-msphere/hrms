import { and, eq, isNull, lt, desc } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { explainPay, type PayExplanation } from "../domain/payrollVariance";
import type { Line } from "../domain/payroll";

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
async function payslipBytes(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.payslips).where(eq(schema.payslips.uuid, id)).limit(1))[0];
  if (!row) throw notFound("payslip not found");
  const bytes = await deps.docs.get(row.r2Key);
  if (!bytes) throw notFound("payslip file not found in storage");
  await stampFirstOpen(deps, actor, row);
  return { row, bytes };
}

/**
 * Record that the employee has seen their own payslip - once, the first time, and only for themselves.
 *
 * WHAT THIS IS FOR. Publishing a run writes payslips and the app then has no idea whether anybody received
 * one. "Eleven people have not opened this month's slip" is a delivery check and, where an employer is obliged
 * to issue a payslip, the only evidence the app holds that it did.
 *
 * WHAT IT IS NOT FOR, and the reason it is shaped the way it is. `domain/auditAccess.ts` deliberately writes no
 * audit row when somebody reads their OWN sensitive data - reading your own pay is expected, and logging it
 * would turn the trail into a record of employees' private behaviour. That principle is intact here: this is
 * ONE timestamp, set ONCE, and never updated afterwards, so it can answer "was it delivered" and cannot answer
 * "how often do they check" or "when were they last looking". A manager or HR opening somebody else's slip
 * changes nothing here at all - that read is somebody's accountability event and the audit trail already has
 * it.
 *
 * Guarded on the column still being null, so two tabs opening at once cannot move a stamp that is supposed to
 * mean "the first time". Best-effort: a stamp that fails must never be the reason an employee cannot read
 * their own payslip.
 */
async function stampFirstOpen(deps: Deps, actor: AppUser, row: typeof schema.payslips.$inferSelect): Promise<void> {
  if (row.firstOpenedAt) return;
  if (!actor.employeeId || actor.employeeId !== row.employeeId) return;
  try {
    await deps.db
      .update(schema.payslips)
      .set({ firstOpenedAt: new Date() })
      .where(and(eq(schema.payslips.uuid, row.uuid), isNull(schema.payslips.firstOpenedAt)));
  } catch (err) {
    console.error("[payslips] first-open stamp failed (non-fatal)", err);
  }
}

/** How many of a run's payslips the people they belong to have not opened yet. The delivery half of publishing
 *  a run, asked at the run rather than per slip because that is where somebody is deciding whether the month
 *  is finished. */
export async function unopenedPayslipCount(deps: Deps, runId: string): Promise<number> {
  const rows = await deps.db
    .select({ uuid: schema.payslips.uuid })
    .from(schema.payslips)
    .where(and(eq(schema.payslips.runId, runId), isNull(schema.payslips.firstOpenedAt)));
  return rows.length;
}

/**
 * Why this payslip differs from the one before it.
 *
 * THE MOST COMMON PAYROLL QUESTION, and the app already holds both answers - it has simply never subtracted
 * them. Deterministic on purpose: the value is the JOIN, not prose about it. Somebody who can see that their
 * net fell by exactly the amount of a new loan line has their answer; somebody who cannot raises a ticket.
 *
 * Compared against the employee's own PREVIOUS payslip by issue order, which is the comparison they mean when
 * they say "last month" - not the previous pay period, which may have no slip for a joiner or a leaver.
 * Returns null when there is no earlier slip: a first payslip has nothing to be different from, and inventing
 * a comparison against zero would say their pay went up by all of it.
 */
export async function explainPayslip(deps: Deps, id: string): Promise<PayExplanation & { compared_to: string } | null> {
  const slip = (await deps.db.select().from(schema.payslips).where(eq(schema.payslips.uuid, id)).limit(1))[0];
  if (!slip) throw notFound("payslip not found");

  // The one immediately before it for the SAME employee. Ordered by issue time, which is the order they were
  // received in and therefore the order the question is asked about.
  const prior = (await deps.db
    .select({ uuid: schema.payslips.uuid, runItemId: schema.payslips.runItemId, createdAt: schema.payslips.createdAt })
    .from(schema.payslips)
    .where(and(eq(schema.payslips.employeeId, slip.employeeId), lt(schema.payslips.createdAt, slip.createdAt)))
    .orderBy(desc(schema.payslips.createdAt))
    .limit(1))[0];
  if (!prior) return null;

  const lines = async (runItemId: string): Promise<Line[]> => {
    const it = (await deps.db.select({ linesJson: schema.payrollRunItems.linesJson }).from(schema.payrollRunItems).where(eq(schema.payrollRunItems.uuid, runItemId)).limit(1))[0];
    if (!it) return [];
    try {
      return JSON.parse(it.linesJson) as Line[];
    } catch {
      return []; // an unreadable item explains nothing, and must not fail the payslip read it rides on
    }
  };

  return { ...explainPay(await lines(slip.runItemId), await lines(prior.runItemId)), compared_to: `payslips/${prior.uuid}` };
}

/** What the slip is called, off the period it was issued for. One derivation, because the two verbs below are
 *  the SAME bytes and a copy saved from one should not be named differently from a copy saved from the other. */
const payslipFileName = (row: { createdAt?: Date | number | null }, id: string) =>
  `payslip-${row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : id}.pdf`;

// `download` is the verb whose whole purpose is KEEPING a copy, and it was the one that named nothing: it
// returned bytes alone, so routes/payslips.ts answered `application/octet-stream` with no
// `Content-Disposition` at all, and a caller outside the SPA saved an extensionless file named after the
// request URL. `preview` - which is not saving anything - carried the name the whole time.
export async function downloadPayslip(deps: Deps, actor: AppUser, id: string) {
  const { row, bytes } = await payslipBytes(deps, actor, id);
  return { bytes, fileName: payslipFileName(row, id) };
}

// `payslips/<id>:preview` - the same bytes, served for INLINE viewing. A separate custom method (not a flag on
// download) so "may look at it in the app" and "may keep a copy" are grantable independently, each with its own
// self / my-dept / org-wide scope.
export async function previewPayslip(deps: Deps, actor: AppUser, id: string) {
  const { row, bytes } = await payslipBytes(deps, actor, id);
  return { bytes, fileName: payslipFileName(row, id) };
}
