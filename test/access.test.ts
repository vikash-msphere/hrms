import { describe, it, expect } from "vitest";
import { actorCan, hasCapability, actorScope, actorVerbScope, stateReadAllowed, deptOf } from "../src/domain/access";
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

  it("actorVerbScope derives APPROVE breadth from the grant, and null when the verb isn't held", () => {
    // The approvals badge counts rows the caller may decide on, so the breadth comes from the `approve` verb
    // rather than a list read - and the two genuinely differ: an employee READS their own leave requests but
    // approves nothing, so their queue is empty rather than "their own rows".
    expect(actorVerbScope(a("employee", "04-002"), "leave-requests", "approve")).toBeNull();
    expect(actorVerbScope(a("manager", "04-001"), "leave-requests", "approve")).toBe("dept");
    expect(actorVerbScope(a("hr_admin", "07-001"), "leave-requests", "approve")).toBe("all");
    expect(actorVerbScope(a("super_admin", null), "leave-requests", "approve")).toBe("all");
    // A collection the role holds no approve grant on at any scope contributes nothing.
    expect(actorVerbScope(a("manager", "04-001"), "loans", "approve")).toBeNull();
  });

  it("hasCapability wildcard semantics match the frontend", () => {
    expect(hasCapability(["**.admin", "**.**"], "operations.admin")).toBe(true);
    expect(hasCapability(["operations.read"], "operations.admin")).toBe(false);
    expect(hasCapability(["employees.bank-account.write"], "employees.bank-account.write")).toBe(true);
  });

  it("a collection's wildcard-verb rule answers for one verb by name, but not for the level ladder", () => {
    // `assets.**` is what an access rule with verb:"*" compiles to: every custom method of that collection.
    expect(hasCapability(["assets.**"], "assets.batchCreate")).toBe(true);
    expect(hasCapability(["assets.**"], "assets.printTag")).toBe(true);
    expect(hasCapability(["assets.**"], "assets.write")).toBe(false); // a level is a different grant
    expect(hasCapability(["assets.**"], "stocktakes.close")).toBe(false); // and it is one collection's
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

// A dept is the caller's employee code minus its own last segment, and the ONE value it must never be is the
// empty string: `''` is a missing scope, not a scope, and an empty prefix reaching a containment test is how a
// dept-scoped grant once read as an org-wide one (see domain/codes.ts#isUnder, which now refuses it outright).
// `domain/permissions.ts#deptOf` normalises it; this is the twin, and the two must agree.
describe("deptOf - a missing dept is null, never an empty prefix", () => {
  const who = (employeeCode: string | null) => ({ employeeCode }) as Parameters<typeof deptOf>[0];

  it("returns the parent segments of an ordinary code", () => {
    expect(deptOf(who("04-002-001"))).toBe("04-002");
    expect(deptOf(who("04-001"))).toBe("04");
  });

  it("returns null when there is no dept to name", () => {
    expect(deptOf(who(null))).toBeNull();
    expect(deptOf(who(""))).toBeNull();
    expect(deptOf(who("04"))).toBeNull(); // single segment: no parent
    expect(deptOf(who("-0kf"))).toBeNull(); // leading '-' -> a leading EMPTY segment, which is not a dept
  });

  it("keeps the list breadth from reading a leading-dash code as a department", () => {
    // The probe would otherwise ask about `-zzzz`, and an empty prefix is exactly what must not decide a scope.
    expect(actorScope(a("employee", "-0kf"), "leave-requests")).toBe("own");
  });
});
