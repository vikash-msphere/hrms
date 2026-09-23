import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import { mergeGrants, rulesToGrant, type CompiledRule } from "../src/domain/compileGrants";
import { ancestorsOf } from "../src/domain/codes";

// P2 half 2 BOLA oracle for per-object grant-exceptions. A USER exception is one row: pattern
// `<col>.<code>.**` (LITERAL code token), match_code=<code>. The middleware narrows the caller's rows by
// the requested object's ancestor codes (exact IN) and overlays them on the role grant, then decide()
// renders the verdict. Two claims proven here:
//  1. The exact-IN narrowing is decision-equivalent to deciding over ALL the caller's rows (a correct
//     SUPERSET - it never drops a row decide() would use, and never adds a cross-object one).
//  2. Exact-object semantics: a share reaches exactly that object (+ sub-resources), never a sibling, and
//     never a prefix-collision neighbour; a deny overrides a role grant (deny-wins).

type UserRow = CompiledRule & { subject: string; subjectKind: "user" };
const exc = (collection: string, code: string, opt: { level?: "read" | "write" | "admin"; deny?: boolean; verb?: string }): UserRow => ({
  subject: "u1",
  subjectKind: "user",
  namespace: collection,
  pattern: `${collection}.${code}.${opt.verb ?? "**"}`, // literal verb tail (custom-method share) or "**" (standard)
  scopeKind: "exact",
  scopeCode: code,
  matchCode: code,
  level: opt.level ?? null,
  effect: opt.deny ? "deny" : "allow",
});

// The middleware's SQL narrowing, mirrored in memory: subject's rows in (collection,'*') with match_code in
// the request object's ancestor set.
const narrow = (rows: UserRow[], collection: string, code: string) =>
  rows.filter((r) => (r.namespace === collection || r.namespace === "*") && ancestorsOf(code).includes(r.matchCode!));
// The full candidate set (no match_code filter) - what decide() would see if nothing were narrowed.
const full = (rows: UserRow[], collection: string) => rows.filter((r) => r.namespace === collection || r.namespace === "*");

const SELF = { employeeCode: "04-002-001" };
const allow = (grant: ReturnType<typeof grantFor>, method: string, path: string, self = SELF) => decide(grant, resolveRequest(method, path), self).allow;

describe("grant-exceptions narrowing is decision-equivalent to the full set (BOLA oracle)", () => {
  const role = grantFor("employee");
  const rows: UserRow[] = [
    exc("employees", "04-002-002", { level: "read" }), // share a peer's record
    exc("employees", "04-002", { level: "read" }), // an exact share on a shorter code (prefix-collision bait)
    exc("payslips", "04-002-009-0", { level: "read" }),
  ];
  const PROBE_CODES = ["04-002-001", "04-002-002", "04-002-003", "04-0029", "04-0029-001", "04-002", "07-001-001"];

  for (const code of PROBE_CODES) {
    for (const col of ["employees", "payslips"]) {
      it(`${col}/${code}: narrowed == full`, () => {
        const gN = mergeGrants(role, rulesToGrant(narrow(rows, col, code)));
        const gF = mergeGrants(role, rulesToGrant(full(rows, col)));
        for (const m of ["GET", "PATCH", "DELETE"]) {
          const p = `/v1/${col}/${code}`;
          expect(allow(gN, m, p), `${m} ${p}`).toBe(allow(gF, m, p));
        }
      });
    }
  }
});

describe("grant-exceptions exact-object semantics", () => {
  const role = grantFor("employee");
  const withExc = (rows: UserRow[], col: string, code: string) => mergeGrants(role, rulesToGrant(narrow(rows, col, code)));

  it("a read share reaches exactly that object, not a sibling or a prefix neighbour", () => {
    const rows = [exc("employees", "04-002-002", { level: "read" })];
    expect(allow(role, "GET", "/v1/employees/04-002-002")).toBe(false); // role alone denies the peer
    expect(allow(withExc(rows, "employees", "04-002-002"), "GET", "/v1/employees/04-002-002")).toBe(true); // share grants it
    expect(allow(withExc(rows, "employees", "04-002-003"), "GET", "/v1/employees/04-002-003")).toBe(false); // sibling untouched
  });

  it("a share on a shorter code does NOT leak to a longer prefix-collision code", () => {
    const rows = [exc("employees", "04-002", { level: "read" })]; // shared code "04-002"
    expect(allow(withExc(rows, "employees", "04-002"), "GET", "/v1/employees/04-002")).toBe(true); // exact object ok
    expect(allow(withExc(rows, "employees", "04-0029"), "GET", "/v1/employees/04-0029")).toBe(false); // "04-0029" is NOT under "04-002"
    expect(allow(withExc(rows, "employees", "04-002-005"), "GET", "/v1/employees/04-002-005")).toBe(false); // a child (not self) is a different literal token
  });

  it("a deny exception overrides a role grant (deny-wins)", () => {
    const role2 = grantFor("payroll_admin"); // can read employee base records broadly (employees.*)
    expect(decide(role2, resolveRequest("GET", "/v1/employees/07-001"), SELF).allow).toBe(true);
    const denied = mergeGrants(role2, rulesToGrant(narrow([exc("employees", "07-001", { deny: true })], "employees", "07-001")));
    expect(decide(denied, resolveRequest("GET", "/v1/employees/07-001"), SELF).allow).toBe(false);
  });
});

describe("grant-exceptions verb (custom-method) shares/denies", () => {
  const role = grantFor("employee");
  const withExc = (rows: UserRow[], col: string, code: string) => mergeGrants(role, rulesToGrant(narrow(rows, col, code)));
  const PEER_DOC = "04-002-009-0"; // a personal-document NOT owned by self (04-002-001)

  it("a verb share grants exactly that custom method on the object - not a sibling verb, not standard GET", () => {
    const rows = [exc("personal-documents", PEER_DOC, { verb: "download" })];
    const g = withExc(rows, "personal-documents", PEER_DOC);
    expect(decide(g, resolveRequest("POST", `/v1/personal-documents/${PEER_DOC}:download`), SELF).allow).toBe(true); // shared verb
    expect(decide(g, resolveRequest("POST", `/v1/personal-documents/${PEER_DOC}:destroy`), SELF).allow).toBe(false); // other verb untouched
    expect(decide(g, resolveRequest("GET", `/v1/personal-documents/${PEER_DOC}`), SELF).allow).toBe(false); // a verb share is not a read grant
  });

  it("a verb deny blocks just that verb, leaving the rest of the role grant intact", () => {
    const own = "04-002-001-7"; // under self -> the employee role grants its own doc read + download
    expect(decide(role, resolveRequest("POST", `/v1/personal-documents/${own}:download`), SELF).allow).toBe(true);
    const g = withExc([exc("personal-documents", own, { verb: "download", deny: true })], "personal-documents", own);
    expect(decide(g, resolveRequest("POST", `/v1/personal-documents/${own}:download`), SELF).allow).toBe(false); // verb denied (deny-wins)
    expect(decide(g, resolveRequest("GET", `/v1/personal-documents/${own}`), SELF).allow).toBe(true); // read still allowed
  });
});
