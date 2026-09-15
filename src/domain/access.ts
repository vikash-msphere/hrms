// Role-free policy queries for business logic. Instead of branching on role names
// (`["hr_admin",...].includes(actor.role)`), services/routes ask "can this actor do X" against the
// single GRANTS policy. Coarse capability checks live here; instance/scoped decisions call decide()
// directly (resolveRequest + the actor's employeeCode).
import { capabilitiesOf, decide, resolveRequest } from "./permissions";
import { hasCapability } from "./capabilityMatch";
import type { Grant, SelfContext } from "./permissions";
import type { StateRule } from "./manifests";
import type { AppUser } from "../env";

// The matching rule itself lives in domain/capabilityMatch.ts - a dependency-free leaf the SPA imports too, so
// client and server cannot answer this question differently. Re-exported here because this is where the
// server's callers already reach for it.
export { hasCapability } from "./capabilityMatch";

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
  // `deptOf`, not a second inline copy of the same split. The two had already drifted - this one derived the
  // dept itself while `actorVerbScope` below called the helper - and the whole point of the helper is that the
  // breadth of a list and the breadth of a verb over the same rows are decided from the same value.
  const dept = deptOf(actor);
  if (dept && canRead(`${dept}-${SCOPE_PROBE_LEAF}`)) return "dept"; // a sibling in the caller's dept, not the caller
  return "own";
}

