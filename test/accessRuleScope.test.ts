import { describe, it, expect } from "vitest";
import { ruleScopeFor, ruleMatchesTarget, fieldIconShouldShow } from "../web/src/components/access/accessRuleScope";

// Regression guards for the ACL UI's target -> rule mapping - the exact surface that kept producing
// over-broad rules (a field icon writing a collection-wide rule; a field-of-object not pinning to the
// object). Each `it` is a bug we shipped at least once.

describe("ruleScopeFor - a rule is exactly as narrow as the target clicked", () => {
  it("object + field -> exact + field (this object's field, NOT collection-wide)", () => {
    expect(ruleScopeFor({ collection: "employees", objectPath: "employees/abc", field: "bank-account" })).toEqual({
      scope: "exact",
      scope_ref: "employees/abc",
      field: "bank-account",
    });
  });
  it("field only (no object) -> all + field (that field across the collection)", () => {
    expect(ruleScopeFor({ collection: "employees", field: "department" })).toEqual({ scope: "all", field: "department" });
  });
  it("object only -> exact (this one object)", () => {
    expect(ruleScopeFor({ collection: "leave-requests", objectPath: "leave-requests/x" })).toEqual({ scope: "exact", scope_ref: "leave-requests/x" });
  });
  it("collection only -> all (the whole collection)", () => {
    expect(ruleScopeFor({ collection: "employees" })).toEqual({ scope: "all" });
  });
  it("subtree on an object -> subtree pinned to that object (this dept + the codes under it)", () => {
    expect(ruleScopeFor({ collection: "departments", objectPath: "departments/eng", scope: "subtree" })).toEqual({
      scope: "subtree",
      scope_ref: "departments/eng",
    });
  });
  it("subtree with NO object degrades to all (subtree must anchor to a ref)", () => {
    expect(ruleScopeFor({ collection: "departments", scope: "subtree" })).toEqual({ scope: "all" });
  });
  it("self/dept tiers are subject-relative (no scope_ref)", () => {
    expect(ruleScopeFor({ collection: "employees", scope: "self" })).toEqual({ scope: "self" });
    expect(ruleScopeFor({ collection: "employees", objectPath: "employees/abc", scope: "dept" })).toEqual({ scope: "dept" });
  });
  it("create target -> create gate (collection-level create, NOT all objects)", () => {
    // A 'New X' button must produce the create scope (1-token gate), never scope:all (= write on every
    // object). The create flag wins over any other dimension.
    expect(ruleScopeFor({ collection: "tickets", create: true })).toEqual({ scope: "create" });
    expect(ruleScopeFor({ collection: "tickets", create: true }).scope).not.toBe("all");
  });
  it("create rule matches only the create target (never a whole-collection or per-object rule)", () => {
    const t = { collection: "tickets", create: true };
    expect(ruleMatchesTarget({ collection: "tickets", scope: "create" }, t)).toBe(true);
    expect(ruleMatchesTarget({ collection: "tickets", scope: "all" }, t)).toBe(false);
    expect(ruleMatchesTarget({ collection: "tickets", scope: "exact", scope_ref: "tickets/x" }, t)).toBe(false);
  });
  it("a dotted sub-resource field of an object -> exact + that field path (identity.uan)", () => {
    expect(ruleScopeFor({ collection: "employees", objectPath: "employees/abc", field: "identity.uan" })).toEqual({
      scope: "exact",
      scope_ref: "employees/abc",
      field: "identity.uan",
    });
  });
  it("a field-of-object NEVER yields scope:all by default (the 'applies to all objects/fields' bug)", () => {
    const s = ruleScopeFor({ collection: "employees", objectPath: "employees/abc", field: "department" });
    expect(s.scope).toBe("exact");
    expect(s.scope_ref).toBe("employees/abc");
  });
  // Field access is scopable exactly like object access: the chosen tier rides with the field token, so a rule
  // can cover "this employee's emergency phone", "their own", "their department's", or "everyone's".
  it("field + self/dept -> subject-relative field rule (no scope_ref)", () => {
    expect(ruleScopeFor({ collection: "employees", field: "personal-info.emergency_phone", scope: "self" })).toEqual({ scope: "self", field: "personal-info.emergency_phone" });
    expect(ruleScopeFor({ collection: "employees", objectPath: "employees/abc", field: "personal-info.emergency_phone", scope: "dept" })).toEqual({ scope: "dept", field: "personal-info.emergency_phone" });
  });
  it("field + exact (this object) -> field pinned to the object", () => {
    expect(ruleScopeFor({ collection: "employees", objectPath: "employees/abc", field: "personal-info.emergency_phone", scope: "exact" })).toEqual({ scope: "exact", scope_ref: "employees/abc", field: "personal-info.emergency_phone" });
  });
  it("field + all (explicitly chosen) -> that field across all objects, even with an object in context", () => {
    expect(ruleScopeFor({ collection: "employees", objectPath: "employees/abc", field: "personal-info.emergency_phone", scope: "all" })).toEqual({ scope: "all", field: "personal-info.emergency_phone" });
  });
});

