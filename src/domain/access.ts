// Role-free policy queries for business logic. Instead of branching on role names
// (`["hr_admin",...].includes(actor.role)`), services/routes ask "can this actor do X" against the
// single GRANTS policy. Coarse capability checks live here; instance/scoped decisions call decide()
// directly (resolveRequest + the actor's employeeCode).
import { capabilitiesOf, decide, resolveRequest } from "./permissions";
import type { Grant, SelfContext } from "./permissions";
import type { StateRule } from "./manifests";
import type { AppUser } from "../env";

// Same matching as the frontend hasCapability (web/src/lib/perm.ts): exact "collection.action", with the
// super_admin wildcard ("**.<action>" / "**.**") and a collection's wildcard-verb rule ("<collection>.**")
// as match-all for the cases they cover.
const LEVELS = new Set(["read", "write", "admin"]);
export function hasCapability(caps: string[], capability: string): boolean {
  if (caps.includes(capability)) return true;
  const action = capability.split(".").pop() ?? "";
  if (caps.includes(`**.${action}`) || caps.includes("**.**")) return true;
  // A wildcard-verb rule (access rule verb:"*" - every custom method of one collection) becomes the capability
  // `<collection>.**`, so asking about one of those verbs by name must answer yes. It says nothing about the
  // read/write/admin ladder, which is a level grant and a separate rule.
  const dot = capability.lastIndexOf(".");
  return dot > 0 && !LEVELS.has(action) && caps.includes(`${capability.slice(0, dot)}.**`);
}

// Coarse, scope-stripped capability check for the actor, computed from the grant carried on the actor (so
// it honors runtime policy with no role-keyed cache to go stale). For per-object/scoped decisions use decide().
export function actorCan(actor: Pick<AppUser, "grant">, capability: string): boolean {
  return hasCapability(capabilitiesOf(actor.grant), capability);
}

export type Scope = "all" | "dept" | "own";

// The synthetic codes the two scope probes below ask decide() about. They are NOT real rows, and the breadth of
// every list in the app rests on that: a grant that reads `<collection>.<SCOPE_PROBE_CODE>` can only be an
// UNSCOPED one, because the probe code is under no department and belongs to nobody.
//
// Two properties make it safe, and test/scopeProbeSentinel.test.ts pins both:
//   - the allocator cannot mint it. A code segment is a base32 counter left-padded with '0' (domain/codes.ts
//     padSeg), so a 5-char segment that does not begin with '0' is the minimal encoding of its value - and
//     `zzzzz` is 32^5-1, i.e. the 33,554,432nd row of one namespace.
//   - it carries no '-', so it cannot be any SCOPED code either: a dept/employee/owner-scoped code is composed
//     as `<parent>-<seg>` and always has two or more segments.
// If either ever stopped holding, a real object could BE the probe, and a per-object share on that one row
// would report `all` - every row of the collection - for the caller who holds it.
export const SCOPE_PROBE_CODE = "zzzzz";
// The leaf appended to a real parent code (`<dept>-zzzz`, `<employeeCode>-zzzz`) to probe the narrower tiers.
// Same argument one level down: a 4-char leaf not starting with '0' is 32^4-1 rows into that parent's scope.
export const SCOPE_PROBE_LEAF = "zzzz";

// How broadly the actor may READ a collection's rows, DERIVED FROM THE GRANT (not role names), by
// probing decide() with synthetic codes: a code under no dept (only an unscoped grant reads it -> all),
// a sibling under the caller's own dept (a my-dept grant reads it -> dept), else own. Drives list
// WHERE clauses so visibility lives in the grant policy, one place, and tightens/loosens there.
export function actorScope(actor: Pick<AppUser, "grant" | "employeeCode">, collection: string): Scope {
  const grant = actor.grant;
  const self = { employeeCode: actor.employeeCode ?? null };
  const canRead = (code: string) => decide(grant, resolveRequest("GET", `/v1/${collection}/${code}`), self).allow;
  if (canRead(SCOPE_PROBE_CODE)) return "all"; // a code under no real dept -> only an unscoped grant matches
  const dept = actor.employeeCode ? actor.employeeCode.split("-").slice(0, -1).join("-") : "";
  if (dept && canRead(`${dept}-${SCOPE_PROBE_LEAF}`)) return "dept"; // a sibling in the caller's dept, not the caller
  return "own";
}

