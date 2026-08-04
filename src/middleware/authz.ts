// Authz middleware — the SOLE access gate, fail-closed. It computes the path-based Decision and BLOCKS on
// anything that is not an explicit { allow: true }: a deny, a null decision, an unresolved path/id, a
// missing user, or any thrown error all return 403 (generic message; the reason is logged server-side,
// never returned - plan 11P). There is no `require_` backstop - this is it. Private by default.
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, AppUser } from "../env";
import type { Deps } from "../deps";
import { forbidden } from "../lib/errors";
import { resolveRequest, decide, type Decision, type Grant } from "../domain/permissions";
import { scopeFor, stateReadAllowed, type ListScope } from "../domain/access";
import { buildCodedPath, uuidToCode, resolveItemState } from "../lib/authzResolve";
import { loadObjectRulesForRequest, loadObjectExceptionCodes, loadObjectExceptionCodesFor } from "../lib/policyLoad";
import { SEARCHABLE_COLLECTIONS } from "../domain/searchIndex";
import { DASHBOARD_SUMMARY_COLLECTIONS } from "../domain/dashboardSummary";
import { ancestorsOf } from "../domain/codes";
import { mergeGrants, rulesToGrant } from "../domain/compileGrants";
import { EVERYONE_ROLE, isSuperGrant } from "../domain/grants";
import { accessAudit, mutationAudit } from "../domain/auditAccess";
import { DEFAULT_POLICY, subresourceBodyKey } from "../domain/manifests";
import { audit } from "../lib/audit";

