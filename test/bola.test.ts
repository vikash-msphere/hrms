import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// DoD #3 acceptance suite: free of BOLA. Every owner-scoped item decision resolves the object's code and
// matches it against the caller's scope (me / my-dept). These assert object-level isolation directly on the
// engine: a caller may reach their OWN owned objects, never another employee's or another dept's, except
// where policy explicitly grants breadth (manager dept, hr/payroll base records, super everything).
//
// Codes are owner-embedded: an employee's code IS the employees item code; their leave-requests/payslips/
// documents/operations/leave-balances codes are nested under it. (The wire token is decoded to this code
// before the decision; opaque tokens are defense-in-depth, never the guard - so we test the code path.)
const SELF = "04-002-001"; // caller, dept 04-002
const PEER = "04-002-002"; // same dept, different employee
const OTHER = "07-001-001"; // different dept

const owned = (code: string) => `${code}-0`; // an owner-embedded child (leave-request/payslip/doc/op/balance)
const d = (role: string, method: string, path: string, self: string | null = SELF) =>
  decide(grantFor(role), resolveRequest(method, path), { employeeCode: self }).allow;

const OWNED_COLLECTIONS = ["leave-requests", "payslips", "personal-documents", "operations", "leave-balances"] as const;

describe("BOLA - employee: own only, never another employee", () => {
  it("reaches own employee record + owned objects", () => {
    expect(d("employee", "GET", `/v1/employees/${SELF}`)).toBe(true);
    expect(d("employee", "PATCH", `/v1/employees/${SELF}/bank-account`)).toBe(true); // own PII
    expect(d("employee", "PATCH", `/v1/employees/${SELF}/bio`)).toBe(true); // own public about-me
    for (const col of OWNED_COLLECTIONS) expect(d("employee", "GET", `/v1/${col}/${owned(SELF)}`)).toBe(true);
  });
  it("cannot reach a dept peer's or another dept's objects", () => {
    for (const victim of [PEER, OTHER]) {
      expect(d("employee", "GET", `/v1/employees/${victim}`)).toBe(false);
      expect(d("employee", "PATCH", `/v1/employees/${victim}`)).toBe(false);
      expect(d("employee", "GET", `/v1/employees/${victim}/bank-account`)).toBe(false);
      expect(d("employee", "PATCH", `/v1/employees/${victim}/bio`)).toBe(false); // never another's bio
      for (const col of OWNED_COLLECTIONS) expect(d("employee", "GET", `/v1/${col}/${owned(victim)}`)).toBe(false);
    }
  });
});

describe("BOLA - manager: own dept subtree, never cross-dept, never PII", () => {
  it("reads a dept peer's base record + dept leave, but not their PII", () => {
    expect(d("manager", "GET", `/v1/employees/${PEER}`)).toBe(true); // dept peer base record
    expect(d("manager", "GET", `/v1/employees/${PEER}/bank-account`)).toBe(false); // peer PII - never
    expect(d("manager", "GET", `/v1/leave-requests/${owned(PEER)}`)).toBe(true); // dept leave
    expect(d("manager", "POST", `/v1/leave-requests/${owned(PEER)}:approve`)).toBe(true); // dept approve (P3a fix)
  });
  it("cannot reach another department", () => {
    expect(d("manager", "GET", `/v1/employees/${OTHER}`)).toBe(false);
    expect(d("manager", "GET", `/v1/leave-requests/${owned(OTHER)}`)).toBe(false);
    expect(d("manager", "POST", `/v1/leave-requests/${owned(OTHER)}:approve`)).toBe(false); // cross-dept approve denied
  });
});

describe("BOLA - hr_admin / payroll_admin: base records broad, others' PII never", () => {
  it("read any base record but not anyone else's PII", () => {
    for (const role of ["hr_admin", "payroll_admin"] as const) {
      expect(d(role, "GET", `/v1/employees/${OTHER}`)).toBe(true); // base record
      for (const sub of ["bank-account", "identity", "personal-info"]) {
        expect(d(role, "GET", `/v1/employees/${OTHER}/${sub}`)).toBe(false); // PII is super-only
      }
    }
  });
  it("payroll cannot write employee records; hr can", () => {
    expect(d("payroll_admin", "PATCH", `/v1/employees/${OTHER}`)).toBe(false);
    expect(d("hr_admin", "PATCH", `/v1/employees/${OTHER}`)).toBe(true);
    expect(d("hr_admin", "PATCH", `/v1/employees/${OTHER}/bio`)).toBe(true); // HR may tidy any public about-me
  });
});

describe("BOLA - super_admin reaches every object (the only ** principal)", () => {
  it("reads/writes anyone's record and PII", () => {
    expect(d("super_admin", "GET", `/v1/employees/${OTHER}/bank-account`, null)).toBe(true);
    expect(d("super_admin", "PATCH", `/v1/employees/${OTHER}`, null)).toBe(true);
    for (const col of OWNED_COLLECTIONS) expect(d("super_admin", "GET", `/v1/${col}/${owned(OTHER)}`, null)).toBe(true);
  });
});
