import { allocOwnedCode } from "./codeAlloc";
import { and, eq } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { updateAsset } from "./assets";

// Asset requests: an employee asks for kit ("I need a laptop"), naming a CATEGORY rather than a specific
// machine - which one they get is inventory's call. A manager (own dept) or HR approves/rejects, the owner
// cancels while pending. Who may decide is the verb's grant (middleware); the service only guards the state
// transitions and the hand-over.
//
// `:issue` is the step the other request types don't have: an approved request still owes the person a thing.
// It hands over a real asset through updateAsset, so the asset takes the ordinary custody route (it waits in
// `pending_ack` until the holder scans its tag) instead of this service inventing a second way to claim that
// somebody is holding something.
export type AssetRequestInput = {
  employee?: string | null; // employees/<id> (the inbound edge already decoded the ref); defaults to the caller
  category?: string | null; // asset-categories/<id>
  justification?: string | null;
  needed_by?: string | null; // YYYY-MM-DD
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? new Date(Date.parse(s + "T00:00:00Z")) : null);

export async function listAssetRequests(
  deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, q?: string, employeeId?: string,
) {
  const conds = [applyScope(scope, schema.assetRequests.code, schema.assetRequests.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "asset-requests", q, schema.assetRequests.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.assetRequests.state, stateFilter as typeof schema.assetRequests.$inferSelect.state));
  // `?employee=`: one person's requests, which is what the profile's Assets tab asks for.
  if (employeeId) conds.push(eq(schema.assetRequests.employeeId, employeeId));
  return keysetPage<typeof schema.assetRequests.$inferSelect>(deps, schema.assetRequests, "asset-requests", and(...(conds.filter(Boolean) as any)), { dir: "desc", max: maxPageSize, pageToken });
}

async function getAssetRequest(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.assetRequests).where(eq(schema.assetRequests.uuid, id)).limit(1))[0];
  if (!row) throw notFound("asset request not found");
  return row;
}

export async function createAssetRequest(deps: Deps, actor: AppUser, input: AssetRequestInput) {
  const categoryId = idFromPath(input.category);
  if (!categoryId) throw invalidArgument("category is required");
  const category = (await deps.db.select().from(schema.assetCategories).where(eq(schema.assetCategories.uuid, categoryId)).limit(1))[0];
  if (!category || category.deleteTime) throw invalidArgument("asset category not found");
  // Default to the caller's own record unless an admin files on someone's behalf (owner-create is gated by the
  // middleware's owner_refs check, so a non-admin can only create under their own employee).
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const row = (await deps.db
    .insert(schema.assetRequests)
    .values({
      code: await allocOwnedCode(deps, schema.assetRequests, schema.assetRequests.employeeId, employeeId),
      employeeId,
      categoryId,
      justification: input.justification?.trim() || null,
      neededBy: dayMs(input.needed_by),
      state: "PENDING",
    })
    .returning())[0]!;
  await audit(deps, actor, "asset_request.create", "asset-requests", row.uuid, createdMeta(row, "asset-requests"), row);
  // Notification types are grouped by their first segment (domain/notificationConfig.ts), so these ride in the
  // existing "asset" category rather than inventing one nobody can configure.
  await notifyManager(deps, employeeId, { type: "asset.requested", noun: "asset request" });
  await emitEvent(deps, actor, "assetRequest.requested", { subject: `asset-requests/${row.uuid}`, employeeId, payload: { categoryId, neededBy: row.neededBy ? new Date(row.neededBy).toISOString() : null } });
  return row;
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED", note?: string | null) {
  const row = await getAssetRequest(deps, id);
  const stuck = to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending";
  if (row.state !== "PENDING") throw failedPrecondition(stuck);
  // Guard the flip on PENDING so the decision is EXACTLY-ONCE (0 rows = already decided by a concurrent call).
  const [updated] = await deps.db
    .update(schema.assetRequests)
    .set({ state: to, decidedBy: actor.uuid, decisionNote: note ?? null, updatedAt: new Date() })
    .where(and(eq(schema.assetRequests.uuid, id), eq(schema.assetRequests.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(stuck);
  await audit(deps, actor, `asset_request.${to.toLowerCase()}`, "asset-requests", id, stateMeta(row.state, to, { employee: `employees/${row.employeeId}`, ...(note ? { reason: note } : {}) }), updated);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, {
      recipient: row.employeeId,
      type: to === "APPROVED" ? "asset.requestApproved" : "asset.requestRejected",
      title: `Asset request ${to.toLowerCase()}`,
      body: to === "APPROVED" ? "Your asset request was approved - it will be handed over once something is free." : "Your asset request was rejected.",
      link: "profile",
      subject: `asset-requests/${id}`,
      actorId: actor.employeeId,
    });
  }
  if (to === "APPROVED") await emitEvent(deps, actor, "assetRequest.approved", { subject: `asset-requests/${id}`, employeeId: row.employeeId, payload: { categoryId: row.categoryId } });
  return updated;
}

export const approveAssetRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null) => decide(deps, actor, id, "APPROVED", note);
export const rejectAssetRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null) => decide(deps, actor, id, "REJECTED", note);
export const cancelAssetRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");

