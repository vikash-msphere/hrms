import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// Attendance authz: everyone clocks in/out + files their own regularizations; managers approve their own
// dept's, HR approves any; nobody else approves. Codes are owner-embedded (mgr 04-001 dept 04; Eve 04-002;
// Hank/HR 07-001; Pat/payroll 07-002), so me/my-dept scope exactly like leave-requests.
const can = (role: string, method: string, path: string, self: string) =>
  decide(grantFor(role), resolveRequest(method, path), { employeeCode: self }).allow;

const ROLES = ["employee", "manager", "hr_admin", "payroll_admin", "super_admin"];

describe("attendance self-service (every role clocks + files own regularizations)", () => {
  it("clock in/out for self is allowed for all roles", () => {
    for (const role of ROLES) {
      expect(can(role, "POST", "/v1/attendance/me:clockIn", "04-002")).toBe(true);
      expect(can(role, "POST", "/v1/attendance/me:clockOut", "04-002")).toBe(true);
    }
  });
  it("list own attendance + create/cancel own regularization is allowed for all roles", () => {
    for (const role of ROLES) {
      expect(can(role, "GET", "/v1/attendance", "04-002")).toBe(true); // list (rows scoped in service)
      expect(can(role, "GET", "/v1/attendance?open=true", "04-002")).toBe(true); // presence
      expect(can(role, "POST", "/v1/attendance-regularizations", "04-002")).toBe(true); // create own
      expect(can(role, "POST", "/v1/attendance-regularizations/04-002-1:cancel", "04-002")).toBe(true); // cancel own
    }
  });
});

describe("attendance regularization approval scope", () => {
  it("manager approves OWN dept, never cross-dept", () => {
    expect(can("manager", "POST", "/v1/attendance-regularizations/04-002-1:approve", "04-001")).toBe(true); // dept 04
    expect(can("manager", "POST", "/v1/attendance-regularizations/07-002-1:approve", "04-001")).toBe(false); // dept 07
  });
  it("hr approves any; employee + payroll cannot approve", () => {
    expect(can("hr_admin", "POST", "/v1/attendance-regularizations/07-002-1:approve", "07-001")).toBe(true);
    expect(can("super_admin", "POST", "/v1/attendance-regularizations/07-002-1:approve", "07-001")).toBe(true);
    expect(can("employee", "POST", "/v1/attendance-regularizations/04-002-1:approve", "04-002")).toBe(false);
    expect(can("payroll_admin", "POST", "/v1/attendance-regularizations/04-002-1:approve", "07-002")).toBe(false);
  });
});

describe("attendance visibility breadth", () => {
  it("hr can read any employee's session item; a plain employee cannot read another's", () => {
    expect(can("hr_admin", "GET", "/v1/attendance/04-002-1", "07-001")).toBe(true); // attendance.** read
    expect(can("employee", "GET", "/v1/attendance/07-002-1", "04-002")).toBe(false); // only own (me)
    expect(can("employee", "GET", "/v1/attendance/04-002-1", "04-002")).toBe(true); // own session
    expect(can("manager", "GET", "/v1/attendance/04-002-1", "04-001")).toBe(true); // dept member
  });
});
