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
export function matchTokens(pat: string[], key: string[], self: SelfContext): boolean {
  if (pat.length === 0) return key.length === 0;
  if (pat[0] === "**") {
    for (let i = 0; i <= key.length; i++) {
      if (matchTokens(pat.slice(1), key.slice(i), self)) return true;
    }
    return false;
  }
  if (key.length === 0) return false;
  if (!matchToken(pat[0]!, key[0]!, self)) return false;
  return matchTokens(pat.slice(1), key.slice(1), self);
}

// The decision. Fail-closed: anything not explicitly allowed is denied; any matching deny wins.
export function decide(grant: Grant, r: Resolved, self: SelfContext): Decision {
  const resourceTokens = r.resource.split(".");
  const action = r.kind === "standard" ? r.level : r.verb;
  const keyTokens = [...resourceTokens, action];

  // deny precedence (matches the full key incl. action token; no downward ladder).
  for (const d of grant.deny ?? []) {
    if (matchTokens(d.split("."), keyTokens, self)) return { allow: false, reason: `denied by "${d}"` };
  }

  if (r.kind === "standard") {
    let max = 0;
    for (const pat of Object.keys(grant.levels)) {
      if (matchTokens(pat.split("."), resourceTokens, self)) max = Math.max(max, LVL[grant.levels[pat]!]);
    }
    return max >= LVL[r.level] ? { allow: true } : { allow: false, reason: `need ${r.level} on ${r.resource}` };
  }
  for (const a of grant.allow) {
    if (matchTokens(a.split("."), keyTokens, self)) return { allow: true };
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

  // A matching deny means not-allowed -> no positive provenance.
  for (const d of grant.deny ?? []) {
    if (matchTokens(d.split("."), keyTokens, self)) return null;
  }

  if (r.kind === "standard") {
    let best: string | null = null;
    let bestLvl = 0;
    for (const pat of Object.keys(grant.levels)) {
      if (matchTokens(pat.split("."), resourceTokens, self)) {
        const lvl = LVL[grant.levels[pat]!];
        if (lvl > bestLvl) { bestLvl = lvl; best = pat; }
      }
    }
    return bestLvl >= LVL[r.level] ? best : null;
  }
  for (const a of grant.allow) {
    if (matchTokens(a.split("."), keyTokens, self)) return a;
  }
  return null;
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
