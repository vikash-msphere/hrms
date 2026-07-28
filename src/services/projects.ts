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

export type ProjectInput = {
  name?: string;
  client?: string | null;
  code?: string | null;
  billable?: boolean;
  status?: "active" | "archived";
};

export async function listProjects(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.projects), showDeleted)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getProject(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.projects).where(eq(schema.projects.uuid, id)).limit(1))[0];
  if (!row) throw notFound("project not found");
  return row;
}

export async function createProject(deps: Deps, actor: AppUser, input: ProjectInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  const row = (await deps.db.insert(schema.projects).values({
    code: await allocFlatCode(deps, schema.projects),
    ...(id ? { uuid: id } : {}),
    name: input.name.trim(),
    client: input.client?.trim() || null,
    projectCode: input.code?.trim() || null,
    billable: input.billable ?? true,
    status: input.status === "archived" ? "archived" : "active",
  }).returning())[0]!;
  await audit(deps, actor, "project.create", "projects", row.uuid, undefined, row);
  return row;
}

export async function updateProject(deps: Deps, actor: AppUser, id: string, patch: ProjectInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.projects).where(eq(schema.projects.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("project not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof ProjectInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) { if (!patch.name?.trim()) throw invalidArgument("name is required"); set.name = patch.name.trim(); }
  if (has("client")) set.client = patch.client?.trim() || null;
  if (has("code")) set.projectCode = patch.code?.trim() || null;
  if (has("billable")) set.billable = !!patch.billable;
  if (has("status")) set.status = patch.status === "archived" ? "archived" : "active";
  const updated = (await deps.db.update(schema.projects).set(set).where(eq(schema.projects.uuid, id)).returning())[0]!;
  await audit(deps, actor, "project.update", "projects", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteProject(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.projects, "project", "projects", id, ifMatch);
}
export async function restoreProject(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.projects, "project", "projects", id);
}
export async function purgeProject(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.projects, "project", "projects", id, ifMatch);
}
