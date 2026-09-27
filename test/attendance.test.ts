import { describe, it, expect } from "vitest";
import { grantFor } from "../bootstrap/authz/grants";
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

// DAY MARKS: HR decides what a day is worth. The shape that matters is asymmetric - everybody can READ the
// decision about their own days (it changes their pay, so they are owed the sight of it), and only HR can
// make one. Both halves have already been wrong once: the row grant shipped without the bare LIST token, so
// the grid that reads marks as a list showed nothing to the person the feature exists to inform.
describe("attendance day marks: read your own, write nobody's", () => {
  it("every role lists their own marks", () => {
    // The bare token IS the list capability (a 1-token rule matches the collection, not its objects). Without
    // it the badge is invisible to the employee, and nothing 403s to say so.
    for (const role of ROLES) expect(can(role, "GET", "/v1/attendance-day-marks", "04-002")).toBe(true);
  });

  it("an employee reads their own and nobody else's, and changes neither", () => {
    expect(can("employee", "GET", "/v1/attendance-day-marks/04-002-1", "04-002")).toBe(true);
    expect(can("employee", "GET", "/v1/attendance-day-marks/07-002-1", "04-002")).toBe(false);
    // Re-valuing your own attendance is the thing this grant exists to keep away from you.
    expect(can("employee", "POST", "/v1/attendance-day-marks", "04-002")).toBe(false);
    expect(can("employee", "PATCH", "/v1/attendance-day-marks/04-002-1", "04-002")).toBe(false);
    expect(can("employee", "DELETE", "/v1/attendance-day-marks/04-002-1", "04-002")).toBe(false);
  });

  it("a manager sees their dept's but decides none of them", () => {
    // Seeded read-only on purpose: marking a day is a pay decision, and an org that wants its managers doing
    // it grants write through the ACL rather than getting it by default.
    expect(can("manager", "GET", "/v1/attendance-day-marks/04-002-1", "04-001")).toBe(true);
    expect(can("manager", "GET", "/v1/attendance-day-marks/07-002-1", "04-001")).toBe(false);
    expect(can("manager", "POST", "/v1/attendance-day-marks", "04-001")).toBe(false);
    expect(can("manager", "PATCH", "/v1/attendance-day-marks/04-002-1", "04-001")).toBe(false);
  });

  it("HR marks, edits and withdraws anybody's day; payroll does not", () => {
    expect(can("hr_admin", "POST", "/v1/attendance-day-marks", "07-001")).toBe(true);
    expect(can("hr_admin", "PATCH", "/v1/attendance-day-marks/04-002-1", "07-001")).toBe(true);
    expect(can("hr_admin", "DELETE", "/v1/attendance-day-marks/04-002-1", "07-001")).toBe(true);
    // Payroll reads the RESULT through the run, not the decision - it does not get to make one.
    expect(can("payroll_admin", "POST", "/v1/attendance-day-marks", "07-002")).toBe(false);
    expect(can("payroll_admin", "GET", "/v1/attendance-day-marks/04-002-1", "07-002")).toBe(false);
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
