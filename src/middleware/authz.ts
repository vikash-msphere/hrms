// Authz middleware — the SOLE access gate, fail-closed. It computes the path-based Decision and BLOCKS on
// anything that is not an explicit { allow: true }: a deny, a null decision, an unresolved path/id, a
// missing user, or any thrown error all return 403 (generic message; the reason is logged server-side,
// never returned - plan 11P). There is no `require_` backstop - this is it. Private by default.
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import { forbidden } from "../lib/errors";
import { resolveRequest, decide, denyingPattern, withOwnerResource, deptOf, type Decision, type Grant } from "../domain/permissions";
import { scopeFor, verbScopeFor, stateReadAllowed, type ListScope } from "../domain/access";
import { buildCodedPath, uuidToCode, resolveItemState, RESOURCE_COLLECTIONS, LIST_OWNER_COLUMNS, OWNER_COLUMN_COLLECTIONS } from "../lib/authzResolve";
import { loadObjectRulesForRequest, loadObjectExceptionCodes, loadObjectExceptionCodesFor } from "../lib/policyLoad";
import { SEARCHABLE_COLLECTIONS } from "../domain/searchIndex";
import { DASHBOARD_SUMMARY_COLLECTIONS } from "../domain/dashboardSummary";
import { ATTENTION_COLLECTIONS } from "../domain/attention";
import { ANALYTICS_COLLECTIONS } from "../domain/peopleAnalytics";
import { TABLE_SOURCE_COLLECTIONS } from "../domain/tableFields";
import { APPROVAL_SUMMARY_COLLECTIONS, TAX_VERIFICATION_QUEUE } from "../domain/approvalsSummary";
import { ancestorsOf, isUnder } from "../domain/codes";
import { mergeGrants, rulesToGrant } from "../domain/compileGrants";
import { isSuperGrant, roleSubjectsOf } from "../domain/grants";
import { inScope } from "../domain/keyScope";
import { isModeratable } from "../domain/moderation";
// Which collections actually offer the `?force` hard purge. Written by the collection factory as each
// collection is mounted, and every route module is imported at load (src/index.ts) - so the set is complete
// before any request is served.
import { hasForcePurge } from "../http/collectionRoute";
import { accessAudit, mutationAudit } from "../domain/auditAccess";
import { DEFAULT_POLICY, subresourceBodyKey } from "../domain/manifests";
import { audit } from "../lib/audit";
import { isJsonBody } from "../http/jsonRequest";
import { queryParam } from "../http/query";
import { selfContextFor, selfContextOf } from "../lib/selfContext";
import { guardAllows, conditionFieldsOf, windowFieldsOf, type GuardContext } from "../domain/ruleCondition";

// Field-level + reference access control on write bodies (docs/archive/plan.txt 11C). For a POST/PATCH whose
// resource-level write already passed, each PROTECTED field present in the body needs write on
// `<collection>.<code>.<field>`, and each declared reference present needs its level on the target's
// code. This is the single place mass-assignment / self-escalation / cross-object refs are gated, so
// services need no inline field guards. Body refs are already decoded to internal ids by the inbound
// edge. Fail-closed on an unresolved reference; a missing/non-JSON/unparseable body adds no constraint.

// The most records one bulk envelope (`{ items: [...] }`) may carry through the field/reference gate. It is a
// CPU bound on what a single request can make this middleware decide, not a route limit - every bulk route
// caps its own list far below (`ASSET_BATCH_MAX` is 100), and a body over this is denied outright rather than
// gated in part. Raise it only alongside a route that genuinely needs a longer list.
const BULK_ITEMS_MAX = 200;

// Touched top-level field NAMES from a JSON write body (names only — never values, matching the audit policy).
// Enriches the write-backstop's generic activity row so the feed can say WHAT changed ("updated · title, status")
// instead of a bare path. The body is already parsed + cached by the handler (and bodyDecision), so this re-read
// costs nothing; capped so a huge payload can't bloat a row. Empty for non-JSON / non-object bodies.
async function touchedFieldNames(c: Context<AppEnv>): Promise<string[]> {
  const m = c.req.method.toUpperCase();
  if (m !== "POST" && m !== "PATCH" && m !== "PUT") return [];
  if (!isJsonBody(c.req.header("content-type"))) return [];
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return [];
    return Object.keys(body).filter((k) => body[k] !== undefined).slice(0, 12);
  } catch {
    return [];
  }
}

