// Pure authz request resolver (docs/archive/plan.txt section 2). Maps an HTTP request to a single permission key.
// PURE: no I/O, returns values. The middleware does the DB work (wire id -> code, caller -> JWT) and
// the matcher (1.2) turns the key + grants into a Decision. The id segments here are already the
// internal CODE (or the literal `me`); the middleware substitutes those before calling resolve.

export type Level = "read" | "write" | "admin";

/**
 * `ownerResource` is the SAME resource path with the id token replaced by the code of the row's OWNER - set by
 * the middleware only for a collection whose rows carry a FLAT code alongside an owner column
 * (services/codeCascade.ts OWNER_COLUMN_COLLECTIONS: `assets`, `users`, and nothing else today).
 *
 * WHY A SECOND KEY RATHER THAN A NEW TOKEN. Those collections' two lanes of one grant disagreed. The LIST lane
 * answers "own" fine - `applyScope` binds `eq(owner, ownerId)` - but the ITEM lane asks `isUnder(callerCode, kt)`
 * against a flat code, which is false for everyone. So `GET /v1/assets/<id>` refused a row the list had just
 * returned. An owned code is the fix everywhere the owner is fixed at create; it is the WRONG fix here, because
 * custody moves (an asset changes hands) and a `users` row may have no employee at all, while a code is
 * immutable by design.
 *
 * Expressed as an alternate resource, not as new `matchToken` semantics, so the BOLA surface stays one
 * reviewable place: nothing about how a pattern matches a key changes, only which keys a request is judged on.
 * The two keys always share their first token (the collection), so the per-namespace pattern buckets below hold.
 *
 * NOT SYMMETRIC, and that is the point: the ALLOW lanes take either key (the owner key can only widen, which is
 * what makes the item lane answer at all), while the DENY lane matches against BOTH (a deny authored on the
 * row's own code must not become bypassable through the owner key). Deny-wins is the invariant that direction
 * protects, and it is the direction that leaks if this is ever "simplified" into one symmetric OR.
 */
export type Resolved =
  | { kind: "standard"; resource: string; level: Level; ownerResource?: string } // resource = dotted path with codes, e.g. "employees.04-1c-0a9.bank-account"
  | { kind: "custom"; resource: string; verb: string; ownerResource?: string };

// Standard-method -> required level. GET=read; POST/PATCH=write; DELETE soft=write, DELETE ?force=admin.
function levelFor(method: string, force: boolean): Level {
  const m = method.toUpperCase();
  if (m === "GET") return "read";
  if (m === "DELETE") return force ? "admin" : "write";
  return "write"; // POST, PATCH (and PUT, if ever)
}

