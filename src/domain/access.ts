// Role-free policy queries for business logic. Instead of branching on role names
// (`["hr_admin",...].includes(actor.role)`), services/routes ask "can this actor do X" against the
// single GRANTS policy. Coarse capability checks live here; instance/scoped decisions call decide()
// directly (resolveRequest + the actor's employeeCode).
import { capabilitiesOf, decide, resolveRequest, matchTokens, LVL, deptOf as permDeptOf } from "./permissions";
import { hasCapability } from "./capabilityMatch";
import type { Grant, Level, SelfContext } from "./permissions";
import { isUnder } from "./codes";
import { isPublicState, SUBRESOURCE_BODY, type StateRule } from "./manifests";
import { COLLECTIONS } from "./collections";
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
  return probeScope(actor, collection, "GET");
}

// The same probe at a chosen level and, optionally, over a field-precise SUB-RESOURCE of the record
// (`/v1/employees/<code>/tax`) rather than the record itself. A sub-resource is its OWN gate: a broad grant on
// the base employee record does not reach it, and `employees.me.tax.**` reaches the caller's tax and nobody
// else's. Both extras exist for `callerScopes` below - nothing in a list path needs them, because a list is
// always a GET and a sub-resource has no list.
function probeScope(actor: Pick<AppUser, "grant" | "employeeCode">, collection: string, method: string, sub?: string): Scope {
  const grant = actor.grant;
  const self = { employeeCode: actor.employeeCode ?? null };
  const can = (code: string) => decide(grant, resolveRequest(method, `/v1/${collection}/${code}${sub ? `/${sub}` : ""}`), self).allow;
  if (can(SCOPE_PROBE_CODE)) return "all"; // a code under no real dept -> only an unscoped grant matches
  // `deptOf`, not a second inline copy of the same split. The two had already drifted - this one derived the
  // dept itself while `actorVerbScope` below called the helper - and the whole point of the helper is that the
  // breadth of a list and the breadth of a verb over the same rows are decided from the same value.
  const dept = deptOf(actor);
  if (dept && can(`${dept}-${SCOPE_PROBE_LEAF}`)) return "dept"; // a sibling in the caller's dept, not the caller
  return "own";
}

