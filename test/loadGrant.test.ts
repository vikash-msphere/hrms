import { describe, it, expect } from "vitest";
import { GRANTS, grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import { compileGrant, rulesToGrant } from "../src/domain/compileGrants";

// P1 loader parity. `loadRoleGrant` reads `access_rules WHERE subject=role AND subject_kind='role'` and
// reconstructs the Grant with `rulesToGrant`. This reproduces that exact path WITHOUT a DB: build the whole
// seeded table (every role's compiled rows tagged with its subject), then for each role apply the loader's
// WHERE filter and reconstruct. Asserts the loaded Grant decides identically to the blob across a generated
// request space - so flipping the runtime authority from the blob to access_rules changes no verdict, and
// the per-role filter never leaks another role's rules.
type Row = ReturnType<typeof compileGrant>[number] & { subject: string; subjectKind: "role" | "user" };

const ROLES = Object.keys(GRANTS);
const ALL_ROWS: Row[] = ROLES.flatMap((role) =>
  compileGrant(GRANTS[role as keyof typeof GRANTS]).map((r) => ({ ...r, subject: role, subjectKind: "role" as const })),
);

const COLLECTIONS = [
  "employees", "leave-requests", "leave-balances", "payslips", "personal-documents", "org-documents",
  "operations", "compensation", "payroll-runs", "users", "departments", "settings", "announcements",
];
const IDS = ["me", "04-001", "04-002", "04-002-001", "04-0029", "07-001"];
const TAILS = ["", "/bank-account", "/identity"];
const VERBS = ["approve", "reject", "download", "cancel"];
const SELVES: (string | null)[] = [null, "04-002-001", "07-001"];

function loaded(role: string) {
  // The loader's SQL WHERE, reproduced in memory.
  const rows = ALL_ROWS.filter((r) => r.subject === role && r.subjectKind === "role");
  return rulesToGrant(rows);
}

describe("loadRoleGrant - reconstructed grant decides identically to the blob", () => {
  for (const role of ROLES) {
    it(`${role}`, () => {
      const blob = GRANTS[role as keyof typeof GRANTS]; // the role's own rules, as one subject's rows hold them
      const fromRules = loaded(role);
      for (const self of SELVES) {
        const ctx = { employeeCode: self };
        for (const col of COLLECTIONS) {
          for (const id of IDS) {
            for (const tail of TAILS) {
              const p = `/v1/${col}/${id}${tail}`;
              for (const m of ["GET", "PATCH", "DELETE"]) {
                expect(decide(fromRules, resolveRequest(m, p), ctx).allow).toBe(decide(blob, resolveRequest(m, p), ctx).allow);
              }
              expect(decide(fromRules, resolveRequest("DELETE", p, true), ctx).allow).toBe(decide(blob, resolveRequest("DELETE", p, true), ctx).allow);
            }
            for (const verb of VERBS) {
              const p = `/v1/${col}/${id}:${verb}`;
              expect(decide(fromRules, resolveRequest("POST", p), ctx).allow).toBe(decide(blob, resolveRequest("POST", p), ctx).allow);
            }
          }
          for (const m of ["GET", "POST"]) {
            const p = `/v1/${col}`;
            expect(decide(fromRules, resolveRequest(m, p), ctx).allow).toBe(decide(blob, resolveRequest(m, p), ctx).allow);
          }
        }
      }
    });
  }

  it("the per-role filter never mixes another role's rules", () => {
    // employee must not gain hr_admin's org-documents write just because both are in the table.
    const emp = loaded("employee");
    expect(decide(emp, resolveRequest("POST", "/v1/org-documents"), { employeeCode: "04-002-001" }).allow).toBe(false);
    expect(decide(grantFor("employee"), resolveRequest("POST", "/v1/org-documents"), { employeeCode: "04-002-001" }).allow).toBe(false);
  });
});
