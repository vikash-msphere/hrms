import { describe, it, expect } from "vitest";
import { validateAccessRule, validateManifest } from "../src/domain/policyValidate";
import { DEFAULT_POLICY } from "../src/domain/manifests";
import { COLLECTIONS, isGrantCollection } from "../src/domain/collections";
import { GRANTS } from "../src/domain/grants";
import { RESOURCE_COLLECTIONS } from "../src/lib/authzResolve";

const P = DEFAULT_POLICY;
const base = { subject_kind: "role", subject: "manager", collection: "employees" };

describe("validateAccessRule (uniform write-time gate for role + user rules)", () => {
  it("accepts a role level rule, a user object rule, a verb rule, and a deny", () => {
    expect(validateAccessRule({ ...base, scope: "dept", level: "write" }, P)).toMatchObject({
      subjectKind: "role", subject: "manager", collection: "employees", scope: "dept", level: "write", effect: "allow",
    });
    expect(validateAccessRule({ subject_kind: "user", subject: "users/abc", collection: "leave-requests", scope: "exact", scope_ref: "leave-requests/xyz", level: "read" }, P).effect).toBe("allow");
    expect(validateAccessRule({ ...base, collection: "leave-requests", scope: "dept", verb: "approve" }, P).verb).toBe("approve");
    expect(validateAccessRule({ ...base, collection: "payroll-runs", scope: "all", verb: "approve", effect: "deny" }, P).effect).toBe("deny");
  });
  it("accepts the `*` wildcard verb (all custom methods) for allow, rejects it for deny", () => {
    expect(validateAccessRule({ ...base, collection: "leave-requests", scope: "dept", verb: "*" }, P).verb).toBe("*");
    // `*` deny would also match the standard read/write/admin token in the deny lane -> allow-only.
    expect(() => validateAccessRule({ ...base, collection: "leave-requests", scope: "dept", verb: "*", effect: "deny" }, P)).toThrow();
  });
  it("rejects not-exactly-one rule kind", () => {
    expect(() => validateAccessRule({ ...base, scope: "all", level: "write", verb: "approve" }, P)).toThrow(); // level+verb
    expect(() => validateAccessRule({ ...base, scope: "all", level: "write", effect: "deny" }, P)).toThrow(); // deny+level
    expect(() => validateAccessRule({ ...base, scope: "all" }, P)).toThrow(); // allow with neither
  });
  it("rejects invalid level / scope / collection / subject", () => {
    expect(() => validateAccessRule({ ...base, scope: "all", level: "superuser" }, P)).toThrow();
    expect(() => validateAccessRule({ ...base, scope: "galaxy", level: "read" }, P)).toThrow();
    expect(() => validateAccessRule({ ...base, collection: "nope", scope: "all", level: "read" }, P)).toThrow(/unknown collection/);
    expect(() => validateAccessRule({ subject_kind: "user", subject: "manager", collection: "employees", scope: "all", level: "read" }, P)).toThrow(/users/);
    expect(() => validateAccessRule({ subject_kind: "alien", subject: "x", collection: "employees", scope: "all", level: "read" }, P)).toThrow();
  });
  it("scope exact/subtree require scope_ref", () => {
    expect(() => validateAccessRule({ ...base, scope: "exact", level: "read" }, P)).toThrow(/scope_ref/);
  });
  it("field rule: accepts a protected field or sub-resource, rejects a non-protected (inert) field", () => {
    expect(validateAccessRule({ ...base, scope: "all", field: "department", level: "write" }, P).field).toBe("department");
    expect(validateAccessRule({ ...base, scope: "all", field: "bank-account", level: "read" }, P).field).toBe("bank-account");
    expect(() => validateAccessRule({ ...base, scope: "all", field: "first_name", level: "write" }, P)).toThrow(/not an access-controlled field/);
  });
  it("field rule: accepts a single field within a sensitive sub-resource (dotted), rejects a bogus prefix", () => {
    expect(validateAccessRule({ ...base, scope: "exact", scope_ref: "employees/x", field: "identity.uan", effect: "deny" }, P).field).toBe("identity.uan");
    expect(validateAccessRule({ ...base, scope: "all", field: "bank-account.account_number", level: "read" }, P).field).toBe("bank-account.account_number");
    expect(() => validateAccessRule({ ...base, scope: "all", field: "bogus.x", level: "write" }, P)).toThrow(/not an access-controlled field/);
  });
});