// The breadth of the per-entity ACTIVITY trail for one collection. Not `probeScope`: activity is not a REST
// path of its own - middleware/authz.ts decides it as a capability whose scope sits at token[1]
// (`activity.<code>.<collection>`), with the collection as the sub-resource - so the probe asks decide()
// directly, with the same synthetic codes and the same reading of the answer.
function probeActivityScope(actor: Pick<AppUser, "grant" | "employeeCode">, collection: string): Scope {
  const self = { employeeCode: actor.employeeCode ?? null };
  const can = (code: string) => decide(actor.grant, { kind: "standard", resource: `activity.${code}.${collection}`, level: "read" }, self).allow;
  if (can(SCOPE_PROBE_CODE)) return "all";
  const dept = deptOf(actor);
  if (dept && can(`${dept}-${SCOPE_PROBE_LEAF}`)) return "dept";
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

/** What the caller may reach ABOUT ONE PERSON: the collection keys, read and write. */
export type SubjectScopes = { read: string[]; write: string[] };

/**
 * For ONE named employee, everything the caller may read or write about them - decided by the engine against
 * that person's REAL code, so the answer correlates with who they are.
 *
 * THIS IS THE ONE HONEST ANSWER FOR A PER-RECORD SURFACE, and the reason `callerScopes` below cannot be it.
 * That function probes with SYNTHETIC codes (`zzzzz`, `<myDept>-zzzz`) that belong to nobody, so it can only
 * report a relative TIER - and a tier is not a relationship:
 *
 *   - `me` needs the subject's code to compare against. A tier says "own" and names nobody.
 *   - `my-reports` / `my-org` match a code in the caller's reporting chain. No synthetic code is in anybody's
 *     chain, so `callerScopes` has to report them as the blanket string `dept` - which the client then reads
 *     as "yes, about everyone", the exact opposite of what a manager-chain grant says.
 *   - a `<code>-*` SUBTREE names a branch that has nothing to do with where the caller sits.
 *   - a per-object SHARE lifts the caller on one record and no other; a tier cannot express it at all.
 *
 * Probing `<collection>.<subjectCode>-<SCOPE_PROBE_LEAF>` - a synthetic LEAF under the subject's REAL code,
 * i.e. "a row of this collection owned by this person" - makes every one of those match or not match on its
 * own terms, with no case analysis here. Owner, department, reporting chain, subtree and share are decided by
 * `decide()` exactly as a real request decides them, which is the whole point: NO POLICY LIVES HERE. Pass the
 * per-object-merged grant (`ctx.objectGrant`) and the full `SelfContext` and the shares and the chain are in.
 *
 * Emitted as the keys that ARE reachable: absent means no, so a client asking about a collection this build
 * has never heard of gets the fail-closed answer. Keys match the capability spelling - `<collection>`,
 * `employees.<sub>` for the field-precise sub-resources, `activity.<collection>` for the per-entity trail.
 */
export function subjectScopes(
  grant: Grant,
  self: SelfContext,
  subjectCode: string,
  collections: Iterable<string> = COLLECTIONS,
): SubjectScopes {
  const read: string[] = [];
  const write: string[] = [];
  // A row OWNED BY this person: their code is the parent, the synthetic leaf is the row. `me` matches it when
  // the subject is the caller, `my-dept` when they are a colleague, `my-reports`/`my-org` when they are in the
  // chain, `<code>-*` when they are under a granted branch - each on the real hierarchy, not on a guess.
  const owned = (collection: string, method: string) =>
    decide(grant, resolveRequest(method, `/v1/${collection}/${subjectCode}-${SCOPE_PROBE_LEAF}`), self).allow;
  for (const collection of collections) {
    if (owned(collection, "GET")) read.push(collection);
    if (owned(collection, "PATCH")) write.push(collection);
    // The per-entity trail, the second and independent gate. Scope sits at token[1] with the collection as the
    // sub-resource (middleware/authz.ts), so it is asked directly rather than as a REST path.
    if (decide(grant, { kind: "standard", resource: `activity.${subjectCode}.${collection}`, level: "read" }, self).allow) {
      read.push(`activity.${collection}`);
    }
  }
  // The employee record's own sub-resources hang off the PERSON rather than off a row they own, so they are
  // probed at the subject's code itself - no leaf. A broad `employees` grant never reaches these.
  for (const sub of Object.keys(SUBRESOURCE_BODY)) {
    const at = (method: string) =>
      decide(grant, resolveRequest(method, `/v1/employees/${subjectCode}/${sub}`), self).allow;
    if (at("GET")) read.push(`employees.${sub}`);
    if (at("PATCH")) write.push(`employees.${sub}`);
  }
  return { read, write };
}

/** Read and write breadth past the caller's own rows, per collection and employee sub-resource. */
export type CallerScopes = { read: Record<string, Scope>; write: Record<string, Scope> };

/**
 * Every collection - and every field-precise employee sub-resource - the caller may read or write BEYOND
 * their own rows, as the breadth the engine actually grants. THE ONE THING THE CAPABILITY SET CANNOT SAY.
 *
 * `capabilitiesOf` strips the scope token (permissions.ts stripScope), so `attendance.me.**` and
 * `attendance.**` both reach the SPA as `attendance.read`, and `employees.me.tax.**` and `employees.*.tax.**`
 * both reach it as `employees.tax.write`. That is the right answer to the question the capability set exists
 * for - "may this caller call this endpoint at all", which is what a nav item or a page gate asks - and the
 * wrong answer to the question every PER-RECORD surface asks: "may this caller reach THIS OTHER PERSON'S
 * rows". Every employee holds the self-service half of attendance, goals, reviews, payslips, the board and
 * their own bank/identity/tax, so a gate written on the stripped string is true for everybody, about
 * everybody - which is how an Edit button for somebody else's tax declarations comes to render.
 *
 * Entries at `own` are OMITTED rather than sent: absent has to read as no, so a client that has never heard
 * of a collection and a client asking about one the caller only self-serves get the same answer.
 *
 * Per-object SHARES are deliberately not folded in. They are rows in grant-exceptions, read per list request,
 * and the reach they give is one object rather than a person's record - a caller holding one finds it on the
 * collection's own page. Same for the DENIES that subtract from a breadth: this says what the grant reaches,
 * and the server re-decides every request either way, which is what keeps this a UX hint and not a gate.
 */
export function callerScopes(
  actor: Pick<AppUser, "grant" | "employeeCode">,
  self: SelfContext = { employeeCode: actor.employeeCode ?? null },
): CallerScopes {
  const read: Record<string, Scope> = {};
  const write: Record<string, Scope> = {};
  for (const collection of COLLECTIONS) {
    const r = probeScope(actor, collection, "GET");
    const w = probeScope(actor, collection, "PATCH");
    if (r !== "own") read[collection] = r;
    if (w !== "own") write[collection] = w;
    // A subtree grant (an explicit `<code>-*` rule, or the manager chain when `self` carries it) is reach past
    // the caller's own rows that no relative tier can express. It is reported as `dept` because that is the
    // shape of it - a branch of the hierarchy, not the whole org - and because a client asking "may I reach
    // somebody else's" only needs to know it is not `own`. One scan answers both lanes: `actorSubtrees` probes
    // a GET, so a write-only subtree grant is not claimed here.
    if (r === "own" && actorSubtrees(actor, collection, undefined, self).length > 0) read[collection] = "dept";
    // The record's ACTIVITY trail is a second, independent gate with a scope of its own, and it is stripped the
    // same way: `activity.me.**` (my own trail) and `activity.**` (everybody's) both reach the SPA as
    // `activity.<collection>.read`. An Activity tab gated on that string renders on every colleague's record
    // for a caller granted only their own - the tab the two-gate check can then only answer empty. Keyed
    // `activity.<collection>`, the spelling the stripped capability already uses. Private by default (no
    // seeded role holds activity at all), so for most callers this adds no key.
    const a = probeActivityScope(actor, collection);
    if (a !== "own") read[`activity.${collection}`] = a;
  }
  // The employee record's sub-resources (`/v1/employees/<code>/<sub>`), each gated by its own patterns and
  // reached by no grant on the base record. Keyed `employees.<sub>` - the spelling the stripped capability
  // already uses - so one key shape answers for both.
  for (const sub of Object.keys(SUBRESOURCE_BODY)) {
    const r = probeScope(actor, "employees", "GET", sub);
    const w = probeScope(actor, "employees", "PATCH", sub);
    if (r !== "own") read[`employees.${sub}`] = r;
    if (w !== "own") write[`employees.${sub}`] = w;
  }
  return { read, write };
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
  // One definition of "public", shared with the list predicate (domain/manifests.ts isPublicState).
  const isPublic = isPublicState(state, rule);
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

// ---- The bound on what an access admin may hand out ------------------------------------------------------
//
// assertNotSelfWidening (services/accessRules.ts) stops an access admin granting THEMSELVES more; nothing
// stopped them granting it to somebody else, or cloning super's rules onto another role. Delegating the ACL
// was therefore delegating super by proxy, one step removed. The bound: a non-super author may write an allow
// rule only when their own grant already COVERS it, at that level (or that verb), at that breadth.
//
// Coverage is decided PATTERN AGAINST PATTERN rather than by probing one synthetic key, because a rule is a
// set of keys and one probe answers for one of them: `employees.*.bank-account.**` read and `employees.me.**`
// read agree on the probe `employees.zzzzz` and disagree about everybody's bank details.
//
// Relative scopes cover only themselves (or what `*`/`**` covers): `me` in the author's grant means the
// author's own rows and `me` in the rule means the grantee's own - the same relation, so one covers the other.
// `my-dept` in the author's grant does not cover the grantee's `me`, because nothing in the pattern puts the
// grantee in the author's department.
function scopeCovers(pt: string, rt: string, self: SelfContext): boolean {
  if (pt === rt) return true;
  if (pt === "*") return rt !== "**";
  if (rt === "me" || rt === "my-dept" || rt === "my-reports" || rt === "my-org" || rt === "*" || rt === "**") return false;
  if (rt.endsWith("-*")) {
    const prefix = rt.slice(0, -2);
    if (pt.endsWith("-*")) return isUnder(pt.slice(0, -2), prefix);
    if (pt === "me") return !!self.employeeCode && isUnder(self.employeeCode, prefix);
    if (pt === "my-dept") {
      const d = permDeptOf(self.employeeCode);
      return !!d && isUnder(d, prefix);
    }
    return false;
  }
  // A literal: a collection, sub-resource or verb name, or an exact code. The engine's own token match answers
  // it, with the author as the caller (an exact code under the author's own code is theirs).
  return matchTokens([pt], [rt], self);
}

function patternCovers(p: string[], pi: number, r: string[], ri: number, self: SelfContext): boolean {
  if (pi >= p.length) return ri >= r.length;
  if (p[pi] === "**") {
    for (let i = ri; i <= r.length; i++) if (patternCovers(p, pi + 1, r, i, self)) return true;
    return false;
  }
  if (ri >= r.length) return false;
  if (!scopeCovers(p[pi]!, r[ri]!, self)) return false;
  return patternCovers(p, pi + 1, r, ri + 1, self);
}

/** Do two patterns share any key? Deliberately generous: a deny that touches a rule anywhere refuses it. */
const overlaps = (a: string[], b: string[], self: SelfContext) => patternCovers(a, 0, b, 0, self) || patternCovers(b, 0, a, 0, self);

/**
 * May this author write an allow rule with `pattern` at `level` (a standard rule) or, with no level, the
 * custom-method rule `pattern` (its last token is the verb)? Deny rules only ever subtract, so they are within
 * anyone's authority and are not asked about here.
 */
export function ruleWithinAuthority(actor: Pick<AppUser, "grant" | "employeeCode">, rule: { pattern: string; level?: Level | null }): boolean {
  const self: SelfContext = { employeeCode: actor.employeeCode ?? null };
  const grant = actor.grant;
  const level = rule.level ?? null;
  const toks = rule.pattern.split(".");
  // An all-scope verb rule is stored as `<collection>.**.<verb>` (services/accessRules.ts buildPattern): the
  // item form and the collection-level form at once, since the ACL cannot tell which one a verb has. Holding
  // the form that exists is holding the verb, so each form is asked about on its own.
  const forms = !level && toks.length === 3 && toks[1] === "**" ? [[toks[0]!, toks[2]!], [toks[0]!, "*", toks[2]!]] : [toks];
  const covered = (f: string[]) =>
    level
      ? Object.entries(grant.levels).some(([p, lvl]) => LVL[lvl] >= LVL[level] && patternCovers(p.split("."), 0, f, 0, self))
      : grant.allow.some((p) => patternCovers(p.split("."), 0, f, 0, self));
  const denied = (f: string[]) => (grant.deny ?? []).some((d) => overlaps(d.split("."), level ? [...f, level] : f, self));
  return forms.some((f) => covered(f) && !denied(f));
}

/**
 * May this caller administer the sign-in account with this code - the engine's answer for
 * `PATCH /v1/users/<code>` on the caller's own grant? For an edit to something else that would move an account as
 * a side effect (services/employees.ts: a work-email change re-pointing the login).
 */
export function mayAdministerAccount(actor: Pick<AppUser, "grant" | "employeeCode">, userCode: string): boolean {
  return decide(actor.grant, resolveRequest("PATCH", `/v1/users/${userCode}`), { employeeCode: actor.employeeCode ?? null }).allow;
}
