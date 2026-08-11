// Access requests: a person who hits a permission wall can ask the access admins for the missing grant
// instead of dead-ending. One notification goes to every active user whose ROLE holds access-rules.write
// (the people the manage-access UI belongs to). The verb itself (`access-rules.requestAccess`) is
// fail-closed like every custom method - an org opts in by granting it to the `everyone` role from the
// "Who can manage access" icon; nothing is opened by default.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { capabilitiesOf } from "../domain/permissions";
import { hasCapability } from "../domain/access";
import { loadRoleGrant } from "../lib/policyLoad";
import { notifyMany } from "./notifications";
import { invalidArgument } from "../lib/errors";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const VERB_RE = /^[a-zA-Z]+$/;

// WHO the access admins are: active users whose ROLE grant carries access-rules.write, minus one employee
// (normally the person the message is about, who does not need to be told about their own action). Recipient
// selection, never an access decision on a caller - the same list backs access requests and the four-eyes
// approval queue (services/accessRules.ts), which is why it lives here as one function instead of twice.
// User-scoped grants of the capability are rare enough to skip (they would only ADD recipients).
export async function accessAdminEmployeeIds(deps: Deps, exceptEmployeeId?: string | null): Promise<string[]> {
  const roles = await deps.db.select({ name: schema.roles.name }).from(schema.roles);
  const adminRoles: string[] = [];
  for (const r of roles) {
    if (hasCapability(capabilitiesOf(await loadRoleGrant(deps, r.name)), "access-rules.write")) adminRoles.push(r.name);
  }
  if (adminRoles.length === 0) return [];
  const recipients = await deps.db
    .select({ emp: schema.users.employeeId })
    .from(schema.users)
    .where(and(inArray(schema.users.role, adminRoles), eq(schema.users.status, "active"), isNotNull(schema.users.employeeId)));
  return [...new Set(recipients.map((r) => r.emp!).filter((e) => e !== exceptEmployeeId))];
}

export async function requestAccess(deps: Deps, user: AppUser, body: { collection?: string; verb?: string; note?: string }): Promise<{ notified: number }> {
  const collection = body.collection ?? "";
  if (!NAME_RE.test(collection)) throw invalidArgument("invalid collection");
  if (body.verb !== undefined && !VERB_RE.test(body.verb)) throw invalidArgument("invalid verb");
  const note = typeof body.note === "string" ? body.note.slice(0, 500).trim() : "";

  const empIds = await accessAdminEmployeeIds(deps, user.employeeId);
  if (empIds.length === 0) return { notified: 0 };
  await notifyMany(deps, empIds, {
    type: "access.requested",
    title: `${user.name || user.email} is asking for access`,
    body: `${user.email} asked for ${body.verb ? `the "${body.verb}" method on ` : "access to "}${collection}.${note ? ` "${note}"` : ""} Turn on access mode and open a key icon on that page to grant it.`,
    link: `#/${collection}`,
    actorId: user.employeeId,
  });
  return { notified: empIds.length };
}