// The code prefixes this actor holds an explicit SUBTREE grant on for `collection` - the `<code>-*` id token
// (`leave-requests.04-1c-*.**`), which is how "this department and everything under it" is expressed, whether
// the department is the caller's own or not.
//
// This is the one scope tier `actorScope` cannot answer, and the reason it needs its own function. The three
// breadths are all RELATIVE to the caller (everything / my department / mine), so each can be settled by one
// probe. A subtree names a place in the hierarchy that has nothing to do with where the caller sits, so there
// is no synthetic code to probe blind: `zzzzz` is under no department and `<myDept>-zzzz` is under the wrong
// one, so a grant on somebody ELSE'S department matched neither and the list collapsed to `own`. The item
// path decided such a grant correctly all along, which is the worst shape a scope can have - the caller could
// open rows their own list would never show them.
//
// So the candidates are lifted from the grant's own patterns, and that is a LOOKUP, not a decision: every
// candidate is then put back through the same `decide()` probe `actorScope` uses, one level down
// (`<prefix>-<SCOPE_PROBE_LEAF>`), and only a prefix the engine actually grants read on survives. A pattern
// the engine would not honour - a deny over the top of it, a level below read - is dropped here by the engine
// itself rather than by this function's reading of the pattern.
//
// Deny patterns are deliberately not scanned for candidates: a deny subtracts, and it already reaches the
// list through `ListScope.denies`, which applies even at `all` breadth.
// `verb` selects the lane, exactly as actorScope/actorVerbScope split: absent reads the level patterns and
// probes a GET (what a list needs), present reads the custom-method patterns and probes that verb (what a
// verb-driven aggregate like the approvals badge needs).
export function actorSubtrees(
  actor: Pick<AppUser, "grant" | "employeeCode">,
  collection: string,
  verb?: string,
  self: SelfContext = { employeeCode: actor.employeeCode ?? null },
): string[] {
  const out: string[] = [];
  const patterns = verb ? actor.grant.allow : Object.keys(actor.grant.levels);
  for (const pattern of patterns) {
    const toks = pattern.split(".");
    if (toks[0] !== collection) continue; // `**` and other namespaces cannot narrow THIS collection to a subtree
    const id = toks[1];
    // `-*` alone would be the empty prefix, which `isUnder` refuses - such a pattern matches nothing, so it is
    // no more a subtree grant than a typo is.
    if (!id || !id.endsWith("-*") || id.length <= 2) continue;
    const prefix = id.slice(0, -2);
    if (out.includes(prefix)) continue;
    // The engine's verdict, not the pattern's promise.
    const probe = `/v1/${collection}/${prefix}-${SCOPE_PROBE_LEAF}${verb ? `:${verb}` : ""}`;
    if (decide(actor.grant, resolveRequest(verb ? "POST" : "GET", probe), self).allow) out.push(prefix);
  }
  // THE MANAGER CHAIN, bound the same way. A `my-reports` / `my-org` rule reaches rows composed under a report's
  // employee code, which is exactly what a subtree means - so each report's code is offered as a candidate and
  // put through the SAME probe every other candidate takes. Without this the item lane would open a report's
  // record while the list that is supposed to contain it stopped at the caller's own rows: the split-brain grant
  // the owner key had to be invented for, one relationship along.
  //
  // The sets are empty unless the caller's grant actually uses the tokens (the middleware only loads them then),
  // so this loop costs nothing for everybody else.
  for (const code of new Set([...(self.reportCodes ?? []), ...(self.orgCodes ?? [])])) {
    if (out.includes(code)) continue;
    const probe = `/v1/${collection}/${code}-${SCOPE_PROBE_LEAF}${verb ? `:${verb}` : ""}`;
    if (decide(actor.grant, resolveRequest(verb ? "POST" : "GET", probe), self).allow) out.push(code);
  }
  return out;
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
//
// The `|| null` is the same guard `domain/permissions.ts#deptOf` carries and for the same reason: a code that
// begins with '-' splits to a leading EMPTY segment, so `"-0kf"` yields the dept `""`. That is a missing value,
// not a scope, and it must never reach a containment test as if it were one - `isUnder` refuses an empty prefix
// precisely because an empty scope prefix once meant "everything". Every consumer here happens to test the
// result for truthiness, so nothing is reachable today; the twin normalises, and a function whose declared
// return type is `string | null` should not be the one that hands out `""` instead.
export function deptOf(actor: Pick<AppUser, "employeeCode">): string | null {
  if (!actor.employeeCode) return null;
  const segs = actor.employeeCode.split("-");
  return (segs.length >= 2 ? segs.slice(0, -1).join("-") : "") || null;
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
//
// `subtrees` are the code prefixes of the caller's explicit subtree GRANTS (actorSubtrees). They OR in
// exactly like shares, and for the same reason: breadth is a single relative tier and cannot also say "and
// the whole of department 04". Unlike shares they come from the broad grant rather than per-object rows, so
// they cost no read - `scopeFor` computes them from the grant it already holds.
export type ListScope = { breadth: Scope; deptCode: string | null; ownerId: string | null; seeRestricted: boolean; shares?: string[]; denies?: string[]; subtrees?: string[] };

export function scopeFor(
  actor: Pick<AppUser, "grant" | "employeeCode" | "employeeId" | "policy">,
  collection: string,
  // The caller's matcher context. Passed in by the middleware so the manager chain (SelfContext.reportCodes /
  // orgCodes) reaches `actorSubtrees` below; defaulted so every other caller is unchanged.
  self: SelfContext = { employeeCode: actor.employeeCode ?? null },
): ListScope {
  const breadth = actorScope(actor, collection);
  return {
    breadth,
    deptCode: deptOf(actor),
    ownerId: actor.employeeId ?? null,
    seeRestricted: seeRestrictedFor(actor, collection),
    // At `all` breadth there is nothing left to widen, so the scan is skipped rather than computed and
    // discarded - this runs for every collection of every fan-out response (search, the summaries).
    subtrees: breadth === "all" ? [] : actorSubtrees(actor, collection, undefined, self),
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
  const subtrees = actorSubtrees(actor, collection, verb);
  // A subtree is authority in its own right, and `actorVerbScope` cannot see it: it returns null when the
  // caller holds the verb at none of the three RELATIVE tiers, which a subtree holder does not - so the badge
  // counted nothing for a manager granted approve over one named department.
  //
  // `own` with a NULL owner is the empty breadth, not a widening: `applyScope` answers `1 = 0` for an own
  // breadth with nothing to bind, so the subtrees below carry the whole predicate and the caller's own rows
  // are not quietly added to a queue they may not act on.
  if (!breadth && !subtrees.length) return null;
  return {
    breadth: breadth ?? "own",
    deptCode: deptOf(actor),
    ownerId: breadth ? actor.employeeId ?? null : null,
    seeRestricted: seeRestrictedFor(actor, collection),
    subtrees,
  };
}
