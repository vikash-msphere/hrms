import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { notFound, aborted, invalidArgument, oneOf } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { EVERYONE_ROLE } from "../domain/grants";

export type UserInput = { role?: string; status?: string; employee?: string | null };

const STATUSES = ["active", "disabled"] as const;
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

export async function listUsers(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string) {
  const all = (await deps.db.select().from(schema.users)).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
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
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");

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

  // Self-lockout guard: an admin cannot strip their own super_admin role or disable themselves.
  if (row.uuid === actor.uuid) {
    if (has("role")) throw invalidArgument("you cannot change your own role");
    if (has("status") && patch.status !== "active") throw invalidArgument("you cannot disable your own account");
  }

  const updated = (await deps.db.update(schema.users).set(set).where(eq(schema.users.uuid, id)).returning())[0]!;
  // Only the fields whose value actually changed (from→to), not every field the form submitted.
  await audit(deps, actor, "user.update", "users", id, diffMeta(row, updated, set), updated);
  return updated;
}
