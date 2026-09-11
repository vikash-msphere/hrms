import { eq, and, isNull } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument } from "../lib/errors";
import { paginate } from "../http/pagination";
import { has, type CrudSpec, type SetOf } from "./crud";
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
    .filter((e) => showDeleted || !e.deleteTime);
  return paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid, "desc", { codec: deps.idCodec, collection: "benefit-enrollments" });
}

// An enrollment is owned by its employee (the code embeds the owner, so own/dept/all scoping works), and the
// only thing a write really decides is which plan, which status, from when, and for which of the employee's
// own dependents. The rest - paging, If-Match, the audit diff, soft delete/restore - is the shared lane.
export const benefitEnrollmentSpec: CrudSpec<BenefitEnrollmentInput, typeof schema.benefitEnrollments> = {
  table: schema.benefitEnrollments,
  collection: "benefit-enrollments",
  auditName: "benefit-enrollment",
  notFound: "enrollment not found",
  allocCode: (deps, table, values) => allocOwnedCode(deps, table, schema.benefitEnrollments.employeeId, values.employeeId as string),
  insert: async (input, deps, actor) => {
    const employeeId = idFromPath(input.employee) ?? actor.employeeId;
    if (!employeeId) throw invalidArgument("employee is required");
    const planId = idFromPath(input.plan);
    if (!planId) throw invalidArgument("plan is required");
    if (input.effective_date && Number.isNaN(dayMs(input.effective_date))) throw invalidArgument("effective_date is invalid");
    return {
      employeeId,
      planId,
      status: input.status === "waived" ? "waived" : "enrolled",
      effectiveDate: input.effective_date ? new Date(dayMs(input.effective_date)) : null,
      dependentsJson: await ownDependentIds(deps, employeeId, input.dependents),
    };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.benefitEnrollments> = {};
    if (has(patch, "status")) set.status = patch.status === "waived" ? "waived" : "enrolled";
    if (has(patch, "effective_date")) {
      if (patch.effective_date && Number.isNaN(dayMs(patch.effective_date))) throw invalidArgument("effective_date is invalid");
      set.effectiveDate = patch.effective_date ? new Date(dayMs(patch.effective_date)) : null;
    }
    // Elected dependents are re-filtered against the ROW's employee, not the patch's - a PATCH cannot move an
    // enrollment to someone else, so the owner is the stored one.
    if (has(patch, "dependents")) set.dependentsJson = await ownDependentIds(deps, row.employeeId, patch.dependents);
    return set;
  },
  // HR enrolling someone else notifies that employee (self-enrolment is silent).
  afterCreate: async (deps, actor, row) => {
    if (row.employeeId === actor.employeeId) return;
    await notify(deps, { recipient: row.employeeId, type: row.status === "waived" ? "benefit.waived" : "benefit.enrolled", title: row.status === "waived" ? "Benefit waived" : "Enrolled in a benefit plan", body: row.status === "waived" ? "A benefit plan was marked waived for you." : "You've been enrolled in a benefit plan.", link: "benefits", subject: `benefit-enrollments/${row.uuid}`, actorId: actor.employeeId });
  },
};
