import { eq, inArray, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { AppUser } from "../env";
import { audit, auditUpdate, diffMeta } from "../lib/audit";
import { notFound, aborted, invalidArgument, isUserEmployeeCollision, oneOf } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { EVERYONE_ROLE } from "../domain/grants";
import { checkEtag, updateAtVersion } from "./versionGuard";
import { clearCache } from "../lib/cache";
import { byIdChunks } from "../lib/dbBatch";

export type UserInput = { role?: string; roles?: string[]; status?: string; employee?: string | null };

/**
 * Stamp when this account was last seen. Called from the auth middleware on every lane, behind the same
 * throttle `api_keys.last_used_at` uses (services/apiKeys.ts `shouldTouchLastUsed`).
 *
 * Deliberately NOT audited and not version-guarded. It is not something a person did to the record - it is the
 * record noticing them - so an audit entry per quarter-hour per account would bury the trail it shares.
 *
 * `updated_at` IS HELD, by writing it back to itself. The column carries `$onUpdateFn` (db/schema.ts), which
 * drizzle applies to any update that does not name it - so the obvious one-column write would re-stamp it,
 * and with it the row's ETag, every fifteen minutes that somebody merely BROWSES. Two things then go wrong at
 * once: `GET /v1/users` is a conditional, list-ETag'd read (http/listEtag.ts), so every client's cached user
 * list would be invalidated by activity that changed nothing in it; and a record whose `update_time` moves on
 * its own reads in the UI - and in `GET /v1/changes` - as a record somebody edited. Self-assignment is the
 * only way to suppress the hook, since suppressing it needs the column present in the SET and the value it
 * should keep is the one already in the row.
 */
export function touchLastSeen(deps: Deps, userId: string, now: Date) {
  return deps.db
    .update(schema.users)
    .set({ lastSeenAt: now, updatedAt: sql`${schema.users.updatedAt}` })
    .where(eq(schema.users.uuid, userId));
}

/**
 * Replace a user's SECONDARY roles (db/schema.ts `user_roles`) with exactly `wanted`.
 *
 * The primary (`users.role`) is dropped from the set rather than rejected: a picker that shows every role the
 * person holds will naturally include it, and storing it twice would mean the union loaded at auth counted it
 * twice and the delete guard had two places to look. `everyone` is refused for the same reason it is refused as
 * a primary - it is a rule SUBJECT, the "allow everyone" primitive, never a persona anybody holds.
 *
 * Wholesale replace, not a diff: the set is tiny, the caller sends what it wants the answer to be, and a diff
 * would need its own conflict story for two admins editing one person at once.
 */
async function setSecondaryRoles(deps: Deps, userUuid: string, primary: string, wanted: string[]): Promise<string[]> {
  const set = [...new Set(wanted.map((r) => String(r ?? "").trim()).filter(Boolean))].filter((r) => r !== primary);
  if (set.includes(EVERYONE_ROLE)) throw invalidArgument("the 'everyone' role cannot be assigned to a user");
  if (set.length) {
    const known = await deps.db.select({ name: schema.roles.name }).from(schema.roles).where(inArray(schema.roles.name, set));
    const missing = set.filter((r) => !known.some((k) => k.name === r));
    if (missing.length) throw invalidArgument(`invalid role: ${missing[0]}`);
  }
  await deps.db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userUuid));
  if (set.length) await deps.db.insert(schema.userRoles).values(set.map((role) => ({ userId: userUuid, role })));
  // The auth read serves this from cache (lib/policyLoad.ts `userRoles:<uuid>`), so a change that is not busted
  // here does not take effect until the TTL lapses - the person keeps the authority they were just stripped of.
  clearCache(`userRoles:${userUuid}`);
  return set;
}

/**
 * Attach each account's SECONDARY roles to the rows a response is about to serialize, in ONE read for the page.
 *
 * Per row it would be a query per account on a list an admin opens to see everybody. The join table is small and
 * usually empty, so the common case is one cheap indexed read returning nothing.
 */
