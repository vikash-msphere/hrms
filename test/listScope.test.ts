import { describe, it, expect } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { applyScope } from "../src/services/listScope";
import type { ListScope } from "../src/domain/access";
import * as schema from "../src/db/schema";

// DoD #2 / risk-B: list scope is fail-closed BY CONSTRUCTION. applyScope maps the middleware's verdict to
// this table's columns; anything missing yields `1 = 0` (no rows), never the full table. A forgotten or
// unset scope must hide everything, not expose everything.
const dialect = new SQLiteSyncDialect();
const sqlOf = (s: ReturnType<typeof applyScope>) => (s === undefined ? undefined : dialect.sqlToQuery(s).sql);
const code = schema.leaveRequests.code;
const owner = schema.leaveRequests.employeeId;
const scope = (s: Partial<ListScope>): ListScope => ({ breadth: "own", deptCode: null, ownerId: null, seeRestricted: false, ...s });

describe("applyScope - fail-closed list binding", () => {
  it("UNSET scope -> 1 = 0 (no rows), never the whole table", () => {
    expect(sqlOf(applyScope(undefined, code, owner))).toBe("1 = 0");
  });

  it("breadth 'all' -> no filter (undefined)", () => {
    expect(applyScope(scope({ breadth: "all" }), code, owner)).toBeUndefined();
  });

  it("breadth 'dept' binds a boundary-safe GLOB on the code, but 1 = 0 if the dept code is missing", () => {
    expect(sqlOf(applyScope(scope({ breadth: "dept", deptCode: "04-002" }), code, owner))).toMatch(/glob/i);
    expect(sqlOf(applyScope(scope({ breadth: "dept", deptCode: null }), code, owner))).toBe("1 = 0"); // fail closed
  });

  it("breadth 'own' binds owner = id, but 1 = 0 if the owner id is missing", () => {
    const own = sqlOf(applyScope(scope({ breadth: "own", ownerId: "abc" }), code, owner));
    expect(own).toMatch(/employee_id/);
    expect(own).toMatch(/=/);
    expect(sqlOf(applyScope(scope({ breadth: "own", ownerId: null }), code, owner))).toBe("1 = 0"); // fail closed
  });

  // GLOB, not LIKE, and that is load-bearing: SQLite only turns a prefix pattern into an index range scan
  // when the comparison is case-sensitive, so `code LIKE '04-002-%'` SCANS the table while the GLOB form
  // SEARCHes the index on `code`. See the note in services/listScope.ts. Asserted on the operator because
  // the whole point is which operator is emitted.
  it("the dept GLOB pattern is prefix-anchored ('<dept>-*'), so a sibling prefix can't leak", () => {
    const { sql, params } = dialect.sqlToQuery(applyScope(scope({ breadth: "dept", deptCode: "04-002" }), code, owner)!);
    expect(sql).toMatch(/glob/i);
    expect(sql).not.toMatch(/like/i); // a LIKE here is a full table scan on the hottest predicate in the app
    expect(params).toContain("04-002-*"); // not "04-002*", which would also match 04-0029...
  });

  it("per-object shares are OR'd into the breadth as their subtree (node + descendants)", () => {
    const { sql, params } = dialect.sqlToQuery(applyScope(scope({ breadth: "own", ownerId: "abc", shares: ["07-001-001", "07-002-003"] }), code, owner)!);
    expect(sql).toMatch(/ or /i);
    expect(sql).toMatch(/glob/i);
    // each share contributes its exact code (node) and its anchored subtree pattern
    expect(params).toEqual(expect.arrayContaining(["abc", "07-001-001", "07-001-001-*", "07-002-003", "07-002-003-*"]));
  });

  it("a user with no breadth but a share sees the shared subtree, not 1 = 0", () => {
    const sqlText = sqlOf(applyScope(scope({ breadth: "own", ownerId: null, shares: ["07-001-001"] }), code, owner));
    expect(sqlText).not.toBe("1 = 0");
    expect(sqlText).toMatch(/glob/i);
  });

  it("a PARENT share lists the node + its descendants, boundary-anchored so 04-002 never leaks to 04-0029", () => {
    const { params } = dialect.sqlToQuery(applyScope(scope({ breadth: "own", ownerId: "x", shares: ["04-002"] }), code, owner)!);
    expect(params).toContain("04-002"); // the node itself (exact eq) - the W3 grant-exceptions parent share
    expect(params).toContain("04-002-*"); // its subtree, anchored by the trailing '-'
    expect(params).not.toContain("04-002*"); // a bare prefix would also match 04-0029 - must NEVER be used
  });

  it("per-object denies hide the whole denied subtree (deny-wins, even against breadth 'all')", () => {
    const { sql, params } = dialect.sqlToQuery(applyScope(scope({ breadth: "all", denies: ["04-002"] }), code, owner)!);
    expect(sql).toMatch(/not /i);
    expect(params).toContain("04-002");
    expect(params).toContain("04-002-*"); // subtree deny, boundary-anchored
    expect(params).not.toContain("04-002*");
  });

  it("'all' breadth with no exceptions is still an unfiltered list (undefined)", () => {
    expect(applyScope(scope({ breadth: "all" }), code, owner)).toBeUndefined();
  });
});

