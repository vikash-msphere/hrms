import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import { compileGrant, mergeGrants, rulesToGrant, type CompiledRule } from "../src/domain/compileGrants";
import { ancestorsOf } from "../src/domain/codes";

// M1 BOLA oracle for EXACT ROLE rules (object-scoped role grants). After the loading refactor a role rule
// with a literal code carries match_code=<code> and rides the same two lanes as a user exception:
//   - broad lane  (loadRoleGrantUncached): the role's scope rows, match_code IS NULL, loaded wholesale + cached;
//   - narrowed lane (loadObjectRulesForRequest): exact rows fetched by match_code IN ancestorsOf(objectCode).
// The engine (decide) is unchanged; this proves the two-lane LOAD feeds it faithfully. Three claims, mirroring
// grantExceptions.test.ts but for subjectKind:"role", plus a model of the new SQL to prove subject isolation.

type RoleRow = CompiledRule & { subject: string; subjectKind: "role" };
const roleRow = (collection: string, code: string, opt: { level?: "read" | "write" | "admin"; deny?: boolean; verb?: string }): RoleRow => ({
  subject: "manager",
  subjectKind: "role",
  namespace: collection,
  pattern: `${collection}.${code}.${opt.verb ?? "**"}`, // literal verb tail (custom-method) or "**" (standard)
  scopeKind: "exact",
  scopeCode: code,
  matchCode: code,
  level: opt.level ?? null,
  effect: opt.deny ? "deny" : "allow",
});

const SELF = { employeeCode: "04-002-001" };
const allow = (g: ReturnType<typeof grantFor>, m: string, p: string, self = SELF) => decide(g, resolveRequest(m, p), self).allow;

// The broad (match_code NULL) lane for a role - exactly what loadRoleGrantUncached now reconstructs.
const broadGrant = (role: string) => rulesToGrant(compileGrant(grantFor(role)).filter((r) => r.matchCode === null));
// The narrowed lane: exact rows whose match_code is an ancestor of the object code, in (collection,'*').
const narrowRole = (rows: RoleRow[], col: string, code: string) =>
  rows.filter((r) => (r.namespace === col || r.namespace === "*") && ancestorsOf(code).includes(r.matchCode!));
const fullRole = (rows: RoleRow[], col: string) => rows.filter((r) => r.namespace === col || r.namespace === "*");

describe("M1: exact role-rule narrowing is decision-equivalent to the full set (BOLA oracle)", () => {
  const broad = broadGrant("employee"); // employee role alone denies reading a peer's record
  const rows: RoleRow[] = [
    roleRow("employees", "04-002-002", { level: "read" }), // pin a peer's record to the role
    roleRow("employees", "04-002", { level: "read" }), // exact share on a shorter code (prefix-collision bait)
    roleRow("payslips", "04-002-009-0", { level: "read" }),
  ];
  const PROBE = ["04-002-001", "04-002-002", "04-002-003", "04-0029", "04-0029-001", "04-002", "07-001-001"];
  for (const code of PROBE) {
    for (const col of ["employees", "payslips"]) {
      it(`${col}/${code}: narrowed == full`, () => {
        const gN = mergeGrants(broad, rulesToGrant(narrowRole(rows, col, code)));
        const gF = mergeGrants(broad, rulesToGrant(fullRole(rows, col)));
        for (const m of ["GET", "PATCH", "DELETE"]) {
          const p = `/v1/${col}/${code}`;
          expect(allow(gN, m, p), `${m} ${p}`).toBe(allow(gF, m, p));
        }
      });
    }
  }
});

describe("M1: broad/narrowed split is decision-lossless vs the old wholesale role load", () => {
  // Before: the entire role ruleset (scope rows + exact rows) loaded together and decided.
  // After: scope rows via IS NULL (broad) + exact rows via IN ancestors (narrowed), then merged.
  const role = "manager";
  const exact: RoleRow[] = [
    roleRow("employees", "07-001", { level: "write" }), // pin a cross-dept record to the manager role
    roleRow("leave-requests", "07-001-003", { deny: true }), // and a per-object deny
  ];
  const wholesale = (col: string) => rulesToGrant([...compileGrant(grantFor(role)), ...fullRole(exact, col)]);
  const split = (col: string, code: string) => mergeGrants(broadGrant(role), rulesToGrant(narrowRole(exact, col, code)));
  const PROBE = ["07-001", "07-001-003", "04-002-001", "04-0029"];
  for (const code of PROBE) {
    for (const col of ["employees", "leave-requests"]) {
      it(`${col}/${code}: split == wholesale`, () => {
        for (const m of ["GET", "PATCH", "DELETE"]) {
          const p = `/v1/${col}/${code}`;
          expect(allow(split(col, code), m, p), `${m} ${p}`).toBe(allow(wholesale(col), m, p));
        }
      });
    }
  }
});