export async function decorateUserRoles(deps: Deps, rows: any[]): Promise<any[]> {
  const ids = rows.map((r) => r?.uuid).filter((id): id is string => typeof id === "string");
  if (!ids.length) return rows;
  const held = new Map<string, string[]>();
  for (const r of await byIdChunks(ids, (group) =>
    deps.db.select({ userId: schema.userRoles.userId, role: schema.userRoles.role }).from(schema.userRoles).where(inArray(schema.userRoles.userId, group)),
  )) {
    held.set(r.userId, [...(held.get(r.userId) ?? []), r.role]);
  }
  // Always set the key, even when empty: the serializer omits `roles` when it is absent, and for an account the
  // response IS about, "none" is the answer rather than "not asked".
  return rows.map((r) => ({ ...r, roles: (held.get(r?.uuid) ?? []).sort() }));
}

const STATUSES = ["active", "disabled"] as const;
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Accounts the caller may see. Scoped like any other list: an admin holds `users.**` (org-wide), while everyone
// else holds only `users.me.**`, which resolves to breadth `own` - so their page is their own account and not,
// as it used to be, every email and role in the company. The owner column is the account's employee link.
export async function listUsers(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string) {
  return keysetPage(deps, schema.users, "users", applyScope(scope, schema.users.code, schema.users.employeeId), {
    max: maxPageSize,
    pageToken,
  });
}

// `me` resolves to the caller; any other id is gated to admins at the route.
export async function getUser(deps: Deps, actor: AppUser, id: string) {
  const realId = id === "me" ? actor.uuid : id;
  const row = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, realId)).limit(1))[0];
  if (!row) throw notFound("user not found");
  return row;
}

export async function updateUser(deps: Deps, actor: AppUser, id: string, patch: UserInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, id)).limit(1))[0];
  if (!row) throw notFound("user not found");
  checkEtag(row, ifMatch);

  const set: SetOf<typeof schema.users> = { updatedAt: new Date() };
  const has = (k: keyof UserInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("role")) {
    // Validate against the roles TABLE (roles are data) - no hardcoded role list. Rare path (admin
    // changing a user's role); not an authz decision, so it adds no cost to the enforcement budget.
    const role = patch.role;
    // `everyone` is a reserved rule-subject (the "allow everyone" primitive), never a persona a user holds.
    if (role === EVERYONE_ROLE) throw invalidArgument("the 'everyone' role cannot be assigned to a user");
    const known = typeof role === "string" && role.length > 0 &&
      (await deps.db.select({ name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.name, role)).limit(1)).length > 0;
    if (!known) throw invalidArgument("invalid role");
    set.role = role;
  }
  if (has("status")) set.status = oneOf(patch.status, STATUSES, "invalid status");
  if (has("employee")) set.employeeId = idFromPath(patch.employee) ?? null;

  // Self-lockout guard: an admin cannot strip their own super_admin role or disable themselves. `roles` is the
  // same act by another name - editing your own set is how you would remove the role you are relying on - so it
  // is refused on the same terms rather than left as the way around the guard next to it.
  if (row.uuid === actor.uuid) {
    if (has("role")) throw invalidArgument("you cannot change your own role");
    if (has("roles")) throw invalidArgument("you cannot change your own roles");
    if (has("status") && patch.status !== "active") throw invalidArgument("you cannot disable your own account");
  }

  // `users_employee_idx` keeps one account per person. Re-pointing an account at someone who already has one
  // is an ordinary mistake an admin makes in a picker, so it answers as one rather than as a 500.
  let updated: typeof row;
  try {
    updated = await updateAtVersion(deps, schema.users, "user", row, set);
  } catch (e) {
    if (!isUserEmployeeCollision(e)) throw e;
    throw invalidArgument("that employee already has a sign-in account; unlink it before linking this one");
  }
  // After the row write, so the primary the secondaries are filtered against is the one that now applies - a
  // patch that changes `role` AND `roles` in one call must not leave the old primary sitting in the join table.
  const meta = diffMeta(row, updated, set, "users") ?? {};
  if (has("roles")) {
    const before = (await deps.db.select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, id))).map((r) => r.role);
    const after = await setSecondaryRoles(deps, id, updated.role, patch.roles ?? []);
    // Recorded as a value diff like any other field: "who was given which role, when" is the question an access
    // review asks first, and the join table keeps no history of its own.
    if (before.sort().join() !== [...after].sort().join()) Object.assign(meta, { diff: { ...(meta as { diff?: object }).diff, roles: { from: before.sort(), to: [...after].sort() } } });
  }
  // Only the fields whose value actually changed (from→to), not every field the form submitted.
  await auditUpdate(deps, actor, "user.update", "users", id, Object.keys(meta).length ? meta : undefined, updated);
  return updated;
}