// Subtree GRANTS bind exactly like per-object shares - both mean "this code and everything under it" - and
// they are what makes a named-department rule show rows instead of only opening records one by one.
describe("applyScope - subtree grants", () => {
  it("ORs the granted subtree into the breadth, boundary-anchored", () => {
    const sql = sqlOf(applyScope(scope({ breadth: "own", ownerId: "emp-1", subtrees: ["07"] }), code, owner))!;
    expect(sql).toContain("glob"); // the index-range operator, never LIKE - see the note on applyScope
    expect(sql).toContain("or");
    // The trailing '-' is the delimiter guard: 07 must not reach the prefix-collision neighbour 079.
    const q = dialect.sqlToQuery(applyScope(scope({ breadth: "own", ownerId: "emp-1", subtrees: ["07"] }), code, owner)!);
    expect(q.params).toContain("07-*");
  });

  it("adds nothing at `all` breadth - the caller already sees everything", () => {
    expect(sqlOf(applyScope(scope({ breadth: "all", subtrees: ["07"] }), code, owner))).toBeUndefined();
  });

  it("carries the whole predicate when the breadth binds nothing (a subtree-only approver)", () => {
    // `own` with a NULL owner is the empty breadth: without the subtree this is `1 = 0`, so the rows that
    // come back are the subtree's and nothing else.
    const sql = sqlOf(applyScope(scope({ breadth: "own", ownerId: null, subtrees: ["07"] }), code, owner))!;
    expect(sql).toContain("1 = 0");
    expect(sql).toContain("glob");
  });

  it("is still beaten by a deny (deny wins, as everywhere else)", () => {
    const sql = sqlOf(applyScope(scope({ breadth: "own", ownerId: "emp-1", subtrees: ["07"], denies: ["07-1a"] }), code, owner))!;
    expect(sql).toContain("not");
  });

  it("a table with no code column matches the subtree against nothing, rather than everything", () => {
    // Same failure direction as every other branch here: a missing column is `1 = 0`, so the OR falls back to
    // the breadth alone instead of widening to rows the grant never named.
    expect(sqlOf(applyScope(scope({ breadth: "own", ownerId: "emp-1", subtrees: ["07"] }), undefined, owner))).toContain("1 = 0");
  });
});

// `multiIndexOr: false` is a choice of PLAN, never of rows: the same predicate, bound as one `+( ... )` term so
// SQLite cannot answer the OR branch by branch from the code index and then sort everything it found. The rows
// it selects are pinned against real D1 in test/cardListRowsRead.test.ts. These pin the SQL it emits.
describe("applyScope - multiIndexOr: false", () => {
  const broad = scope({ breadth: "own", ownerId: "emp-1", subtrees: ["ve", "vr"], shares: ["vp-07"] });

  it("wraps the OR in unary plus around exactly the predicate it would otherwise bind, with the same values", () => {
    const plain = dialect.sqlToQuery(applyScope(broad, code, owner)!);
    const walked = dialect.sqlToQuery(applyScope(broad, code, owner, { multiIndexOr: false })!);
    expect(walked.sql).toBe(`+(${plain.sql})`);
    expect(walked.params).toEqual(plain.params);
  });

  it("leaves a lone branch as it was: with nothing OR'd in there is no union to keep out of the index", () => {
    const own = scope({ breadth: "own", ownerId: "emp-1" });
    expect(sqlOf(applyScope(own, code, owner, { multiIndexOr: false }))).toBe(sqlOf(applyScope(own, code, owner)));
    const dept = scope({ breadth: "dept", deptCode: "04-002" });
    expect(sqlOf(applyScope(dept, code, owner, { multiIndexOr: false }))).toBe(sqlOf(applyScope(dept, code, owner)));
  });

  it("changes nothing at `all` breadth, and a deny still applies outside the wrap", () => {
    expect(applyScope(scope({ breadth: "all", subtrees: ["ve"] }), code, owner, { multiIndexOr: false })).toBeUndefined();
    const sql = sqlOf(applyScope({ ...broad, denies: ["ve-0a"] }, code, owner, { multiIndexOr: false }))!;
    expect(sql.startsWith("(+(")).toBe(true);
    expect(sql).toMatch(/\) and not \(/);
  });

  it("is off unless asked for: the default binds the OR seekable, as every other list does", () => {
    expect(sqlOf(applyScope(broad, code, owner))).not.toMatch(/^\+\(/);
    expect(sqlOf(applyScope(broad, code, owner, {}))).toBe(sqlOf(applyScope(broad, code, owner)));
  });
});
