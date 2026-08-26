// Category-based ticket visibility, done with ACL data only (no engine change). A category's viewers
// (its assignee + configured members) get a per-object READ share on each ticket in that category - the same
// `access_rules` row shape the ACL UI writes (`createAccessRule`), so the middleware already honors it for
// both the list (scope.shares) and the item GET (merged grant). Shares are written on create and maintained
// on reassign. The requester is NOT shared here - they see their own ticket via the existing owner scope.
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { deriveNarrowing } from "../domain/compileGrants";
import { clearCache, clearCachePrefix } from "../lib/cache";

// An exact per-object read grant on one ticket, byte-identical to what `createAccessRule` produces for a
// `scope:exact, level:read` user rule (pattern `tickets.<code>.**`).
const readPattern = (code: string) => `tickets.${code}.**`;

// The user accounts behind a set of employee ids (skips employees with no login). De-duped.
export async function usersForEmployees(deps: Deps, employeeIds: (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const rows = await deps.db.select({ uuid: schema.users.uuid }).from(schema.users).where(inArray(schema.users.employeeId, ids));
  return rows.map((r) => r.uuid);
}

export async function grantTicketRead(deps: Deps, ticketCode: string, userUuid: string) {
  const pattern = readPattern(ticketCode);
  const dup = (await deps.db
    .select({ id: schema.accessRules.uuid })
    .from(schema.accessRules)
    .where(and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user"), eq(schema.accessRules.pattern, pattern), eq(schema.accessRules.effect, "allow")))
    .limit(1))[0];
  if (dup) return; // already shared
  const n = deriveNarrowing(pattern);
  await deps.db.insert(schema.accessRules).values({
    subject: userUuid,
    subjectKind: "user",
    namespace: n.namespace,
    pattern,
    scopeKind: n.scopeKind,
    scopeCode: n.scopeCode,
    matchCode: n.scopeKind === "exact" ? n.scopeCode : null,
    level: "read",
    effect: "allow",
  });
  clearCache(`userGrant:${userUuid}`); // bust the member's cached grant so the share takes effect promptly
  clearCachePrefix("objRules:"); // the share IS a per-object rule: drop the cached per-caller slices too
}

export async function revokeTicketRead(deps: Deps, ticketCode: string, userUuid: string) {
  const pattern = readPattern(ticketCode);
  await deps.db.delete(schema.accessRules).where(and(
    eq(schema.accessRules.subject, userUuid),
    eq(schema.accessRules.subjectKind, "user"),
    eq(schema.accessRules.pattern, pattern),
    eq(schema.accessRules.effect, "allow"),
  ));
  clearCache(`userGrant:${userUuid}`);
  clearCachePrefix("objRules:");
}

// Share a ticket (read) with each of the given employees' user accounts.
export async function shareTicketWith(deps: Deps, ticketCode: string, employeeIds: (string | null | undefined)[]) {
  for (const u of await usersForEmployees(deps, employeeIds)) await grantTicketRead(deps, ticketCode, u);
}
