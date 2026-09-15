// Compile a Grant (the editable policy blob) into flat `access_rules` ROWS - the read-extreme authority
// table. PURE: no I/O, returns values. The rows carry the VERBATIM grant pattern, so the unchanged decision
// engine (`permissions.ts decide`) renders every verdict; the (namespace, scope_kind, scope_code,
// match_code) columns are DERIVED narrowing keys the DB uses to fetch a SUPERSET of candidate rows (P1).
//
// Security boundary (BOLA): because the pattern is preserved and `decide()` does the real match, a too-LOOSE
// narrowing key only costs extra fetched rows (the engine filters them out). The one thing that must never
// happen is DROPPING a row that would match - that is a hole. Two oracles guard it: this module's compile is
// a lossless projection (round-tripped by `rulesToGrant`, differentially tested == blob decision), and the
// P1 exact-IN narrowing is differentially tested as a correct superset. No SQL prefix/`LIKE` match ever.
import { LVL, type Grant, type Level } from "./permissions";
import { parseCondition, parseFromIp, parseWindow, type GuardIndex } from "./ruleCondition";

export type ScopeKind = "all" | "subtree" | "exact" | "self" | "dept" | "reports" | "org";
export type Effect = "allow" | "deny";

// One compiled rule, id-less and subject-less by itself: storage assigns the id (genId), and the caller
// supplies `subject` (role name or user uuid) + `subjectKind`. A pure logical projection of one pattern.
export type CompiledRule = {
  namespace: string; // collection (first pattern token) or '*' for the super "**" pattern
  pattern: string; // VERBATIM grant pattern - the decision input (never re-derived)
  scopeKind: ScopeKind; // derived from the id-position scope token
  scopeCode: string; // code prefix for subtree/exact; '' otherwise
  matchCode: string | null; // exact object code for per-object rows (user exceptions OR exact role rules); NULL for scope/pattern rules
  level: Level | null; // read|write|admin for level rules; NULL for verb (allow) / deny rules
  effect: Effect;
  // Optional per-rule threshold, as stored (JSON text) - carried through so a caller's condition index can be
  // built from the same rows their grant is. Never affects the pattern or the compiled Grant.
  condition?: string | null;
  fromIp?: string | null;
  window?: string | null;
};

/**
 * The guards each ALLOW pattern carries, for one caller's rule set (domain/ruleCondition.ts ConditionIndex).
 *
 * Built beside the Grant rather than inside it: the Grant is the decision input and must stay exactly what it
 * was, or every consumer of it - mergeGrants, the API-key clamp, the capability set - would have to learn about
 * a concept that decides nothing. Deny rules are skipped: a deny already refuses outright, and a "deny only
 * above ₹50,000" is a different feature (it would have to GRANT below the line, which conditions never do).
 *
 * A rule with no guards contributes an entry with both halves null, which is what makes an unguarded rule beat
 * a guarded one on the same pattern - see the union note in ruleCondition.ts.
 */
export function guardsOf(rules: CompiledRule[]): GuardIndex {
  const out: GuardIndex = new Map();
  for (const r of rules) {
    if (r.effect !== "allow") continue;
    const list = out.get(r.pattern) ?? [];
    list.push({ condition: parseCondition(r.condition ?? null), fromIp: parseFromIp(r.fromIp ?? null), window: parseWindow(r.window ?? null) });
    out.set(r.pattern, list);
  }
  return out;
}

/** Merge two guard indexes the way grants merge: a pattern's entries from both sides, concatenated. */
export function mergeGuards(a: GuardIndex, b: GuardIndex): GuardIndex {
  if (!a.size) return b;
  if (!b.size) return a;
  const out: GuardIndex = new Map(a);
  for (const [pattern, list] of b) out.set(pattern, [...(out.get(pattern) ?? []), ...list]);
  return out;
}

// Derive the narrowing keys from a grant pattern. The id/scope position is token[1] (the token right after
// the collection); in grant patterns it is always a scope token (`me` / `my-dept` / `*` / `<prefix>-*` /
// `**`) or absent. `**` as the whole pattern is the super grant (matches every collection) -> namespace '*'.
export function deriveNarrowing(pattern: string): { namespace: string; scopeKind: ScopeKind; scopeCode: string } {
  const toks = pattern.split(".");
  if (toks[0] === "**") return { namespace: "*", scopeKind: "all", scopeCode: "" };
  const namespace = toks[0]!;
  const scope = toks[1];
  if (scope === undefined) return { namespace, scopeKind: "all", scopeCode: "" }; // collection-only pattern (e.g. "employees")
  if (scope === "me") return { namespace, scopeKind: "self", scopeCode: "" };
  if (scope === "my-dept") return { namespace, scopeKind: "dept", scopeCode: "" };
  // The manager chain. Subject-relative like `me`/`my-dept`, so no scope code: the rule means "whoever reports
  // to the holder", resolved per caller at decision time rather than pinned to a place in the tree.
  if (scope === "my-reports") return { namespace, scopeKind: "reports", scopeCode: "" };
  if (scope === "my-org") return { namespace, scopeKind: "org", scopeCode: "" };
  if (scope === "*" || scope === "**") return { namespace, scopeKind: "all", scopeCode: "" };
  if (scope.endsWith("-*")) return { namespace, scopeKind: "subtree", scopeCode: scope.slice(0, -2) }; // "04-*" -> prefix "04"
  return { namespace, scopeKind: "exact", scopeCode: scope }; // a literal code in the id position (user per-object rows)
}

