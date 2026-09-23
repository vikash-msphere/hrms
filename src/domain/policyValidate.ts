// Write-time validation for the management endpoints. The READ path stays lenient (parsePolicy falls back
// to DEFAULT on bad input so the worker never fails open); a WRITE must REJECT malformed input so a bad
// edit can never silently drop authority or revert the manifest. Pure: throws AppError (400) on bad input.
import { invalidArgument } from "../lib/errors";
import { COLLECTIONS } from "./collections";
import type { Level } from "./permissions";
import { isFieldScopeTarget, supportedScopesOf, type Policy } from "./manifests";
import { CONDITION_OPS, conditionFieldsOf, parseCondition, parseFromIp, parseWindow, windowFieldsOf, type RuleCondition, type RuleWindow } from "./ruleCondition";

const LEVELS = new Set<Level>(["read", "write", "admin"]);
// `create` is the collection-level CREATE gate: it compiles to the 1-token `<collection>` pattern (matches the
// bare collection POST + list, never an individual object). Distinct from `all`, which compiles to
// `<collection>.**` (every object). The engine already evaluates 1-token patterns (the seed uses them); this
// just lets the ACL author one.
// `reports` / `org` are the manager chain (domain/permissions.ts SelfContext). Subject-relative like `self`
// and `dept`, so like them they take no `scope_ref`.
const SCOPES = new Set(["all", "self", "reports", "org", "dept", "subtree", "exact", "create"]);
const VERB_RE = /^[a-zA-Z][a-zA-Z0-9]*$/; // a custom-method name (e.g. download, approve)

export type AccessRuleScope = "all" | "self" | "reports" | "org" | "dept" | "subtree" | "exact" | "create";
export type AccessRuleInput = {
  subjectKind: "role" | "user";
  subject: string; // role name, or "users/<id>" (the id already wire-decoded by the inbound edge)
  collection: string;
  scope: AccessRuleScope;
  condition?: RuleCondition;
  fromIp?: string;
  window?: RuleWindow;
  scopeRef?: string; // "{collection}/{id}" for scope exact/subtree
  field?: string;
  level?: Level; // present only for an allow level rule
  verb?: string; // present only for a verb (custom-method) rule
  effect: "allow" | "deny";
  expiresAt?: Date; // optional expiry (temporary access); absent = permanent
};

