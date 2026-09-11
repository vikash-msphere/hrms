// Role catalog management (super-only via the `roles` collection key; the middleware gates it). Roles are
// data: add/remove a row, not an edit. Lockout guards live here (service-level write invariants, NO authz
// import - keeps the single-source gate clean): protected core roles undeletable; you cannot delete the
// role you are using; a role still held by any user cannot be deleted (FK users.role -> roles.name RESTRICT).
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, removedMeta } from "../lib/audit";
import { notFound, invalidArgument, failedPrecondition, alreadyExists } from "../lib/errors";
import { clearCache } from "../lib/cache";
import { paginate } from "../http/pagination";

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/; // lower-snake-case identifier, 2-41 chars

export async function listRoles(deps: Deps, maxPageSize = 50, pageToken?: string) {
  const rows = await deps.db.select().from(schema.roles);
  // No `wire`: a role's identity IS its name (`/v1/roles/<name>`), so the cursor's uid half is already the
  // public identifier - there is no internal id to keep off the wire here.
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.name);
}

export async function getRole(deps: Deps, name: string) {
  const row = (await deps.db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1))[0];
  if (!row) throw notFound("role not found");
  return row;
}

export async function createRole(deps: Deps, actor: AppUser, body: { name?: string; label?: string; protected?: boolean }, idQuery?: string) {
  const name = (body.name || idQuery || "").trim();
  if (!NAME_RE.test(name)) throw invalidArgument("role name must be lower-snake-case (a-z, 0-9, _), 2-41 chars");
  if ((await deps.db.select({ n: schema.roles.name }).from(schema.roles).where(eq(schema.roles.name, name)).limit(1))[0]) throw alreadyExists("role already exists");
  const [row] = await deps.db.insert(schema.roles).values({ name, label: String(body.label || name), protected: !!body.protected }).returning();
  // A new role starts with NO access_rules rows -> the engine reconstructs EMPTY_GRANT (deny-all). Authority is
  // added later as individual rules via the access-rules API. No grant blob, no recompile.
  await audit(deps, actor, "role.create", "roles", name, createdMeta(row, "roles"), row);
  return row!;
}

export async function updateRole(deps: Deps, actor: AppUser, name: string, body: { label?: string; protected?: boolean }) {
  const before = await getRole(deps, name); // 404 if absent, and the label/protected this write replaces
  const patch: Record<string, unknown> = { updatedAt: new Date() }; // name is immutable (it is the key + FK target)
  if (body.label !== undefined) patch.label = String(body.label);
  if (body.protected !== undefined) patch.protected = !!body.protected;
  const [row] = await deps.db.update(schema.roles).set(patch).where(eq(schema.roles.name, name)).returning();
  await audit(deps, actor, "role.update", "roles", name, diffMeta(before, row, patch, "roles"), row);
  return row!;
}

export async function deleteRole(deps: Deps, actor: AppUser, name: string) {
  const role = await getRole(deps, name);
  if (role.protected) throw failedPrecondition("protected core role cannot be deleted");
  if (name === actor.role) throw failedPrecondition("cannot delete the role you are using");
  if ((await deps.db.select({ u: schema.users.uuid }).from(schema.users).where(eq(schema.users.role, name)).limit(1))[0]) {
    throw failedPrecondition("role is in use by one or more users"); // FK ON DELETE RESTRICT also enforces this
  }
  // Drop the role's access rules (fold of the old removeRoleRules), bust its cache, then remove the role.
  await deps.db.delete(schema.accessRules).where(and(eq(schema.accessRules.subject, name), eq(schema.accessRules.subjectKind, "role")));
  clearCache(`grant:${name}`);
  await deps.db.delete(schema.roles).where(eq(schema.roles.name, name));
  // The role row and its access rules are hard-deleted above, so what it WAS survives only here.
  await audit(deps, actor, "role.delete", "roles", name, removedMeta(role, "roles"), role);
}