// Compile one role's Grant into rows. `levels` entries become allow level-rules; `allow` patterns become
// allow verb-rules (level NULL); `deny` patterns become deny rules. An EXACT-scope pattern (a literal code in
// the id position) carries that code as `match_code`, so it rides the same ancestor-code IN narrowed lane as
// a user exception (loaded per-object, never in the cached broad grant). Scope patterns (all/subtree/self/
// dept) keep `match_code` NULL - they are the broad rules matched by (subject, namespace).
export function compileGrant(grant: Grant): CompiledRule[] {
  const rules: CompiledRule[] = [];
  const push = (pattern: string, level: Level | null, effect: Effect) => {
    const n = deriveNarrowing(pattern);
    let { scopeKind, scopeCode } = n;
    let matchCode = scopeKind === "exact" ? scopeCode : null;
    // A collection-level custom-method rule ("batch.run", "announcements.markAllRead") is a 2-token verb
    // rule. deriveNarrowing reads token[1] (the verb) as an object code -> scopeKind "exact" -> match_code set,
    // which makes policyLoad treat it as a per-object exception (loaded only by object-ancestor-code, never for
    // a verb) and drop it from the broad role grant. It is NOT per-object: make it a broad rule (match_code
    // NULL) so the role actually gets the capability. Per-object verb grants are 3-token (col.<code>.verb) and
    // unaffected; per-object LEVEL grants (col.<code>) keep exact (level !== null).
    // This holds for DENY too, and a deny is where getting it wrong FAILS OPEN: a 2-token deny left on the
    // per-object lane is never loaded (the verb name is not an object code), so the revoked capability keeps
    // working - and loadObjectExceptionCodes would meanwhile pick the verb name up as a bogus list exclusion.
    // Grant patterns never carry a literal code in the id position (only ACL-authored per-object rows do, and
    // those are 3-token `col.<code>.**` built by accessRules.buildPattern), so no real per-object deny is
    // caught by this rewrite.
    if (level === null && scopeKind === "exact" && pattern.split(".").length === 2) {
      scopeKind = "all";
      scopeCode = "";
      matchCode = null;
    }
    rules.push({ namespace: n.namespace, pattern, scopeKind, scopeCode, matchCode, level, effect });
  };
  for (const [pattern, level] of Object.entries(grant.levels)) push(pattern, level, "allow");
  for (const pattern of grant.allow) push(pattern, null, "allow");
  for (const pattern of grant.deny ?? []) push(pattern, null, "deny");
  return rules;
}

// Inverse of `compileGrant`: rebuild a Grant from a set of compiled rules. This is the RUNTIME
// reconstructor - P1 feeds it the rows narrowed for one request, then calls the unchanged `decide()`. So
// the decision is always rendered by the tested engine over verbatim patterns; the rows never re-implement
// any matching. Lossless by construction (it is the exact inverse), which the differential test asserts.
//
// THE HIGHER LEVEL WINS when two rows carry the same pattern, for the same reason `mergeGrants` below takes a
// max rather than letting one side overwrite the other: both rows were granted, so keeping the max widens
// nothing, while letting the last one seen win is a silent DOWNGRADE of an authority somebody was given. And
// "last one seen" is not even a stable notion here - the rows arrive from an unordered `select`, so a role
// holding `write` and `read` on one pattern would flip between them across replicas and across isolates.
//
// The write path does try to keep this from arising: `services/accessRules.ts` refuses an identical
// (subject, pattern, effect). But that is a check-then-insert with no unique index behind it, and
// `bootstrap/bootstrap.sql` seeds rows directly, so a duplicate is storable - and the one thing a grant
// reconstructor must not do is answer a different question depending on row order.
export function rulesToGrant(rules: CompiledRule[]): Grant {
  const levels: Record<string, Level> = {};
  const allow: string[] = [];
  const deny: string[] = [];
  for (const r of rules) {
    if (r.effect === "deny") deny.push(r.pattern);
    else if (r.level !== null) {
      const held = levels[r.pattern];
      if (held === undefined || LVL[r.level] > LVL[held]) levels[r.pattern] = r.level;
    } else allow.push(r.pattern);
  }
  const grant: Grant = { levels, allow };
  if (deny.length) grant.deny = deny;
  return grant;
}

// Overlay one Grant on another (role grant + this object's per-object USER exceptions). The matcher takes
// the MAX level across matching patterns and applies deny-wins, so adding an exception's `<col>.<code>.**`
// level raises access for that object, and an exception deny blocks it (deny precedence is unchanged). Pure
// union - no precedence logic here; `decide()` remains the sole authority over the merged patterns.
export function mergeGrants(base: Grant, extra: Grant): Grant {
  // The HIGHER level wins on a pattern both sides carry. A plain spread let `extra` replace it outright, which
  // for equal patterns and unequal levels is a DOWNGRADE - a user rule holding `read` where their role holds
  // `write` would take access away by overlaying it, which is not what an additive overlay means (deny is the
  // instrument for taking something away, and it still wins below). Both sides were granted, so keeping the
  // max widens nothing beyond what the two already allowed.
  const levels: Record<string, Level> = { ...base.levels };
  for (const [pattern, level] of Object.entries(extra.levels)) {
    const held = levels[pattern];
    if (held === undefined || LVL[level] > LVL[held]) levels[pattern] = level;
  }
  const grant: Grant = { levels, allow: [...base.allow, ...extra.allow] };
  const deny = [...(base.deny ?? []), ...(extra.deny ?? [])];
  if (deny.length) grant.deny = deny;
  return grant;
}