// Field-level + reference access control on write bodies (docs/archive/plan.txt 11C). For a POST/PATCH whose
// resource-level write already passed, each PROTECTED field present in the body needs write on
// `<collection>.<code>.<field>`, and each declared reference present needs its level on the target's
// code. This is the single place mass-assignment / self-escalation / cross-object refs are gated, so
// services need no inline field guards. Body refs are already decoded to internal ids by the inbound
// edge. Fail-closed on an unresolved reference; a missing/non-JSON/unparseable body adds no constraint.
// Touched top-level field NAMES from a JSON write body (names only — never values, matching the audit policy).
// Enriches the write-backstop's generic activity row so the feed can say WHAT changed ("updated · title, status")
// instead of a bare path. The body is already parsed + cached by the handler (and bodyDecision), so this re-read
// costs nothing; capped so a huge payload can't bloat a row. Empty for non-JSON / non-object bodies.
async function touchedFieldNames(c: Context<AppEnv>): Promise<string[]> {
  const m = c.req.method.toUpperCase();
  if (m !== "POST" && m !== "PATCH" && m !== "PUT") return [];
  if (!c.req.header("content-type")?.includes("application/json")) return [];
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

async function bodyDecision(c: Context<AppEnv>, deps: Deps, coded: string, user: AppUser, grant: Grant): Promise<Decision | null> {
  const method = c.req.method.toUpperCase();
  if (method !== "POST" && method !== "PATCH" && method !== "PUT") return null;
  if (!c.req.header("content-type")?.includes("application/json")) return null;
  const segs = coded.replace(/^\/v1\//, "").split("?")[0]!.split("/").filter(Boolean);
  const collection = segs[0]!;
  const code = segs[1]; // resource code (or "me"); undefined on create
  const fields = user.policy.protected_fields[collection] ?? [];
  const refs = user.policy.references[collection] ?? {};
  const ownerRefs = user.policy.owner_refs[collection] ?? {};
  // A write to a field-bearing sub-resource (employees/<code>/identity|bank-account|personal-info) gates
  // each body field per `<collection>.<code>.<sub>.<key>` write - the write half of field-level control.
  const sub = segs.length === 3 ? segs[2]! : null;
  const subBodyKey = sub ? subresourceBodyKey(sub) : null;
  if (fields.length === 0 && Object.keys(refs).length === 0 && Object.keys(ownerRefs).length === 0 && subBodyKey === null) return null;
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null; // not parseable as JSON -> the validator will reject it; no field to gate
  }
  if (!body || typeof body !== "object") return null;
  const self = { employeeCode: user.employeeCode };
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      const resource = code ? `${collection}.${code}.${f}` : `${collection}.${f}`;
      const d = decide(grant, { kind: "standard", resource, level: "write" }, self);
      if (!d.allow) return { allow: false, reason: `field "${f}": ${d.reason}` };
    }
  }
  for (const [field, spec] of Object.entries(refs)) {
    const v = body[field];
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
    const v = body[field];
    if (typeof v === "string" && v.length > 0) {
      const ownerCode = await uuidToCode(deps, spec.collection, v.split("/").pop()!);
      if (!ownerCode) return { allow: false, reason: `unresolved owner "${field}"` };
      const d = decide(grant, { kind: "standard", resource: `${collection}.${ownerCode}`, level: "write" }, self);
      if (!d.allow) return { allow: false, reason: `owner "${field}": ${d.reason}` };
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
  return { allow: true };
}

// Per-collection list verdicts for a fan-out envelope (`GET /v1/search`, `GET /v1/dashboard-summary`): for
// every named collection, run the very same decision a real `GET /v1/<collection>` would get here, and where
// it passes, resolve that collection's list scope (breadth + the caller's per-object shares/denies).
// Collections the caller may not list are simply absent from the map, so the consuming service can never
// query them. The exceptions for all of them are read once, not once per collection.
export async function scopesForCollections(deps: Deps, user: AppUser, collections: readonly string[]): Promise<Map<string, ListScope>> {
  const self = { employeeCode: user.employeeCode };
  const listable = collections.filter((col) => decide(user.grant, resolveRequest("GET", `/v1/${col}`), self).allow);
  const out = new Map<string, ListScope>();
  if (listable.length === 0) return out;
  const roleSubjects = isSuperGrant(user.grant) ? [user.role] : [user.role, EVERYONE_ROLE];
  const exceptions = await loadObjectExceptionCodesFor(deps, user.uuid, roleSubjects, listable);
  for (const col of listable) {
    const scope = scopeFor(user, col);
    const exc = exceptions.get(col);
    scope.shares = exc?.shares ?? [];
    scope.denies = exc?.denies ?? [];
    out.set(col, scope);
  }
  return out;
}

export const searchScopesFor = (deps: Deps, user: AppUser) => scopesForCollections(deps, user, SEARCHABLE_COLLECTIONS);

export const authz: MiddlewareHandler<AppEnv> = async (c, next) => {
  let decision: Decision | null = null;
  let pathname = "";
  try {
    const user = c.get("user");
    if (user) {
      const deps = c.get("deps");
      const url = new URL(c.req.url);
      pathname = url.pathname;
      // Per-request client metadata for the audit trail (this user object is request-scoped; audit() reads it).
      user.reqMeta = { ip: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? undefined, ua: c.req.header("user-agent") ?? undefined };
      // Reset the per-request audit flag (batch reuses one shared user object across sub-requests). audit() sets
      // it true when the handler logs its own activity row; the write backstop after next() reads it to dedupe.
      user.audited = false;
      const self = { employeeCode: user.employeeCode };
      const collection = pathname.replace(/^\/v1\//, "").split("/").filter(Boolean)[0] ?? "";

      // Global search: `search` is a TRANSPORT, not a resource - it owns no data and widens nothing, like the
      // /v1/batch:run envelope. So the ENVELOPE is allowed for any authenticated caller, and the real gating
      // happens per collection, below, in searchScopesFor() - still here, in the one place that decides.
      if (collection === "search" || collection === "dashboard-summary") {
        // dashboard-summary is the same shape: an aggregate envelope over many collections, each gated below
        // (scopesForCollections) by the exact decision its own list request would get.
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
          const roleSubjects = isSuperGrant(user.grant) ? [user.role] : [user.role, EVERYONE_ROLE];
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
          const readDec = decide(g, { kind: "standard", resource: `${tEntity}.${tCode}`, level: "read" }, self);
          decision = !readDec.allow
            ? readDec
            : decide(user.grant, { kind: "standard", resource: `activity.${tCode}.${tEntity}`, level: "read" }, self);
        }
        }
      } else {
      const stateRule = user.policy.state_visibility?.[collection];

      // Resolve the top id -> code. For a state-gated collection the SAME read also returns the row's
      // public-state columns, so the item-read gate below adds no read (budget stays one id->code resolve).
      let itemCode: string | null = null;
      let itemState: Record<string, unknown> | null = null;
      const resolveId = stateRule
        ? async (col: string, id: string) => {
            const r = await resolveItemState(deps, col, id, Object.keys(stateRule.public_when));
            itemCode = r?.code ?? null;
            itemState = r?.state ?? null;
            return itemCode;
          }
        : async (col: string, id: string) => (itemCode = await uuidToCode(deps, col, id));
      const coded = await buildCodedPath(pathname, resolveId);
      const force = url.searchParams.get("force") === "true";
      const resolved = resolveRequest(c.req.method, coded, force);

      // Per-object exceptions: for an item request whose object code resolved, fetch the caller's per-object
      // rows - USER exceptions (grant-exceptions) AND any exact ROLE rules - narrowed by the object's ancestor
      // codes (exact IN, no SQL prefix) and overlay them on the broad role grant. decide() renders the verdict
      // over the merged patterns - a share raises access for THIS object, a per-object deny blocks it
      // (deny-wins). No object code -> the broad role grant alone.
      // `everyone` rules apply to every caller EXCEPT super (the `**` holder), who must stay unrestrictable.
      const roleSubjects = isSuperGrant(user.grant) ? [user.role] : [user.role, EVERYONE_ROLE];
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
      decision = decide(grant, resolved, self);
      // Resource-level write allowed -> additionally gate protected fields + body references.
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
  } catch {
    decision = null; // any resolution error -> deny below (FAIL CLOSED; there is no backstop)
  }

  // Audit (best-effort; NEVER affects the decision). Records every denial (access.denied - the abuse
  // signal) and every allowed read of a sensitive surface (PII sub-resource / sensitive item / download),
  // anchored on the path's internal id. Ordinary allowed reads write nothing. A failed audit is logged,
  // not fatal - auditing is observability, not access control.
  {
    const adeps = c.get("deps");
    const auser = c.get("user");
    const dec: Decision = decision ?? { allow: false, reason: "unresolved request (fail-closed)" };
    // Own-record read? The item's resolved code equals (employees) or is a child of (owner-embedded rows like
    // payslips/compensation) the caller's employee code. Used to skip auditing self-views of sensitive data.
    const ec = auser?.employeeCode;
    const ic = c.get("itemCode");
    const isSelf = !!ec && !!ic && (ic === ec || ic.startsWith(`${ec}-`));
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
    // off, or a handler that reads the scope (announcements:markAllRead does) would get one computed against
    // a resource that does not exist.
    const verbAt = segs[0]?.indexOf(":") ?? -1;
    const collection = verbAt >= 0 ? segs[0]!.slice(0, verbAt) : segs[0] ?? "";
    const scope = scopeFor(user, collection);
    // A collection-level list also honors the caller's per-object shares/denies (one indexed read): shares
    // widen the result, denies remove rows (deny-wins). Covers user exceptions AND exact role rules. Item
    // paths don't need it (handled in the decision) - and neither do custom methods, which act on what the
    // caller named rather than listing rows, so they stay off this extra read.
    // `search` and `dashboard-summary` are aggregate ROUTES, not collections: no rule can carry their
    // namespace, and their handlers read searchScopes/summaryScopes (each already scoped per collection
    // below), never this scope - so the read would be a guaranteed-empty one thrown away.
    if (segs.length === 1 && verbAt < 0 && collection !== "search" && collection !== "dashboard-summary") {
      const roleSubjects = isSuperGrant(user.grant) ? [user.role] : [user.role, EVERYONE_ROLE];
      const exc = await loadObjectExceptionCodes(c.get("deps"), user.uuid, roleSubjects, collection);
      scope.shares = exc.shares;
      scope.denies = exc.denies;
    }
    c.set("scope", scope);
    // Global search fans one query across many collections, so it needs the SAME pair of answers for each of
    // them - may the caller list it, and with what scope. Both are decided here, exactly as above, and handed
    // over as a map; the search service only binds them to columns. That keeps this middleware the one place
    // access is decided even for a request that spans the whole app.
    if (collection === "search") c.set("searchScopes", await searchScopesFor(c.get("deps"), user));
    // Dashboard summary fans COUNT/SUM queries across the KPI collections - same per-collection decide/scope
    // pair as search, handed over as a map; the service only binds them.
    if (collection === "dashboard-summary") c.set("summaryScopes", await scopesForCollections(c.get("deps"), user, DASHBOARD_SUMMARY_COLLECTIONS));
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