// pathname like "/v1/leave-requests/04-1c-0a9-0kf:approve" (codes already substituted, query stripped).
export function resolveRequest(method: string, pathname: string, force = false): Resolved {
  let p = pathname.replace(/^\/v1\//, "").replace(/^\/+/, "");
  const qi = p.indexOf("?");
  if (qi >= 0) p = p.slice(0, qi);
  let verb: string | undefined;
  const colon = p.lastIndexOf(":");
  if (colon >= 0) {
    verb = p.slice(colon + 1);
    p = p.slice(0, colon);
  }
  const resource = p.split("/").filter(Boolean).join(".");
  if (verb) return { kind: "custom", resource, verb };
  return { kind: "standard", resource, level: levelFor(method, force) };
}

/**
 * `r` plus its OWNER key: the same resource with the id token (token[1], the position `buildCodedPath`
 * substitutes) replaced by `ownerCode`. See Resolved#ownerResource for what it is for.
 *
 * PURE, and here rather than inline in the middleware, because the token position is a fact about the resource
 * grammar - the same fact `reprefixPattern` (services/codeCascade.ts) has to know - and a second place spelling
 * it would be a second place to get it wrong.
 *
 * Returns `r` unchanged when there is no id token to replace (a collection-level path like `/v1/assets`), so a
 * caller may apply it unconditionally.
 */
export function withOwnerResource(r: Resolved, ownerCode: string): Resolved {
  const toks = r.resource.split(".");
  if (toks.length < 2) return r;
  toks[1] = ownerCode;
  return { ...r, ownerResource: toks.join(".") };
}

// The single permission key the matcher checks: "<resource>.<action>" where action is the level token
// (standard) or the verb (custom).
export function keyOf(r: Resolved): string {
  return r.kind === "standard" ? `${r.resource}.${r.level}` : `${r.resource}.${r.verb}`;
}

// ---- Grants + matcher (docs/archive/plan.txt section 3) -------------------------------------------------------

import { isUnder, segments } from "./codes";

export type Grant = {
  levels: Record<string, Level>; // resource pattern -> granted level (ladder: admin > write > read)
  allow: string[]; // custom-method key patterns (resource + verb)
  deny?: string[]; // key patterns (resource + action); deny WINS, no downward ladder
};

/**
 * What the matcher knows about the CALLER. `employeeCode` comes off the auth read and answers `me` / `my-dept`.
 *
 * `reportCodes` / `orgCodes` are the manager chain, which the code hierarchy cannot express: a code encodes
 * exactly one relationship, department nesting. `my-dept` has been standing in for "my team" throughout the
 * manager grant, and wherever the reporting line diverges from the department tree - a matrix org, a dotted
 * line, a manager who owns people in two departments, a department with two managers - it is wrong in BOTH
 * directions at once: it shows a manager peers they do not manage, and hides reports who sit elsewhere.
 *
 * They are OPTIONAL because they cost a read. Almost no grant mentions these tokens, so the middleware resolves
 * them only when the caller's own grant actually uses one (`grantNeedsReports` below) - otherwise every request
 * in the app would pay for a relationship nobody asked about. Undefined therefore means "not loaded", and the
 * tokens fail CLOSED on it: an unresolved report set matches nothing rather than everything.
 */
export type SelfContext = {
  employeeCode: string | null; // caller's employee code, from the auth read
  /** Employee codes of the caller's DIRECT reports (`my-reports`). */
  reportCodes?: readonly string[];
  /** Employee codes of the caller's whole reporting subtree, direct reports included (`my-org`). */
  orgCodes?: readonly string[];
};

/**
 * `via` is the PATTERN that allowed it - `compensation.**`, `leave-requests.me.*` - recorded so the trail can
 * say what authorized an action, not only what refused one. A denial has named its pattern in `reason` since
 * this file was written; the asymmetry was that a permission explained nothing.
 *
 * The pattern, deliberately, and not the access-rule id: by the time a decision is made the grant is a
 * COMPILED projection, so several rules have collapsed into one pattern and the row ids are gone. Carrying
 * provenance through compilation would change the cached blob, mergeGrants and the API-key clamp; the pattern
 * costs one field and narrows "which rule was this?" to a handful, answerable with one query when asked.
 */
export type Decision = { allow: true; via?: string } | { allow: false; reason: string };

// The level ladder. Exported because the API-key ceiling (domain/keyScope.ts) must clamp granted levels
// against the SAME ordering the matcher decides with - a second, drifting copy of this ladder would be an
// authorization bug waiting to happen.
export const LVL: Record<Level, number> = { read: 1, write: 2, admin: 3 };

// my-dept = the caller's employee code minus its own last segment (the dept subtree prefix). Null if
// the caller has no employee code or it has no dept segment.
//
// The `|| null` on the result is not belt-and-braces: a code beginning with `-` splits to a leading empty
// segment, so `"-0kf"` yields the dept `""`. An empty scope prefix must never reach a containment test as if
// it were a scope (see the header on codes.ts#isUnder) - it is a missing value, not "everything".
export function deptOf(employeeCode: string | null): string | null {
  if (!employeeCode) return null;
  const segs = segments(employeeCode);
  return (segs.length >= 2 ? segs.slice(0, -1).join("-") : "") || null;
}

// Match one pattern token against one concrete key token. `**` is handled by matchTokens, not here.
function matchToken(pt: string, kt: string, self: SelfContext): boolean {
  if (pt === "*") return true;
  // `me` matches the literal self token (path "/employees/me") OR a resource whose code is under the
  // caller's employee code (owned resources addressed by their code, e.g. "04-1c-0a9-0kf").
  // TRUTHINESS, not `!== null`. `employeeCode` is joined straight off `employees.code`, a nullable TEXT
  // column with no CHECK - and `''` is not NULL, so a blank code passed the null guard and then asked
  // `isUnder('', kt)`, which used to answer true for every code in the collection. A self-scoped grant
  // silently became an org-wide one for exactly the caller whose record was least complete. isUnder now
  // refuses an empty prefix as well, so this is the second of the two locks rather than the only one.
  if (pt === "me") return kt === "me" || (!!self.employeeCode && isUnder(self.employeeCode, kt));
  if (pt === "my-dept") {
    const d = deptOf(self.employeeCode);
    return !!d && isUnder(d, kt);
  }
  // NO `my-dept-only` TOKEN, and the reason is worth writing down because it looks like a one-liner next to
  // `my-dept`. "My department but not its sub-departments" cannot be decided from the code alone: an owned row
  // is `<deptPath>-<employeeSeg>-<leaf>`, so `04-1c-0a9-0kf` is indistinguishable, by shape or by depth, from a
  // row belonging to an employee in a SUB-department `04-1c-0a9`. Telling them apart needs to know which
  // children the department actually has, which is a read the matcher cannot make. Expressed on depth alone the
  // tier would be exactly right for `employees` and `departments` and would silently match nothing on the
  // thirty-odd owned collections - a half-working chip, which is worse than an absent one.
  //
  // The MANAGER CHAIN (see SelfContext). A report's own code, or any row owned-coded under it - the same
  // containment `me` uses, asked of somebody else's code. An unloaded set is empty, so these match nothing.
  if (pt === "my-reports") return (self.reportCodes ?? []).some((c) => isUnder(c, kt));
  if (pt === "my-org") return (self.orgCodes ?? []).some((c) => isUnder(c, kt));
  // `-*` would ask for the empty prefix; isUnder refuses it, so such a pattern matches nothing rather than
  // everything. A grant that means "all codes" is written `*` or `**`, which never reach here.
  if (pt.endsWith("-*")) return isUnder(pt.slice(0, -2), kt); // explicit code prefix, e.g. "04-*"
  return pt === kt;
}

// Dot-delimited pattern vs key, with `**` matching zero-or-more trailing tokens. Within a single token,
// `me`/`my-dept`/`<prefix>-*` do '-'-boundary-aware code-prefix matching (matchToken).
//
// Walked by INDEX rather than by slicing both arrays at every token. Same recursion, same answer - but a list
// response asks this hundreds of thousands of times (one decide() per candidate verb per row, over every
// pattern in the grant), and the slicing form allocated two throwaway arrays per token of every one of them.
export function matchTokens(pat: string[], key: string[], self: SelfContext): boolean {
  return matchFrom(pat, 0, key, 0, self);
}

function matchFrom(pat: string[], pi: number, key: string[], ki: number, self: SelfContext): boolean {
  if (pi >= pat.length) return ki >= key.length;
  if (pat[pi] === "**") {
    for (let i = ki; i <= key.length; i++) {
      if (matchFrom(pat, pi + 1, key, i, self)) return true;
    }
    return false;
  }
  if (ki >= key.length) return false;
  if (!matchToken(pat[pi]!, key[ki]!, self)) return false;
  return matchFrom(pat, pi + 1, key, ki + 1, self);
}

// ---- Per-grant pattern index (pure performance; decides nothing) --------------------------------------------
//
// A grant is a flat bag of patterns - a seeded role carries 120-190 of them across ~60 collections - and
// decide() used to split and walk EVERY one of them on every call. The access hint asks for one decision per
// candidate verb per row, so a 100-row page of cards was ~1,200 full walks of the whole grant: 16-22 ms of
// pure CPU per list response, measured, which is the Workers request budget spent on hints alone.
//
// So each grant is indexed ONCE (memoized on the grant object) into: patterns pre-split into tokens, bucketed
// by the collection their first token names. A decision about `cards.<code>` can only be affected by a pattern
// whose first token is `cards` or one that matches any collection (`**`, `*`, or a scope token in the
// collection position), so it walks those two lists instead of all 190.
//
// This is a lookup narrowing, not a rule change: the buckets are a partition by a token match that
// matchTokens would have performed anyway, `deny` is left as one in-order list (it is tiny, and its
// first-match wins the reason string), and every pattern still gets its verdict from matchToken/matchTokens.
type Indexed = { tokens: string[]; pattern: string; level: Level | null; ord: number };
type GrantIndex = {
  deny: { tokens: string[]; pattern: string }[];
  levelsByNs: Map<string, Indexed[]>;
  levelsAny: Indexed[];
  allowByNs: Map<string, Indexed[]>;
  allowAny: Indexed[];
};

// Can this pattern's first token match a collection OTHER than one literal name? `**` spans tokens, `*`
// matches any, and the code-scope tokens are only ever meaningful positionally - all of them have to be
// consulted whatever collection is being asked about. Anything else is a literal collection name.
const spansCollections = (first: string): boolean =>
  first === "**" || first === "*" || first === "me" || first === "my-dept" || first === "my-reports" || first === "my-org" || first.endsWith("-*");

/**
 * Does this grant use the manager-chain tokens at all?
 *
 * Resolving the caller's reports costs a read, and almost no grant mentions them - so the middleware asks this
 * first and loads the set only when the answer is yes. Memoized on the grant object, exactly like the pattern
 * index above, so the scan happens once per grant rather than once per request.
 *
 * Deliberately over-inclusive: a token anywhere in the pattern counts. The tokens are only meaningful in the id
 * position, so scanning every token can only ever return `true` too often - which costs one read - where being
 * too clever could return `false` for a pattern that does use them, and silently strip the caller's access.
 */
const NEEDS_REPORTS = new WeakMap<Grant, { direct: boolean; org: boolean }>();
export function grantNeedsReports(grant: Grant): { direct: boolean; org: boolean } {
  let hit = NEEDS_REPORTS.get(grant);
  if (hit) return hit;
  hit = { direct: false, org: false };
  for (const p of [...Object.keys(grant.levels), ...grant.allow, ...(grant.deny ?? [])]) {
    if (!hit.direct && p.includes("my-reports")) hit.direct = true;
    if (!hit.org && p.includes("my-org")) hit.org = true;
    if (hit.direct && hit.org) break;
  }
  NEEDS_REPORTS.set(grant, hit);
  return hit;
}

const INDEX = new WeakMap<Grant, GrantIndex>();

function indexOf(grant: Grant): GrantIndex {
  let idx = INDEX.get(grant);
  if (idx) return idx;
  idx = { deny: [], levelsByNs: new Map(), levelsAny: [], allowByNs: new Map(), allowAny: [] };
  const bucket = (map: Map<string, Indexed[]>, ns: string): Indexed[] => {
    let b = map.get(ns);
    if (!b) map.set(ns, (b = []));
    return b;
  };
  for (const d of grant.deny ?? []) idx.deny.push({ tokens: d.split("."), pattern: d });
  let ord = 0;
  for (const [pattern, level] of Object.entries(grant.levels)) {
    const tokens = pattern.split(".");
    const entry: Indexed = { tokens, pattern, level, ord: ord++ };
    (spansCollections(tokens[0]!) ? idx.levelsAny : bucket(idx.levelsByNs, tokens[0]!)).push(entry);
  }
  ord = 0;
  for (const pattern of grant.allow) {
    const tokens = pattern.split(".");
    const entry: Indexed = { tokens, pattern, level: null, ord: ord++ };
    (spansCollections(tokens[0]!) ? idx.allowAny : bucket(idx.allowByNs, tokens[0]!)).push(entry);
  }
  INDEX.set(grant, idx);
  return idx;
}

/**
 * The DENY lane alone: the pattern that explicitly denies `r`, or null.
 *
 * Split out of `decide` so the same deny pass can be asked about a key the request is not otherwise decided
 * on. The one caller is the delete gate (`middleware/authz.ts`): a `DELETE` resolves to the standard `write`
 * level, which is what makes "may edit but never delete" inexpressible - the two actions are one key. Asking
 * the deny lane about the `delete` VERB adds the missing axis without touching what grants anything: a verb
 * deny can only ever subtract from an allow the standard lane already made.
 *
 * It is deliberately NOT a `decide()` on the custom lane, which is fail-closed and would require every
 * deletion in the app to be granted a verb it has never needed.
 */
export function denyingPattern(grant: Grant, r: Resolved, self: SelfContext): string | null {
  const action = r.kind === "standard" ? r.level : r.verb;
  const keyTokens = [...r.resource.split("."), action];
  // Both keys, for the reason Resolved#ownerResource states: a deny must bite whichever key the allow lane
  // would have used, or the owner key becomes a way around it.
  const ownerKeyTokens = r.ownerResource ? [...r.ownerResource.split("."), action] : null;
  for (const d of indexOf(grant).deny) {
    if (matchTokens(d.tokens, keyTokens, self)) return d.pattern;
    if (ownerKeyTokens && matchTokens(d.tokens, ownerKeyTokens, self)) return d.pattern;
  }
  return null;
}

// The decision. Fail-closed: anything not explicitly allowed is denied; any matching deny wins.
export function decide(grant: Grant, r: Resolved, self: SelfContext): Decision {
  const resourceTokens = r.resource.split(".");
  const action = r.kind === "standard" ? r.level : r.verb;
  const keyTokens = [...resourceTokens, action];
  // The owner key (Resolved#ownerResource). Null for every collection but the flat-coded owner-column ones, so
  // the shape of this function is unchanged for the whole rest of the app.
  const ownerTokens = r.ownerResource ? r.ownerResource.split(".") : null;
  const ownerKeyTokens = ownerTokens ? [...ownerTokens, action] : null;
  const idx = indexOf(grant);
  const ns = resourceTokens[0]!;

  // deny precedence (matches the full key incl. action token; no downward ladder). BOTH keys - see
  // Resolved#ownerResource for why this half is not optional.
  for (const d of idx.deny) {
    if (matchTokens(d.tokens, keyTokens, self)) return { allow: false, reason: `denied by "${d.pattern}"` };
    if (ownerKeyTokens && matchTokens(d.tokens, ownerKeyTokens, self)) return { allow: false, reason: `denied by "${d.pattern}"` };
  }

  if (r.kind === "standard") {
    let max = 0;
    // The pattern that got the level highest. The ladder takes the max, so the last one to raise it is the one
    // that actually authorized the request - an earlier weaker match did not.
    let via: string | undefined;
    const need = LVL[r.level];
    for (const list of [idx.levelsByNs.get(ns), idx.levelsAny]) {
      if (!list) continue;
      for (const p of list) {
        const lvl = LVL[p.level!];
        // The ladder takes the MAX, so a pattern that cannot raise it need not be matched at all.
        if (lvl <= max) continue;
        if (matchTokens(p.tokens, resourceTokens, self) || (ownerTokens && matchTokens(p.tokens, ownerTokens, self))) {
          max = lvl;
          via = p.pattern;
          if (max >= need) return { allow: true, via: p.pattern }; // nothing above the need can change the answer
        }
      }
    }
    return max >= need ? { allow: true, via } : { allow: false, reason: `need ${r.level} on ${r.resource}` };
  }
  for (const list of [idx.allowByNs.get(ns), idx.allowAny]) {
    if (!list) continue;
    for (const a of list) {
      if (matchTokens(a.tokens, keyTokens, self) || (ownerKeyTokens && matchTokens(a.tokens, ownerKeyTokens, self))) return { allow: true, via: a.pattern };
    }
  }
  return { allow: false, reason: `no grant for ${r.resource}.${r.verb}` };
}

// Provenance for the access HINT (UX only): the grant pattern that GRANTS `r` to this caller, or null if `r`
// is not allowed. Mirrors decide()'s allow path exactly - for a standard level the highest-level matching
// pattern that meets the need, for a custom verb the first matching allow pattern. The scope embedded in that
// pattern (me / my-dept / *-prefix / *) is what the client renders as "why" (allowed via self/dept/... scope).
// Never consulted for enforcement; decide() remains the sole authority.
export function matchingPattern(grant: Grant, r: Resolved, self: SelfContext): string | null {
  const resourceTokens = r.resource.split(".");
  const action = r.kind === "standard" ? r.level : r.verb;
  const keyTokens = [...resourceTokens, action];
  // Mirrors decide()'s handling of the owner key, deny half included - a hint that disagreed with the decision
  // would render an affordance the request then refuses, which is the failure this function exists to avoid.
  const ownerTokens = r.ownerResource ? r.ownerResource.split(".") : null;
  const ownerKeyTokens = ownerTokens ? [...ownerTokens, action] : null;
  const idx = indexOf(grant);
  const ns = resourceTokens[0]!;

  // A matching deny means not-allowed -> no positive provenance.
  for (const d of idx.deny) {
    if (matchTokens(d.tokens, keyTokens, self)) return null;
    if (ownerKeyTokens && matchTokens(d.tokens, ownerKeyTokens, self)) return null;
  }

  if (r.kind === "standard") {
    let best: string | null = null;
    let bestLvl = 0;
    for (const list of [idx.levelsByNs.get(ns), idx.levelsAny]) {
      if (!list) continue;
      for (const p of list) {
        const lvl = LVL[p.level!];
        if (lvl > bestLvl && (matchTokens(p.tokens, resourceTokens, self) || (ownerTokens && matchTokens(p.tokens, ownerTokens, self)))) { bestLvl = lvl; best = p.pattern; }
      }
    }
    return bestLvl >= LVL[r.level] ? best : null;
  }
  // The FIRST matching allow pattern, in the grant's own order - which the two buckets do not preserve between
  // them, so the winner is the lowest original ordinal rather than the first one encountered.
  let best: Indexed | null = null;
  for (const list of [idx.allowByNs.get(ns), idx.allowAny]) {
    if (!list) continue;
    for (const a of list) {
      if ((!best || a.ord < best.ord) && (matchTokens(a.tokens, keyTokens, self) || (ownerKeyTokens && matchTokens(a.tokens, ownerKeyTokens, self)))) best = a;
    }
  }
  return best?.pattern ?? null;
}

// Scope-stripped capability set for a role: the `<collection>.<action>` pairs the caller can do for at
// least one scope (docs/archive/plan.txt section 7, tier 1). Drives the client's coarse <Can> gating (nav, page,
// global buttons) - NOT per-object decisions. Levels expand down the ladder (write => read); the
// wildcard collection "**" (super_admin) is emitted as-is and the client treats "**.x"/"**.**" as match-all.
const LADDER: Record<Level, Level[]> = { read: ["read"], write: ["read", "write"], admin: ["read", "write", "admin"] };

// Drop scope/id tokens (me, my-dept, *, **, code-prefixes, code/id segments) but KEEP structural
// sub-resource tokens (bank-account, identity, ...). So "employees.me.bank-account.**" -> "employees.bank-account"
// (NOT "employees", which would falsely imply directory write), and "employees.**" -> "employees".
function stripScope(pattern: string): string {
  const toks = pattern.split(".");
  const out = [toks[0]!]; // collection
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]!;
    // In grant PATTERNS the id position is always one of these scope tokens (never a literal code), so
    // structural sub-resource names like "bank-account" (which contain '-') are correctly kept.
    const isScope = t === "*" || t === "**" || t === "me" || t === "my-dept" || t.endsWith("-*");
    if (!isScope) out.push(t);
  }
  return out.filter(Boolean).join(".");
}

export function capabilitiesOf(grant: Grant): string[] {
  const caps = new Set<string>();
  for (const [pat, lvl] of Object.entries(grant.levels)) {
    const base = stripScope(pat);
    for (const a of LADDER[lvl]) caps.add(`${base}.${a}`);
  }
  for (const a of grant.allow) {
    const t = a.split(".");
    const verb = t[t.length - 1]!;
    const base = stripScope(t.slice(0, -1).join(".")) || t[0]!;
    caps.add(`${base}.${verb}`);
  }
  return [...caps].sort();
}
