// Load the caller's authority from the compiled `access_rules` store (the read-extreme path). Replaces the
// grant-blob join: `auth.ts` reconstructs the role Grant from rows here, then the UNCHANGED engine
// (`permissions.ts decide`) renders every verdict. The `grants`/`policy` blob tables remain the editable
// source-of-record (P2 recompiles them into `access_rules` on edit); they are no longer read at decide time.
//
// Read budget: a role's rule set is bounded (RBAC patterns), fetched by the covering (subject, namespace)
// index and cached per role with a short TTL, so warm decisions approach ~0 DB reads. The cache is
// correctness-independent (a cold isolate reconstructs the same Grant from the same rows); a grant edit
// propagates within the TTL (the accepted few-seconds lag). Per-object USER exceptions are NOT loaded here -
// they are narrowed by exact ancestor-code IN per request in P2.
import { and, eq, inArray, isNull, isNotNull, or } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { Grant } from "../domain/permissions";
import type { Policy } from "../domain/manifests";
import { DEFAULT_POLICY } from "../domain/manifests";
import { EMPTY_GRANT, EVERYONE_ROLE, isSuperGrant } from "../domain/grants";
import { rulesToGrant, mergeGrants, guardsOf, mergeGuards, type CompiledRule } from "../domain/compileGrants";
import type { GuardIndex } from "../domain/ruleCondition";
import { cached } from "./cache";
import { byIdChunks } from "./dbBatch";

// THE liveness predicate for authority: which rows actually decide. Every load path below applies this, so
// the two lifecycle features ride one condition:
//   • four-eyes approval (services/accessRules.ts) - a `pending` row is INERT (a grant does nothing until a
//     second admin approves it), while a `pending_delete` row KEEPS ENFORCING (the removal has not been
//     approved yet, so the authority is still real). A pending change never applies itself in either
//     direction; approving is what makes it take effect.
//   • expiring grants - a temporary rule stops deciding the moment it lapses. The nightly cron then deletes
//     the row, but deletion is hygiene, not the mechanism: a skipped tick can never leave access alive.
//
// APPLIED AFTER THE CACHE, IN MEMORY, AND NOT AS A SQL PREDICATE. Expiry is TIME-dependent, and every load
// below is memoized for TTL_MS - so a predicate evaluated inside the cached query freezes the verdict "is this
// still live" for the life of the entry. The per-object lane was written this way deliberately and said so;
// the broad role and user grants were not, so a temporary role grant or user rule went on deciding for up to
// five seconds after `expires_at`. A grant that outlives its own expiry is the one thing an expiring grant
// exists not to do, and how long by is not the point: the entry is a pure reduction of the same rows, so the
// row set caches and the clock does not.
//
// It costs the query the residual filter it used to do: the (subject, subject_kind) index still selects the
// same narrow set, and a subject's pending/lapsed rows are a handful at most.
type RuleLifecycle = { status: string | null; expiresAt: Date | null };
const isLive = (now: Date | number) => (r: RuleLifecycle): boolean =>
  (r.status === "active" || r.status === "pending_delete") && (r.expiresAt === null || +new Date(r.expiresAt) > +now);

// Every column a compiled rule decides with, plus the two its lifecycle is judged by. One bag, so no load path
// can select a shape `isLive` cannot be applied to.
const RULE_COLUMNS = {
  namespace: schema.accessRules.namespace,
  pattern: schema.accessRules.pattern,
  scopeKind: schema.accessRules.scopeKind,
  scopeCode: schema.accessRules.scopeCode,
  matchCode: schema.accessRules.matchCode,
  level: schema.accessRules.level,
  effect: schema.accessRules.effect,
  status: schema.accessRules.status,
  expiresAt: schema.accessRules.expiresAt,
  // The per-rule threshold (domain/ruleCondition.ts). Selected with every other decision column so the
  // condition index is built from the SAME cached rows the grant is, rather than a second read per request.
  condition: schema.accessRules.condition,
  fromIp: schema.accessRules.fromIp,
  window: schema.accessRules.window,
} as const;

