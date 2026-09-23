// The API-key ceiling. An API key acts as an existing user (its owner) and may only ever NARROW that user's
// authority - never widen it. This module is where that claim is enforced, and it is deliberately pure so the
// claim is provable by unit test (test/keyScope.test.ts) rather than argued about.
//
// WHY A SCOPE IS NOT A `Grant`. The obvious design - store a second Grant on the key and intersect it with
// the owner's - requires pattern algebra over `me` / `my-dept` / `<prefix>-*` (permissions.ts matchToken).
// Deciding whether one such pattern is a subset of another is exactly where a BOLA hole would hide. So a
// scope is instead three plain facts, each of which intersects EXACTLY against the grant's own structure:
//
//   collections -> the first pattern token, which is the same thing access_rules.namespace stores and
//                  compileGrants.deriveNarrowing derives. No new concept, no ambiguity.
//   maxLevel    -> clamps down the read/write/admin ladder. Subsumes any read-only flag, so there is no
//                  second "mode" concept to keep in sync.
//   verbs       -> the custom-method (last) token.
//
// Everything here fails CLOSED: when a pattern cannot be narrowed precisely it is dropped, never kept.

import { LVL, type Grant, type Level, type Resolved } from "./permissions";

// `"*"` means "no restriction on this axis". A list means the allowlist, and an EMPTY list means nothing is
// allowed on that axis (fail-closed, not fail-open - an empty list is a lock, not a wildcard).
export type KeyScope = {
  collections: string[] | "*"; // allowed collections (first pattern token)
  maxLevel: Level; // ceiling on every granted level
  verbs: string[] | "*"; // allowed custom methods (last key token)
};

// The widest scope expressible: acts exactly as the owner. Useful as a default in tests and as the "full
// delegation" option in the UI; NOT the default for a newly minted key.
export const FULL_SCOPE: KeyScope = { collections: "*", maxLevel: "admin", verbs: "*" };

const firstToken = (pattern: string) => pattern.split(".")[0] ?? "";
const lastToken = (pattern: string) => {
  const t = pattern.split(".");
  return t[t.length - 1] ?? "";
};
// A leading `**` or `*` means the pattern is not anchored to one collection, so it has to be expanded to the
// scope's concrete collections before it can be trusted under a narrowed key.
const isCrossCollection = (token: string) => token === "**" || token === "*";
const collectionAllowed = (scope: KeyScope, ns: string) => scope.collections === "*" || scope.collections.includes(ns);
const clamp = (level: Level, maxLevel: Level): Level => (LVL[level] <= LVL[maxLevel] ? level : maxLevel);

// Expand one cross-collection pattern (`**` / `*` in the collection slot) into one concrete pattern per
// allowed collection. `**` becomes `<col>.**` (matches the collection itself and everything under it);
// `*` occupies exactly one token, so only that token is substituted.
function expandCollections(pattern: string, scope: KeyScope): string[] {
  const toks = pattern.split(".");
  const head = toks[0]!;
  if (!isCrossCollection(head)) return collectionAllowed(scope, head) ? [pattern] : [];
  if (scope.collections === "*") return [pattern];
  return scope.collections.map((col) => (head === "**" ? `${col}.**` : [col, ...toks.slice(1)].join(".")));
}

// Narrow a level pattern set. Cross-collection patterns (super's `**`) collapse to one entry per allowed
// collection; every surviving level is clamped to the ceiling. When two source patterns collapse onto the
// same narrowed pattern, the HIGHER level wins - both were already granted, so keeping the max widens
// nothing (and both are clamped to maxLevel regardless).
function narrowLevels(grant: Grant, scope: KeyScope): Record<string, Level> {
  const levels: Record<string, Level> = {};
  for (const [pattern, level] of Object.entries(grant.levels)) {
    const capped = clamp(level, scope.maxLevel);
    for (const narrowed of expandCollections(pattern, scope)) {
      const prev = levels[narrowed];
      levels[narrowed] = prev === undefined || LVL[capped] > LVL[prev] ? capped : prev;
    }
  }
  return levels;
}

// A custom method is a WRITE, whatever the verb is called.
//
// This is the app's existing answer to the question, not a new one: lib/viewAs.ts decides what a read-only
// simulation may carry and admits GET/HEAD plus the GET-only batch transport - every `:verb` is refused,
// including the ones that only render (`:pdf`, `:download`, `:preview`). A verb is a POST that runs a service,
// so "it happens to return bytes" is not a property the gate can read off the request.
//
// The ceiling therefore has to cover the verb axis. It did not: `inScope` checked the collection and the verb
// list for a custom method and never the level, so a key minted `{ max_level: "read", verbs: "*" }` - which
// the mint dialog offers as "read" plus an "Allow actions" tick - could `payroll-runs/<id>:publish`,
// `loans/<id>:disburse` and `leave-requests/<id>:approve`. Every surface a person audits these by calls that
// key "read only", and `max_level` is the axis whose name promises it is not.
const VERBS_NEED = "write" as const;
export const verbsAllowedAt = (maxLevel: Level): boolean => LVL[VERBS_NEED] <= LVL[maxLevel];

