// Write-time validation for the management endpoints. The READ path stays lenient (parsePolicy falls back
// to DEFAULT on bad input so the worker never fails open); a WRITE must REJECT malformed input so a bad
// edit can never silently drop authority or revert the manifest. Pure: throws AppError (400) on bad input.
import { invalidArgument } from "../lib/errors";
import { COLLECTIONS } from "./collections";
import type { Level } from "./permissions";
import { isFieldScopeTarget, type Policy } from "./manifests";

const LEVELS = new Set<Level>(["read", "write", "admin"]);
// `create` is the collection-level CREATE gate: it compiles to the 1-token `<collection>` pattern (matches the
// bare collection POST + list, never an individual object). Distinct from `all`, which compiles to
// `<collection>.**` (every object). The engine already evaluates 1-token patterns (the seed uses them); this
// just lets the ACL author one.
const SCOPES = new Set(["all", "self", "dept", "subtree", "exact", "create"]);
const VERB_RE = /^[a-zA-Z][a-zA-Z0-9]*$/; // a custom-method name (e.g. download, approve)

export type AccessRuleScope = "all" | "self" | "dept" | "subtree" | "exact" | "create";
export type AccessRuleInput = {
  subjectKind: "role" | "user";
  subject: string; // role name, or "users/<id>" (the id already wire-decoded by the inbound edge)
  collection: string;
  scope: AccessRuleScope;
  scopeRef?: string; // "{collection}/{id}" for scope exact/subtree
  field?: string;
  level?: Level; // present only for an allow level rule
  verb?: string; // present only for a verb (custom-method) rule
  effect: "allow" | "deny";
};

// Validate + normalize ONE access rule (role OR user) - the single uniform validator, replacing the old
// blob-shaped validateGrant + the inline grant-exception checks. Rejects: unknown collection; not exactly one
// rule kind (a level rule, a verb rule, or a deny - so level+verb and deny+level are out); bad
// level/verb/scope/effect; a field rule on a field that isn't access-controlled (would be inert). The
// over-broad `**`/cross-collection rule is impossible here (collection must be a real collection, never
// `**`), so it stays super-only via the seed. Verb fail-closed + deny-wins are ENGINE behavior, not re-done
// here - this only shapes a valid row.
export function validateAccessRule(body: unknown, policy: Policy): AccessRuleInput {
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
  return {
    subjectKind,
    subject,
    collection,
    scope: scope as AccessRuleScope,
    scopeRef: typeof b.scope_ref === "string" ? b.scope_ref : undefined,
    field: typeof field === "string" ? field : undefined,
    level: hasLevel ? (b.level as Level) : undefined,
    verb: hasVerb ? (b.verb as string) : undefined,
    effect,
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
