import { eq, and } from "drizzle-orm";
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

type Relationship = typeof schema.dependents.$inferSelect.relationship;
export type DependentInput = {
  employee?: string | null;
  name?: string;
  relationship?: Relationship;
  date_of_birth?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listDependents(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.dependents.code, schema.dependents.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.dependents.employeeId, empId));
  const all = (await deps.db.select().from(schema.dependents).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((d) => showDeleted || !d.deleteTime)
    .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getDependent(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.dependents).where(eq(schema.dependents.uuid, id)).limit(1))[0];
  if (!row) throw notFound("dependent not found");
  return row;
}

export async function createDependent(deps: Deps, actor: AppUser, input: DependentInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  if (input.date_of_birth && Number.isNaN(dayMs(input.date_of_birth))) throw invalidArgument("date_of_birth is invalid");
  const row = (await deps.db.insert(schema.dependents).values({
    code: await allocOwnedCode(deps, schema.dependents, schema.dependents.employeeId, employeeId),
    ...(id ? { uuid: id } : {}),
    employeeId,
    name: input.name.trim(),
    relationship: input.relationship ?? "other",
    dateOfBirth: input.date_of_birth ? new Date(dayMs(input.date_of_birth)) : null,
  }).returning())[0]!;
  await audit(deps, actor, "dependent.create", "dependents", row.uuid, undefined, row);
  return row;
}

export async function updateDependent(deps: Deps, actor: AppUser, id: string, patch: DependentInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.dependents).where(eq(schema.dependents.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("dependent not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof DependentInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) { if (!patch.name?.trim()) throw invalidArgument("name is required"); set.name = patch.name.trim(); }
  if (has("relationship")) set.relationship = patch.relationship;
  if (has("date_of_birth")) {
    if (patch.date_of_birth && Number.isNaN(dayMs(patch.date_of_birth))) throw invalidArgument("date_of_birth is invalid");
    set.dateOfBirth = patch.date_of_birth ? new Date(dayMs(patch.date_of_birth)) : null;
  }
  const updated = (await deps.db.update(schema.dependents).set(set).where(eq(schema.dependents.uuid, id)).returning())[0]!;
  await audit(deps, actor, "dependent.update", "dependents", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteDependent(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.dependents, "dependent", "dependents", id, ifMatch);
}
export async function restoreDependent(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.dependents, "dependent", "dependents", id);
}
export async function purgeDependent(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.dependents, "dependent", "dependents", id, ifMatch);
}
