// Access requests: a person who hits a permission wall can ask the access admins for the missing grant
// instead of dead-ending. One notification goes to every active user whose ROLE holds access-rules.write
// (the people the manage-access UI belongs to). The verb itself (`access-rules.requestAccess`) is
// fail-closed like every custom method - an org opts in by granting it to the `everyone` role from the
// "Who can manage access" icon; nothing is opened by default.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { holdsCapability, roleHolderEmployeeIds } from "./capabilityHolders";
import { notifyMany } from "./notifications";
import { invalidArgument } from "../lib/errors";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const VERB_RE = /^[a-zA-Z]+$/;

// WHO the access admins are: active users whose ROLE grant carries access-rules.write, minus one employee
// (normally the person the message is about, who does not need to be told about their own action). The same
// list backs access requests and the four-eyes approval queue (services/accessRules.ts), which is why it is
// one function rather than two.
//
// The body of it now lives in services/capabilityHolders.ts, because this was the ONE feature that answered
// "who handles this" from the grant - the tax verifiers and the suggestion reviewers each answered it from a
// hardcoded array of role names, and got the drift that comes with one. This name stays as the spelling its
// own callers read best.
export const accessAdminEmployeeIds = (deps: Deps, exceptEmployeeId?: string | null): Promise<string[]> =>
  roleHolderEmployeeIds(deps, holdsCapability("access-rules.write"), exceptEmployeeId);

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
