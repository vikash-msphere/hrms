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

  it("breadth 'dept' binds a boundary-safe LIKE on the code, but 1 = 0 if the dept code is missing", () => {
    expect(sqlOf(applyScope(scope({ breadth: "dept", deptCode: "04-002" }), code, owner))).toMatch(/like/i);
    expect(sqlOf(applyScope(scope({ breadth: "dept", deptCode: null }), code, owner))).toBe("1 = 0"); // fail closed
  });

  it("breadth 'own' binds owner = id, but 1 = 0 if the owner id is missing", () => {
    const own = sqlOf(applyScope(scope({ breadth: "own", ownerId: "abc" }), code, owner));
    expect(own).toMatch(/employee_id/);
    expect(own).toMatch(/=/);
    expect(sqlOf(applyScope(scope({ breadth: "own", ownerId: null }), code, owner))).toBe("1 = 0"); // fail closed
  });

  it("the dept LIKE pattern is prefix-anchored ('<dept>-%'), so a sibling prefix can't leak", () => {
    const { sql, params } = dialect.sqlToQuery(applyScope(scope({ breadth: "dept", deptCode: "04-002" }), code, owner)!);
    expect(sql).toMatch(/like/i);
    expect(params).toContain("04-002-%"); // not "04-002%", which would also match 04-0029...
  });

  it("per-object shares are OR'd into the breadth as their subtree (node + descendants)", () => {
    const { sql, params } = dialect.sqlToQuery(applyScope(scope({ breadth: "own", ownerId: "abc", shares: ["07-001-001", "07-002-003"] }), code, owner)!);
    expect(sql).toMatch(/ or /i);
    expect(sql).toMatch(/like/i);
    // each share contributes its exact code (node) and its anchored subtree pattern
    expect(params).toEqual(expect.arrayContaining(["abc", "07-001-001", "07-001-001-%", "07-002-003", "07-002-003-%"]));
  });

  it("a user with no breadth but a share sees the shared subtree, not 1 = 0", () => {
    const sqlText = sqlOf(applyScope(scope({ breadth: "own", ownerId: null, shares: ["07-001-001"] }), code, owner));
    expect(sqlText).not.toBe("1 = 0");
    expect(sqlText).toMatch(/like/i);
  });

  it("a PARENT share lists the node + its descendants, boundary-anchored so 04-002 never leaks to 04-0029", () => {
    const { params } = dialect.sqlToQuery(applyScope(scope({ breadth: "own", ownerId: "x", shares: ["04-002"] }), code, owner)!);
    expect(params).toContain("04-002"); // the node itself (exact eq) - the W3 grant-exceptions parent share
    expect(params).toContain("04-002-%"); // its subtree, anchored by the trailing '-'
    expect(params).not.toContain("04-002%"); // a bare prefix would also match 04-0029 - must NEVER be used
  });

  it("per-object denies hide the whole denied subtree (deny-wins, even against breadth 'all')", () => {
    const { sql, params } = dialect.sqlToQuery(applyScope(scope({ breadth: "all", denies: ["04-002"] }), code, owner)!);
    expect(sql).toMatch(/not /i);
    expect(params).toContain("04-002");
    expect(params).toContain("04-002-%"); // subtree deny, boundary-anchored
    expect(params).not.toContain("04-002%");
  });

  it("'all' breadth with no exceptions is still an unfiltered list (undefined)", () => {
    expect(applyScope(scope({ breadth: "all" }), code, owner)).toBeUndefined();
  });
});
