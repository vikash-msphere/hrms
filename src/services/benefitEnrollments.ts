import { eq, and, isNull } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { notify } from "./notifications";

export type BenefitEnrollmentInput = {
  employee?: string | null;
  plan?: string | null;
  status?: "enrolled" | "waived";
  effective_date?: string | null;
  dependents?: string[]; // dependent refs (the employee's own)
};

// Auto-enrol an employee in every plan flagged auto_enroll they aren't already enrolled/waived in. IDEMPOTENT
// (safe to re-run: existing enrollments are skipped), so the automation that calls it on employee.created can
// fire at-least-once without duplicating. Returns how many new enrollments were created.
export async function enrollDefaultBenefits(deps: Deps, actor: AppUser, employeeId: string): Promise<{ enrolled: number }> {
  const plans = await deps.db
    .select()
    .from(schema.benefitPlans)
    .where(and(eq(schema.benefitPlans.autoEnroll, true), isNull(schema.benefitPlans.deleteTime)));
  if (!plans.length) return { enrolled: 0 };
  const existing = await deps.db
    .select({ planId: schema.benefitEnrollments.planId })
    .from(schema.benefitEnrollments)
    .where(and(eq(schema.benefitEnrollments.employeeId, employeeId), isNull(schema.benefitEnrollments.deleteTime)));
  const have = new Set(existing.map((r) => r.planId));
  let enrolled = 0;
  for (const plan of plans) {
    if (have.has(plan.uuid)) continue;
    await deps.db.insert(schema.benefitEnrollments).values({
      code: await allocOwnedCode(deps, schema.benefitEnrollments, schema.benefitEnrollments.employeeId, employeeId),
      employeeId,
      planId: plan.uuid,
      status: "enrolled",
      effectiveDate: new Date(),
    });
    enrolled++;
  }
  await audit(deps, actor, "benefit-enrollment.enrollDefaults", "employees", employeeId, { enrolled });
  return { enrolled };
}
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Keep only dependent ids that actually belong to this employee (defence against electing someone else's).
async function ownDependentIds(deps: Deps, employeeId: string, refs?: string[]): Promise<string | null> {
  if (!Array.isArray(refs) || !refs.length) return null;
  const want = new Set(refs.map(idFromPath).filter(Boolean) as string[]);
  const owned = new Set((await deps.db.select({ uuid: schema.dependents.uuid }).from(schema.dependents).where(eq(schema.dependents.employeeId, employeeId))).map((d) => d.uuid));
  const kept = [...want].filter((id) => owned.has(id));
  return kept.length ? JSON.stringify(kept) : null;
}

export async function listBenefitEnrollments(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.benefitEnrollments.code, schema.benefitEnrollments.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.benefitEnrollments.employeeId, empId));
  const all = (await deps.db.select().from(schema.benefitEnrollments).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((e) => showDeleted || !e.deleteTime)
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getBenefitEnrollment(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.benefitEnrollments).where(eq(schema.benefitEnrollments.uuid, id)).limit(1))[0];
  if (!row) throw notFound("enrollment not found");
  return row;
}

export async function createBenefitEnrollment(deps: Deps, actor: AppUser, input: BenefitEnrollmentInput, id?: string) {
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const planId = idFromPath(input.plan);
  if (!planId) throw invalidArgument("plan is required");
  if (input.effective_date && Number.isNaN(dayMs(input.effective_date))) throw invalidArgument("effective_date is invalid");
  const row = (await deps.db.insert(schema.benefitEnrollments).values({
    code: await allocOwnedCode(deps, schema.benefitEnrollments, schema.benefitEnrollments.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    planId,
    status: input.status === "waived" ? "waived" : "enrolled",
    effectiveDate: input.effective_date ? new Date(dayMs(input.effective_date)) : null,
    dependentsJson: await ownDependentIds(deps, employeeId, input.dependents),
  }).returning())[0]!;
  await audit(deps, actor, "benefit-enrollment.create", "benefit-enrollments", row.uuid, undefined, row);
  // HR enrolling someone else notifies that employee (self-enrolment is silent).
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: row.status === "waived" ? "benefit.waived" : "benefit.enrolled", title: row.status === "waived" ? "Benefit waived" : "Enrolled in a benefit plan", body: row.status === "waived" ? "A benefit plan was marked waived for you." : "You've been enrolled in a benefit plan.", link: "benefits", subject: `benefit-enrollments/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateBenefitEnrollment(deps: Deps, actor: AppUser, id: string, patch: BenefitEnrollmentInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.benefitEnrollments).where(eq(schema.benefitEnrollments.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("enrollment not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof BenefitEnrollmentInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("status")) set.status = patch.status === "waived" ? "waived" : "enrolled";
  if (has("effective_date")) {
    if (patch.effective_date && Number.isNaN(dayMs(patch.effective_date))) throw invalidArgument("effective_date is invalid");
    set.effectiveDate = patch.effective_date ? new Date(dayMs(patch.effective_date)) : null;
  }
  if (has("dependents")) set.dependentsJson = await ownDependentIds(deps, row.employeeId, patch.dependents);
  const updated = (await deps.db.update(schema.benefitEnrollments).set(set).where(eq(schema.benefitEnrollments.uuid, id)).returning())[0]!;
  await audit(deps, actor, "benefit-enrollment.update", "benefit-enrollments", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteBenefitEnrollment(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.benefitEnrollments, "enrollment", "benefit-enrollments", id, ifMatch);
}
export async function restoreBenefitEnrollment(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.benefitEnrollments, "enrollment", "benefit-enrollments", id);
}
export async function purgeBenefitEnrollment(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.benefitEnrollments, "enrollment", "benefit-enrollments", id, ifMatch);
}