// How broadly the actor may perform a CUSTOM VERB on a collection's rows - the same synthetic-code probe as
// actorScope, run against `POST /v1/<collection>/<code>:<verb>`. Unlike read, there is no separate gate above
// this (a verb aggregate is not a list request), so "own" is PROBED rather than assumed: a caller with no
// approve grant at all gets null and the collection contributes nothing.
export function actorVerbScope(actor: Pick<AppUser, "grant" | "employeeCode">, collection: string, verb: string): Scope | null {
  const grant = actor.grant;
  const self = { employeeCode: actor.employeeCode ?? null };
  const canVerb = (code: string) => decide(grant, resolveRequest("POST", `/v1/${collection}/${code}:${verb}`), self).allow;
  if (canVerb(SCOPE_PROBE_CODE)) return "all"; // a code under no real dept -> only an unscoped grant matches
  const dept = deptOf(actor);
  if (dept && canVerb(`${dept}-${SCOPE_PROBE_LEAF}`)) return "dept"; // a sibling in the caller's dept, not the caller
  // `me` matches a code UNDER the caller's employee code (matchToken), which is how owned rows are addressed.
  if (actor.employeeCode && canVerb(`${actor.employeeCode}-${SCOPE_PROBE_LEAF}`)) return "own";
  return null;
}

// The caller's department code (their employee code minus its own last segment), or null.
export function deptOf(actor: Pick<AppUser, "employeeCode">): string | null {
  if (!actor.employeeCode) return null;
  const segs = actor.employeeCode.split("-");
  return segs.length >= 2 ? segs.slice(0, -1).join("-") : null;
}

// May the caller see a state-gated collection's NON-public rows (drafts/disabled)? Derived from the grant
// + the manifest's state rule: with no rule there is nothing restricted (true); otherwise the caller needs
// the rule's `requires` level on the collection (the editors). A decision, made here, not in the service.
function seeRestrictedFor(actor: Pick<AppUser, "grant" | "employeeCode" | "policy">, collection: string): boolean {
  const rule = actor.policy.state_visibility?.[collection];
  if (!rule) return true;
  return decide(actor.grant, { kind: "standard", resource: collection, level: rule.requires }, { employeeCode: actor.employeeCode ?? null }).allow;
}

// Pure item-read gate for a state-gated collection: a row in its `public_when` state is readable by the
// resource grant (return true); a non-public row (draft/disabled) needs `requires` on the item. The row
// state is passed in (it rode the id->code resolve), so this stays pure. Used by the authz middleware.
export function stateReadAllowed(grant: Grant, itemResource: string, state: Record<string, unknown>, rule: StateRule, self: SelfContext): boolean {
  const isPublic = Object.entries(rule.public_when).every(([k, v]) => Boolean(state[k]) === v);
  if (isPublic) return true;
  return decide(grant, { kind: "standard", resource: itemResource, level: rule.requires }, self).allow;
}

// The resolved list scope for a (caller, collection): the breadth + the values a WHERE needs + whether
// restricted (draft/disabled) rows are visible. The middleware computes this once and sets it on the
// request context; the service binds it to columns via applyScope and decides nothing. This is how list
// visibility leaves the service while staying a decision.
// `shares`/`denies` are the caller's per-object exception codes for this collection (grant-exceptions),
// loaded by the middleware for list requests: shares OR into the breadth, denies AND-NOT out (deny-wins,
// mirroring the item path). Exact codes only - applyScope binds them with IN / NOT IN (no SQL prefix).
export type ListScope = { breadth: Scope; deptCode: string | null; ownerId: string | null; seeRestricted: boolean; shares?: string[]; denies?: string[] };

export function scopeFor(actor: Pick<AppUser, "grant" | "employeeCode" | "employeeId" | "policy">, collection: string): ListScope {
  return {
    breadth: actorScope(actor, collection),
    deptCode: deptOf(actor),
    ownerId: actor.employeeId ?? null,
    seeRestricted: seeRestrictedFor(actor, collection),
  };
}

// The scope of the rows a caller may run a custom VERB on - the shape applyScope binds, so a verb-driven
// aggregate (the approvals badge counts rows the caller may `approve`) filters by the same rules a real
// request would decide. Null when the caller holds the verb at no scope: there is nothing to count.
export function verbScopeFor(
  actor: Pick<AppUser, "grant" | "employeeCode" | "employeeId" | "policy">,
  collection: string,
  verb: string,
): ListScope | null {
  const breadth = actorVerbScope(actor, collection, verb);
  if (!breadth) return null;
  return { breadth, deptCode: deptOf(actor), ownerId: actor.employeeId ?? null, seeRestricted: seeRestrictedFor(actor, collection) };
}
