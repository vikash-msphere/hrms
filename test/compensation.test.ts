import { describe, it, expect } from "vitest";
import { grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// Compensation (base pay + revisions/increments) is payroll_admin + super only - it's sensitive and not
// reachable by employees, managers, or HR (HR has employee write but NOT compensation). Mirrors the
// existing `compensation.**: write` grant on payroll_admin.
const can = (role: string, method: string, path: string) =>
  decide(grantFor(role), resolveRequest(method, path), { employeeCode: "07-002" }).allow;

describe("compensation authz (payroll_admin + super only)", () => {
  for (const [method, path] of [
    ["GET", "/v1/compensation"], // list / salary history
    ["POST", "/v1/compensation"], // create a revision (increment)
    ["GET", "/v1/compensation/07-002-1"], // an item
  ] as const) {
    it(`${method} ${path}: payroll + super allowed; employee/manager/hr denied`, () => {
      expect(can("payroll_admin", method, path)).toBe(true);
      expect(can("super_admin", method, path)).toBe(true);
      for (const role of ["employee", "manager", "hr_admin"]) expect(can(role, method, path)).toBe(false);
    });
  }

  // Collection-level custom method: re-derive every current row's split under the live ctc config.
  it("POST /v1/compensation:reapplySplit: payroll + super allowed; others denied", () => {
    expect(can("payroll_admin", "POST", "/v1/compensation:reapplySplit")).toBe(true);
    expect(can("super_admin", "POST", "/v1/compensation:reapplySplit")).toBe(true);
    for (const role of ["employee", "manager", "hr_admin"]) expect(can(role, "POST", "/v1/compensation:reapplySplit")).toBe(false);
  });
});