// The serialized resource a mutating handler returned (its JSON response body), for the write-backstop's
// point-in-time entity label. Reads a CLONE so the client's response stream is untouched. Null for empty/204/
// non-JSON responses (e.g. DELETE) — those either carry no record or were already inline-audited with the row.
async function responseResource(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    if (!c.res.headers.get("content-type")?.includes("application/json")) return null;
    const body = await c.res.clone().json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The collection a `/v1` path names, with a COLLECTION-LEVEL custom method's verb stripped off.
 *
 * `/v1/announcements:markAllRead` names the collection `announcements`; `announcements:markAllRead` is not a
 * collection and is a key no registry in the app holds. This file derived that name in three places and one of
 * them kept the verb - the resolution block, whose value then went to `hasForcePurge()` and to
 * `policy.state_visibility[…]`, so both silently answered "no" for every collection-level verb in the app.
 * Nothing is reachable through it as the routes stand (such a request has no item to state-gate, and `force`
 * only lifts a DELETE), which is precisely why it could sit there: it is one rule, so it gets one
 * implementation rather than three spellings of which two happen to be right.
 */
function collectionOf(pathname: string): string {
  const first = pathname.replace(/^\/v1\//, "").split("?")[0]!.split("/").filter(Boolean)[0] ?? "";
  const verbAt = first.indexOf(":");
  return verbAt >= 0 ? first.slice(0, verbAt) : first;
}

async function bodyDecision(c: Context<AppEnv>, deps: Deps, coded: string, user: AppUser, grant: Grant): Promise<Decision | null> {
  const method = c.req.method.toUpperCase();
  if (method !== "POST" && method !== "PATCH" && method !== "PUT") return null;
  const segs = coded.replace(/^\/v1\//, "").split("?")[0]!.split("/").filter(Boolean);
  // A custom method carries its verb in the LAST path segment, and the gate is about the COLLECTION and the
  // OBJECT, never the verb - so it is split off. Both halves matter:
  //   - a collection-level method (`assets:batchCreate`) otherwise reads as the collection name
  //     "assets:batchCreate", which is in no policy map, so the gate returned null and the bulk-items loop
  //     below - written for exactly that route - never ran on it.
  //   - an item-level method (`assets/<code>:verify`) otherwise reads as the code "<code>:verify", so a
  //     protected field in a verb body is gated on a resource that no grant can match. Fail-closed rather
  //     than open, but it denies the caller who does hold the field grant.
  const collection = collectionOf(coded);
  const code = segs[1]?.split(":")[0]; // resource code (or "me"); undefined on create
  const fields = user.policy.protected_fields[collection] ?? [];
  const refs = user.policy.references[collection] ?? {};
  const ownerRefs = user.policy.owner_refs[collection] ?? {};
  // A write to a field-bearing sub-resource (employees/<code>/identity|bank-account|personal-info) gates
  // each body field per `<collection>.<code>.<sub>.<key>` write - the write half of field-level control.
  const sub = segs.length === 3 ? segs[2]!.split(":")[0]! : null;
  const subBodyKey = sub ? subresourceBodyKey(sub) : null;
  if (fields.length === 0 && Object.keys(refs).length === 0 && Object.keys(ownerRefs).length === 0 && subBodyKey === null) return null;

  // A DECLARED REF CARRIED IN THE QUERY STRING IS STILL THAT REF.
  //
  // This gate used to return early on anything that was not a JSON body, which quietly made the owner-on-create
  // check a property of the CONTENT TYPE rather than of the request. `personal-documents:uploadForm16` files a
  // document for `?employee=<ref>` with the raw PDF as the body, so it took the early return and never ran -
  // while its sibling `:generateForm16`, which files the same document for the same person through a JSON
  // body, was gated. Two routes, one authorization question, two answers, decided by how the bytes happened to
  // be shaped. Exposure today is nil (a collection-level verb key is two tokens, so only an org-wide grant
  // reaches either route, and for such a caller filing across owners is the intent) - but this is the single
  // place cross-owner creates are stopped, and "unless the payload is a PDF" is not a rule anyone would write.
  //
  // So the declared refs are collected from the query string as well, and gated identically. Only keys the
  // policy already NAMES for this collection are read, so nothing else about the query is interpreted here.
  // READ THROUGH http/query.ts, like every other parameter this middleware decides from. That file states the
  // rule and names `force` as the case that proved it: the app has two query parsers that do not agree about
  // a fragment, and a gate reading one while the handler reads the other is how `#?force=true` was gated as a
  // soft delete and executed as a hard purge. These keys are a gate input too - they decide whether a caller
  // may file a record under someone else's ownership - so they are read by the parser the rest of the gate
  // uses, rather than being the one reader in this file exempt from its own rule.
  const declared = [...Object.keys(refs), ...Object.keys(ownerRefs)];
  const fromQuery: Record<string, unknown> = {};
  for (const key of declared) {
    const v = queryParam(c, key);
    if (typeof v === "string" && v.length > 0) fromQuery[key] = v;
  }

  // The request's own matcher context. This gate decides `<collection>.<code>.<field>` and the owner key -
  // both per ROW - so rebuilt from the employee code alone it refused a caller whose write grant reaches the
  // row through `my-reports` / `my-org`, while the resource-level decision a few lines down allowed it. Same
  // seam as the read side (lib/selfContext.ts#selfContextOf); the caller was stamped with it above.
  const self = selfContextOf(user);
  // JSON-FAMILY, not just `application/json`: an Update arrives as `application/merge-patch+json`, so a
  // substring test for `application/json` skipped this entire gate on every PATCH in the app (see
  // http/jsonRequest.ts). Every lane that decides whether a body exists asks the same predicate.
  let body: Record<string, unknown> = {};
  if (isJsonBody(c.req.header("content-type"))) {
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {}; // not parseable as JSON -> the validator will reject it; no field to gate
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  }
  // Protected fields, declared references and the owner-on-create gate, over ONE record's worth of body.
  const gateRecord = async (rec: Record<string, unknown>): Promise<Decision | null> => {
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(rec, f)) {
        const resource = code ? `${collection}.${code}.${f}` : `${collection}.${f}`;
        const d = decide(grant, { kind: "standard", resource, level: "write" }, self);
        if (!d.allow) return { allow: false, reason: `field "${f}": ${d.reason}` };
      }
    }
    for (const [field, spec] of Object.entries(refs)) {
      const v = rec[field];
      if (typeof v === "string" && v.length > 0) {
        const refCode = await uuidToCode(deps, spec.collection, v.split("/").pop()!);
        if (!refCode) return { allow: false, reason: `unresolved reference "${field}"` };
        const d = decide(grant, { kind: "standard", resource: `${spec.collection}.${refCode}`, level: spec.level }, self);
        if (!d.allow) return { allow: false, reason: `reference "${field}": ${d.reason}` };
      }
    }
    // Owner-on-create (closes BOLA gap A): a body owner field assigns who the NEW resource belongs to. The
    // caller must be allowed to create under that owner - write on `<collection>.<ownerCode>` (own via `me`,
    // or an admin with that owner's namespace). Absent field => owned by the caller (the service default),
    // which the resource-level write grant already covers.
    for (const [field, spec] of Object.entries(ownerRefs)) {
      const v = rec[field];
      if (typeof v === "string" && v.length > 0) {
        const ownerCode = await uuidToCode(deps, spec.collection, v.split("/").pop()!);
        if (!ownerCode) return { allow: false, reason: `unresolved owner "${field}"` };
        const d = decide(grant, { kind: "standard", resource: `${collection}.${ownerCode}`, level: "write" }, self);
        if (!d.allow) return { allow: false, reason: `owner "${field}": ${d.reason}` };
      }
    }
    return null;
  };
  // The query-carried refs first: on the one route that uses them there is no JSON body to gate at all, and
  // where both are present a ref may legitimately appear in either.
  if (Object.keys(fromQuery).length) {
    const deniedQuery = await gateRecord(fromQuery);
    if (deniedQuery) return deniedQuery;
  }
  const denied = await gateRecord(body);
  if (denied) return denied;
  // A BULK body (`{ items: [ …one record each… ] }`, as `assets:batchCreate` takes) is many records in one
  // request, so the same gates apply to each of them. Without this, wrapping a record in an envelope would be
  // a way to write a protected field or reference something unreadable - the gates would only ever look at the
  // envelope.
  //
  // The ceiling REFUSES rather than skips. It used to `slice(0, BULK_ITEMS_MAX)`, which walks the first N and
  // lets everything after them through ungated - the one outcome this loop exists to prevent, reachable by
  // sending N+1 records. It never fired (the widest route cap in the app is ASSET_BATCH_MAX = 100, and each
  // route's own schema rejects a longer list before any handler sees it), so the fail-open direction was
  // invisible and would have stayed invisible until some later collection was given a larger cap. A body over
  // the ceiling is not a request any route accepts, so denying it costs nothing and cannot fail open; the
  // number stays as the explicit bound on what one request may make this gate do.
  if (Array.isArray(body.items)) {
    if (body.items.length > BULK_ITEMS_MAX) return { allow: false, reason: `bulk body carries more than ${BULK_ITEMS_MAX} items` };
    for (const item of body.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const itemDenied = await gateRecord(item as Record<string, unknown>);
      if (itemDenied) return itemDenied;
    }
  }
  // Per-field write gate on a sub-resource: each key PRESENT in the field map needs write on
  // `<collection>.<code>.<sub>.<key>`. A field with no field-specific rule rides the broad sub-resource write
  // grant (engine `**` match) - inherit by default; an explicit per-field deny blocks just that key.
  if (subBodyKey !== null && code) {
    const map = subBodyKey === "" ? body : (body[subBodyKey] as Record<string, unknown> | undefined);
    if (map && typeof map === "object") {
      for (const key of Object.keys(map)) {
        const d = decide(grant, { kind: "standard", resource: `${collection}.${code}.${sub}.${key}`, level: "write" }, self);
        if (!d.allow) return { allow: false, reason: `field "${sub}.${key}": ${d.reason}` };
      }
    }
  }
  // NULL, not `{ allow: true }`. The caller folds this in as `decision = (await bodyDecision(…)) ?? decision`,
  // so a bare allow REPLACES the resource-level decision - and with it the `via` pattern that authorized the
  // request, which lib/audit.ts stamps on every row the handler then writes. "Nothing here objects" is what
  // this returns, and null is how it says so without discarding the answer it was narrowing.
  return null;
}

// Aggregate ROUTES: transports that own no rows and grant nothing, answering over many collections at once.
// The envelope is open to any authenticated caller and the real gating happens per collection inside (see
// scopesForCollections / approvalScopesFor), which is why they are exempt from the collection-level decision
// and from its per-object exception read. Listed once, because a transport added to only some of the three
// places that consult this would be half-gated.
const AGGREGATE_ROUTES = new Set(["search", "dashboard-summary", "people-analytics", "approvals-summary", "activity-counts", "changes", "attention"]);

/**
 * ITEM-level custom methods whose handler LISTS OTHER RECORDS, mapped to the collection those records are in.
 *
 * Almost every custom method acts on the one record its path names, which is why the scope block below does
 * not pay for an exception read on them - `announcements:markRead` fires on dwell, and a D1 read per scroll is
 * not a cost this app can carry. These four are the exceptions: each answers with rows OTHER than the one it
 * was called on, re-decided in SQL through `applyScope`.
 *
 * TWO THINGS WERE WRONG WITHOUT THIS MAP, and they are separate.
 *
 * The denies. `applyScope` can only subtract the denies it is handed (services/listScope.ts), and the block
 * below loaded them for collection LISTS only - so on these paths `scope.denies` was always empty and a record
 * an ACL deny explicitly hides from somebody came back to them anyway: a neighbouring suggestion or ticket
 * with its title and its numbers, and a review with its attainment. A deny is the one half of a scope that
 * must never soften, and it was softening on exactly the surfaces that go looking for records nobody named.
 *
 * The collection. The scope is computed for the collection in the PATH, which for `review-cycles:variablePay`
 * is `review-cycles` while the rows it binds are `reviews` (services/variablePay.ts). The handler's own comment
 * says reviews are read through the caller's reviews scope; it was being handed the cycle's. Naming the target
 * here is what makes that sentence true, and it keeps the deciding in this middleware rather than letting a
 * service resolve a second scope for itself.
 *
 * Adding a verb that reads `c.get("scope")` without adding it here is the drift this guards, so
 * test/scopedVerbDrift.test.ts holds these keys against the route files.
 */
export const SCOPE_READING_VERBS = new Map<string, string>([
  ["suggestions:similar", "suggestions"], // other suggestions asking the same thing (services/suggestionSimilar.ts)
  ["tickets:triage", "tickets"], // the resolved neighbours a routing suggestion is voted from (services/ticketTriage.ts)
  ["cards:triage", "cards"], // the delivered neighbours a card's filing suggestion is voted from (services/cardTriage.ts)
  ["review-cycles:variablePay", "reviews"], // every review in the cycle, priced (services/variablePay.ts)
  ["review-cycles:award", "reviews"], // the same lines, then paid
]);

// Per-collection list verdicts for a fan-out envelope (`GET /v1/search`, `GET /v1/dashboard-summary`): for
// every named collection, run the very same decision a real `GET /v1/<collection>` would get here, and where
// it passes, resolve that collection's list scope (breadth + the caller's per-object shares/denies).
// Collections the caller may not list are simply absent from the map, so the consuming service can never
// query them. The exceptions for all of them are read once, not once per collection.
export async function scopesForCollections(deps: Deps, user: AppUser, collections: readonly string[]): Promise<Map<string, ListScope>> {
  // Same context the item lane decides with, so a fan-out (search, the summaries, the table builder) scopes a
  // manager's collections exactly as a plain list of one of them would. Cached, so this is free once warm.
  const self = await selfContextFor(deps, user);
  const listable = collections.filter((col) => decide(user.grant, resolveRequest("GET", `/v1/${col}`), self).allow);
  const out = new Map<string, ListScope>();
  if (listable.length === 0) return out;
  const roleSubjects = roleSubjectsOf(user, user.grant);
  const exceptions = await loadObjectExceptionCodesFor(deps, user.uuid, roleSubjects, listable);
  for (const col of listable) {
    const scope = scopeFor(user, col, self);
    const exc = exceptions.get(col);
    scope.shares = exc?.shares ?? [];
    scope.denies = exc?.denies ?? [];
    out.set(col, scope);
  }
  return out;
}

export const searchScopesFor = (deps: Deps, user: AppUser) => scopesForCollections(deps, user, SEARCHABLE_COLLECTIONS);

// Which collections this caller may LIST, as names only (`GET /v1/changes` answers with collection names, not
// rows). The boolean half of scopesForCollections, decided by the same `decide()` a real list request gets -
// and, because no rows are involved, it needs neither a scope nor the per-object exception read. `settings` is
// included because it is an audited, cached collection like any other, even though it is not code-scoped.
export function listableCollectionsFor(user: AppUser): Set<string> {
  const self = { employeeCode: user.employeeCode };
  const all = [...RESOURCE_COLLECTIONS, "settings"];
  return new Set(all.filter((col) => decide(user.grant, resolveRequest("GET", `/v1/${col}`), self).allow));
}

// Per-queue APPROVE verdicts for the approvals badge (`GET /v1/approvals-summary`). Same shape as the two
// fan-outs above, one axis over: the decision is the custom verb `approve`, not a list read, because the badge
// counts what the caller may DECIDE ON. A queue the caller holds `approve` in at no scope is absent from the
// map, so the service can never count it.
//
// Per-object SHARES are deliberately not merged in: a list row's `access.can` hint is computed from the role
// grant (http/accessHint.ts), so an object-level share has never put a row in this badge. Denies still apply -
// a denied subtree is out of the caller's list, so it cannot be in their queue either.
export async function approvalScopesFor(deps: Deps, user: AppUser): Promise<Map<string, ListScope>> {
  const out = new Map<string, ListScope>();
  const approvable: string[] = [];
  for (const col of APPROVAL_SUMMARY_COLLECTIONS) {
    const scope = verbScopeFor(user, col, "approve");
    if (!scope) continue;
    out.set(col, scope);
    approvable.push(col);
  }
  if (!approvable.length) return out;
  const roleSubjects = roleSubjectsOf(user, user.grant);
  const exceptions = await loadObjectExceptionCodesFor(deps, user.uuid, roleSubjects, approvable);
  for (const col of approvable) out.get(col)!.denies = exceptions.get(col)?.denies ?? [];
  return out;
}

/**
 * A denial the resolution block DECIDED, raised as a throw only because it has to unwind out of the middle of
 * the lane structure below.
 *
 * The lanes are a chain of `if/else if/else` that each assign `decision`, so a gate sitting ABOVE them cannot
 * simply assign and fall through - the lane it lands in would overwrite the verdict. Throwing skips them; this
 * type is how the catch tells "we decided no" apart from "we could not decide", which are the same fail-closed
 * ANSWER but very different events, and the reason string is what separates them in the log and in the
 * `access.denied` audit row.
 */
class AuthzDenied extends Error {
  constructor(readonly denyReason: string) {
    super(denyReason);
  }
}

export const authz: MiddlewareHandler<AppEnv> = async (c, next) => {
  let decision: Decision | null = null;
  // How to re-ask THIS request's access question of a different grant, set by the lane that decided it. Used
  // only by the view-as containment check below; stays null on the lanes that decide nothing concrete.
  // A holder rather than a bare `let`, because every assignment happens inside a nested closure and narrowing
  // would otherwise settle it at `null` for the reader below.
  //
  // `guardCtx` is what the THRESHOLD axis was measured against on this request (the row's guarded columns, the
  // caller's address, the clock), kept so the containment check can put the real caller's guards to the very
  // same facts rather than re-reading the row.
  const contain: {
    reDecide: ((grant: Grant, employeeCode: string | null) => Decision) | null;
    guardCtx: GuardContext | null;
  } = { reDecide: null, guardCtx: null };
  let pathname = "";
  try {
    const user = c.get("user");
    if (user) {
      const deps = c.get("deps");
      const url = new URL(c.req.url);
      pathname = url.pathname;
      // Per-request client metadata for the audit trail (this user object is request-scoped; audit() reads it).
      // `cf-connecting-ip` ONLY - the address Cloudflare itself observed, which a client cannot set (the edge
      // overwrites any value it is handed). `x-forwarded-for` used to be the fallback and it is caller-supplied
      // text: on this path it decides the IP written into the audit trail, so a caller could choose the address
      // recorded against their own actions. Behind the edge that header never won anyway (cf-connecting-ip is
      // always present), so the fallback bought nothing and only ever applied where the app is NOT behind
      // Cloudflare - exactly the deployment where it is forgeable. No address is better than a chosen one; the
      // column is already nullable for the callers that legitimately have none (cron, internal dispatch).
      // Same rule the attendance clock's network fence follows (routes/attendance.ts).
      user.reqMeta = { ip: c.req.header("cf-connecting-ip") ?? undefined, ua: c.req.header("user-agent") ?? undefined };
      // One trace for the whole request, so every audit entry it writes is recognisable as ONE act. Minted
      // here and not in audit(): the workflow engine reads `deps.trace` too (emitEvent treats a set trace as
      // "already inside an execution"), so an event this request emits, the automation it runs and the writes
      // that automation makes all inherit the request's id instead of each starting a trace of their own.
      // Never overwritten - an internal apiCall re-dispatch reuses this Deps and belongs to the outer act.
      deps.trace ??= crypto.randomUUID();
      // Reset the per-request audit flag (batch reuses one shared user object across sub-requests). audit() sets
      // it true when the handler logs its own activity row; the write backstop after next() reads it to dedupe.
      user.audited = false;
      // The matcher context for this request. Carries the caller's reporting line when - and only when -
      // their grant uses the manager-chain tokens, so `my-reports` / `my-org` decide with real data and
      // everybody else pays nothing (lib/selfContext.ts).
      const self = await selfContextFor(deps, user);
      // Published on the context so a handler can put the SAME question to the engine the middleware just
      // decided with - `domain/access.ts subjectScopes` needs the reporting chain to answer "may I see this
      // person's goals", and resolving it a second time would be a second read. Read-only to handlers: it
      // decides nothing on its own, it is the context a decision is made IN.
      c.set("self", self);
      // ...and on the CALLER too, for the surfaces that decide about a row while holding only an AppUser: the
      // access hint, the field redaction every serialized resource passes through, and the grid's per-cell
      // gate. Each of those rebuilt the context as `{ employeeCode }`, which cannot match `my-reports` or
      // `my-org` - so a manager reaching their team through the chain got the row and neither its redacted
      // fields nor its verbs. Same trick, and for the same reason, as `reqMeta` above: the alternative is
      // threading the context through every serializer signature in the app.
      user.self = self;
      // Set by whichever lane below decides a CONCRETE request, so the view-as containment check after the
      // try/catch can put the identical question to the real caller's grant. See the check for why it is a
      // closure rather than the resolved request itself (the activity lane asks two questions, not one).
      const decidedAs = (fn: (grant: Grant, employeeCode: string | null) => Decision) => void (contain.reDecide = fn);
      const collection = collectionOf(pathname);
      // `?force=true` is the hard purge, and it is what lifts a DELETE from `write` to `admin`. It only lifts
      // it where the purge EXISTS: a collection whose delete is already permanent ignores the parameter
      // outright (collectionRoute's DELETE handler), so escalating there would refuse a caller their own
      // delete over a purge that is not on offer - which is how a `compensation` DELETE held at `write`
      // answered 403 for `?force=true` and 204 without it.
      const force = url.searchParams.get("force") === "true" && hasForcePurge(collection);

      // ---- API-key ceiling ---------------------------------------------------------------------------
      // A key's scope has ALREADY narrowed user.grant at auth time, which is what makes every grant-derived
      // answer below correct (list scopes, search scopes, capability hints). This is the second, independent
      // gate on the request itself, and it is not redundant: the lanes below merge per-object exception rules
      // onto the grant at decision time (mergeGrants, further down), and that merge can re-widen past the
      // ceiling. Checking the resolved request here means no merge can ever escape it.
      //
      // Deliberately no exemption for the transports (search, dashboard-summary, activity, batch). A key
      // scoped to specific collections simply cannot use them; one scoped to "*" can, subject to max_level.
      // Uniform beats special-cased when the thing being decided is authority.
      if (user.apiKey) {
        // Resolved off the raw pathname: the collection token and the level/verb do not depend on the
        // id -> code substitution that the coded path below performs.
        const asked = resolveRequest(c.req.method, pathname, force);
        // `AuthzDenied`, not `forbidden`: this is a DECISION, and the catch below turns it back into one. It
        // used to throw the HTTP error, which the catch swallowed into `decision = null` - so the request was
        // still refused (fail-closed held), but the reason was replaced by "unresolved request" in both the
        // DENY log and the `access.denied` audit row. A key acting outside its scope is the single most
        // load-bearing entry that row can carry, and it was the one case that could not be read back.
        if (!inScope(asked, user.apiKey.scope)) throw new AuthzDenied("outside api key scope");
      }

      // Global search: `search` is a TRANSPORT, not a resource - it owns no data and widens nothing, like the
      // /v1/batch:run envelope. So the ENVELOPE is allowed for any authenticated caller, and the real gating
      // happens per collection, below, in searchScopesFor() - still here, in the one place that decides.
      if (AGGREGATE_ROUTES.has(collection)) {
        // dashboard-summary is the same shape: an aggregate envelope over many collections, each gated below
        // (scopesForCollections) by the exact decision its own list request would get. approvals-summary too,
        // with `approve` as the per-queue decision instead of a list read; activity-counts likewise, with a
        // list read per collection, exactly like search. `changes` answers with collection NAMES, so its
        // per-collection gate is the same list decision reduced to a boolean (below).
        decision = { allow: true };
      // Activity feed: GET /v1/activity?resource=<entity>/<id> is gated by READ on the TARGET resource —
      // decided HERE (the single gate), not on the `activity` capability. The service only queries rows.
      } else if (collection === "activity") {
        const resource = url.searchParams.get("resource") ?? "";
        // No ?resource = the ORG-WIDE feed. Gate on the `audit` capability (super-only by default); it grants
        // no data of its own beyond the audit trail, so a plain resource-level read decides it.
        if (!resource) {
          decision = decide(user.grant, { kind: "standard", resource: "audit", level: "read" }, self);
        } else {
        const si = resource.indexOf("/");
        const tEntity = si >= 0 ? resource.slice(0, si) : "";
        const tId = si >= 0 ? resource.slice(si + 1) : "";
        const tCode = tEntity && tId ? await uuidToCode(deps, tEntity, tId) : null;
        if (!tCode) {
          decision = { allow: false, reason: "activity: unresolved target resource" };
        } else {
          const roleSubjects = roleSubjectsOf(user, user.grant);
          let g: Grant = user.grant;
          const objRules = await loadObjectRulesForRequest(deps, user.uuid, roleSubjects, tEntity, ancestorsOf(tCode));
          if (objRules.length) g = mergeGrants(user.grant, rulesToGrant(objRules));
          c.set("objectGrant", g);
          // TWO-GATE: seeing a record's activity trail needs (1) READ on the record AND (2) the independent
          // `activity` capability covering it. Read stays NECESSARY (never leak activity for an unreadable
          // record); the activity grant only narrows. Resource `activity.<code>.<collection>` puts the scope at
          // token[1] and the collection as a sub-resource, so `activity.my-dept.**` / `activity.*.<col>` /
          // `activity.me.**` all narrow via the standard engine. Activity uses the caller's BROAD grant (role +
          // everyone + user rules); per-object activity shares are not a thing (the read gate carries objects).
          // BOTH gates, as one closure, so the containment check below asks the real caller the same two
          // questions rather than only the first: the broad grant is the right one to put to them (per-object
          // activity shares are not a thing, exactly as above).
          const bothGates = (grant: Grant, employeeCode: string | null): Decision => {
            const asThem = { employeeCode };
            const read = decide(grant, { kind: "standard", resource: `${tEntity}.${tCode}`, level: "read" }, asThem);
            return read.allow ? decide(grant, { kind: "standard", resource: `activity.${tCode}.${tEntity}`, level: "read" }, asThem) : read;
          };
          decidedAs(bothGates);
          const readDec = decide(g, { kind: "standard", resource: `${tEntity}.${tCode}`, level: "read" }, self);
          decision = !readDec.allow
            ? readDec
            : decide(user.grant, { kind: "standard", resource: `activity.${tCode}.${tEntity}`, level: "read" }, self);
        }
        }
      } else {
      const stateRule = user.policy.state_visibility?.[collection];

      // Resolve the top id -> code. For a state-gated collection, or one whose rows are flat-coded with an owner
      // column, the SAME read also returns the row's public-state columns and/or its owner id - so neither the
      // item-read gate below nor the owner key adds a read (budget stays one id->code resolve).
      let itemCode: string | null = null;
      let itemState: Record<string, unknown> | null = null;
      let itemOwnerId: string | null = null;
      // The row's threshold columns, as loaded above. Shares the `state` bag because they come off one select;
      // kept as its own name so the state gate and the condition gate never read each other's meaning into it.
      let itemRow: Record<string, unknown> | null = null;
      const ownerProp = OWNER_COLUMN_COLLECTIONS.has(collection) ? LIST_OWNER_COLUMNS[collection] : undefined;
      // The columns a per-rule THRESHOLD could be evaluated against (domain/ruleCondition.ts). Selected only
      // when this caller actually holds a conditioned rule, and read on the SAME statement as the code - so a
      // threshold costs no read, and a caller without one changes nothing about the query.
      //
      // "This caller" is BOTH principals under a simulation: the subject's guards decide the request, and the
      // real admin's decide the containment check below. A simulation of an unguarded subject by a guarded
      // admin would otherwise select no columns, and the containment check would have nothing to measure the
      // admin's own cap against.
      const guarded = !!user.guards?.size || !!user.simulatedBy?.guards?.size;
      const condFields = guarded ? { ...conditionFieldsOf(collection), ...windowFieldsOf(collection) } : {};
      const condCols = Object.values(condFields);
      const resolveId = stateRule || ownerProp || condCols.length
        ? async (col: string, id: string) => {
            const r = await resolveItemState(deps, col, id, [...(stateRule ? Object.keys(stateRule.public_when) : []), ...condCols], ownerProp);
            itemCode = r?.code ?? null;
            itemState = r?.state ?? null;
            itemOwnerId = r?.ownerId ?? null;
            itemRow = r?.state ?? null;
            return itemCode;
          }
        : async (col: string, id: string) => (itemCode = await uuidToCode(deps, col, id));
      const coded = await buildCodedPath(pathname, resolveId);
      // The OWNER KEY (domain/permissions.ts Resolved#ownerResource). Only `assets` and `users` reach here: their
      // rows carry a flat code, so `me` / `my-dept` could never match the item lane even where the list lane
      // answered "own" - which is how `GET /v1/assets/<id>` came to 403 on a row the list had just returned.
      //
      // The owner id rode the resolve above; turning it into a CODE goes through the cached uuid->code resolver,
      // so warm this is free. A resolve that comes back null adds no key at all - an asset held by nobody, or a
      // service account with no employee, is decided exactly as it is today.
      const ownerCode = itemOwnerId ? await uuidToCode(deps, "employees", itemOwnerId) : null;
      const resolved = ownerCode
        ? withOwnerResource(resolveRequest(c.req.method, coded, force), ownerCode)
        : resolveRequest(c.req.method, coded, force);

      // Per-object exceptions: for an item request whose object code resolved, fetch the caller's per-object
      // rows - USER exceptions (grant-exceptions) AND any exact ROLE rules - narrowed by the object's ancestor
      // codes (exact IN, no SQL prefix) and overlay them on the broad role grant. decide() renders the verdict
      // over the merged patterns - a share raises access for THIS object, a per-object deny blocks it
      // (deny-wins). No object code -> the broad role grant alone.
      // `everyone` rules apply to every caller EXCEPT super (the `**` holder), who must stay unrestrictable.
      const roleSubjects = roleSubjectsOf(user, user.grant);
      let grant: Grant = user.grant;
      if (itemCode) {
        const objRules = await loadObjectRulesForRequest(deps, user.uuid, roleSubjects, collection, ancestorsOf(itemCode));
        if (objRules.length) grant = mergeGrants(user.grant, rulesToGrant(objRules));
      }
      // Expose the grant this request decided with (role grant + any per-object exceptions for the item) so a
      // handler can emit a share-accurate `access.can` hint without re-loading. UX only; gates nothing.
      c.set("objectGrant", grant);
      // Expose the resolved item code so a handler can do per-field read redaction off the SAME code the
      // decision used (no second uuid->code resolve). Null on collection/create paths.
      c.set("itemCode", itemCode);
      // ...and the owner code the decision used, so the access hint is computed on the SAME pair of keys the
      // request was decided on. Without it an item response would advertise no actions on a row this very
      // request just allowed. Null for every collection but the flat-coded owner-column ones.
      c.set("itemOwnerCode", ownerCode);
      // The resolved request is caller-independent (it names the object's own code), so the real caller's
      // grant can be asked the identical question - which is what the containment check below does. Per-object
      // exceptions are deliberately NOT re-loaded for them: a share is authority over one object, and the
      // conservative reading of "may this admin read this" is their own standing grant.
      decidedAs((g, employeeCode) => decide(g, resolved, { employeeCode }));
      decision = decide(grant, resolved, self);
      // The delete axis. A DELETE resolves to the standard `write` level (`domain/permissions.ts` levelFor),
      // so editing a record and destroying it are the SAME key and "may edit but never delete" - the most
      // common request after read-only - could not be said at all. The deny lane supplies the missing axis
      // without adding a rung to the ladder or a grant anyone must now hold: a deny on the `delete` verb
      // (or `purge`, the `?force` hard delete) blocks it, and everything else decides exactly as before.
      // Subtractive by construction, and it reuses the deny semantics the model already has for
      // separation-of-duties (payroll `:approve` is super-only the same way).
      if (decision.allow && c.req.method.toUpperCase() === "DELETE") {
        const verb = force ? "purge" : "delete";
        // Carries the owner key: this lane exists to SUBTRACT, so it has to see every key the allow lane saw.
        const denied = denyingPattern(grant, { kind: "custom", resource: resolved.resource, verb, ownerResource: resolved.ownerResource }, self);
        if (denied) decision = { allow: false, reason: `denied by "${denied}"` };
      }
      // THE THRESHOLD AXIS (domain/ruleCondition.ts). A rule may carry a limit on the row it is exercised
      // against - "approve expenses up to 50,000" - which no code token can express, because every scope token
      // is a predicate on WHO owns a row and this one is a predicate on WHAT the row says.
      //
      // Subtractive, exactly like the delete axis above: it is asked only once `decide()` has already allowed,
      // it consults the pattern THAT decision named (`via`), and its only possible outcome is a refusal. There
      // is no branch here that turns a no into a yes, which is what keeps `decide()` the single authority.
      //
      // A NETWORK fence rides the same gate but is a predicate on the REQUEST, not a row - "this payroll grant
      // only from the office range" - so unlike a threshold it applies on collection paths as well as items.
      // That asymmetry is why the gate runs whenever the caller holds ANY guard, and the row half simply has
      // nothing to measure when there is no item.
      //
      // A THRESHOLD is item-only, and deliberately so. A list has no single row to measure, and a limit is about
      // ACTING rather than seeing: a manager may look at every expense in their department and still be unable
      // to approve the large ones. Making it a list predicate would silently hide rows they are meant to review.
      // `satisfies` fails closed on an absent row, which is exactly that - a capped rule cannot authorize a
      // collection-level request, because there is nothing to check the cap against.
      if (decision.allow && guarded) {
        // The condition names the WIRE field an admin authored; the row bag is keyed by drizzle column. One
        // translation here rather than a second spelling of the map in the evaluator.
        const byWire: Record<string, unknown> = {};
        for (const [wire, col] of Object.entries(condFields)) byWire[wire] = itemRow?.[col];
        // Parked for the containment check, which measures the REAL caller's guards against the same facts.
        contain.guardCtx = { row: itemCode ? byWire : null, ip: user.reqMeta?.ip, now: +deps.clock.now() };
        if (!guardAllows(user.guards, decision.via, contain.guardCtx)) {
          decision = { allow: false, reason: `outside the limits on "${decision.via}"` };
        }
      }
      // Resource-level write allowed -> additionally gate protected fields + body references.
      //
      // DELIBERATELY WITHOUT THE OWNER KEY. The owner key answers "is this row yours"; a protected field is
      // precisely what you may not set on your own row, and `users` protects `role` and `status`. Were the key to
      // reach here, a `users.me.**` rule - which the ACL can now author - would match `users.<ownerCode>.role`
      // and become self-promotion to any role. So field and reference gates keep deciding on the row's REAL
      // code, which for these collections is flat: only an explicit `users.*` / `users.**` holder matches it.
      if (decision.allow) decision = (await bodyDecision(c, deps, coded, user, grant)) ?? decision;

      // State-visibility gate: touching a NON-public row (e.g. unpublished/disabled) needs `requires` on
      // the item. The row state rode the resolve above. Public rows are read by the resource grant. Applies
      // to EVERY item method, not just GET: a broadly-granted custom verb (react/vote/markRead) both acts on
      // the row and re-serializes it in its response, so a GET-only gate would let a caller who cannot read
      // a draft still interact with it - and read it back - through a write verb.
      if (decision.allow && stateRule && itemCode && itemState) {
        if (!stateReadAllowed(grant, `${collection}.${itemCode}`, itemState, stateRule, self)) {
          decision = { allow: false, reason: `restricted ${collection}: not public, needs ${stateRule.requires}` };
        }
      }
      }
    }
  } catch (e) {
    // A DECIDED denial carries its reason through; anything else is a failure to decide.
    if (e instanceof AuthzDenied) {
      decision = { allow: false, reason: e.denyReason };
    } else {
      // FAIL CLOSED (there is no backstop) - and SAY SO. This block used to discard the error entirely, which
      // is the one swallow in this file that had no log beside it. The cost is not a wrong answer: a D1 blip,
      // a throw inside uuidToCode/buildCodedPath/resolveItemState, or a malformed policy row all reach the
      // caller as "you do not have permission" with the DENY line reading `reason="unresolved request"` - an
      // outage wearing the shape of a permissions bug, with nothing anywhere naming the real failure. With
      // [observability] on, this is the only trace it will ever leave.
      console.error(`[authz] resolution failed [${c.get("requestId") ?? "-"}] ${c.req.method} ${pathname}:`, e);
      decision = null;
    }
  }

  // ---- View-as containment (rail 2, second half) -----------------------------------------------------------
  //
  // A SIMULATION MAY NOT ANSWER WHAT THE REAL CALLER COULD NOT ASK. lib/viewAs.ts installs the SUBJECT's
  // fully-assembled grant as the request principal and intersects it with nothing, and grant subsumption is
  // not computable over patterns - so the only widening it could refuse was the upward one (borrowing super).
  // The widening that matters is sideways: an ordinary employee holds `employees.me.bank-account.**` outright,
  // both admin roles are deliberately kept out of everyone else's PII (domain/grants.ts `...OWN_PII`), and
  // `GET /v1/employees/<X>/bank-account` under `X-View-As: employees/<X>` resolved to X's own code, matched X's
  // own self-grant, and returned X's decrypted account number.
  //
  // Containment does not need to be computed over grants, because this middleware has ALREADY resolved this
  // request: ask the real caller's grant the same concrete question and refuse the simulated answer when they
  // would have been denied. That keeps the honest use of the feature - an access admin checking that somebody
  // can see their own dashboard - and removes the sideways read, one request at a time. It is the caller-bound
  // shape services/accessPreview.ts already applies to the preview surface next door.
  //
  // Lanes that decide nothing concrete (the fan-out aggregates: search, the dashboard/analytics summaries)
  // set no `reDecide` and are not bound here. They gate on nothing themselves - any signed-in caller passes -
  // and narrow by per-collection SCOPE instead, which under a simulation is the subject's, by design: those
  // surfaces exist to show what the person being watched sees.
  if (decision?.allow) {
    const simulated = c.get("user")?.simulatedBy;
    if (simulated) {
      const real = contain.reDecide?.(simulated.grant, simulated.employeeCode) ?? { allow: true };
      if (!real.allow) {
        decision = { allow: false, reason: `view as: you may not read through a simulation what you cannot read as yourself (${real.reason})` };
      } else if (contain.reDecide && simulated.guards?.size) {
        // THE REAL CALLER'S OWN LIMITS, asked of the pattern that would have authorized them. Answering the
        // grant alone is only half of "could they have read this as themselves": a rule capped at an amount,
        // held open only in a window, or fenced to the office range grants nothing outside those bounds, so a
        // simulation that consulted the pattern and not its guards was a way to read past a fence by opening
        // one. The facts are the ones the subject's own gate measured (`contain.guardCtx`); a request that
        // resolved no item carries a null row, which is what `satisfies` fails closed on - the same answer a
        // capped rule gets on a collection path when the admin asks it directly.
        const ctx = contain.guardCtx ?? { row: null, ip: c.get("user")?.reqMeta?.ip, now: Date.now() };
        if (!guardAllows(simulated.guards, real.via, ctx)) {
          decision = { allow: false, reason: `view as: outside the limits on your own "${real.via}"` };
        }
      }
    }
  }

  // Audit (best-effort; NEVER affects the decision). Records every denial (access.denied - the abuse
  // signal) and every allowed read of a sensitive surface (PII sub-resource / sensitive item / download),
  // anchored on the path's internal id. Ordinary allowed reads write nothing. A failed audit is logged,
  // not fatal - auditing is observability, not access control.
  {
    const adeps = c.get("deps");
    const auser = c.get("user");
    const dec: Decision = decision ?? { allow: false, reason: "unresolved request (fail-closed)" };
    // The pattern that authorized this request, parked on the request-scoped user so EVERY audit row the
    // handler writes carries it - not just the two the middleware writes itself. Same trick as `reqMeta` and
    // for the same reason: the alternative is threading a decision through every service signature in the app
    // to record one string. Overwritten per sub-request in a batch, exactly like `audited` above.
    if (auser) auser.authorizedBy = dec.allow ? dec.via : undefined;
    // Own-record read? The item's resolved code equals (employees) or is a child of (owner-embedded rows like
    // payslips/compensation) the caller's employee code. Used to skip auditing self-views of sensitive data.
    const ec = auser?.employeeCode;
    const ic = c.get("itemCode");
    // NO READ MADE THROUGH A SIMULATION IS A SELF-READ. `isSelf` exists to stop logging YOUR reads of YOUR own
    // data, and under view-as neither pronoun refers to the person driving: both sides of the comparison come
    // from the SUBJECT, so it was always true and the `<col>.read.sensitive` row was never written - for
    // `bank-account`, `identity` and `tax`, the three the policy calls an accountability event. The same
    // request made honestly IS audited (the admin's code against the subject's), which left view-as quieter
    // than acting as yourself, inverting lib/viewAs.ts's own promise that a simulated read stays attributable.
    // lib/audit.ts stamps `viewing_as` faithfully - on rows that get written, and there was no row to stamp.
    const isSelf = !auser?.simulatedBy && !!ec && !!ic && (ic === ec || ic.startsWith(`${ec}-`));
    // How far the authorizing rule actually REACHED on this request, counted per pattern in `rule_usage` so an
    // access review can tell a genuinely org-wide rule from one whose holders only ever touched their own team.
    // Same two containment tests the engine decides with (`me` / `my-dept`), asked about the resolved item code.
    // Undefined when there is no item (a collection-level request classifies nothing) - see the schema comment.
    if (auser) {
      const dept = deptOf(ec ?? null);
      auser.authorizedScope = !dec.allow || !ic || !ec ? undefined : isSelf ? "self" : dept && isUnder(dept, ic) ? "dept" : "wider";
    }
    try {
      const ev = accessAudit(c.req.method, pathname, dec, auser?.policy.audit ?? DEFAULT_POLICY.audit, isSelf);
      // Pass the AppUser (not just its email) so the row records actor_id → the feed resolves it to a name.
      if (ev && adeps) await audit(adeps, auser ?? "anonymous", ev.action, ev.entity, ev.entityId ?? undefined, ev.meta);
    } catch (e) {
      console.error("[authz] audit write failed (non-fatal)", e);
    }
  }

  // Prime directive: fail closed. A null decision means we could NOT establish access (no user, an
  // unresolved path, or a thrown error). There is no `require_` backstop anymore, so null MUST deny -
  // never fall through to the handler. Only an explicit { allow: true } proceeds.
  if (!decision || !decision.allow) {
    // Log the reason; return a GENERIC message so the response never leaks the internal code/path (11P).
    const reason = decision ? decision.reason : "unresolved request (fail-closed)";
    console.warn(`[authz] DENY ${c.req.method} ${pathname} role=${c.get("user")?.role} reason="${reason}"`);
    throw forbidden("you do not have permission to perform this action");
  }

  // Allowed. Decide the list scope here - off the grant, in the middleware - so list services bind it
  // (applyScope) without making any access decision.
  const user = c.get("user");
  if (user) {
    const segs = pathname.replace(/^\/v1\//, "").split("/").filter(Boolean);
    // A COLLECTION-level custom method carries its verb in that first segment (`announcements:markAllRead`),
    // so the raw segment is not a collection name. Scope is about the collection either way - split the verb
    // off (collectionOf, the one place that does), or a handler that reads the scope
    // (announcements:markAllRead does) would get one computed against a resource that does not exist.
    const isCollectionVerb = (segs[0]?.indexOf(":") ?? -1) >= 0;
    const collection = collectionOf(pathname);
    // An item verb that lists OTHER rows binds its own collection's scope, which is not always the one in the
    // path - see SCOPE_READING_VERBS. Everything else scopes the collection it names.
    const itemVerb = segs.length === 2 ? segs[1]!.split(":")[1] : undefined;
    const boundCollection = itemVerb ? SCOPE_READING_VERBS.get(`${collection}:${itemVerb}`) : undefined;
    const scopeCollection = boundCollection ?? collection;
    // Re-derived rather than reached for: the decision's `self` is scoped to the block above. Both calls hit the
    // same cache entry, so this costs no read.
    const scope = scopeFor(user, scopeCollection, await selfContextFor(c.get("deps"), user));
    // A collection-level list also honors the caller's per-object shares/denies (one indexed read): shares
    // widen the result, denies remove rows (deny-wins). Covers user exceptions AND exact role rules. Item
    // paths don't need it (handled in the decision) - and neither do most custom methods, which act on what the
    // caller named rather than listing rows, so they stay off this extra read.
    // The aggregate ROUTES are not collections: no rule can carry their namespace, and their handlers read
    // searchScopes/summaryScopes/approvalScopes (each already scoped per collection below), never this scope -
    // so the read would be a guaranteed-empty one thrown away.
    //
    // ...AND THE ITEM VERBS THAT DO LIST ROWS (see SCOPE_READING_VERBS). The premise above - "a custom method
    // acts on what the caller named" - stopped being true for the verbs that answer with OTHER records, and
    // `applyScope` can only subtract the denies it is handed: on those paths `scope.denies` was always empty,
    // so a record explicitly denied to somebody came back to them as a neighbour. Read against the collection
    // the verb BINDS, which is the one the exceptions have to be about.
    if (boundCollection || (segs.length === 1 && !isCollectionVerb && !AGGREGATE_ROUTES.has(collection))) {
      const roleSubjects = roleSubjectsOf(user, user.grant);
      const exc = await loadObjectExceptionCodes(c.get("deps"), user.uuid, roleSubjects, scopeCollection);
      scope.shares = exc.shares;
      scope.denies = exc.denies;
    }
    c.set("scope", scope);
    // Global search fans one query across many collections, so it needs the SAME pair of answers for each of
    // them - may the caller list it, and with what scope. Both are decided here, exactly as above, and handed
    // over as a map; the search service only binds them to columns. That keeps this middleware the one place
    // access is decided even for a request that spans the whole app.
    // The tab-bar badge counts ask the same question of the same collections ("what may this caller list, and
    // with what breadth"), so they ride the same map rather than a second resolve of the same verdicts.
    if (collection === "search" || collection === "activity-counts") c.set("searchScopes", await searchScopesFor(c.get("deps"), user));
    // "What changed since I last looked" answers with collection NAMES, so it needs only the boolean half of
    // that same decision - no scope, and no per-object exception read.
    if (collection === "changes") c.set("listableCollections", listableCollectionsFor(user));
    // Dashboard summary fans COUNT/SUM queries across the KPI collections - same per-collection decide/scope
    // pair as search, handed over as a map; the service only binds them.
    if (collection === "dashboard-summary") c.set("summaryScopes", await scopesForCollections(c.get("deps"), user, DASHBOARD_SUMMARY_COLLECTIONS));
    // "What needs me" reads goals, cards and reviews and reports the ones in trouble. Same fan-out, same
    // reason: each collection is decided by the exact list decision it would get on its own, so a caller who
    // cannot list reviews is simply never told about one.
    if (collection === "attention") c.set("attentionScopes", await scopesForCollections(c.get("deps"), user, [...ATTENTION_COLLECTIONS]));
    // The people report is the same fan-out one axis over: it answers per PERSON rather than per collection, so
    // the roster it lists (`employees`) and every measure's own collection are each decided here, by the exact
    // list decision they would get on their own. A collection missing from the map costs the report a column.
    if (collection === "people-analytics") c.set("analyticsScopes", await scopesForCollections(c.get("deps"), user, ANALYTICS_COLLECTIONS));
    // A custom grid mixes fields from many collections, so running one asks the same pair of questions of each
    // of them - may this caller list it, and with what breadth. Decided here, once, for every collection a grid
    // can touch; the runner only binds them. This is what makes a SHARED view safe: the recipient runs it under
    // their own map, so they get the same grid with fewer columns and fewer rows, never the author's.
    if (collection === "table-views") c.set("tableScopes", await scopesForCollections(c.get("deps"), user, TABLE_SOURCE_COLLECTIONS));
    // The builder's field catalogue is answered from the SAME map as the runner, and for the same reason it
    // needs more than the boolean half: the base picker must not offer a collection whose breadth can bind to
    // no row (an own-breadth caller on a table with no owner column, a principal with no employee record), and
    // the breadth - with the caller's shares - is what says so. One exception read, exactly as `:run` pays.
    if (collection === "table-fields") c.set("tableScopes", await scopesForCollections(c.get("deps"), user, TABLE_SOURCE_COLLECTIONS));
    // Approvals badge: the same per-queue pattern, decided with the `approve` verb. The prior-employer
    // verification queue has no table, so its own capability (`tax-verifications.read` - the gate its rows
    // endpoint gets) is decided here too and handed over as a boolean.
    if (collection === "approvals-summary") {
      c.set("approvalScopes", await approvalScopesFor(c.get("deps"), user));
      const asSelf = { employeeCode: user.employeeCode };
      c.set("taxVerificationsReadable", decide(user.grant, resolveRequest("GET", `/v1/${TAX_VERIFICATION_QUEUE}`), asSelf).allow);
    }
    // MAY THIS CALLER LIFT A MODERATION HIDE? Decided here, like every other question about authority, and
    // handed to the two walls' un-hide verbs as a boolean (`:restore` on a suggestion, `:enable` on an
    // announcement). Those verbs are ordinary self-service - an author undoing their own delete - and a
    // moderation hide is written with the same two columns, so without this the service cannot tell the two
    // apart and an author walks a moderator's decision back. Pure in-memory `decide()`, no read, and only on
    // the two collections that can carry a hold.
    if (isModeratable(collection)) {
      c.set("mayModerate", decide(user.grant, resolveRequest("POST", "/v1/moderation:decide"), selfContextOf(user)).allow);
    }
  }

  await next();

  // Write backstop: after a mutating request the authz gate ALLOWED and the handler completed WITHOUT throwing
  // (a thrown handler unwinds past this via app.onError; a 4xx it returns is filtered by status). If nothing
  // logged an activity row inline (user.audited still false), emit ONE generic row so every create/update/
  // delete/custom-method call reaches the feed. Best-effort — a failed audit is logged, never fatal.
  const wuser = c.get("user");
  if (wuser && !wuser.audited && c.res.status >= 200 && c.res.status < 300) {
    const ev = mutationAudit(c.req.method, pathname);
    if (ev) {
      // Enrich the generic row with the touched field NAMES (never values) so the feed shows what changed.
      const fields = await touchedFieldNames(c);
      if (fields.length) ev.meta.fields = fields;
      // Snapshot the record's descriptive label from the RESPONSE body (the serialized resource) — point-in-time,
      // no read. describeRow reads on-row descriptive fields, unaffected by wire-id tokenization.
      const snapshot = await responseResource(c);
      try {
        await audit(c.get("deps"), wuser, ev.action, ev.entity, ev.entityId ?? undefined, ev.meta, snapshot);
      } catch (e) {
        console.error("[authz] write-backstop audit failed (non-fatal)", e);
      }
    }
  }
};