// Narrow a custom-method allow list, on both axes. A pattern whose verb slot is itself a wildcard
// (`<col>.**`, granting every verb) is expanded to one pattern per allowed verb by APPENDING the verb - the
// `**` then absorbs the id segments in between, so `<col>.**.approve` still matches both
// `<col>.<code>.approve` and the collection-level `<col>.approve`.
//
// Under-approximation, on purpose: `<col>.*.approve` (from a `<col>.*` source) cannot match a
// collection-level verb, because `*` must consume exactly one token. That direction is safe - it denies
// something the owner could do, rather than allowing something they could not.
function narrowAllow(grant: Grant, scope: KeyScope): string[] {
  const out = new Set<string>();
  // A read-ceilinged key performs no custom methods at all, so it carries no allow patterns - which is also
  // what makes every grant-derived ANSWER agree with the gate (an `access.can` hint computed off this grant
  // would otherwise offer verbs `inScope` then refuses). `parseScope` already empties `verbs` for such a
  // scope, so this is the same rule said where the grant is built.
  if (!verbsAllowedAt(scope.maxLevel)) return [];
  for (const pattern of grant.allow) {
    for (const base of expandCollections(pattern, scope)) {
      if (scope.verbs === "*") {
        out.add(base);
        continue;
      }
      const verb = lastToken(base);
      if (isCrossCollection(verb)) for (const v of scope.verbs) out.add(`${base}.${v}`);
      else if (scope.verbs.includes(verb)) out.add(base);
    }
  }
  return [...out];
}

// Narrow a grant to what a key bearing `scope` may do. The result is always a subset of `grant`: every
// request `decide()` allows under the narrowed grant is also allowed under the original.
//
// `deny` is carried through VERBATIM and unfiltered. Deny only ever subtracts, so keeping every entry can
// only make the key weaker - and dropping one (say, because its collection is out of scope) would silently
// re-enable something the owner is explicitly denied.
export function narrowGrant(grant: Grant, scope: KeyScope): Grant {
  const narrowed: Grant = { levels: narrowLevels(grant, scope), allow: narrowAllow(grant, scope) };
  if (grant.deny?.length) narrowed.deny = [...grant.deny];
  return narrowed;
}

// The ceiling check applied to an already-resolved request, used by the authz middleware as a second gate.
//
// WHY BOTH THIS AND narrowGrant. The middleware merges per-object exception rules onto the caller's grant at
// decision time (middleware/authz.ts), so a grant narrowed once at auth time can be widened again afterwards.
// narrowGrant makes every grant-derived ANSWER correct (list scopes, search scopes, capability hints); this
// makes the request itself SAFE regardless of what got merged. Neither subsumes the other.
export function inScope(r: Resolved, scope: KeyScope): boolean {
  if (!collectionAllowed(scope, firstToken(r.resource))) return false;
  if (r.kind === "standard") return LVL[r.level] <= LVL[scope.maxLevel];
  // The LEVEL CEILING APPLIES TO A VERB TOO - see verbsAllowedAt. Checked here as well as normalised in
  // `parseScope`, because this is the gate: a scope stored before that normalisation existed, or written
  // straight into `api_keys.scope_json`, must be refused rather than trusted.
  if (!verbsAllowedAt(scope.maxLevel)) return false;
  return scope.verbs === "*" || scope.verbs.includes(r.verb);
}

// The persisted / on-the-wire form. `scope_json` stores exactly this, so there is one snake_case shape
// crossing both boundaries (HTTP and the DB) and one camelCase shape inside the engine - never a third.
export type WireScope = { collections: string[] | "*"; max_level: Level; verbs: string[] | "*" };

export function scopeToWire(scope: KeyScope): WireScope {
  return { collections: scope.collections, max_level: scope.maxLevel, verbs: scope.verbs };
}

// Parse + validate a stored/submitted scope. Returns null when the shape is wrong, so callers fail closed
// rather than defaulting to something permissive. `known` is the collection registry (domain/collections
// COLLECTIONS) - naming a collection that does not exist is a typo that would silently grant nothing, so it
// is rejected at write time instead.
export function parseScope(value: unknown, known?: ReadonlySet<string>): KeyScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const level = raw.max_level;
  if (level !== "read" && level !== "write" && level !== "admin") return null;

  const axis = (v: unknown, validate?: (s: string) => boolean): string[] | "*" | null => {
    if (v === "*") return "*";
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !s)) return null;
    if (validate && (v as string[]).some((s) => !validate(s))) return null;
    return [...new Set(v as string[])];
  };

  const collections = axis(raw.collections, known ? (s) => known.has(s) : undefined);
  const verbs = axis(raw.verbs);
  if (collections === null || verbs === null) return null;
  // NORMALISED, not refused: a custom method is a write (see verbsAllowedAt), so a read-ceilinged scope holds
  // no verbs. Refusing the combination here would be wrong in the one place this function must not be - it
  // parses STORED scopes on the authentication path, and returning null there kills the key outright ("API key
  // scope is unreadable"). Emptying the axis only ever narrows, so a key minted before this rule existed keeps
  // working for exactly the reads it was labelled with. The MINT path refuses it loudly instead
  // (services/apiKeys.ts), so nobody is quietly handed something narrower than they asked for.
  //
  // It also keeps the wire honest: http/serialize.ts round-trips the stored scope through this function, so
  // the "· actions" marker the key list is audited by disappears with the authority it described.
  return { collections, maxLevel: level, verbs: verbsAllowedAt(level) ? verbs : [] };
}
