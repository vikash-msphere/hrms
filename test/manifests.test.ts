import { describe, it, expect } from "vitest";
import { REFERENCES, PROTECTED_FIELDS, referencesOf, protectedFieldsOf, isFieldScopeTarget, subresourceBodyKey, DEFAULT_POLICY } from "../src/domain/manifests";
import { GRANTS } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

const SELF = { employeeCode: "04-1c-0a9" };
// Simulate the middleware's per-field check: write on <collection>/<id>/<field>.
const canSetField = (role: keyof typeof GRANTS, path: string) => decide(GRANTS[role], resolveRequest("PATCH", path), SELF).allow;

describe("REFERENCES manifest", () => {
  it("lists only non-ownership refs, with a read level on the target", () => {
    expect(referencesOf("leave-requests")).toEqual({ leave_type: { collection: "leave-types", level: "read" } });
    expect(referencesOf("payroll-runs").pay_period?.collection).toBe("pay-periods");
    // ownership refs live in OWNER_REFS, not REFERENCES (they require write-scope, not just read)
    expect(referencesOf("employees")).toEqual({});
    expect(referencesOf("personal-documents").employee).toBeUndefined();
  });
});

describe("PROTECTED_FIELDS manifest", () => {
  it("guards the escalation-sensitive fields", () => {
    expect(protectedFieldsOf("users")).toContain("role");
    expect(protectedFieldsOf("employees")).toEqual(["department", "manager", "epf_enrolled", "employee_number"]);
    expect(protectedFieldsOf("compensation")).toContain("annual_ctc"); // the authoritative pay figure (base_pay is derived/readOnly)
    expect(protectedFieldsOf("holidays")).toEqual([]); // unguarded resource
  });

  it("re-parent fields: HR may set department, a plain employee may not (even on self)", () => {
    // The middleware will check write on <collection>/<id>/<field>; here we exercise that key directly.
    expect(canSetField("hr_admin", "/v1/employees/07-2a-0b1/department")).toBe(true); // employees.** write
    expect(canSetField("employee", "/v1/employees/me/department")).toBe(false); // no record write -> cannot re-parent self
    expect(canSetField("employee", "/v1/employees/me/bank-account")).toBe(true); // but self sub-resources are fine
  });

  it("compensation amounts are payroll-only, never self", () => {
    expect(canSetField("payroll_admin", "/v1/compensation/04-1c-0a9-0/base_pay")).toBe(true); // compensation.** write
    expect(canSetField("employee", "/v1/compensation/04-1c-0a9-0/base_pay")).toBe(false);
  });
});

describe("isFieldScopeTarget - which fields a per-field rule may target", () => {
  const P = DEFAULT_POLICY;
  it("accepts a protected base field and a whole sensitive sub-resource", () => {
    expect(isFieldScopeTarget(P, "employees", "department")).toBe(true);
    expect(isFieldScopeTarget(P, "employees", "bank-account")).toBe(true);
    expect(isFieldScopeTarget(P, "employees", "identity")).toBe(true);
  });
  it("accepts the tax sub-resource and its fields", () => {
    expect(isFieldScopeTarget(P, "employees", "tax")).toBe(true);
    expect(isFieldScopeTarget(P, "employees", "tax.prior_employer_income")).toBe(true);
    expect(subresourceBodyKey("tax")).toBe("values");
  });
  it("accepts a single field WITHIN a sensitive sub-resource (dotted), key not validated", () => {
    expect(isFieldScopeTarget(P, "employees", "identity.uan")).toBe(true);
    expect(isFieldScopeTarget(P, "employees", "bank-account.account_number")).toBe(true);
    expect(isFieldScopeTarget(P, "employees", "personal-info.blood_group")).toBe(true);
    expect(isFieldScopeTarget(P, "employees", "identity.anything")).toBe(true); // dynamic identity keys
  });
  it("rejects an inert field: a non-protected base field, or a non-sensitive sub-resource prefix", () => {
    expect(isFieldScopeTarget(P, "employees", "first_name")).toBe(false);
    expect(isFieldScopeTarget(P, "employees", "notasub.x")).toBe(false);
    expect(isFieldScopeTarget(P, "employees", "identity.")).toBe(false); // empty leaf key
  });
});

describe("subresourceBodyKey - body-shape map for per-field write gating", () => {
  it("maps field-bearing sub-resources to their write-body wrapper key", () => {
    expect(subresourceBodyKey("identity")).toBe("values");
    expect(subresourceBodyKey("bank-account")).toBe(""); // flat body
    expect(subresourceBodyKey("personal-info")).toBe("");
  });
  it("returns null for a path that is not a field-bearing sub-resource", () => {
    expect(subresourceBodyKey("employees")).toBeNull();
    expect(subresourceBodyKey("documents")).toBeNull();
  });
});