/**
 * `:issue` - hand a real asset to the requester and close the request.
 *
 * Only an APPROVED request can be issued (approving and handing over are two decisions, often by two people),
 * and only an asset nobody else holds: reassigning somebody's laptop through here would take it off them
 * silently. The hand-over is `updateAsset`, so the asset lands in `pending_ack`, the holder is notified, and
 * custody is still proved by scanning the tag.
 */
export async function issueAssetRequest(deps: Deps, actor: AppUser, id: string, assetPath?: string | null) {
  const row = await getAssetRequest(deps, id);
  if (row.state !== "APPROVED") throw failedPrecondition("only an approved request can be issued");
  const assetId = idFromPath(assetPath);
  if (!assetId) throw invalidArgument("asset is required");
  const asset = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, assetId)).limit(1))[0];
  if (!asset) throw notFound("asset not found");
  if (asset.assignedTo && asset.assignedTo !== row.employeeId) throw failedPrecondition("that asset is assigned to somebody else");
  if (asset.status === "retired") throw failedPrecondition("a retired asset cannot be handed over");
  // Close the request FIRST, guarded on APPROVED: two approvers clicking at once must not hand over two
  // machines against one request. The loser gets the precondition, and no asset has moved yet.
  const [updated] = await deps.db
    .update(schema.assetRequests)
    .set({ state: "ISSUED", issuedAssetId: assetId, issuedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.assetRequests.uuid, id), eq(schema.assetRequests.state, "APPROVED")))
    .returning();
  if (!updated) throw failedPrecondition("only an approved request can be issued");
  // ISSUED is terminal, so the claim has to be given back if the hand-over itself fails (a locked asset, a
  // category rule, somebody else assigning it in between). Otherwise the request reads as fulfilled while
  // nobody was handed anything, and there is no state left to retry from.
  try {
    await updateAsset(deps, actor, assetId, { assigned_to: `employees/${row.employeeId}` });
  } catch (e) {
    await deps.db
      .update(schema.assetRequests)
      .set({ state: "APPROVED", issuedAssetId: null, issuedAt: null, updatedAt: new Date() })
      .where(and(eq(schema.assetRequests.uuid, id), eq(schema.assetRequests.state, "ISSUED")));
    throw e;
  }
  await audit(deps, actor, "asset_request.issue", "asset-requests", id, { asset: `assets/${assetId}` }, updated);
  await emitEvent(deps, actor, "assetRequest.issued", { subject: `asset-requests/${id}`, employeeId: row.employeeId, payload: { categoryId: row.categoryId, assetId } });
  return updated;
}