// Validate + normalize ONE access rule (role OR user) - the single uniform validator, replacing the old
// blob-shaped validateGrant + the inline grant-exception checks. Rejects: unknown collection; not exactly one
// rule kind (a level rule, a verb rule, or a deny - so level+verb and deny+level are out); bad
// level/verb/scope/effect; a field rule on a field that isn't access-controlled (would be inert). The
// over-broad `**`/cross-collection rule is impossible here (collection must be a real collection, never
// `**`), so it stays super-only via the seed. Verb fail-closed + deny-wins are ENGINE behavior, not re-done
// here - this only shapes a valid row.
export function validateAccessRule(body: unknown, policy: Policy, now: Date = new Date()): AccessRuleInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidArgument("access rule body must be an object");
  const b = body as Record<string, unknown>;
  const subjectKind = b.subject_kind;
  if (subjectKind !== "role" && subjectKind !== "user") throw invalidArgument("subject_kind must be 'role' or 'user'");
  const subject = b.subject;
  if (typeof subject !== "string" || !subject) throw invalidArgument("subject is required");
  if (subjectKind === "user" && !subject.startsWith("users/")) throw invalidArgument("user subject must be a users/{id} reference");
  const collection = b.collection;
  if (typeof collection !== "string" || !COLLECTIONS.has(collection)) throw invalidArgument(`unknown collection "${String(collection)}"`);
  const scope = b.scope;
  if (typeof scope !== "string" || !SCOPES.has(scope)) throw invalidArgument("scope must be all|self|dept|subtree|exact|create");
  if ((scope === "exact" || scope === "subtree") && (typeof b.scope_ref !== "string" || !b.scope_ref.includes("/"))) {
    throw invalidArgument(`scope ${scope} requires scope_ref as {collection}/{id}`);
  }
  // A CROSS-collection anchor - `{collection: "leave-requests", scope: "subtree", scope_ref: "departments/x"}`
  // - is how a named department is granted, and it works because every owned code is composed under its
  // employee, which is composed under its department: the compiled `<deptCode>-*` token reaches the whole
  // department's rows. It is only meaningful when the rule's collection is department-coded, which is exactly
  // what declaring the `dept` tier says (supportedScopesOf derives `named-dept` from it). Anchoring a flat
  // collection to a department, or to some third collection, composes a prefix nothing is coded under: the
  // rule stores, displays and decides NOTHING, which is the one outcome an access UI must never produce
  // silently. `exact` is unaffected - it pins to one object of the rule's own collection.
  if (scope === "subtree") {
    const refCollection = String(b.scope_ref).slice(0, String(b.scope_ref).indexOf("/"));
    if (refCollection !== collection) {
      if (refCollection !== "departments") throw invalidArgument(`scope_ref for scope=subtree must be a ${collection} or a departments object`);
      const tiers = supportedScopesOf(policy, collection);
      if (!tiers.includes("named-dept")) throw invalidArgument(`"${collection}" is not department-coded, so it cannot be scoped to one department`);
    }
  }
  // The create gate is collection-level only: no per-object/field/verb narrowing (a verb/field would make the
  // 1-token pattern meaningless).
  if (scope === "create" && (b.field != null || b.verb != null)) throw invalidArgument("scope=create gates collection-level creation; it takes no field or verb");
  if (b.effect !== undefined && b.effect !== "allow" && b.effect !== "deny") throw invalidArgument("effect must be allow|deny");
  const effect = b.effect === "deny" ? "deny" : "allow";
  const hasLevel = b.level !== undefined && b.level !== null;
  const hasVerb = b.verb !== undefined && b.verb !== null;
  if (hasLevel && hasVerb) throw invalidArgument("provide either level or verb, not both");
  if (effect === "deny" && hasLevel) throw invalidArgument("effect=deny does not take a level (deny the object/scope, or a specific verb)");
  if (effect === "allow" && !hasLevel && !hasVerb) throw invalidArgument("provide level (standard method) or verb (custom method)");
  if (hasLevel && !LEVELS.has(b.level as Level)) throw invalidArgument("level must be read|write|admin");
  // `*` is the wildcard verb = ALL custom methods (compiles to a `collection.<scope>.*` allow/deny that the
  // matcher's `*` token matches against any verb), so one rule covers every custom method instead of one each.
  if (hasVerb && b.verb !== "*" && (typeof b.verb !== "string" || !VERB_RE.test(b.verb))) throw invalidArgument("verb must be a custom-method name (or '*' for all custom methods)");
  // The level tokens are the ACTION token of a STANDARD key, so a verb named `read`/`write`/`admin` would make
  // a verb pattern collide with the standard lane (an all-scope verb rule carries a `**` id token, which also
  // matches the collection-level standard key). No custom method is named that; reject it rather than let one
  // author a rule whose blast radius is not what the modal shows.
  if (hasVerb && LEVELS.has(b.verb as Level)) throw invalidArgument("verb must be a custom-method name, not a level (read|write|admin)");
  // `*` is ALLOW-only: the custom-allow lane is consulted only for custom requests (safe), but the deny lane
  // is checked for standard requests too, where `*` would also match the read/write/admin token and over-deny.
  if (b.verb === "*" && effect === "deny") throw invalidArgument("verb '*' (all custom methods) supports allow only; deny a specific method instead");
  const field = b.field;
  if (field !== undefined && field !== null) {
    if (typeof field !== "string" || !field) throw invalidArgument("field must be a non-empty string");
    if (!isFieldScopeTarget(policy, collection, field)) throw invalidArgument(`"${field}" is not an access-controlled field of "${collection}"`);
  }
  // Optional expiry (temporary access). Must be a real instant in the FUTURE - an already-lapsed rule would
  // be authored dead, which reads on screen as granted access that silently does nothing.
  let expiresAt: Date | undefined;
  if (b.expire_time !== undefined && b.expire_time !== null && b.expire_time !== "") {
    const t = typeof b.expire_time === "number" ? b.expire_time : Date.parse(String(b.expire_time));
    if (!Number.isFinite(t)) throw invalidArgument("expire_time must be an ISO timestamp");
    if (t <= +now) throw invalidArgument("expire_time must be in the future");
    expiresAt = new Date(t);
  }
  // An optional THRESHOLD on the row (domain/ruleCondition.ts). Validated against the collection's declared
  // conditionable fields, so a typo is refused at authoring time rather than becoming a rule that silently
  // refuses everything (the evaluator fails closed on an unknown field, which is right at decision time and
  // useless as feedback here).
  let condition: RuleCondition | undefined;
  if (b.condition !== undefined && b.condition !== null && b.condition !== "") {
    const parsed = parseCondition(b.condition);
    if (!parsed) throw invalidArgument(`condition must be {field, op, value} with op one of ${CONDITION_OPS.join("/")} and a numeric value`);
    const allowed = conditionFieldsOf(collection);
    if (!allowed[parsed.field]) {
      const names = Object.keys(allowed);
      throw invalidArgument(names.length ? `condition field must be one of ${names.join("/")} for ${collection}` : `${collection} rules cannot carry a condition`);
    }
    // A limit on a rule that grants nothing to exercise it against is a rule that reads as capped and is not.
    if (scope === "create") throw invalidArgument("a create rule has no row to measure, so it cannot carry a condition");
    condition = parsed;
  }
  // An optional NETWORK fence. Validated by parsing it: an allow-list that yields no usable rule is a typo, and
  // a typo here is a rule that silently refuses every request rather than one that fences it.
  let fromIp: string | undefined;
  if (b.from_ip !== undefined && b.from_ip !== null && String(b.from_ip).trim() !== "") {
    const raw = String(b.from_ip).trim();
    if (!parseFromIp(raw)?.length) throw invalidArgument("from_ip must be a comma-separated list of IP addresses or CIDR blocks");
    fromIp = raw;
  }
  // An optional relative TIME WINDOW, validated against the collection's declared date fields for the same
  // reason a threshold is: an unlisted field would be a rule that silently refuses everything.
  let window: RuleWindow | undefined;
  if (b.window !== undefined && b.window !== null && b.window !== "") {
    const parsed = parseWindow(b.window);
    if (!parsed) throw invalidArgument("window must be {field, within_days} with a positive number of days");
    const allowed = windowFieldsOf(collection);
    if (!allowed[parsed.field]) {
      const names = Object.keys(allowed);
      throw invalidArgument(names.length ? `window field must be one of ${names.join("/")} for ${collection}` : `${collection} rules cannot carry a time window`);
    }
    if (scope === "create") throw invalidArgument("a create rule has no row to date, so it cannot carry a time window");
    window = parsed;
  }
  return {
    subjectKind,
    subject,
    collection,
    condition,
    fromIp,
    window,
    scope: scope as AccessRuleScope,
    scopeRef: typeof b.scope_ref === "string" ? b.scope_ref : undefined,
    field: typeof field === "string" ? field : undefined,
    level: hasLevel ? (b.level as Level) : undefined,
    verb: hasVerb ? (b.verb as string) : undefined,
    effect,
    expiresAt,
  };
}

// Strict manifest validation for policy writes: all five sections must be present objects.
export function validateManifest(value: unknown): Policy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArgument("policy value must be an object");
  const v = value as Record<string, unknown>;
  const isObj = (x: unknown) => x !== null && typeof x === "object" && !Array.isArray(x);
  for (const k of ["protected_fields", "references", "owner_refs", "state_visibility", "audit"]) {
    if (!isObj(v[k])) throw invalidArgument(`policy manifest missing or invalid "${k}"`);
  }
  return value as Policy;
}
