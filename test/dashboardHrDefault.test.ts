import { describe, it, expect } from "vitest";
import { isHrViewer, kpiDefaultVisible } from "../web/src/lib/dashboardConfig";

// The "hr" default audience on dashboard cards is decided by what the caller can reach, not by a role name.
// Roles are an org's own data: an org whose HR role is `hr_manager` has no `hr_admin`, and a name check
// showed those cards to nobody there.
describe("dashboard HR default audience", () => {
  it("is anyone who can edit every employee record, whatever their role is called", () => {
    expect(isHrViewer({ write: { employees: "all" } })).toBe(true);
  });

  it("is not a department-wide editor, a self-service caller, or a caller with no scopes loaded", () => {
    expect(isHrViewer({ write: { employees: "dept" } })).toBe(false);
    expect(isHrViewer({ write: {} })).toBe(false);
    expect(isHrViewer(undefined)).toBe(false);
  });

  it("is not granted by other org-wide writes", () => {
    // Payroll can reach every payslip without being the HR audience for onboarding or recruiting cards.
    expect(isHrViewer({ write: { payslips: "all", "employees.bank-account": "all" } })).toBe(false);
  });

  it("gates only the hr default; everyone and none are unaffected", () => {
    expect(kpiDefaultVisible("hr", true)).toBe(true);
    expect(kpiDefaultVisible("hr", false)).toBe(false);
    expect(kpiDefaultVisible("everyone", false)).toBe(true);
    expect(kpiDefaultVisible("none", true)).toBe(false);
    expect(kpiDefaultVisible(undefined, true)).toBe(false);
  });
});