describe("ruleMatchesTarget - scoped field rules partition by tier AND field", () => {
  it("a self-scoped field target matches only the self+field rule", () => {
    const t = { collection: "employees", field: "personal-info.emergency_phone", scope: "self" };
    expect(ruleMatchesTarget({ collection: "employees", scope: "self", field: "personal-info.emergency_phone" }, t)).toBe(true);
    expect(ruleMatchesTarget({ collection: "employees", scope: "all", field: "personal-info.emergency_phone" }, t)).toBe(false); // different tier
    expect(ruleMatchesTarget({ collection: "employees", scope: "self", field: "personal-info.blood_group" }, t)).toBe(false); // different field
    expect(ruleMatchesTarget({ collection: "employees", scope: "self" }, t)).toBe(false); // non-field rule
  });
  it("an exact field-of-object target matches only that object's field rule", () => {
    const t = { collection: "employees", objectPath: "employees/abc", field: "personal-info.emergency_phone", scope: "exact" };
    expect(ruleMatchesTarget({ collection: "employees", scope: "exact", scope_ref: "employees/abc", field: "personal-info.emergency_phone" }, t)).toBe(true);
    expect(ruleMatchesTarget({ collection: "employees", scope: "exact", scope_ref: "employees/zzz", field: "personal-info.emergency_phone" }, t)).toBe(false);
  });
});

describe("ruleMatchesTarget - per-object and collection-wide rules are never conflated", () => {
  const objField = { collection: "employees", objectPath: "employees/abc", field: "bank-account" };
  it("matches a rule of the same exact object + field", () => {
    expect(ruleMatchesTarget({ collection: "employees", scope: "exact", scope_ref: "employees/abc", field: "bank-account" }, objField)).toBe(true);
  });
  it("does NOT match a different object's same field", () => {
    expect(ruleMatchesTarget({ collection: "employees", scope: "exact", scope_ref: "employees/zzz", field: "bank-account" }, objField)).toBe(false);
  });
  it("does NOT match the collection-wide version of the field", () => {
    expect(ruleMatchesTarget({ collection: "employees", scope: "all", field: "bank-account" }, objField)).toBe(false);
  });
  it("never matches a different collection (the bank -> documents cross-namespace bug)", () => {
    expect(ruleMatchesTarget({ collection: "personal-documents", scope: "exact", scope_ref: "personal-documents/d", field: "bank-account" }, objField)).toBe(false);
  });
  it("object target ignores field rules and vice-versa", () => {
    const obj = { collection: "employees", objectPath: "employees/abc" };
    expect(ruleMatchesTarget({ collection: "employees", scope: "exact", scope_ref: "employees/abc" }, obj)).toBe(true);
    expect(ruleMatchesTarget({ collection: "employees", scope: "exact", scope_ref: "employees/abc", field: "department" }, obj)).toBe(false);
  });
  it("scope matching is verb-agnostic: a custom-method rule matches the object scope (the modal filters by verb)", () => {
    const obj = { collection: "leave-requests", objectPath: "leave-requests/x" };
    expect(ruleMatchesTarget({ collection: "leave-requests", scope: "exact", scope_ref: "leave-requests/x", verb: "approve" }, obj)).toBe(true);
    expect(ruleMatchesTarget({ collection: "leave-requests", scope: "all", verb: "approve" }, { collection: "leave-requests" })).toBe(true);
  });
  it("subtree target matches only the subtree rule pinned to the same object", () => {
    const t = { collection: "departments", objectPath: "departments/eng", scope: "subtree" };
    expect(ruleMatchesTarget({ collection: "departments", scope: "subtree", scope_ref: "departments/eng" }, t)).toBe(true);
    expect(ruleMatchesTarget({ collection: "departments", scope: "subtree", scope_ref: "departments/sales" }, t)).toBe(false);
    expect(ruleMatchesTarget({ collection: "departments", scope: "exact", scope_ref: "departments/eng" }, t)).toBe(false);
    expect(ruleMatchesTarget({ collection: "departments", scope: "all" }, t)).toBe(false);
  });
  it("collection target matches only collection-wide non-field rules", () => {
    const col = { collection: "employees" };
    expect(ruleMatchesTarget({ collection: "employees", scope: "all" }, col)).toBe(true);
    expect(ruleMatchesTarget({ collection: "employees", scope: "all", field: "department" }, col)).toBe(false);
    expect(ruleMatchesTarget({ collection: "employees", scope: "exact", scope_ref: "employees/abc" }, col)).toBe(false);
  });
});