describe("M1: exact role-rule object semantics (prefix collision, deny-wins)", () => {
  const broad = broadGrant("employee");
  const withExact = (rows: RoleRow[], col: string, code: string) => mergeGrants(broad, rulesToGrant(narrowRole(rows, col, code)));

  it("a role pin reaches exactly that object, not a sibling", () => {
    const rows = [roleRow("employees", "04-002-002", { level: "read" })];
    expect(allow(broad, "GET", "/v1/employees/04-002-002")).toBe(false); // employee role alone denies the peer
    expect(allow(withExact(rows, "employees", "04-002-002"), "GET", "/v1/employees/04-002-002")).toBe(true); // pin grants it
    expect(allow(withExact(rows, "employees", "04-002-003"), "GET", "/v1/employees/04-002-003")).toBe(false); // sibling untouched
  });

  it("a role pin on a shorter code does NOT leak to a prefix-collision code", () => {
    const rows = [roleRow("employees", "04-002", { level: "read" })];
    expect(allow(withExact(rows, "employees", "04-002"), "GET", "/v1/employees/04-002")).toBe(true); // exact object ok
    expect(allow(withExact(rows, "employees", "04-0029"), "GET", "/v1/employees/04-0029")).toBe(false); // 04-0029 NOT under 04-002
    expect(allow(withExact(rows, "employees", "04-002-005"), "GET", "/v1/employees/04-002-005")).toBe(false); // child = different literal token
  });

  it("a role per-object deny overrides a broader role allow (deny-wins)", () => {
    const broad2 = broadGrant("payroll_admin"); // reads employee base records broadly (employees.*)
    expect(allow(broad2, "GET", "/v1/employees/07-001")).toBe(true);
    const denied = mergeGrants(broad2, rulesToGrant(narrowRole([roleRow("employees", "07-001", { deny: true })], "employees", "07-001")));
    expect(allow(denied, "GET", "/v1/employees/07-001")).toBe(false);
  });
});

describe("M1: combined narrowed query isolates by (subject, subject_kind) - no cross-kind leak", () => {
  // Model of loadObjectRulesForRequest's WHERE: ((subject=user AND kind='user') OR (subject=role AND kind='role'))
  // AND namespace IN (col,'*') AND match_code IN ancestorsOf(code). A role named like a uuid (or a user row whose
  // subject equals a role name) must NOT cross-load, because each branch pins BOTH subject and kind.
  type AnyRow = CompiledRule & { subject: string; subjectKind: "role" | "user" };
  const USER = "uuuuuuuuuuuuu"; // a 13-char base32-shaped uuid
  const ROLE = "manager";
  const CODE = "04-002-001";
  const r = (subject: string, subjectKind: "role" | "user", code: string): AnyRow => ({
    subject, subjectKind, namespace: "employees", pattern: `employees.${code}.**`, scopeKind: "exact", scopeCode: code, matchCode: code, level: "read", effect: "allow",
  });

  const table: AnyRow[] = [
    r(USER, "user", CODE), // legit: the caller's own user exception
    r(ROLE, "role", CODE), // legit: an exact rule on the caller's role
    r(USER, "role", CODE), // DECOY: a role literally NAMED like the caller's uuid
    r(ROLE, "user", CODE), // DECOY: a user row whose subject collides with a role name
    r("other_role", "role", CODE), // DECOY: a different role's exact rule
    r("vvvvvvvvvvvvv", "user", CODE), // DECOY: a different user's exception
  ];

  const queried = table.filter(
    (row) =>
      ((row.subject === USER && row.subjectKind === "user") || (row.subject === ROLE && row.subjectKind === "role")) &&
      (row.namespace === "employees" || row.namespace === "*") &&
      ancestorsOf(CODE).includes(row.matchCode!),
  );

  it("returns exactly the caller's user exception and the role's rule, no decoys", () => {
    expect(queried).toHaveLength(2);
    expect(queried).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: USER, subjectKind: "user" }),
        expect.objectContaining({ subject: ROLE, subjectKind: "role" }),
      ]),
    );
    // none of the cross-kind / other-subject decoys slipped in
    expect(queried.some((x) => x.subject === USER && x.subjectKind === "role")).toBe(false);
    expect(queried.some((x) => x.subject === ROLE && x.subjectKind === "user")).toBe(false);
    expect(queried.some((x) => x.subject === "other_role" || x.subject === "vvvvvvvvvvvvv")).toBe(false);
  });
});
