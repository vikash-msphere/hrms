import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// The dashboard celebrations feed is a collection-level custom method on employees. It is company-wide (every
// signed-in role may read it), so the grant must allow `employees.upcomingCelebrations` for all five roles.
// grantFor reads the typed GRANTS seed; seedDrift.test.ts pins the DB seed to that same source.
const PATH = "/v1/employees:upcomingCelebrations";
const can = (role: string) => decide(grantFor(role), resolveRequest("GET", PATH), { employeeCode: "04-002-001" }).allow;

describe("celebrations feed authz", () => {
  it("resolves to the custom verb on the employees collection (the colon makes it custom, not a list read)", () => {
    const r = resolveRequest("GET", PATH);
    expect(r).toEqual({ kind: "custom", resource: "employees", verb: "upcomingCelebrations" });
  });

  it("every role may read it", () => {
    for (const role of ["employee", "manager", "hr_admin", "payroll_admin", "super_admin"]) {
      expect(can(role)).toBe(true);
    }
  });

  it("an unknown role (deny-all) may not", () => {
    expect(can("intern_no_policy")).toBe(false);
  });
});
