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
import { rulesToGrant, mergeGrants, type CompiledRule } from "../domain/compileGrants";
import { cached } from "./cache";

// Per-object EXCEPTION rules for one request: the caller's USER exceptions AND any exact ROLE rules in this
// collection whose match_code is an ANCESTOR of the requested object's code (the exact ancestor-code IN
// narrowing - the second index). A share/deny on a leaf matches that exact code; one on a parent covers its
// descendants; the engine then does the precise isUnder match. No SQL prefix/LIKE. Not cached: per-object,
// tiny, index-only, and rare - the broad role grant is the cached part. Returns [] for the common no-row case.
// One indexed read covers both subjects; the `(subject, subject_kind)` pairing keeps a role named like a uuid
// (or vice-versa) from cross-loading the other kind's rows. NULL-match_code broad role rows never match (NULL
// is not IN any set), so this never re-pulls the cached grant.
export async function loadObjectRulesForRequest(
  deps: Deps,
  userUuid: string,
  roles: string[],
  collection: string,
  ancestorCodes: string[],
): Promise<CompiledRule[]> {
  if (ancestorCodes.length === 0) return [];
  return (await deps.db
    .select({
      namespace: schema.accessRules.namespace,
      pattern: schema.accessRules.pattern,
      scopeKind: schema.accessRules.scopeKind,
      scopeCode: schema.accessRules.scopeCode,
      matchCode: schema.accessRules.matchCode,
      level: schema.accessRules.level,
      effect: schema.accessRules.effect,
    })
    .from(schema.accessRules)
    .where(
      and(
        or(
          and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user")),
          and(inArray(schema.accessRules.subject, roles), eq(schema.accessRules.subjectKind, "role")),
        ),
        inArray(schema.accessRules.namespace, [collection, "*"]),
        inArray(schema.accessRules.matchCode, ancestorCodes),
      ),
    )) as CompiledRule[];
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
export async function loadRoleGrantUncached(deps: Deps, role: string): Promise<Grant> {
  const subjects = role === EVERYONE_ROLE ? [EVERYONE_ROLE] : [role, EVERYONE_ROLE];
  const rows = (await deps.db
    .select({
      subject: schema.accessRules.subject,
      namespace: schema.accessRules.namespace,
      pattern: schema.accessRules.pattern,
      scopeKind: schema.accessRules.scopeKind,
      scopeCode: schema.accessRules.scopeCode,
      matchCode: schema.accessRules.matchCode,
      level: schema.accessRules.level,
      effect: schema.accessRules.effect,
    })
    .from(schema.accessRules)
    .where(
      and(inArray(schema.accessRules.subject, subjects), eq(schema.accessRules.subjectKind, "role"), isNull(schema.accessRules.matchCode)),
    )) as (CompiledRule & { subject: string })[];
  if (rows.length === 0) return EMPTY_GRANT;
  const roleRows = rows.filter((r) => r.subject === role);
  const everyoneRows = rows.filter((r) => r.subject === EVERYONE_ROLE);
  const roleGrant = roleRows.length ? rulesToGrant(roleRows) : EMPTY_GRANT;
  // Super (the `**` holder) is exempt; otherwise union `everyone` under the role (role levels win on overlap).
  if (role === EVERYONE_ROLE || isSuperGrant(roleGrant) || everyoneRows.length === 0) return roleGrant;
  return mergeGrants(rulesToGrant(everyoneRows), roleGrant);
}

// The caller's per-object exception codes for a collection, split into shares (allow) and denies, for the
// LIST predicate. Covers the caller's USER exceptions AND any exact ROLE rules (both per-object). One indexed
// read; match_code is the object code (exact codes only - applyScope binds them with IN / NOT IN, no SQL
// prefix). `match_code IS NOT NULL` keeps the broad scope role rows out of this list query. Returns empty
// arrays for the common no-row case.
export async function loadObjectExceptionCodes(deps: Deps, userUuid: string, roles: string[], collection: string): Promise<{ shares: string[]; denies: string[] }> {
  const rows = await deps.db
    .select({ matchCode: schema.accessRules.matchCode, effect: schema.accessRules.effect })
    .from(schema.accessRules)
    .where(
      and(
        or(
          and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user")),
          and(inArray(schema.accessRules.subject, roles), eq(schema.accessRules.subjectKind, "role")),
        ),
        inArray(schema.accessRules.namespace, [collection, "*"]),
        isNotNull(schema.accessRules.matchCode),
      ),
    );
  const shares: string[] = [];
  const denies: string[] = [];
  for (const r of rows) if (r.matchCode) (r.effect === "deny" ? denies : shares).push(r.matchCode);
  return { shares, denies };
}

// Same rows as loadObjectExceptionCodes, but for MANY collections in ONE read, keyed by collection. Global
// search fans a single query across ~60 collections; asking per collection would be ~60 indexed reads for a
// row set that is tiny and shares one index. Namespace `*` rules apply to every collection, so they are
// merged into each key. A collection with no exception rows gets empty arrays.
export async function loadObjectExceptionCodesFor(
  deps: Deps,
  userUuid: string,
  roles: string[],
  collections: string[],
): Promise<Map<string, { shares: string[]; denies: string[] }>> {
  const wanted = new Set(collections);
  const rows = await deps.db
    .select({ namespace: schema.accessRules.namespace, matchCode: schema.accessRules.matchCode, effect: schema.accessRules.effect })
    .from(schema.accessRules)
    .where(
      and(
        or(
          and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user")),
          and(inArray(schema.accessRules.subject, roles), eq(schema.accessRules.subjectKind, "role")),
        ),
        inArray(schema.accessRules.namespace, [...collections, "*"]),
        isNotNull(schema.accessRules.matchCode),
      ),
    );
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
export function loadRoleGrant(deps: Deps, role: string): Promise<Grant> {
  return cached(`grant:${role}`, TTL_MS, () => loadRoleGrantUncached(deps, role));
}

// A USER's BROAD grant - the user's own scope rules (match_code IS NULL), symmetric with the role grant, so a
// user can hold collection/dept/field-scope access just like a role (not only per-object exceptions). Exact
// (per-object) user rows are excluded here; they ride the narrowed lane (`loadObjectRulesForRequest`). Cached
// per user with the same short TTL (the common case is no rows -> EMPTY_GRANT), so warm decisions stay ~0 reads.
export async function loadUserGrantUncached(deps: Deps, userUuid: string): Promise<Grant> {
  const rows = (await deps.db
    .select({
      namespace: schema.accessRules.namespace,
      pattern: schema.accessRules.pattern,
      scopeKind: schema.accessRules.scopeKind,
      scopeCode: schema.accessRules.scopeCode,
      matchCode: schema.accessRules.matchCode,
      level: schema.accessRules.level,
      effect: schema.accessRules.effect,
    })
    .from(schema.accessRules)
    .where(
      and(eq(schema.accessRules.subject, userUuid), eq(schema.accessRules.subjectKind, "user"), isNull(schema.accessRules.matchCode)),
    )) as CompiledRule[];
  if (rows.length === 0) return EMPTY_GRANT;
  return rulesToGrant(rows);
}

export function loadUserGrant(deps: Deps, userUuid: string): Promise<Grant> {
  return cached(`userGrant:${userUuid}`, TTL_MS, () => loadUserGrantUncached(deps, userUuid));
}

// The global manifest (one row, key 'manifest'), cached. Falls back to DEFAULT_POLICY (never empty).
export function loadManifest(deps: Deps): Promise<Policy> {
  return cached("manifest", TTL_MS, async () => {
    const row = (await deps.db.select({ v: schema.policy.valueJson }).from(schema.policy).where(eq(schema.policy.key, "manifest")).limit(1))[0];
    return parsePolicy(row?.v);
  });
}