describe("validateManifest (P2 strict policy write)", () => {
  it("accepts the default manifest", () => {
    expect(validateManifest(DEFAULT_POLICY)).toBe(DEFAULT_POLICY);
  });
  it("rejects a manifest missing a required section", () => {
    const { audit, ...missing } = DEFAULT_POLICY as Record<string, unknown>;
    expect(() => validateManifest(missing)).toThrow(/audit/);
    expect(() => validateManifest({})).toThrow();
    expect(() => validateManifest(null)).toThrow();
  });
});

describe("collection registry stays in sync (drift gate)", () => {
  it("every seed-grant pattern names a known collection (or **)", () => {
    const bad: string[] = [];
    for (const grant of Object.values(GRANTS)) {
      const pats = [...Object.keys(grant.levels), ...grant.allow, ...(grant.deny ?? [])];
      for (const p of pats) if (!isGrantCollection(p.split(".")[0]!)) bad.push(p);
    }
    expect(bad).toEqual([]);
  });
  it("every code-bearing resource collection is in the registry", () => {
    const missing = RESOURCE_COLLECTIONS.filter((c) => !COLLECTIONS.has(c));
    expect(missing).toEqual([]);
  });
});

// A cross-collection anchor is how a named department is granted: the rule is about `leave-requests`, the
// anchor is a `departments` object, and it works because every owned code is composed under its employee,
// which is composed under its department - so `<deptCode>-*` reaches the whole department's rows.
//
// The failure it has to refuse is the silent one. Anchoring a collection that is NOT department-coded
// composes a prefix nothing is coded under: the rule stores fine, displays fine, and decides nothing. An
// access UI may refuse a rule; it may not accept one and quietly do nothing with it.
describe("validateAccessRule - cross-collection subtree anchor", () => {
  const anchor = (collection: string) => ({ subject_kind: "role", subject: "manager", collection, scope: "subtree", scope_ref: "departments/abc", level: "read" });

  it("accepts a department anchor on a department-coded collection", () => {
    expect(validateAccessRule(anchor("leave-requests"), P).scopeRef).toBe("departments/abc");
    expect(validateAccessRule(anchor("employees"), P).scopeRef).toBe("departments/abc");
    // Newly department-scopable, and so newly anchorable (manifests.ts SUPPORTED_SCOPES).
    expect(validateAccessRule(anchor("expenses"), P).scopeRef).toBe("departments/abc");
  });

  it("refuses a department anchor on a collection that is not department-coded", () => {
    // Flat catalogues: their codes have no department segment, so the prefix would match nothing.
    expect(() => validateAccessRule(anchor("holidays"), P)).toThrow(/not department-coded/);
    expect(() => validateAccessRule(anchor("leave-types"), P)).toThrow(/not department-coded/);
  });

  it("refuses an anchor that is neither the rule's own collection nor a department", () => {
    const r = { subject_kind: "role", subject: "manager", collection: "leave-requests", scope: "subtree", scope_ref: "employees/abc", level: "read" };
    expect(() => validateAccessRule(r, P)).toThrow(/must be a leave-requests or a departments object/);
  });

  it("still accepts a same-collection subtree (the departments case it was built for)", () => {
    const r = { subject_kind: "role", subject: "manager", collection: "departments", scope: "subtree", scope_ref: "departments/abc", level: "read" };
    expect(validateAccessRule(r, P).scope).toBe("subtree");
  });

  it("leaves `exact` alone - it pins to one object of the rule's own collection", () => {
    const r = { subject_kind: "role", subject: "manager", collection: "leave-requests", scope: "exact", scope_ref: "leave-requests/abc", level: "read" };
    expect(validateAccessRule(r, P).scope).toBe("exact");
  });
});
