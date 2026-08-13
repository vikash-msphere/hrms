import { allocFlatCode } from "./codeAlloc";
import { and, eq } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { notify } from "./notifications";
import { emitEvent } from "./eventBus";

export type AssetInput = {
  asset_tag?: string | null;
  name?: string;
  category?: string | null;
  serial_number?: string | null;
  status?: "in_stock" | "assigned" | "repair" | "retired";
  assigned_to?: string | null; // employees/<id> or null (the inbound edge already decoded the ref)
  assigned_on?: string | null; // YYYY-MM-DD
  purchase_date?: string | null;
  tag_printed_time?: string | null; // ISO timestamp - set by the tag printer's "mark printed", null clears
  last_verified_time?: string | null; // ISO timestamp - set by a stocktake scan sighting the physical asset
  notes?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? new Date(Date.parse(s + "T00:00:00Z")) : null);

// One employee's assigned assets, or - unfiltered - everything the caller may see (the inventory). The owner
// for scope purposes is `assignedTo` (dynamic), so an employee's "own" list tracks reassignment.
export async function listAssets(deps: Deps, scope: ListScope, employeeId?: string) {
  const conds = [applyScope(scope, schema.assets.code, schema.assets.assignedTo)];
  if (employeeId) conds.push(eq(schema.assets.assignedTo, employeeId));
  const rows = await deps.db.select().from(schema.assets).where(conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as any)) : undefined);
  return rows.sort((a, b) => (a.assetTag ?? a.name).localeCompare(b.assetTag ?? b.name) || a.uuid.localeCompare(b.uuid));
}

export async function getAsset(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("asset not found");
  return row;
}

export async function createAsset(deps: Deps, actor: AppUser, input: AssetInput) {
  if (!input.name || !input.name.trim()) throw invalidArgument("name is required");
  const assignedTo = idFromPath(input.assigned_to) ?? null;
  const status = input.status ?? (assignedTo ? "assigned" : "in_stock");
  const row = (await deps.db
    .insert(schema.assets)
    .values({
      code: await allocFlatCode(deps, schema.assets),
      assetTag: input.asset_tag?.trim() || null,
      name: input.name.trim(),
      category: input.category?.trim() || null,
      serialNumber: input.serial_number?.trim() || null,
      status,
      assignedTo,
      assignedOn: assignedTo ? (dayMs(input.assigned_on) ?? new Date()) : null,
      purchaseDate: dayMs(input.purchase_date),
      notes: input.notes?.trim() || null,
    })
    .returning())[0]!;
  await audit(deps, actor, "asset.create", "assets", row.uuid, undefined, row);
  await emitEvent(deps, actor, "asset.created", { subject: `assets/${row.uuid}`, employeeId: assignedTo, payload: { category: row.category, hasTag: !!row.assetTag } });
  if (assignedTo && assignedTo !== actor.employeeId)
    await notify(deps, { recipient: assignedTo, type: "asset.assigned", title: "Asset assigned to you", body: `${row.name}${row.assetTag ? ` (${row.assetTag})` : ""}`, link: "assets", subject: `assets/${row.uuid}`, actorId: actor.employeeId });
  return row;
}

export async function updateAsset(deps: Deps, actor: AppUser, id: string, patch: AssetInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("asset not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof AssetInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: SetOf<typeof schema.assets> = { updatedAt: new Date() };
  if (has("asset_tag")) set.assetTag = patch.asset_tag?.trim() || null;
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name cannot be empty");
    set.name = patch.name.trim();
  }
  if (has("category")) set.category = patch.category?.trim() || null;
  if (has("serial_number")) set.serialNumber = patch.serial_number?.trim() || null;
  if (has("purchase_date")) set.purchaseDate = dayMs(patch.purchase_date);
  if (has("tag_printed_time")) {
    const ts = patch.tag_printed_time ? new Date(Date.parse(patch.tag_printed_time)) : null;
    if (ts && Number.isNaN(+ts)) throw invalidArgument("tag_printed_time must be an ISO timestamp");
    set.tagPrintedAt = ts;
  }
  if (has("last_verified_time")) {
    const ts = patch.last_verified_time ? new Date(Date.parse(patch.last_verified_time)) : null;
    if (ts && Number.isNaN(+ts)) throw invalidArgument("last_verified_time must be an ISO timestamp");
    set.verifiedAt = ts;
  }
  if (has("notes")) set.notes = patch.notes?.trim() || null;
  // Assignment: set assigned_to (employees/<id> or null) -> owner + assigned-on date, and (unless an explicit
  // status is also given) the derived status. Keep the prior assigned-on if the same person is re-saved.
  let derivedAssigned = row.assignedTo;
  if (has("assigned_to")) {
    const to = idFromPath(patch.assigned_to) ?? null;
    set.assignedTo = to;
    set.assignedOn = to ? (dayMs(patch.assigned_on) ?? (row.assignedTo === to ? row.assignedOn : new Date())) : null;
    derivedAssigned = to;
  }
  if (has("status")) set.status = patch.status;
  else if (has("assigned_to")) set.status = derivedAssigned ? "assigned" : "in_stock";
  const [updated] = await deps.db.update(schema.assets).set(set).where(eq(schema.assets.uuid, id)).returning();
  await audit(deps, actor, "asset.update", "assets", id, diffMeta(row, updated, set), updated);
  // Newly assigned to someone (a reassignment) notifies the new owner.
  if (has("assigned_to") && derivedAssigned && derivedAssigned !== row.assignedTo && derivedAssigned !== actor.employeeId)
    await notify(deps, { recipient: derivedAssigned, type: "asset.assigned", title: "Asset assigned to you", body: `${updated!.name}${updated!.assetTag ? ` (${updated!.assetTag})` : ""}`, link: "assets", subject: `assets/${id}`, actorId: actor.employeeId });
  return updated!;
}

export async function deleteAsset(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("asset not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  await deps.db.delete(schema.assets).where(eq(schema.assets.uuid, id));
  await audit(deps, actor, "asset.delete", "assets", id);
}
