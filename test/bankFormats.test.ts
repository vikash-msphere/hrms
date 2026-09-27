import { describe, it, expect } from "vitest";
import { grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// Bank bulk-payment formats: payroll + super manage the mappings/templates (/v1/bank-formats) - they are how a
// payout file is laid out, which is payroll's work; the sensitive debit account + currency (/v1/payroll-debit)
// are private-by-default so ONLY super_admin reaches them - no grant names that namespace, so every other role
// fails closed. These assert the data-driven gate.
const can = (role: string, method: string, path: string) =>
  decide(grantFor(role), resolveRequest(method, path), { employeeCode: "04-001-001" }).allow;

const ALL = ["employee", "manager", "hr_admin", "payroll_admin", "super_admin"];

describe("bank-formats authz (payroll + super manage; others denied)", () => {
  it("read + write (mappings + template upload): payroll_admin + super only", () => {
    for (const [method, path] of [["GET", "/v1/bank-formats"], ["PUT", "/v1/bank-formats"], ["POST", "/v1/bank-formats/IDFC FIRST Bank:uploadTemplate"]] as const) {
      expect(can("payroll_admin", method, path)).toBe(true);
      expect(can("super_admin", method, path)).toBe(true);
      for (const role of ["employee", "manager", "hr_admin"]) expect(can(role, method, path)).toBe(false);
    }
  });
});

// INVARIANT: employer bank details (the debit account) are reachable by super_admin ONLY, by every route
// that could expose them - the masked config namespace AND the payroll bank file (which embeds the full
// debit account + every employee's account number). Both are super-only structurally (no other role's grant
// names them), not deny-based, so no future broad grant can re-expose them. This test fails if that drifts.
describe("employer bank details are super_admin-only on every surface", () => {
  const SURFACES: [string, string][] = [
    ["GET", "/v1/payroll-debit-accounts"], // list (masked)
    ["GET", "/v1/payroll-debit-accounts/IDFC FIRST Bank"], // item (masked)
    ["PATCH", "/v1/payroll-debit-accounts/IDFC FIRST Bank"], // write
    ["POST", "/v1/payroll-runs/07-1:bankFile"], // the bank file embeds the full debit account
  ];
  for (const [method, path] of SURFACES) {
    it(`${method} ${path}: only super_admin`, () => {
      expect(can("super_admin", method, path)).toBe(true);
      for (const role of ALL.filter((r) => r !== "super_admin")) expect(can(role, method, path)).toBe(false);
    });
  }
});
