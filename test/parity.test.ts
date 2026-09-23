import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// DoD #2: route×role parity. Pins the COLLECTION-LEVEL access (GET /col = list, POST /col = create) for
// every resource collection × every non-super role. Expectations are authored from role intent (the grant
// design), independent of the engine - so a drift in any grant trips exactly one cell. super_admin is `**`
// (always allowed) and asserted separately. Item-level / cross-owner isolation is covered by bola.test.
//
// Notable pinned cells (intentional today; flagged so any change is deliberate):
//  - org-documents: HR/super only (company docs are private by default; employees see only personal docs).
//  - payslips: HR is excluded (payroll/employee domain - separation of duties from hr_admin).
//  - holiday-selections: owner/dept only; hr & payroll hold no grant.
//  - leave-balances: hr_admin reads all (encashment page needs the real number); no create, payroll has none.
//  - leave-requests: HR views all but does not create; payroll has none. personal-documents: employees read
//    own, HR writes (employee files are HR-managed). users: super-only (others are auto-provisioned).
const SELF = "04-002-001";
const can = (role: string, method: string, path: string) =>
  decide(grantFor(role), resolveRequest(method, path), { employeeCode: SELF }).allow;

type LC = [list: boolean, create: boolean];
const T: LC = [true, true], R: LC = [true, false], N: LC = [false, false];

const MATRIX: Record<string, { employee: LC; manager: LC; hr_admin: LC; payroll_admin: LC }> = {
  employees:            { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  departments:          { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  "leave-requests":     { employee: T, manager: T, hr_admin: R, payroll_admin: N },
  "leave-types":        { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  "leave-balances":     { employee: R, manager: R, hr_admin: R, payroll_admin: N },
  holidays:             { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  "holiday-selections": { employee: T, manager: T, hr_admin: N, payroll_admin: N },
  "org-documents":      { employee: N, manager: N, hr_admin: T, payroll_admin: N },
  "personal-documents": { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  announcements:        { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  "pay-components":     { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  "pay-periods":        { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  "payroll-runs":       { employee: N, manager: N, hr_admin: N, payroll_admin: T },
  payslips:             { employee: R, manager: R, hr_admin: N, payroll_admin: R },
  operations:           { employee: R, manager: R, hr_admin: R, payroll_admin: R },
  users:                { employee: N, manager: N, hr_admin: N, payroll_admin: N },
  settings:             { employee: R, manager: R, hr_admin: T, payroll_admin: R },
  preferences:          { employee: T, manager: T, hr_admin: T, payroll_admin: T },
  compensation:         { employee: N, manager: N, hr_admin: N, payroll_admin: T },
};

describe("route×role parity (collection-level list/create)", () => {
  for (const [col, roles] of Object.entries(MATRIX)) {
    it(col, () => {
      for (const [role, [list, create]] of Object.entries(roles)) {
        expect(can(role, "GET", `/v1/${col}`), `${role} should ${list ? "" : "NOT "}list ${col}`).toBe(list);
        expect(can(role, "POST", `/v1/${col}`), `${role} should ${create ? "" : "NOT "}create ${col}`).toBe(create);
      }
      expect(can("super_admin", "GET", `/v1/${col}`)).toBe(true);
      expect(can("super_admin", "POST", `/v1/${col}`)).toBe(true);
    });
  }
});
