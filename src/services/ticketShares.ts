// Category-based ticket visibility, done with ACL data only (no engine change). A category's viewers
// (its assignee + configured members) get a per-object READ share on each ticket in that category - the same
// `access_rules` row shape the ACL UI writes (`createAccessRule`), so the middleware already honors it for
// both the list (scope.shares) and the item GET (merged grant). Shares are written on create and maintained
// on reassign. The requester is NOT shared here - they see their own ticket via the existing owner scope. A
// category's servicing ROLES get more than read, on the same per-object lane (see "Servicing roles" below).
//
// Every row this file writes is marked `source: "ticket-share"`, and every row it deletes is matched on that
// mark. Without it the revoke could not tell its own share from a grant a person authored in the ACL modal on
// the same ticket - the two rows are identical - so a routine reassign silently destroyed the hand-authored
// one, at whatever level it granted. See the column's note in db/schema.ts.
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { deriveNarrowing } from "../domain/compileGrants";
import { clearCache, clearCachePrefix } from "../lib/cache";
import { byIdChunks, insertBatches, runBatch } from "../lib/dbBatch";

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

// The rows this machinery owns for one (ticket, user): its own shares, never anybody's authored rule.
const ownRule = (pattern: string, userUuid: string) => and(
  eq(schema.accessRules.subject, userUuid),
  eq(schema.accessRules.subjectKind, "user"),
  eq(schema.accessRules.pattern, pattern),
  eq(schema.accessRules.effect, "allow"),
  eq(schema.accessRules.source, "ticket-share"),
);

export async function grantTicketRead(deps: Deps, actor: AppUser, ticketCode: string, userUuid: string) {
  const pattern = readPattern(ticketCode);
  const dup = (await deps.db
    .select({ id: schema.accessRules.uuid })
    .from(schema.accessRules)
    .where(ownRule(pattern, userUuid))
    .limit(1))[0];
  if (dup) return; // already shared
  const n = deriveNarrowing(pattern);
  const [row] = await deps.db.insert(schema.accessRules).values({
    subject: userUuid,
    subjectKind: "user",
    namespace: n.namespace,
    pattern,
    scopeKind: n.scopeKind,
    scopeCode: n.scopeCode,
    matchCode: n.scopeKind === "exact" ? n.scopeCode : null,
    level: "read",
    effect: "allow",
    source: "ticket-share",
  }).returning();
  // Audited like any other change to who may read a record. Every ACL-authored rule write audits; these did
  // not, so "why can this person no longer see the ticket" had no answer in the trail at all.
  await audit(deps, actor, "ticket-share.grant", "access-rules", row!.uuid, { subject: `users/${userUuid}`, pattern, level: "read", source: "ticket-share" }, row!);
  clearCache(`userGrant:${userUuid}`); // bust the member's cached grant so the share takes effect promptly
  clearCachePrefix("objRules:"); // the share IS a per-object rule: drop the cached per-caller slices too
}

export async function revokeTicketRead(deps: Deps, actor: AppUser, ticketCode: string, userUuid: string) {
  const pattern = readPattern(ticketCode);
  const [removed] = await deps.db.delete(schema.accessRules).where(ownRule(pattern, userUuid)).returning();
  if (!removed) return; // nothing of ours to revoke (an authored rule on the same ticket is not ours to touch)
  await audit(deps, actor, "ticket-share.revoke", "access-rules", removed.uuid, { subject: `users/${userUuid}`, pattern, level: removed.level, source: "ticket-share" }, removed);
  clearCache(`userGrant:${userUuid}`);
  clearCachePrefix("objRules:");
}

// Share a ticket (read) with each of the given employees' user accounts.
export async function shareTicketWith(deps: Deps, actor: AppUser, ticketCode: string, employeeIds: (string | null | undefined)[]) {
  for (const u of await usersForEmployees(deps, employeeIds)) await grantTicketRead(deps, actor, ticketCode, u);
}

