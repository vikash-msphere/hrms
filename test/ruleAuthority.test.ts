import { describe, it, expect } from "vitest";
import { ruleWithinAuthority } from "../src/domain/access";
import { grantFor } from "../bootstrap/authz/grants";
import type { Grant } from "../src/domain/permissions";

// An access admin may hand out only authority they hold themselves. Without this bound, delegating the ACL was
// delegating super by proxy: any rule could be written for somebody else, and cloned from super_admin.

const actor = (grant: Grant, employeeCode: string | null = "04-1c-0a9") => ({ grant, employeeCode });
// A delegated access admin who is otherwise an hr_admin.
const hr = actor(grantFor("hr_admin"));

describe("ruleWithinAuthority", () => {
  it("allows a rule the author already holds at that level or above", () => {
    expect(ruleWithinAuthority(hr, { pattern: "holidays.**", level: "write" })).toBe(true);
    expect(ruleWithinAuthority(hr, { pattern: "leave-requests.**", level: "read" })).toBe(true);
    expect(ruleWithinAuthority(hr, { pattern: "leave-requests.*.approve" })).toBe(true); // hr holds leave-requests.*.approve
    // The ACL writes an all-scope verb rule as `<collection>.**.<verb>` (accessRules.ts buildPattern), which is
    // the item form and the collection-level form at once; holding the one that exists is holding the verb.
    expect(ruleWithinAuthority(hr, { pattern: "leave-requests.**.approve" })).toBe(true);
    expect(ruleWithinAuthority(hr, { pattern: "leave-requests.my-dept.approve" })).toBe(true); // any row covers any department's
  });

  it("refuses a rule that reaches past the author's own grant", () => {
    expect(ruleWithinAuthority(hr, { pattern: "compensation.**", level: "read" })).toBe(false); // hr has no comp access
    expect(ruleWithinAuthority(hr, { pattern: "leave-requests.**", level: "write" })).toBe(false); // hr reads, not writes
    expect(ruleWithinAuthority(hr, { pattern: "payroll-runs.**.approve" })).toBe(false);
    expect(ruleWithinAuthority(hr, { pattern: "**", level: "read" })).toBe(false); // the super pattern
    expect(ruleWithinAuthority(hr, { pattern: "employees.*.bank-account.**", level: "read" })).toBe(false); // others' PII
  });

  it("maps relative scopes onto the author's own reach", () => {
    // Every employee holds their own bank details, so granting somebody THEIR OWN is within anyone's authority.
    expect(ruleWithinAuthority(hr, { pattern: "employees.me.bank-account.**", level: "write" })).toBe(true);
    // A department-wide payslip grant needs the author to reach a department's payslips.
    expect(ruleWithinAuthority(hr, { pattern: "payslips.my-dept.**", level: "read" })).toBe(false);
  });

  it("the collection-level create gate needs the author to be able to create there", () => {
    expect(ruleWithinAuthority(hr, { pattern: "holidays", level: "write" })).toBe(true);
    expect(ruleWithinAuthority(hr, { pattern: "compensation", level: "write" })).toBe(false);
  });

  it("super may grant anything", () => {
    expect(ruleWithinAuthority(actor(grantFor("super_admin"), null), { pattern: "compensation.**", level: "admin" })).toBe(true);
  });
});
