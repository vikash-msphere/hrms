// Decide whether a caller may READ a specific object in ANOTHER collection than the request path - used to
// gate a cross-collection reference (e.g. generating a letter from a chosen letter-template).
// Mirrors the per-object grant merge the authz middleware does for the request item
// (src/middleware/authz.ts): role grant + everyone + the caller's per-object rules for that object, then
// decide(read). Honors per-template ACL tightening (deny-wins) exactly like a real request would.
import { decide, type Grant } from "../domain/permissions";
import { mergeGrants, rulesToGrant } from "../domain/compileGrants";
import { isSuperGrant, EVERYONE_ROLE, roleSubjectsOf } from "../domain/grants";
import { ancestorsOf } from "../domain/codes";
import { loadObjectRulesForRequest } from "./policyLoad";
import { uuidToCode } from "./authzResolve";
import type { Deps } from "../deps";
import type { AppUser } from "../env";

// May `user` read the object identified by `code` in `collection`? Pure-ish (one rules query). Returns false
// for a missing code (fail safe).
export async function canReadObjectCode(deps: Deps, user: AppUser, collection: string, code: string | null | undefined): Promise<boolean> {
  if (!code) return false;
  const roleSubjects = roleSubjectsOf(user, user.grant);
  let grant: Grant = user.grant;
  const objRules = await loadObjectRulesForRequest(deps, user.uuid, roleSubjects, collection, ancestorsOf(code));
  if (objRules.length) grant = mergeGrants(user.grant, rulesToGrant(objRules));
  return decide(grant, { kind: "standard", resource: `${collection}.${code}`, level: "read" }, { employeeCode: user.employeeCode }).allow;
}

// Convenience: resolve a uuid -> code then read-check.
export async function canReadObjectId(deps: Deps, user: AppUser, collection: string, uuid: string | null | undefined): Promise<boolean> {
  if (!uuid) return false;
  return canReadObjectCode(deps, user, collection, await uuidToCode(deps, collection, uuid));
}