// ---- Servicing roles -----------------------------------------------------------------------------------------
// A category's `roles` SERVICE every ticket filed under it, where its members only read them. No role rule can
// say "the IT tickets": a ticket's code is its requester's (allocOwnedCode), so the category is in no token a
// pattern matches. What a role gets instead is, on each ticket, the pair hr_admin's help-desk rules amount to on
// one ticket: `tickets.<code>.**` at `write`, and the same pattern as a verb rule (level NULL, every verb). Both
// are EXACT role rules, so they ride the per-object lane (lib/policyLoad.ts objectRulesFor): the list shows the
// ticket through the caller's shares, the item and its verbs pass on the merged rule, and nobody holding the
// role pays for them on any other request. Membership is the role's, read at decision time, so a person given
// or stripped of the role gains or loses the queue with no share to rewrite.
//
// Marked `source: "ticket-share"` like the read shares, for the same reason: the revoke must never delete a rule
// an admin authored on the same ticket for the same role.
const roleRule = (role: string) => and(
  eq(schema.accessRules.subject, role),
  eq(schema.accessRules.subjectKind, "role"),
  eq(schema.accessRules.effect, "allow"),
  eq(schema.accessRules.source, "ticket-share"),
);

function roleServiceRows(ticketCode: string, role: string) {
  const pattern = readPattern(ticketCode);
  const n = deriveNarrowing(pattern);
  const base = {
    subject: role,
    subjectKind: "role" as const,
    namespace: n.namespace,
    pattern,
    scopeKind: n.scopeKind,
    scopeCode: n.scopeCode,
    matchCode: n.scopeKind === "exact" ? n.scopeCode : null,
    effect: "allow" as const,
    source: "ticket-share" as const,
  };
  return [{ ...base, level: "write" as const }, { ...base, level: null }];
}

/** Give `role` the servicing pair on each ticket. Idempotent: a pair (or half of one) already held is skipped. */
export async function serviceTicketsByRole(deps: Deps, actor: AppUser, ticketCodes: string[], role: string) {
  if (!ticketCodes.length) return;
  const patterns = [...new Set(ticketCodes)].map(readPattern);
  const held = await byIdChunks(patterns, (group) =>
    deps.db.select({ pattern: schema.accessRules.pattern, level: schema.accessRules.level }).from(schema.accessRules).where(and(roleRule(role), inArray(schema.accessRules.pattern, group))),
  );
  const have = new Set(held.map((r) => `${r.pattern}|${r.level}`));
  const rows = [...new Set(ticketCodes)].flatMap((c) => roleServiceRows(c, role)).filter((r) => !have.has(`${r.pattern}|${r.level}`));
  if (!rows.length) return;
  await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.accessRules).values(group)));
  // One entry per call rather than per row: a category given a role on a live queue writes two rows per ticket,
  // and the question the trail answers is "when did this role get these tickets", which is one event.
  await audit(deps, actor, "ticket-share.grantRole", "roles", role, { subject: `roles/${role}`, tickets: rows.length / 2, level: "write", source: "ticket-share" });
  clearCachePrefix("objRules:");
}

/** Take the servicing pair back from `role` on each ticket. Touches only rows this machinery wrote. */
export async function unserviceTicketsByRole(deps: Deps, actor: AppUser, ticketCodes: string[], role: string) {
  if (!ticketCodes.length) return;
  const patterns = [...new Set(ticketCodes)].map(readPattern);
  const removed = await byIdChunks(patterns, (group) =>
    deps.db.delete(schema.accessRules).where(and(roleRule(role), inArray(schema.accessRules.pattern, group))).returning({ uuid: schema.accessRules.uuid }),
  );
  if (!removed.length) return;
  await audit(deps, actor, "ticket-share.revokeRole", "roles", role, { subject: `roles/${role}`, rules: removed.length, source: "ticket-share" });
  clearCachePrefix("objRules:");
}
