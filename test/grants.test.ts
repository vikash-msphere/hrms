import { describe, it, expect } from "vitest";
import { GRANTS, grantFor } from "../src/domain/grants";
import { ROLES } from "../src/db/schema";
import { resolveRequest, decide, capabilitiesOf } from "../src/domain/permissions";
import type { Role } from "../src/env";

// Representative behaviour checks per role (the exhaustive route×role parity is step 1.5).
const SELF = { employeeCode: "04-1c-0a9" }; // dept 04-1c
const ok = (role: Role, m: string, p: string, force = false) => decide(grantFor(role), resolveRequest(m, p, force), SELF).allow;

describe("GRANTS - policy integrity", () => {
  it("covers exactly the ROLES list (no missing or extra role)", () => {
    expect(Object.keys(GRANTS).sort()).toEqual([...ROLES].sort());
  });

  it("PII sub-resources are super-only by default; everyone keeps OWN PII; base record still readable", () => {
    const OTHER = "07-2a-0b1"; // not under SELF's dept (04-1c)
    const SELFCODE = "04-1c-0a9";
    for (const sub of ["bank-account", "identity", "personal-info"]) {
      // Others' PII: denied to employee/manager/hr/payroll; only super reaches it (via ** in config).
      for (const role of ["employee", "manager", "hr_admin", "payroll_admin"] as const) {
        expect(ok(role, "GET", `/v1/employees/${OTHER}/${sub}`)).toBe(false);
      }
      expect(ok("super_admin", "GET", `/v1/employees/${OTHER}/${sub}`)).toBe(true);
      // Own PII: every role keeps self-service (write implies read).
      for (const role of ["employee", "manager", "hr_admin", "payroll_admin"] as const) {
        expect(ok(role, "PATCH", `/v1/employees/${SELFCODE}/${sub}`)).toBe(true);
      }
    }
    // The base record is still readable by the broad readers (PII exclusion did not remove base access).
    expect(ok("hr_admin", "GET", `/v1/employees/${OTHER}`)).toBe(true);
    expect(ok("payroll_admin", "GET", `/v1/employees/${OTHER}`)).toBe(true);
    // Manager reads a dept member's base record but NOT their PII (checked above).
    expect(ok("manager", "GET", "/v1/employees/04-1c-0b2")).toBe(true); // dept member base
  });

  it("protected fields are gated by the resource-write grant (field-level body AC)", () => {
    // employee cannot set role/department/comp on their own record (mass-assignment / self-escalation)
    expect(ok("employee", "PATCH", "/v1/employees/04-1c-0a9/department")).toBe(false);
    expect(ok("employee", "PATCH", "/v1/users/04-1c-0a9/role")).toBe(false);
    expect(ok("employee", "PATCH", "/v1/compensation/04-1c-0a9/base_pay")).toBe(false);
    // HR sets employee fields; only super sets a user's role; payroll sets pay amounts
    expect(ok("hr_admin", "PATCH", "/v1/employees/0a/department")).toBe(true);
    expect(ok("hr_admin", "PATCH", "/v1/users/0a/role")).toBe(false);
    expect(ok("super_admin", "PATCH", "/v1/users/0a/role")).toBe(true);
    expect(ok("payroll_admin", "PATCH", "/v1/compensation/0a/base_pay")).toBe(true);
  });
});

describe("GRANTS - employee (self-service only)", () => {
  it("reads open collections + own data; cannot touch others or admin surfaces", () => {
    expect(ok("employee", "GET", "/v1/holidays")).toBe(true);
    // operations are employee-owned: may list (rows scoped in the route) + read own, never another's
    expect(ok("employee", "GET", "/v1/operations")).toBe(true); // may LIST
    expect(ok("employee", "GET", "/v1/operations/04-1c-0a9-0")).toBe(true); // own (under self code)
    expect(ok("employee", "GET", "/v1/operations/07-2a-0b1-0")).toBe(false); // another's -> denied (BOLA)
    expect(ok("employee", "GET", "/v1/settings/holidays")).toBe(true);
    expect(ok("employee", "GET", "/v1/preferences")).toBe(true);
    expect(ok("employee", "POST", "/v1/preferences")).toBe(true);
    expect(ok("employee", "POST", "/v1/leave-requests")).toBe(true);
    expect(ok("employee", "GET", "/v1/payslips/04-1c-0a9-0")).toBe(true); // own
    expect(ok("employee", "GET", "/v1/employees")).toBe(true); // may LIST the directory (rows scoped in service)
    expect(ok("employee", "GET", "/v1/employees/07-2a-0b1")).toBe(false); // but cannot GET another's record
    expect(ok("employee", "PATCH", "/v1/employees/04-1c-0a9/bank-account")).toBe(true); // own
    expect(ok("employee", "PATCH", "/v1/employees/07-2a-0b1")).toBe(false); // someone else's record
    expect(ok("employee", "POST", "/v1/holidays")).toBe(false); // config.write
    expect(ok("employee", "GET", "/v1/users")).toBe(false); // admin only
    expect(ok("employee", "POST", "/v1/payroll-runs")).toBe(false); // payroll only
  });
});