// Per-object EXCEPTION rules for one request: the caller's USER exceptions AND any exact ROLE rules in this
// collection whose match_code is an ANCESTOR of the requested object's code (the exact ancestor-code IN
// narrowing - the second index). A share/deny on a leaf matches that exact code; one on a parent covers its
// descendants; the engine then does the precise isUnder match. No SQL prefix/LIKE. Sliced out of the caller's
// cached per-object rule set (objectRulesFor, below) rather than read per request. Returns [] for the common
// no-row case. The `(subject, subject_kind)` pairing there keeps a role named like a uuid (or vice-versa) from
// cross-loading the other kind's rows, and NULL-match_code broad role rows are excluded, so this never
// re-pulls the cached grant.
export async function loadObjectRulesForRequest(
  deps: Deps,
  userUuid: string,
  roles: string[],
  collection: string,
  ancestorCodes: string[],
): Promise<CompiledRule[]> {
  if (ancestorCodes.length === 0) return [];
  const codes = new Set(ancestorCodes);
  return (await objectRulesFor(deps, userUuid, roles)).filter(
    (r) => (r.namespace === collection || r.namespace === "*") && r.matchCode !== null && codes.has(r.matchCode),
  );
}

// ---- The caller's per-object rules, once per caller ---------------------------------------------------------
// Every per-object lane above and below - the item path's rule merge, a list's shares/denies, the fan-out
// transports' per-collection exceptions - wants a DIFFERENT slice of the SAME tiny row set: the match-coded
// rules whose subject is this caller or one of their roles. Asked per slice, that was an indexed read on every
// item request AND every list request, for a row set that is usually empty and always small (a caller's ACL
// shares, not the org's).
//
// So it is loaded once per caller and sliced in memory, cached exactly like the broad grant next to it: same
// TTL, same correctness contract (a pure reduction of the same rows - a cold isolate computes the identical
// verdict), same busting (any rule write clears the band, see services/accessRules.ts). The liveness predicate
// is applied AFTER the cache, because expiry is time-dependent: an expiring share must stop deciding the
// moment it lapses, not when the entry does.
type StoredObjectRule = CompiledRule & RuleLifecycle;

async function objectRulesUncached(deps: Deps, userUuid: string, roles: string[]): Promise<StoredObjectRule[]> {
  return (await deps.db
    .select(RULE_COLUMNS)
    .from(schema.accessRules)
    .where(
      and(
        or(
          and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user")),
          and(inArray(schema.accessRules.subject, roles), eq(schema.accessRules.subjectKind, "role")),
        ),
        isNotNull(schema.accessRules.matchCode),
      ),
    )) as StoredObjectRule[];
}

async function objectRulesFor(deps: Deps, userUuid: string, roles: string[]): Promise<StoredObjectRule[]> {
  const rows = await cached(`objRules:${userUuid}:${[...roles].sort().join("|")}`, TTL_MS, () =>
    objectRulesUncached(deps, userUuid, roles),
  );
  // A `pending` rule is inert, a `pending_delete` one still enforces, and a lapsed one decides nothing - see
  // `isLive`, and the note there on why this is after the cache rather than in the query.
  return rows.filter(isLive(deps.clock.now()));
}

const TTL_MS = 5000; // ~5s: read-mostly authority; an edit reflects within this window (accepted lag).

