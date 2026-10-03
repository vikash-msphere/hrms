// Role catalog management (super-only via the `roles` collection key; the middleware gates it). Roles are
// data: add/remove a row, not an edit. Lockout guards live here (service-level write invariants, NO authz
// import - keeps the single-source gate clean): protected core roles undeletable; you cannot delete the
// role you are using; a role still held by any user cannot be deleted (FK users.role -> roles.name RESTRICT).
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditUpdate, createdMeta, diffMeta, removedMeta } from "../lib/audit";
import { notFound, invalidArgument, failedPrecondition, alreadyExists } from "../lib/errors";
import { clearCache } from "../lib/cache";
import { generational } from "../lib/cacheGenerations";
import { EVERYONE_ROLE } from "../domain/grants";
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

const PROVISIONED_KEY = "role:provisioned";

/**
 * The role a new account is given - on hire (services/employees.ts) and at first sign-in (middleware/auth.ts).
 * Read off the `roles` row that carries `provisioned`, never a name written here: which role new people get is
 * the org's call, made in Access Management. None marked is refused, not guessed at, so an org that clears it
 * gets a clear error on the next hire rather than accounts quietly landing in some role.
 */
export function provisionedRole(deps: Deps): Promise<string> {
  // Held until the `roles` counter moves (lib/cacheGenerations.ts). Throws INSIDE the loader, so the refusal is
  // never cached: the moment an admin marks a role, the next hire sees it rather than a remembered "none".
  return generational(deps, PROVISIONED_KEY, ["roles"], async () => {
    const row = (await deps.db.select({ name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.provisioned, true)).limit(1))[0];
    if (!row) throw failedPrecondition("no role is set to be given to new accounts - choose one in Access Management > Roles");
    return row.name;
  });
}

/** Display label per role name, for the given names only. Unknown names are left out, never invented. */
export async function roleLabels(deps: Deps, names: readonly string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(names)].filter(Boolean);
  if (!wanted.length) return {};
  const rows = await deps.db.select({ name: schema.roles.name, label: schema.roles.label }).from(schema.roles).where(inArray(schema.roles.name, wanted));
  return Object.fromEntries(rows.map((r) => [r.name, r.label]));
}

export async function updateRole(deps: Deps, actor: AppUser, name: string, body: { label?: string; protected?: boolean; provisioned?: boolean }) {
  const before = await getRole(deps, name); // 404 if absent, and the label/protected this write replaces
  const patch: Record<string, unknown> = { updatedAt: new Date() }; // name is immutable (it is the key + FK target)
  if (body.label !== undefined) patch.label = String(body.label);
  if (body.protected !== undefined) patch.protected = !!body.protected;
  // The provisioned flag MOVES, it is never just cleared: one role always answers "what do new people get".
  // Clearing it here would leave every next hire refused, which is a lockout of hiring by a checkbox.
  if (body.provisioned === false && before.provisioned) throw failedPrecondition("choose another role to give new accounts instead of clearing this one");
  if (body.provisioned === true && !before.provisioned) {
    if (name === EVERYONE_ROLE) throw invalidArgument("everyone is not a role an account can hold");
    patch.provisioned = true;
    // Unset the old holder first, in the same batch, so the partial unique index never sees two.
    await deps.db.batch([
      deps.db.update(schema.roles).set({ provisioned: false, updatedAt: new Date() }).where(eq(schema.roles.provisioned, true)),
      deps.db.update(schema.roles).set(patch).where(eq(schema.roles.name, name)),
    ]);
    clearCache(PROVISIONED_KEY);
  } else {
    await deps.db.update(schema.roles).set(patch).where(eq(schema.roles.name, name));
  }
  const row = await getRole(deps, name);
  await auditUpdate(deps, actor, "role.update", "roles", name, diffMeta(before, row, patch, "roles"), row);
  return row;
}

export async function deleteRole(deps: Deps, actor: AppUser, name: string) {
  const role = await getRole(deps, name);
  if (role.protected) throw failedPrecondition("protected core role cannot be deleted");
  if (role.provisioned) throw failedPrecondition("new accounts are given this role - choose another one first");
  if (name === actor.role) throw failedPrecondition("cannot delete the role you are using");
  if ((await deps.db.select({ u: schema.users.uuid }).from(schema.users).where(eq(schema.users.role, name)).limit(1))[0]) {
    throw failedPrecondition("role is in use by one or more users"); // FK ON DELETE RESTRICT also enforces this
  }
  // ...and the same question of the SECONDARY holders. A role nobody carries as their primary can still be held
  // by people through `user_roles` (db/schema.ts), whose FK is RESTRICT for exactly this reason - so without
  // this check the delete would fail deep in SQLite as a 500 instead of answering the precondition it is.
  if ((await deps.db.select({ u: schema.userRoles.userId }).from(schema.userRoles).where(eq(schema.userRoles.role, name)).limit(1))[0]) {
    throw failedPrecondition("role is in use by one or more users");
  }
  // Drop the role's access rules (fold of the old removeRoleRules), bust its cache, then remove the role.
  await deps.db.delete(schema.accessRules).where(and(eq(schema.accessRules.subject, name), eq(schema.accessRules.subjectKind, "role")));
  clearCache(`grant:${name}`);
  await deps.db.delete(schema.roles).where(eq(schema.roles.name, name));
  // The role row and its access rules are hard-deleted above, so what it WAS survives only here.
  await audit(deps, actor, "role.delete", "roles", name, removedMeta(role, "roles"), role);
}