describe("GRANTS - manager", () => {
  it("approves leave and reads own dept subtree", () => {
    expect(ok("manager", "POST", "/v1/leave-requests/04-1c-0b2-0:approve")).toBe(true);
    expect(ok("manager", "POST", "/v1/holidays")).toBe(false); // still not config.write
  });
});

describe("GRANTS - hr_admin", () => {
  it("writes employees/config but cannot force-purge or list users", () => {
    expect(ok("hr_admin", "POST", "/v1/employees")).toBe(true);
    expect(ok("hr_admin", "PATCH", "/v1/employees/07-2a-0b1")).toBe(true);
    expect(ok("hr_admin", "DELETE", "/v1/employees/07-2a-0b1")).toBe(true); // soft delete = write
    expect(ok("hr_admin", "DELETE", "/v1/employees/07-2a-0b1", true)).toBe(false); // force purge = admin (super only)
    expect(ok("hr_admin", "POST", "/v1/holidays")).toBe(true);
    expect(ok("hr_admin", "GET", "/v1/users")).toBe(false); // admin only
    expect(ok("hr_admin", "POST", "/v1/payroll-runs")).toBe(false);
  });
});

describe("GRANTS - payroll_admin", () => {
  it("runs payroll and reads employees, but cannot approve runs or write employee records", () => {
    expect(ok("payroll_admin", "POST", "/v1/payroll-runs")).toBe(true);
    expect(ok("payroll_admin", "POST", "/v1/payroll-runs/0a:submit")).toBe(true); // can submit/lock/publish
    expect(ok("payroll_admin", "POST", "/v1/payroll-runs/0a:approve")).toBe(false); // approve is super-only (deny)
    expect(ok("payroll_admin", "GET", "/v1/employees/07-2a-0b1")).toBe(true); // employee.read.all
    expect(ok("payroll_admin", "POST", "/v1/employees")).toBe(false); // not employee.write
    expect(ok("payroll_admin", "POST", "/v1/holidays")).toBe(false);
  });
});

describe("GRANTS - super_admin", () => {
  it("can do everything including force-purge and user admin", () => {
    expect(ok("super_admin", "DELETE", "/v1/employees/07-2a-0b1", true)).toBe(true);
    expect(ok("super_admin", "GET", "/v1/users")).toBe(true);
    expect(ok("super_admin", "POST", "/v1/payroll-runs/0a:publish")).toBe(true);
  });
});

describe("GRANTS - personal-documents:generateLetter (HR + super only)", () => {
  // The letter-generation custom method resolves to the verb key personal-documents.generateLetter; only
  // hr_admin (broad personal-documents.** allow) and super_admin (**) may invoke it.
  it("allows hr_admin and super_admin, denies employee/manager/payroll", () => {
    for (const p of ["/v1/personal-documents:generateLetter", "/v1/personal-documents:previewLetter"]) {
      expect(ok("hr_admin", "POST", p)).toBe(true);
      expect(ok("super_admin", "POST", p)).toBe(true);
      for (const role of ["employee", "manager", "payroll_admin"] as const) {
        expect(ok(role, "POST", p)).toBe(false);
      }
    }
  });
});