// Parse the global body-AC manifest. Falls back to the typed seed default if the row is missing/corrupt
// (identical values) - body-AC keeps working; it is NEVER weakened to empty (which would fail OPEN).
export function parsePolicy(json: string | null | undefined): Policy {
  if (!json) return DEFAULT_POLICY;
  try {
    const p = JSON.parse(json) as Policy;
    // supported_scopes is the newest section; a manifest row written before it existed simply falls back to
    // the typed default (additive, never weakens body-AC), so the ACL scope chips keep working.
    return p && typeof p === "object" && p.protected_fields && p.references && p.owner_refs && p.state_visibility && p.audit
      ? { ...p, supported_scopes: p.supported_scopes ?? DEFAULT_POLICY.supported_scopes }
      : DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}

// Reconstruct a role's BROAD Grant from its compiled rows - the scope patterns only (match_code IS NULL).
// EXACT (per-object) role rules are excluded here and ride the narrowed ancestor-IN lane per request
// (`loadObjectRulesForRequest`), exactly like user exceptions, so the cached grant stays small and a
// per-object pin never inflates every holder's decision. Reconstruction is the tested inverse of the
// compiler; fail-closed: an unknown/unconfigured role (no rows) yields EMPTY_GRANT (deny-all), never throws.
// Loads the role's BROAD grant UNIONED with the `everyone` pseudo-role in ONE query (both are role-subject
// rows): `subject IN (role, 'everyone')`. `everyone` rides this shared, per-role-cached read so it adds no
// extra DB round-trip and its rows are read once per role (not per request). EXCEPTION: a super role (its
// own rules grant `**`) is exempt - `everyone` is dropped so an `everyone` deny can never lock out the
// break-glass identity. The two subjects are split by `subject` and merged with the role's own levels winning.
type StoredRoleRule = CompiledRule & RuleLifecycle & { subject: string };

/** The role's own + `everyone`'s broad rows in EVERY lifecycle state - what gets cached. See `isLive`. */
async function roleRulesUncached(deps: Deps, role: string): Promise<StoredRoleRule[]> {
  const subjects = role === EVERYONE_ROLE ? [EVERYONE_ROLE] : [role, EVERYONE_ROLE];
  return (await deps.db
    .select({ subject: schema.accessRules.subject, ...RULE_COLUMNS })
    .from(schema.accessRules)
    .where(
      and(inArray(schema.accessRules.subject, subjects), eq(schema.accessRules.subjectKind, "role"), isNull(schema.accessRules.matchCode)),
    )) as StoredRoleRule[];
}

/** The grant those rows amount to AT `now` - the liveness cut and the `everyone` union, over cached rows. */
function roleGrantFrom(rows: StoredRoleRule[], role: string, now: Date | number): Grant {
  const live = rows.filter(isLive(now));
  if (live.length === 0) return EMPTY_GRANT;
  const roleRows = live.filter((r) => r.subject === role);
  const everyoneRows = live.filter((r) => r.subject === EVERYONE_ROLE);
  const roleGrant = roleRows.length ? rulesToGrant(roleRows) : EMPTY_GRANT;
  // Super (the `**` holder) is exempt; otherwise union `everyone` under the role (role levels win on overlap).
  if (role === EVERYONE_ROLE || isSuperGrant(roleGrant) || everyoneRows.length === 0) return roleGrant;
  return mergeGrants(rulesToGrant(everyoneRows), roleGrant);
}

export async function loadRoleGrantUncached(deps: Deps, role: string): Promise<Grant> {
  return roleGrantFrom(await roleRulesUncached(deps, role), role, deps.clock.now());
}

// The caller's per-object exception codes for a collection, split into shares (allow) and denies, for the
// LIST predicate. Covers the caller's USER exceptions AND any exact ROLE rules (both per-object). Sliced out
// of the caller's cached per-object rule set, so a list request pays no read for it; match_code is the object
// code (exact codes only - applyScope binds them with IN / NOT IN, no SQL prefix). Returns empty arrays for
// the common no-row case.
export async function loadObjectExceptionCodes(deps: Deps, userUuid: string, roles: string[], collection: string): Promise<{ shares: string[]; denies: string[] }> {
  const rows = (await objectRulesFor(deps, userUuid, roles)).filter((r) => r.namespace === collection || r.namespace === "*");
  const shares: string[] = [];
  const denies: string[] = [];
  for (const r of rows) if (r.matchCode) (r.effect === "deny" ? denies : shares).push(r.matchCode);
  return { shares, denies };
}

// Same rows as loadObjectExceptionCodes, but keyed by collection for MANY collections at once - what the
// fan-out transports (search, the summaries) need. Namespace `*` rules apply to every collection, so they are
// merged into each key. A collection with no exception rows gets empty arrays. Same cached row set: the whole
// fan-out costs no read of its own.
export async function loadObjectExceptionCodesFor(
  deps: Deps,
  userUuid: string,
  roles: string[],
  collections: string[],
): Promise<Map<string, { shares: string[]; denies: string[] }>> {
  const wanted = new Set(collections);
  const rows = (await objectRulesFor(deps, userUuid, roles)).filter((r) => r.namespace === "*" || wanted.has(r.namespace));
  const out = new Map<string, { shares: string[]; denies: string[] }>();
  const bucket = (c: string) => {
    let b = out.get(c);
    if (!b) out.set(c, (b = { shares: [], denies: [] }));
    return b;
  };
  for (const r of rows) {
    if (!r.matchCode) continue;
    const targets = r.namespace === "*" ? collections : wanted.has(r.namespace) ? [r.namespace] : [];
    for (const c of targets) {
      const b = bucket(c);
      (r.effect === "deny" ? b.denies : b.shares).push(r.matchCode);
    }
  }
  return out;
}

// Cached per-role grant load (the hot path). Correctness-independent: the cache only saves the read.
//
// THE ROWS ARE CACHED, NOT THE GRANT, so the liveness cut is taken against THIS request's clock - see the note
// on `isLive`. The key is unchanged (`grant:<role>`), because services/accessRules.ts busts it by that exact
// name and by the `grant:` prefix for an `everyone` edit.
export async function loadRoleGrant(deps: Deps, role: string): Promise<Grant> {
  const rows = await cached(`grant:${role}`, TTL_MS, () => roleRulesUncached(deps, role));
  return roleGrantFrom(rows, role, deps.clock.now());
}

/**
 * The per-rule THRESHOLDS this role's live rules carry (domain/ruleCondition.ts).
 *
 * Reads the SAME cached rows `loadRoleGrant` just reduced, so it costs no read of its own, and applies the same
 * liveness cut - an expired rule must stop constraining exactly when it stops granting.
 */
export async function loadRoleGuards(deps: Deps, role: string): Promise<GuardIndex> {
  const rows = await cached(`grant:${role}`, TTL_MS, () => roleRulesUncached(deps, role));
  return guardsOf(rows.filter(isLive(deps.clock.now())));
}

/** The same, for the caller's own broad user rules. */
export async function loadUserGuards(deps: Deps, userUuid: string): Promise<GuardIndex> {
  const rows = await cached(`userGrant:${userUuid}`, TTL_MS, () => userRulesUncached(deps, userUuid));
  return guardsOf(rows.filter(isLive(deps.clock.now())));
}

// A USER's BROAD grant - the user's own scope rules (match_code IS NULL), symmetric with the role grant, so a
// user can hold collection/dept/field-scope access just like a role (not only per-object exceptions). Exact
// (per-object) user rows are excluded here; they ride the narrowed lane (`loadObjectRulesForRequest`). Cached
// per user with the same short TTL (the common case is no rows -> EMPTY_GRANT), so warm decisions stay ~0 reads.
type StoredUserRule = CompiledRule & RuleLifecycle;

/** The user's own broad rows in EVERY lifecycle state - what gets cached. See `isLive`. */
async function userRulesUncached(deps: Deps, userUuid: string): Promise<StoredUserRule[]> {
  return (await deps.db
    .select(RULE_COLUMNS)
    .from(schema.accessRules)
    .where(
      and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user"), isNull(schema.accessRules.matchCode)),
    )) as StoredUserRule[];
}

/** The grant those rows amount to AT `now`. */
function userGrantFrom(rows: StoredUserRule[], now: Date | number): Grant {
  const live = rows.filter(isLive(now));
  return live.length === 0 ? EMPTY_GRANT : rulesToGrant(live);
}

export async function loadUserGrantUncached(deps: Deps, userUuid: string): Promise<Grant> {
  return userGrantFrom(await userRulesUncached(deps, userUuid), deps.clock.now());
}

// Rows cached, liveness cut per request - the same split as `loadRoleGrant` above, and the key is likewise the
// one services/accessRules.ts busts (`userGrant:<uuid>`, also cleared by services/ticketShares.ts).
export async function loadUserGrant(deps: Deps, userUuid: string): Promise<Grant> {
  const rows = await cached(`userGrant:${userUuid}`, TTL_MS, () => userRulesUncached(deps, userUuid));
  return userGrantFrom(rows, deps.clock.now());
}

/**
 * The SECONDARY roles a user holds (db/schema.ts `user_roles`), cached per user.
 *
 * Its own cache band rather than a join onto the auth read: the common case is NO rows, and a cached empty array
 * costs nothing on every subsequent request, whereas widening the auth join would add a table to a query every
 * request in the app runs. Busted by name (`userRoles:<uuid>`) wherever the set is edited - services/users.ts.
 *
 * The PRIMARY role is deliberately not included: it comes off the `users` row the caller already read, and
 * folding it in here would mean this cache had to be busted on a plain role change too.
 */
export async function loadUserRoles(deps: Deps, userUuid: string): Promise<string[]> {
  return cached(`userRoles:${userUuid}`, TTL_MS, async () =>
    (await deps.db.select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, userUuid))).map((r) => r.role),
  );
}

