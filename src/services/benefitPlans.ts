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

type Category = typeof schema.benefitPlans.$inferSelect.category;
export type BenefitPlanInput = {
  name?: string;
  category?: Category;
  description?: string | null;
  provider?: string | null;
  employee_cost?: number;
  employer_cost?: number;
  cost_period?: "month" | "year";
  allows_dependents?: boolean;
  auto_enroll?: boolean;
};

export async function listBenefitPlans(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.benefitPlans), showDeleted)
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getBenefitPlan(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.benefitPlans).where(eq(schema.benefitPlans.uuid, id)).limit(1))[0];
  if (!row) throw notFound("benefit plan not found");
  return row;
}

export async function createBenefitPlan(deps: Deps, actor: AppUser, input: BenefitPlanInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  const row = (await deps.db.insert(schema.benefitPlans).values({
    code: await allocFlatCode(deps, schema.benefitPlans),
    ...(id ? { uuid: id } : {}),
    name: input.name.trim(),
    category: input.category ?? "health",
    description: input.description?.trim() || null,
    provider: input.provider?.trim() || null,
    employeeCost: Math.max(0, input.employee_cost ?? 0),
    employerCost: Math.max(0, input.employer_cost ?? 0),
    costPeriod: input.cost_period === "year" ? "year" : "month",
    allowsDependents: !!input.allows_dependents,
    autoEnroll: !!input.auto_enroll,
  }).returning())[0]!;
  await audit(deps, actor, "benefit-plan.create", "benefit-plans", row.uuid, undefined, row);
  return row;
}

export async function updateBenefitPlan(deps: Deps, actor: AppUser, id: string, patch: BenefitPlanInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.benefitPlans).where(eq(schema.benefitPlans.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("benefit plan not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof BenefitPlanInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) { if (!patch.name?.trim()) throw invalidArgument("name is required"); set.name = patch.name.trim(); }
  if (has("category")) set.category = patch.category;
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("provider")) set.provider = patch.provider?.trim() || null;
  if (has("employee_cost")) set.employeeCost = Math.max(0, patch.employee_cost ?? 0);
  if (has("employer_cost")) set.employerCost = Math.max(0, patch.employer_cost ?? 0);
  if (has("cost_period")) set.costPeriod = patch.cost_period === "year" ? "year" : "month";
  if (has("allows_dependents")) set.allowsDependents = !!patch.allows_dependents;
  if (has("auto_enroll")) set.autoEnroll = !!patch.auto_enroll;
  const updated = (await deps.db.update(schema.benefitPlans).set(set).where(eq(schema.benefitPlans.uuid, id)).returning())[0]!;
  await audit(deps, actor, "benefit-plan.update", "benefit-plans", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteBenefitPlan(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.benefitPlans, "benefit-plan", "benefit-plans", id, ifMatch);
}
export async function restoreBenefitPlan(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.benefitPlans, "benefit-plan", "benefit-plans", id);
}
export async function purgeBenefitPlan(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.benefitPlans, "benefit-plan", "benefit-plans", id, ifMatch);
}
