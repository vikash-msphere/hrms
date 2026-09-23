// WHO to tell, decided from the GRANT rather than from a list of role names.
//
// Several features have to notify "the people who handle this": the access admins when somebody asks for a
// permission, the tax verifiers when a prior-employer declaration lands, the reviewers when a suggestion is
// submitted. Each of those had written its own answer, and two of the three had written it as a literal:
//
//     const TAX_VERIFIER_ROLES = ["hr_admin", "payroll_admin", "super_admin"];
//
// which is exactly the shape domain/access.ts exists to remove ("instead of branching on role names, ask
// whether this actor can do X"). Branching on names is wrong in both directions and silently: a custom role
// granted the capability is never told, and a seeded role that has since had it revoked goes on being told.
// Neither shows up as an error - a notification that should have been sent simply is not one.
//
// They had also each written the same full-table read: `select employeeId, role from users` with the filtering
// done in JS. `users` has a row per person who has ever signed in, D1 bills rows READ, and both of these run
// on an ordinary write path. The query below names the roles it wants and asks the database for those.
//
// NOT AN ACCESS DECISION, in any of its callers - it chooses recipients. The gate on the action itself is the
// authz middleware, as always (test/singleSource.test.ts's rule is about the engine, and the engine is what
// this asks). Getting it wrong sends a bell to the wrong desk; it opens nothing.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { capabilitiesOf, decide, type Grant, type Level } from "../domain/permissions";
import { hasCapability, SCOPE_PROBE_CODE } from "../domain/access";
import { loadRoleGrant } from "../lib/policyLoad";

/**
 * The employee ids of every ACTIVE user whose ROLE grant satisfies `holds`, minus one employee (normally the
 * actor, who does not need to be told about their own action).
 *
 * Roles are the enumeration axis because they are the only bounded one: the table is a handful of rows and
 * every grant behind it is cached (loadRoleGrant), so warm this costs no query at all before the single
 * `users` read at the end.
 *
 * USER-SCOPED grants are deliberately not walked. They would only ever ADD recipients - a person holding the
 * capability through their own rule still sees the queue, they just do not get the bell - and finding them
 * means reading `access_rules` for every user-subject rule in the namespace and compiling each one, which is
 * a real cost on a write path to cover a case the ACL UI treats as an exception. The asymmetry is worth
 * stating rather than discovering: if a deployment starts granting these through user rules, this is the
 * function that has to learn about it.
 */
export async function roleHolderEmployeeIds(deps: Deps, holds: (grant: Grant) => boolean, exceptEmployeeId?: string | null): Promise<string[]> {
  const roles = await deps.db.select({ name: schema.roles.name }).from(schema.roles);
  const holders: string[] = [];
  for (const r of roles) {
    if (holds(await loadRoleGrant(deps, r.name))) holders.push(r.name);
  }
  if (holders.length === 0) return [];
  const recipients = await deps.db
    .select({ emp: schema.users.employeeId })
    .from(schema.users)
    .where(and(inArray(schema.users.role, holders), eq(schema.users.status, "active"), isNotNull(schema.users.employeeId)));
  return [...new Set(recipients.map((r) => r.emp!).filter((e) => e !== exceptEmployeeId))];
}

/**
 * Coarse, SCOPE-STRIPPED: does this grant carry `<collection>.<action>` for at least one scope? The same
 * question the client's `<Can>` gating asks, and the right one for a collection whose rows are not code-scoped
 * at all - `access-rules` has no `code` column, so "for some scope" and "for every row" are the same sentence.
 */
export const holdsCapability = (capability: string) => (grant: Grant): boolean => hasCapability(capabilitiesOf(grant), capability);

/**
 * SCOPE-AWARE: may this grant act on SOMEBODY ELSE'S row - anyone's, not just its own or its department's?
 *
 * The distinction is the whole point for these queues. `employees.me.tax.**: write` is in OWN_PII, so EVERY
 * employee in the org holds the scope-stripped capability `employees.tax.write` for their own record - ask the
 * coarse question above and the "tax verifiers to notify" becomes the entire company. The probe is the same
 * one domain/access.ts uses to measure list breadth: a code under no department that belongs to nobody, asked
 * with an EMPTY self-context so `me` and `my-dept` cannot match either. What is left matching is an unscoped
 * grant, which is exactly the authority the queue is about.
 */
const NOBODY = { employeeCode: null };
export const holdsForAnyone = (resource: string, level: Level) => (grant: Grant): boolean =>
  decide(grant, { kind: "standard", resource: resource.replace("*", SCOPE_PROBE_CODE), level }, NOBODY).allow;

/** The same question for a CUSTOM METHOD: may this grant run `<collection>.<verb>` on anyone's row? */
export const holdsVerbForAnyone = (resource: string, verb: string) => (grant: Grant): boolean =>
  decide(grant, { kind: "custom", resource: resource.replace("*", SCOPE_PROBE_CODE), verb }, NOBODY).allow;