/**
 * How deep `my-org` will walk the reporting line, and how many people it will carry.
 *
 * A transitive subtree is unbounded by nature, and this runs on the auth path of a platform that bills rows
 * read. The depth cap is one read per level; the size cap stops a CEO's `my-org` rule from loading the whole
 * company into a matcher that then does a linear scan per decision. Both are generous for a real reporting
 * line and both fail by TRUNCATING, which loses access rather than granting it.
 */
const ORG_MAX_DEPTH = 8;
const ORG_MAX_PEOPLE = 500;

/**
 * The caller's reporting line as employee CODES: their direct reports, and optionally the whole subtree below.
 *
 * WHY CODES AND NOT IDS. The matcher compares codes (`isUnder`), because every owned row is composed under its
 * owner's employee code - so a report's code answers for that person's leave requests, payslips and documents
 * without a second lookup per collection.
 *
 * Cached per (employee, depth) like the grant itself: the reporting line is read-mostly, and the same short TTL
 * bounds how long a re-parented report keeps or loses reach. Loaded ONLY when the caller's grant actually uses
 * the tokens (domain/permissions.ts `grantNeedsReports`), so a request from somebody with no manager rule pays
 * nothing.
 */
export async function loadReportCodes(deps: Deps, managerEmployeeId: string, transitive: boolean): Promise<string[]> {
  return cached(`reports:${transitive ? "org" : "direct"}:${managerEmployeeId}`, TTL_MS, async () => {
    const childrenOf = async (ids: string[]) =>
      ids.length
        ? await byIdChunks(ids, (group) =>
            deps.db
              .select({ uuid: schema.employees.uuid, code: schema.employees.code })
              .from(schema.employees)
              .where(and(inArray(schema.employees.managerId, group), isNull(schema.employees.deleteTime))),
          )
        : [];
    let frontier = [managerEmployeeId];
    const seen = new Set<string>([managerEmployeeId]);
    const codes: string[] = [];
    for (let depth = 0; depth < (transitive ? ORG_MAX_DEPTH : 1); depth++) {
      const rows = await childrenOf(frontier);
      // A cycle in the reporting line (A manages B manages A) is a data error, not an impossibility - `seen`
      // makes it terminate rather than loop the auth path forever.
      const next = rows.filter((r) => !seen.has(r.uuid));
      for (const r of next) {
        seen.add(r.uuid);
        if (r.code) codes.push(r.code);
      }
      if (!next.length || codes.length >= ORG_MAX_PEOPLE) break;
      frontier = next.map((r) => r.uuid);
    }
    return codes.slice(0, ORG_MAX_PEOPLE);
  });
}

// The global manifest (one row, key 'manifest'), cached. Falls back to DEFAULT_POLICY (never empty).
export function loadManifest(deps: Deps): Promise<Policy> {
  return cached("manifest", TTL_MS, async () => {
    const row = (await deps.db.select({ v: schema.policy.valueJson }).from(schema.policy).where(eq(schema.policy.key, "manifest")).limit(1))[0];
    return parsePolicy(row?.v);
  });
}
