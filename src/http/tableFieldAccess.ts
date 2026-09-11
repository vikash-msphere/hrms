// The two authz questions a custom grid asks that a list scope cannot answer: may this caller read this
// employee's PII sub-resource on THIS row, and may they see a masked value unmasked.
//
// Lives in src/http for the same reason fieldAccess.ts and accessHint.ts do: the decision is rendered by the
// engine's own `decide()`, never re-implemented, and this is the layer allowed to call it (a service is not -
// see test/singleSource.test.ts). It can only NARROW: the request has already been authorized by the
// middleware by the time a runner calls any of this.
import { decide, resolveRequest, type Grant, type SelfContext } from "../domain/permissions";
import type { AppUser } from "../env";
import { deniedFieldKeys } from "./fieldAccess";

/**
 * Which of `keys` this caller may NOT read under `employees.<code>.<subresource>`.
 *
 * Two decisions, in the order the profile endpoint takes them: the sub-resource itself (no read on
 * `employees.<code>.identity` hides every identity field on that row), then each field under it. Both are
 * pure in-memory matches - a page of 100 people costs zero extra reads.
 *
 * `null` code (a row with no hierarchy code) denies everything: an access decision needs a scope key, and
 * missing one fails closed.
 */
export function deniedSubresourceKeys(
  grant: Grant,
  code: string | null | undefined,
  subresource: string,
  keys: string[],
  self: SelfContext,
): Set<string> {
  if (!code) return new Set(keys);
  if (!decide(grant, { kind: "standard", resource: `employees.${code}.${subresource}`, level: "read" }, self).allow) {
    return new Set(keys);
  }
  return deniedFieldKeys(grant, "employees", code, subresource, keys, self);
}

/**
 * Does this caller hold `unmask` - the virtual capability that turns a masked PAN or a masked account number
 * into the real value?
 *
 * Decided as the other virtual capabilities are (the middleware decides `tax-verifications` exactly so): the
 * request a real `GET /v1/unmask` would resolve to. Private by default - no seeded grant names `unmask`, so
 * only super passes until an admin grants it, and the per-field read above still has to allow as well.
 */
export function canUnmask(user: AppUser): boolean {
  return decide(user.grant, resolveRequest("GET", "/v1/unmask"), { employeeCode: user.employeeCode }).allow;
}
