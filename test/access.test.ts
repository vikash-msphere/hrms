import { describe, it, expect } from "vitest";
import { actorCan, hasCapability, actorScope, stateReadAllowed } from "../src/domain/access";
import { grantFor } from "../src/domain/grants";
import { STATE_VISIBILITY } from "../src/domain/manifests";

// actorCan/actorScope read the grant off the actor (loaded at auth in prod). Here we attach the seed grant
// per role - identical to what the DB serves (seed.sql is generated from the same source).
const u = (role: string) => ({ role, grant: grantFor(role) } as any);
const a = (role: string, employeeCode: string | null) => ({ role, employeeCode, grant: grantFor(role) } as any);

describe("access.actorCan", () => {
  it("super_admin wildcard satisfies any capability", () => {
    expect(actorCan(u("super_admin"), "operations.admin")).toBe(true);
    expect(actorCan(u("super_admin"), "employees.write")).toBe(true);
    expect(actorCan(u("super_admin"), "anything.read")).toBe(true);
  });

  it("non-super has only its granted capabilities", () => {
    expect(actorCan(u("employee"), "operations.admin")).toBe(false); // employee reads ops, not admin
    expect(actorCan(u("employee"), "operations.read")).toBe(true);
    expect(actorCan(u("hr_admin"), "employees.write")).toBe(true);
    expect(actorCan(u("payroll_admin"), "employees.write")).toBe(false); // payroll reads employees only
    expect(actorCan(u("payroll_admin"), "payroll-runs.write")).toBe(true);
  });

  it("actorScope derives list breadth from the grant (manager = dept, not all)", () => {
    // employees: employee own, manager dept, hr/payroll/super all
    expect(actorScope(a("employee", "04-002"), "employees")).toBe("own");
    expect(actorScope(a("manager", "04-001"), "employees")).toBe("dept");
    expect(actorScope(a("hr_admin", "07-001"), "employees")).toBe("all");
    expect(actorScope(a("payroll_admin", "07-002"), "employees")).toBe("all");
    expect(actorScope(a("super_admin", null), "employees")).toBe("all");
    // leave-requests: manager now dept (tightened), hr all, employee own
    expect(actorScope(a("manager", "04-001"), "leave-requests")).toBe("dept");
    expect(actorScope(a("hr_admin", "07-001"), "leave-requests")).toBe("all");
    expect(actorScope(a("employee", "04-002"), "leave-requests")).toBe("own");
    // leave-balances: manager dept
    expect(actorScope(a("manager", "04-001"), "leave-balances")).toBe("dept");
    // payslips: payroll all, manager own (no payslips dept grant)
    expect(actorScope(a("payroll_admin", "07-002"), "payslips")).toBe("all");
    expect(actorScope(a("manager", "04-001"), "payslips")).toBe("own");
  });

  it("hasCapability wildcard semantics match the frontend", () => {
    expect(hasCapability(["**.admin", "**.**"], "operations.admin")).toBe(true);
    expect(hasCapability(["operations.read"], "operations.admin")).toBe(false);
    expect(hasCapability(["employees.bank-account.write"], "employees.bank-account.write")).toBe(true);
  });
});

describe("access.stateReadAllowed (item draft visibility, no BOLA)", () => {
  const rule = STATE_VISIBILITY.announcements!; // { requires: write, public_when: { published, disabled: false } }
  const self = { employeeCode: "04-1c-0a9" };
  const read = (role: string, state: Record<string, unknown>) =>
    stateReadAllowed(grantFor(role), "announcements.0a", state, rule, self);

  it("public (published + enabled) rows are readable by anyone", () => {
    expect(read("employee", { published: true, disabled: false })).toBe(true);
    expect(read("hr_admin", { published: true, disabled: false })).toBe(true);
  });

  it("non-public rows (draft or disabled) need write; non-editors are denied", () => {
    expect(read("employee", { published: false, disabled: false })).toBe(false); // draft
    expect(read("employee", { published: true, disabled: true })).toBe(false); // disabled
    expect(read("manager", { published: false, disabled: false })).toBe(false);
    expect(read("payroll_admin", { published: false, disabled: false })).toBe(false);
  });

  it("editors (write on the collection) read non-public rows", () => {
    expect(read("hr_admin", { published: false, disabled: false })).toBe(true);
    expect(read("super_admin", { published: false, disabled: true })).toBe(true);
  });
});