describe("GRANTS - positions (role history): HR writes, super reads/writes; others have no access", () => {
  it("records of designation/department changes are HR + super only", () => {
    expect(ok("hr_admin", "POST", "/v1/positions")).toBe(true);
    expect(ok("hr_admin", "GET", "/v1/positions")).toBe(true);
    expect(ok("super_admin", "POST", "/v1/positions")).toBe(true);
    for (const role of ["employee", "manager", "payroll_admin"] as const) {
      expect(ok(role, "GET", "/v1/positions")).toBe(false);
      expect(ok(role, "POST", "/v1/positions")).toBe(false);
    }
  });
});

describe("GRANTS - bonuses (awards): HR writes, payroll reads (they pay out through the run), others have no access", () => {
  it("one-off awards are HR + super; payroll sees but cannot award", () => {
    expect(ok("hr_admin", "POST", "/v1/bonuses")).toBe(true);
    expect(ok("super_admin", "GET", "/v1/bonuses")).toBe(true);
    expect(ok("payroll_admin", "GET", "/v1/bonuses")).toBe(true);
    expect(ok("payroll_admin", "POST", "/v1/bonuses")).toBe(false);
    for (const role of ["employee", "manager"] as const) {
      expect(ok(role, "GET", "/v1/bonuses")).toBe(false);
      expect(ok(role, "POST", "/v1/bonuses")).toBe(false);
    }
  });
});

describe("GRANTS - settlements (FnF): HR writes, super reads/writes; others have no access", () => {
  it("full-and-final settlements are HR + super only", () => {
    expect(ok("hr_admin", "POST", "/v1/settlements")).toBe(true);
    expect(ok("super_admin", "GET", "/v1/settlements")).toBe(true);
    for (const role of ["employee", "manager", "payroll_admin"] as const) {
      expect(ok(role, "GET", "/v1/settlements")).toBe(false);
      expect(ok(role, "POST", "/v1/settlements")).toBe(false);
    }
  });
});

describe("GRANTS - leave-encashments (cashout): HR records + decides, payroll/employee read own-scoped", () => {
  it("HR + super create and decide; payroll sees payout rows; employees list (own rows via scope); managers denied", () => {
    expect(ok("super_admin", "POST", "/v1/leave-encashments")).toBe(true);
    expect(ok("super_admin", "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(true);
    expect(ok("hr_admin", "POST", "/v1/leave-encashments")).toBe(true);
    expect(ok("hr_admin", "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(true);
    expect(ok("payroll_admin", "GET", "/v1/leave-encashments")).toBe(true);
    expect(ok("payroll_admin", "POST", "/v1/leave-encashments")).toBe(false);
    expect(ok("payroll_admin", "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(false);
    // Employees (and managers, who inherit) may call the list endpoint (rows scoped to own by applyScope)
    // but cannot create or decide.
    for (const role of ["employee", "manager"] as const) {
      expect(ok(role, "GET", "/v1/leave-encashments")).toBe(true);
      expect(ok(role, "POST", "/v1/leave-encashments")).toBe(false);
      expect(ok(role, "POST", "/v1/leave-encashments/07-2a-0b1-0:approve")).toBe(false);
    }
  });
});

describe("capabilitiesOf (scope-stripped tier-1 set)", () => {
  it("expands the ladder and strips scope", () => {
    const caps = capabilitiesOf(GRANTS.employee);
    expect(caps).toContain("holidays.read");
    expect(caps).toContain("leave-requests.read"); // from leave-requests write (ladder)
    expect(caps).toContain("leave-requests.write");
    expect(caps).toContain("leave-requests.cancel"); // allow verb
    expect(caps).toContain("employees.read"); // can list the directory
    expect(caps).toContain("employees.bank-account.write"); // own sub-resource (structural token kept)
    expect(caps).not.toContain("employees.write"); // must NOT imply directory write (would show wrong buttons)
    expect(caps).not.toContain("payroll-runs.write"); // employee has no payroll
  });
  it("manager gains approve; hr gains employee write", () => {
    expect(capabilitiesOf(GRANTS.manager)).toContain("leave-requests.approve");
    expect(capabilitiesOf(GRANTS.hr_admin)).toContain("employees.write");
    expect(capabilitiesOf(GRANTS.payroll_admin)).toContain("payroll-runs.write");
  });
  it("super_admin is the ** wildcard", () => {
    const caps = capabilitiesOf(GRANTS.super_admin);
    expect(caps).toContain("**.admin");
    expect(caps).toContain("**.**");
  });
});
