// Access requests: a person who hits a permission wall can ask the access admins for the missing grant
// instead of dead-ending. One notification goes to every active user whose ROLE holds access-rules.write
// (the people the manage-access UI belongs to). The verb itself (`access-rules.requestAccess`) is
// fail-closed like every custom method - an org opts in by granting it to the `everyone` role from the
// "Who can manage access" icon; nothing is opened by default.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { holdsCapability, roleHolderEmployeeIds } from "./capabilityHolders";
import { notifyMany } from "./notifications";
import { audit } from "../lib/audit";
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

// A temporary request ("I need payroll write for this afternoon") is a different ask from a permanent one,
// and the difference only reaches the admin if the requester can say it. Capped at a fortnight: past that it
// is not break-glass, it is a grant, and should be authored as one with its own review.
const MAX_REQUEST_HOURS = 24 * 14;

export async function requestAccess(
  deps: Deps,
  user: AppUser,
  body: { collection?: string; verb?: string; note?: string; hours?: number },
): Promise<{ notified: number }> {
  const collection = body.collection ?? "";
  if (!NAME_RE.test(collection)) throw invalidArgument("invalid collection");
  if (body.verb !== undefined && !VERB_RE.test(body.verb)) throw invalidArgument("invalid verb");
  const note = typeof body.note === "string" ? body.note.slice(0, 500).trim() : "";
  let hours: number | undefined;
  if (body.hours !== undefined && body.hours !== null) {
    const h = Number(body.hours);
    if (!Number.isFinite(h) || h <= 0 || h > MAX_REQUEST_HOURS) throw invalidArgument(`hours must be between 1 and ${MAX_REQUEST_HOURS}`);
    hours = Math.round(h);
  }
  const what = `${body.verb ? `the "${body.verb}" method on ` : "access to "}${collection}`;
  const forHow = hours ? ` for the next ${hours} hour${hours === 1 ? "" : "s"}` : "";

  // AUDITED, not just notified. A request is somebody asking for privilege, which is exactly the kind of
  // event an access trail exists to hold - and until now it left no row at all: if every admin ignored the
  // notification, or it was cleared, nothing anywhere recorded that the ask had been made. The reason is
  // recorded with it, because "why did this person get payroll write in March" is the question a reviewer
  // actually asks, and the answer was only ever in a notification body.
  await audit(deps, user, "access-request.raised", "access-rules", undefined, {
    collection,
    ...(body.verb ? { verb: body.verb } : {}),
    ...(hours ? { hours } : {}),
    ...(note ? { note } : {}),
    sentence: `asked for ${what}${forHow}`,
  });

  const empIds = await accessAdminEmployeeIds(deps, user.employeeId);
  if (empIds.length === 0) return { notified: 0 };
  await notifyMany(deps, empIds, {
    type: "access.requested",
    title: `${user.name || user.email} is asking for access`,
    body: `${user.email} asked for ${what}${forHow}.${note ? ` "${note}"` : ""} Turn on access mode and open a key icon on that page to grant it${hours ? ", and set the expiry when you do" : ""}.`,
    link: collection,
    actorId: user.employeeId,
  });
  return { notified: empIds.length };
}
