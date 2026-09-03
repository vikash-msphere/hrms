import { eq, inArray } from "drizzle-orm";
import { allocFlatCode, allocOwnedCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { paginate } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, purgeRow } from "./softDelete";
import { notify } from "./notifications";

export type ReviewCycleInput = {
  name?: string;
  period_start?: string | null;
  period_end?: string | null;
  self_due_date?: string | null;
  manager_due_date?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const dateOrNull = (s?: string | null) => (s ? new Date(Date.parse(s + "T00:00:00Z")) : null);

export async function listReviewCycles(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.reviewCycles), showDeleted);
  const { items: slice, nextPageToken } = paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid);
  return { items: slice, nextPageToken };
}

async function getReviewCycle(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review cycle not found");
  return row;
}

// How many reviews each of the given cycles has (for the wire `review_count`), in one query.
export async function reviewCountsFor(deps: Deps, cycleIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!cycleIds.length) return map;
  const rows = await deps.db.select({ c: schema.reviews.cycleId }).from(schema.reviews).where(inArray(schema.reviews.cycleId, cycleIds));
  for (const r of rows) map.set(r.c, (map.get(r.c) ?? 0) + 1);
  return map;
}

export async function createReviewCycle(deps: Deps, actor: AppUser, input: ReviewCycleInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  for (const k of ["period_start", "period_end", "self_due_date", "manager_due_date"] as const) {
    if (input[k] && Number.isNaN(dayMs(input[k]))) throw invalidArgument(`${k} is invalid`);
  }
  const row = (await deps.db
    .insert(schema.reviewCycles)
    .values({
      code: await allocFlatCode(deps, schema.reviewCycles),
      ...(id ? { uuid: id } : {}),
      name: input.name.trim(),
      periodStart: dateOrNull(input.period_start),
      periodEnd: dateOrNull(input.period_end),
      selfDueDate: dateOrNull(input.self_due_date),
      managerDueDate: dateOrNull(input.manager_due_date),
    })
    .returning())[0]!;
  await audit(deps, actor, "review-cycle.create", "review-cycles", row.uuid, createdMeta(row, "review-cycles"), row);
  return row;
}

export async function updateReviewCycle(deps: Deps, actor: AppUser, id: string, patch: ReviewCycleInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("review cycle not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.reviewCycles> = { updatedAt: new Date() };
  const has = (k: keyof ReviewCycleInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name is required");
    set.name = patch.name.trim();
  }
  if (has("period_start")) set.periodStart = dateOrNull(patch.period_start);
  if (has("period_end")) set.periodEnd = dateOrNull(patch.period_end);
  if (has("self_due_date")) set.selfDueDate = dateOrNull(patch.self_due_date);
  if (has("manager_due_date")) set.managerDueDate = dateOrNull(patch.manager_due_date);
  const updated = (await deps.db.update(schema.reviewCycles).set(set).where(eq(schema.reviewCycles.uuid, id)).returning())[0]!;
  await audit(deps, actor, "review-cycle.update", "review-cycles", id, diffMeta(row, updated, set, "review-cycles"), updated);
  return updated;
}

// Create a review shell per selected employee that doesn't already have one in this cycle, and notify each new
// reviewee that their self-assessment is open. `actor`/`cycleName` power the notification attribution + body.
async function addReviewees(deps: Deps, cycleId: string, employeeRefs: string[], actor: AppUser, cycleName: string) {
  const ids = [...new Set(employeeRefs.map(idFromPath).filter(Boolean) as string[])];
  if (!ids.length) throw invalidArgument("select at least one employee");
  const existing = new Set(
    (await deps.db.select({ e: schema.reviews.employeeId }).from(schema.reviews).where(eq(schema.reviews.cycleId, cycleId))).map((r) => r.e),
  );
  for (const employeeId of ids) {
    if (existing.has(employeeId)) continue;
    const code = await allocOwnedCode(deps, schema.reviews, schema.reviews.employeeId, employeeId);
    const row = (await deps.db.insert(schema.reviews).values({ code, cycleId, employeeId }).returning())[0]!;
    await notify(deps, { recipient: employeeId, type: "review.opened", title: "Your performance review is open", body: `${cycleName}: start your self-assessment.`, link: "reviews", subject: `reviews/${row.uuid}`, action: "respond", actorId: actor.employeeId });
  }
}

// Launch a DRAFT cycle: create reviews for the selected employees and mark it ACTIVE.
export async function launchReviewCycle(deps: Deps, actor: AppUser, id: string, employees: string[]) {
  const row = await getReviewCycle(deps, actor, id);
  if (row.state !== "DRAFT") throw failedPrecondition("only a draft cycle can be launched");
  await addReviewees(deps, id, employees, actor, row.name);
  const updated = (await deps.db.update(schema.reviewCycles).set({ state: "ACTIVE", updatedAt: new Date() }).where(eq(schema.reviewCycles.uuid, id)).returning())[0]!;
  await audit(deps, actor, "review-cycle.launch", "review-cycles", id, stateMeta(row.state, "ACTIVE", { fields: employees.slice(0, 12) }), updated);
  return updated;
}

// Add more reviewees to an already-active cycle (HR onboarding someone mid-cycle).
export async function addRevieweesToCycle(deps: Deps, actor: AppUser, id: string, employees: string[]) {
  const row = await getReviewCycle(deps, actor, id);
  if (row.state !== "ACTIVE") throw failedPrecondition("the cycle must be active to add reviewees");
  await addReviewees(deps, id, employees, actor, row.name);
  // WHO was added. "Someone was added to the cycle mid-flight" is the question this entry exists to answer.
  await audit(deps, actor, "review-cycle.addReviewees", "review-cycles", id, { fields: employees.slice(0, 12) }, row);
  return row;
}

export async function setReviewCycleState(deps: Deps, actor: AppUser, id: string, state: "ACTIVE" | "CLOSED") {
  const row = await getReviewCycle(deps, actor, id);
  if (state === "CLOSED" && row.state !== "ACTIVE") throw failedPrecondition("only an active cycle can be closed");
  if (state === "ACTIVE" && row.state !== "CLOSED") throw failedPrecondition("only a closed cycle can be reopened");
  const updated = (await deps.db.update(schema.reviewCycles).set({ state, updatedAt: new Date() }).where(eq(schema.reviewCycles.uuid, id)).returning())[0]!;
  await audit(deps, actor, `review-cycle.${state === "CLOSED" ? "close" : "reopen"}`, "review-cycles", id, stateMeta(row.state, state), updated);
  return updated;
}

export async function deleteReviewCycle(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.reviewCycles, "review-cycle", "review-cycles", id, ifMatch);
}

export async function purgeReviewCycle(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  // Tear down children bottom-up (FKs): feedback on the cycle's reviews, then the reviews, then the cycle.
  const reviewIds = (await deps.db.select({ uuid: schema.reviews.uuid }).from(schema.reviews).where(eq(schema.reviews.cycleId, id))).map((r) => r.uuid);
  if (reviewIds.length) await deps.db.delete(schema.reviewFeedback).where(inArray(schema.reviewFeedback.reviewId, reviewIds));
  await deps.db.delete(schema.reviews).where(eq(schema.reviews.cycleId, id));
  await purgeRow(deps, actor, schema.reviewCycles, "review-cycle", "review-cycles", id, ifMatch);
}
