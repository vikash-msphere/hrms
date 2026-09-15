// Pure access-rule scope logic (NO React/DOM) - the target -> rule mapping that the ACL UI uses, extracted so
// it is unit-testable without a browser. This is exactly the surface that kept regressing (a field icon
// creating a collection-wide rule, a field-of-object not pinning to the object, etc.), so it carries its own
// tests in test/accessRuleScope.test.ts. Keep it dependency-free.

// What the user clicked: a collection, optionally an object, optionally a field. `create` marks a "new <X>"
// affordance - it manages the collection-level CREATE gate (the 1-token `<collection>` write), distinct from
// per-object access and from whole-collection (`<collection>.**`) access.
// `scope` is the chosen tier for an object/collection target: "exact" (this object), "self" (own), "dept",
// "subtree", or "all". Omitted -> the legacy default (exact when an object is in scope, else all), so callers
// that don't pick a scope behave exactly as before.
// `anchorPath` is the object a "named-dept" rule is anchored to ("departments/<id>"), picked by the grantor
// rather than taken from the page. It is a SEPARATE field from `objectPath` on purpose: `objectPath` is
// whatever the clicked element is about (a leave request, an employee), and a named-department rule is
// deliberately not about that object at all - conflating them is how a "this department" grant would silently
// pin itself to whichever row the admin happened to open the modal from.
export type AccessRuleTarget = { collection: string; objectPath?: string; anchorPath?: string; field?: string; create?: boolean; scope?: string };
// The scope-bearing fields of an access rule (as listed by the API / sent on create). `verb` (the custom
// method) is intentionally NOT matched here - scope matching is verb-agnostic; the modal partitions matched
// rules by verb itself (a level rule has no verb; a custom-method rule's verb names the method).
export type AccessRuleRow = { collection: string; scope: string; scope_ref?: string; field?: string; verb?: string };
// The scope fields to POST when creating a rule for a target.
export type RuleScopeBody = { scope: string; scope_ref?: string; field?: string };

// The effective scope tier for an object/collection target (field/create targets ignore it). Defaults to the
// legacy behavior: a specific object -> "exact", a bare collection -> "all".
function effScope(t: AccessRuleTarget): string {
  return t.scope ?? (t.objectPath ? "exact" : "all");
}

// The rule scope a target should create, honoring BOTH dimensions so a rule is exactly as narrow as the thing
// clicked: create gate -> the collection-level create scope; otherwise the chosen scope TIER ("exact"/"subtree"
// pin to this object via scope_ref, self/dept/all are collection-relative), carrying the `field` token when the
// target is a field. A field rule is scoped exactly like an object rule (this object / own / dept / all) - the
// backend pattern (accessRules.ts buildPattern) composes `<collection>.<scope>.<field>` for every tier - so
// e.g. "this employee's emergency phone" or "everyone's emergency phone" are both expressible.
export function ruleScopeFor(t: AccessRuleTarget): RuleScopeBody {
  if (t.create) return { scope: "create" };
  const field = t.field ? { field: t.field } : {};
  const s = effScope(t);
  // A named department compiles to the SAME wire scope as a subtree - it is one, `<deptCode>-*` - and differs
  // only in where the anchor came from. The server sees no new scope value; the tier exists so the UI can
  // offer "one department" without an object on the page.
  if (s === "named-dept") return t.anchorPath ? { scope: "subtree", scope_ref: t.anchorPath, ...field } : { scope: "all", ...field };
  // exact (this object) and subtree (this object + the codes under it) are BOTH anchored to the clicked
  // object, so they pin via scope_ref; with no object in scope they degrade to collection-wide.
  if (s === "exact" || s === "subtree") return t.objectPath ? { scope: s, scope_ref: t.objectPath, ...field } : { scope: "all", ...field };
  return { scope: s, ...field };
}

// Does an existing rule belong to THIS target's scope (so rules at different scopes - per-object vs own vs
// collection-wide - are never conflated in the modal's list / role dropdown)? Field rules match the same scope
// tiers as object rules, additionally requiring the field token to match (a non-field rule never matches a
// field target and vice versa).
export function ruleMatchesTarget(r: AccessRuleRow, t: AccessRuleTarget): boolean {
  if (r.collection !== t.collection) return false;
  if (t.create) return r.scope === "create" && !r.field && !r.verb;
  if ((r.field ?? undefined) !== (t.field ?? undefined)) return false;
  const s = effScope(t);
  // A named-department rule is stored as `subtree`, so it is matched by its ANCHOR, not by the page's object -
  // otherwise two rules on different departments would read as the same rule.
  if (s === "named-dept") return r.scope === "subtree" && !!t.anchorPath && r.scope_ref === t.anchorPath;
  if (s === "exact" || s === "subtree") return r.scope === s && r.scope_ref === t.objectPath;
  return r.scope === s;
}

// Should a <Field>/<Detail> show its manage icon? ONLY when it has a real field-level access target - an
// explicit `field` key (a protected field like department/manager, or a sub-resource section such as
// identity/bank-account/personal-info). Ordinary fields (first_name, UAN, aadhaar, account_number, ...) have
// NO independent access - they live inside their sub-resource or the base record - so they get NO icon.
// (Previously an ordinary field with an object in scope got an OBJECT-scope icon, so "deny UAN" wrote a deny
// on the whole employee record and cascaded to Aadhaar, Bank, everything.) Object-level access is managed
// from the row icon (lists), sub-resources from their section chip, never from an arbitrary field.
export function fieldIconShouldShow(field: string | undefined): boolean {
  return !!field;
}