describe("fieldIconShouldShow - icon ONLY for a real field-level target", () => {
  // The icon shows for any explicit field KEY: a protected base field (department), a whole sub-resource
  // (bank-account), or a single sub-resource field written dotted (identity.uan). A control with no field key
  // (undefined) gets none - that breadth belongs to the object/collection icon, not an unlabelled control.
  it("no field key -> hidden", () => expect(fieldIconShouldShow(undefined)).toBe(false));
  it("explicit field / sub-resource / dotted sub-resource field -> shown", () => {
    expect(fieldIconShouldShow("department")).toBe(true);
    expect(fieldIconShouldShow("bank-account")).toBe(true);
    expect(fieldIconShouldShow("identity.uan")).toBe(true);
  });
});

// "One department" - the tier that says WHICH department, rather than "the subject's own". It compiles to the
// same wire scope a subtree does, because it IS one (`<deptCode>-*`); what is new is that the anchor is picked
// by the grantor instead of taken from whatever row the modal was opened on. That distinction is the whole
// test: an anchor must never be confused with the page's object, in either direction.
describe("ruleScopeFor - named department", () => {
  it("compiles to a subtree pinned to the PICKED department, not the page's object", () => {
    const t = { collection: "leave-requests", objectPath: "leave-requests/req-1", anchorPath: "departments/sales", scope: "named-dept" };
    expect(ruleScopeFor(t)).toEqual({ scope: "subtree", scope_ref: "departments/sales" });
  });

  it("carries a field token like every other tier", () => {
    const t = { collection: "employees", anchorPath: "departments/sales", field: "bank-account", scope: "named-dept" };
    expect(ruleScopeFor(t)).toEqual({ scope: "subtree", scope_ref: "departments/sales", field: "bank-account" });
  });

  it("with no department picked it does NOT silently pin to the page's object", () => {
    // Degrading to org-wide is the existing behaviour for an unanchored subtree, and the modal blocks the
    // write in this state - but the one outcome that must never happen is pinning to `objectPath`, which
    // would author a rule about a single leave request while the admin believed they granted a department.
    const t = { collection: "leave-requests", objectPath: "leave-requests/req-1", scope: "named-dept" };
    expect(ruleScopeFor(t)).toEqual({ scope: "all" });
  });
});

describe("ruleMatchesTarget - named department", () => {
  const t = { collection: "leave-requests", objectPath: "leave-requests/req-1", anchorPath: "departments/sales", scope: "named-dept" };
  it("matches the rule on the same department only", () => {
    expect(ruleMatchesTarget({ collection: "leave-requests", scope: "subtree", scope_ref: "departments/sales" }, t)).toBe(true);
    expect(ruleMatchesTarget({ collection: "leave-requests", scope: "subtree", scope_ref: "departments/eng" }, t)).toBe(false);
  });
  it("never matches the page's object or the subject-relative dept rule", () => {
    expect(ruleMatchesTarget({ collection: "leave-requests", scope: "subtree", scope_ref: "leave-requests/req-1" }, t)).toBe(false);
    expect(ruleMatchesTarget({ collection: "leave-requests", scope: "dept" }, t)).toBe(false);
    expect(ruleMatchesTarget({ collection: "leave-requests", scope: "all" }, t)).toBe(false);
  });
});
