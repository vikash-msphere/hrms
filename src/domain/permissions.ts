// Pure authz request resolver (docs/archive/plan.txt section 2). Maps an HTTP request to a single permission key.
// PURE: no I/O, returns values. The middleware does the DB work (wire id -> code, caller -> JWT) and
// the matcher (1.2) turns the key + grants into a Decision. The id segments here are already the
// internal CODE (or the literal `me`); the middleware substitutes those before calling resolve.

export type Level = "read" | "write" | "admin";

export type Resolved =
  | { kind: "standard"; resource: string; level: Level } // resource = dotted path with codes, e.g. "employees.04-1c-0a9.bank-account"
  | { kind: "custom"; resource: string; verb: string };

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

export type SelfContext = { employeeCode: string | null }; // caller's employee code, from the JWT

export type Decision = { allow: true } | { allow: false; reason: string };

// The level ladder. Exported because the API-key ceiling (domain/keyScope.ts) must clamp granted levels
// against the SAME ordering the matcher decides with - a second, drifting copy of this ladder would be an
// authorization bug waiting to happen.
export const LVL: Record<Level, number> = { read: 1, write: 2, admin: 3 };

// my-dept = the caller's employee code minus its own last segment (the dept subtree prefix). Null if
// the caller has no employee code or it has no dept segment.
function deptOf(employeeCode: string | null): string | null {
  if (!employeeCode) return null;
  const segs = segments(employeeCode);
  return segs.length >= 2 ? segs.slice(0, -1).join("-") : null;
}

// Match one pattern token against one concrete key token. `**` is handled by matchTokens, not here.
function matchToken(pt: string, kt: string, self: SelfContext): boolean {
  if (pt === "*") return true;
  // `me` matches the literal self token (path "/employees/me") OR a resource whose code is under the
  // caller's employee code (owned resources addressed by their code, e.g. "04-1c-0a9-0kf").
  if (pt === "me") return kt === "me" || (self.employeeCode !== null && isUnder(self.employeeCode, kt));
  if (pt === "my-dept") {
    const d = deptOf(self.employeeCode);
    return d !== null && isUnder(d, kt);
  }
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
  first === "**" || first === "*" || first === "me" || first === "my-dept" || first.endsWith("-*");

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

// The decision. Fail-closed: anything not explicitly allowed is denied; any matching deny wins.
export function decide(grant: Grant, r: Resolved, self: SelfContext): Decision {
  const resourceTokens = r.resource.split(".");
  const action = r.kind === "standard" ? r.level : r.verb;
  const keyTokens = [...resourceTokens, action];
  const idx = indexOf(grant);
  const ns = resourceTokens[0]!;

  // deny precedence (matches the full key incl. action token; no downward ladder).
  for (const d of idx.deny) {
    if (matchTokens(d.tokens, keyTokens, self)) return { allow: false, reason: `denied by "${d.pattern}"` };
  }

  if (r.kind === "standard") {
    let max = 0;
    const need = LVL[r.level];
    for (const list of [idx.levelsByNs.get(ns), idx.levelsAny]) {
      if (!list) continue;
      for (const p of list) {
        const lvl = LVL[p.level!];
        // The ladder takes the MAX, so a pattern that cannot raise it need not be matched at all.
        if (lvl <= max) continue;
        if (matchTokens(p.tokens, resourceTokens, self)) {
          max = lvl;
          if (max >= need) return { allow: true }; // nothing above the need can change the answer
        }
      }
    }
    return max >= need ? { allow: true } : { allow: false, reason: `need ${r.level} on ${r.resource}` };
  }
  for (const list of [idx.allowByNs.get(ns), idx.allowAny]) {
    if (!list) continue;
    for (const a of list) if (matchTokens(a.tokens, keyTokens, self)) return { allow: true };
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
  const idx = indexOf(grant);
  const ns = resourceTokens[0]!;

  // A matching deny means not-allowed -> no positive provenance.
  for (const d of idx.deny) {
    if (matchTokens(d.tokens, keyTokens, self)) return null;
  }

  if (r.kind === "standard") {
    let best: string | null = null;
    let bestLvl = 0;
    for (const list of [idx.levelsByNs.get(ns), idx.levelsAny]) {
      if (!list) continue;
      for (const p of list) {
        const lvl = LVL[p.level!];
        if (lvl > bestLvl && matchTokens(p.tokens, resourceTokens, self)) { bestLvl = lvl; best = p.pattern; }
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
      if ((!best || a.ord < best.ord) && matchTokens(a.tokens, keyTokens, self)) best = a;
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
