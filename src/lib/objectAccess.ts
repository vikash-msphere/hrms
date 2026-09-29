// Decide whether a caller may READ a specific object in ANOTHER collection than the request path - used to
// gate a cross-collection reference (e.g. generating a letter from a chosen letter-template).
// Mirrors the per-object grant merge the authz middleware does for the request item
// (src/middleware/authz.ts): role grant + everyone + the caller's per-object rules for that object, then
// decide(read). Honors per-template ACL tightening (deny-wins) exactly like a real request would.
import { decide, type Grant } from "../domain/permissions";
import { mergeGrants, rulesToGrant } from "../domain/compileGrants";
import { isSuperGrant, EVERYONE_ROLE, roleSubjectsOf } from "../domain/grants";
import { ancestorsOf } from "../domain/codes";
import { loadObjectRulesForRequest, loadRoleGrant, loadUserGrant } from "./policyLoad";
import { uuidToCode } from "./authzResolve";
import { selfContextOf } from "./selfContext";
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
  // The request's own matcher context, for the reason lib/selfContext.ts#selfContextOf gives: this decides a
  // ROW, so a context rebuilt from the employee code cannot match a grant that reaches it through the
  // reporting line and the cross-collection reference is refused to somebody a real request would allow.
  return decide(grant, { kind: "standard", resource: `${collection}.${code}`, level: "read" }, selfContextOf(user)).allow;
}

/**
 * Does the caller hold `level` on EVERY object of `collection` - an org-wide rule, not a share on some of them?
 * Asked of the wildcard key `<collection>.*`: only a wildcard pattern matches the token `*`, so no rule naming
 * one code (a board share, a per-record share) can answer yes. A caller with no grant (a system actor) holds
 * nothing.
 */
export function holdsEveryObject(user: Pick<AppUser, "grant" | "self" | "employeeCode">, collection: string, level: "read" | "write"): boolean {
  if (!user.grant) return false;
  return decide(user.grant, { kind: "standard", resource: `${collection}.*`, level }, selfContextOf(user)).allow;
}

/**
 * What the caller may do to ONE board as a single word - manage it, work its tasks, or see it - over the grant
 * the request carries. Board access is all subtree rules on the board's code (domain/boardAccess.ts), so the
 * caller's grant already holds every rule that decides it. An affordance for the page (the `my_access` field),
 * never a gate: every request on the board is decided by the middleware.
 */
export function boardAccessLevel(user: Pick<AppUser, "grant" | "self" | "employeeCode"> | undefined, boardCode: string | null | undefined): "manage" | "edit" | "view" | undefined {
  if (!user?.grant || !boardCode) return undefined;
  const self = selfContextOf(user);
  const may = (collection: string, level: "read" | "write") => decide(user.grant, { kind: "standard", resource: `${collection}.${boardCode}`, level }, self).allow;
  if (may("boards", "write")) return "manage";
  if (may("cards", "write")) return "edit";
  return may("boards", "read") ? "view" : undefined;
}

/**
 * `boardAccessLevel` over the caller's grant as the DATABASE holds it now, not as the request loaded it. For a
 * write that has just changed the caller's own board rules (creating a board makes its creator a manager;
 * editing the sharing list may add or drop them): the request's grant predates those rows, so its answer would
 * be the one from before the write.
 */
export async function freshBoardAccessLevel(deps: Deps, user: AppUser, boardCode: string | null | undefined): Promise<"manage" | "edit" | "view" | undefined> {
  if (!user.grant || !boardCode) return undefined;
  const roles = user.roles?.length ? [...user.roles] : [user.role];
  const grants = await Promise.all([...roles.map((r) => loadRoleGrant(deps, r)), loadUserGrant(deps, user.uuid)]);
  return boardAccessLevel({ ...user, grant: grants.reduce(mergeGrants) }, boardCode);
}

// Convenience: resolve a uuid -> code then read-check.
export async function canReadObjectId(deps: Deps, user: AppUser, collection: string, uuid: string | null | undefined): Promise<boolean> {
  if (!uuid) return false;
  return canReadObjectCode(deps, user, collection, await uuidToCode(deps, collection, uuid));
}
