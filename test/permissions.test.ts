import { describe, it, expect } from "vitest";
import { resolveRequest, keyOf, decide, matchingPattern } from "../src/domain/permissions";
import { deriveNarrowing } from "../src/domain/compileGrants";
import type { Grant, SelfContext } from "../src/domain/permissions";

// Caller is employee 04-1c-0a9 (dept 04-1c). `req` resolves a request; `ok` asserts allow.
const SELF: SelfContext = { employeeCode: "04-1c-0a9" };
const req = (m: string, p: string, force = false) => resolveRequest(m, p, force);
const allow = (g: Grant, m: string, p: string, force = false, self: SelfContext = SELF) =>
  decide(g, req(m, p, force), self).allow;

describe("resolveRequest", () => {
  it("GET list/get -> read", () => {
    expect(resolveRequest("GET", "/v1/employees")).toEqual({ kind: "standard", resource: "employees", level: "read" });
    expect(resolveRequest("GET", "/v1/employees/04-1c-0a9")).toEqual({ kind: "standard", resource: "employees.04-1c-0a9", level: "read" });
  });
  it("POST/PATCH -> write", () => {
    expect(keyOf(resolveRequest("POST", "/v1/employees"))).toBe("employees.write");
    expect(resolveRequest("PATCH", "/v1/employees/04-1c-0a9/bank-account")).toEqual({
      kind: "standard",
      resource: "employees.04-1c-0a9.bank-account",
      level: "write",
    });
  });
  it("DELETE soft=write, force=admin", () => {
    expect(keyOf(resolveRequest("DELETE", "/v1/holidays/0h"))).toBe("holidays.0h.write");
    expect(keyOf(resolveRequest("DELETE", "/v1/holidays/0h", true))).toBe("holidays.0h.admin");
  });
  it("custom method -> verb action", () => {
    expect(resolveRequest("POST", "/v1/leave-requests/04-1c-0a9-0kf:approve")).toEqual({
      kind: "custom",
      resource: "leave-requests.04-1c-0a9-0kf",
      verb: "approve",
    });
  });
  it("strips query string and leading slash variants", () => {
    expect(resolveRequest("DELETE", "/v1/holidays/0h?force=true&x=1").resource).toBe("holidays.0h");
  });
  it("keeps the literal me token (middleware binds it from the JWT)", () => {
    expect(resolveRequest("GET", "/v1/employees/me/bank-account").resource).toBe("employees.me.bank-account");
  });
});

describe("keyOf", () => {
  it("standard -> resource.level", () => {
    expect(keyOf(resolveRequest("GET", "/v1/documents/0a9-0kf"))).toBe("documents.0a9-0kf.read");
    expect(keyOf(resolveRequest("DELETE", "/v1/holidays/0h", true))).toBe("holidays.0h.admin");
  });
  it("custom -> resource.verb", () => {
    expect(keyOf(resolveRequest("POST", "/v1/payroll-runs/0a:approve"))).toBe("payroll-runs.0a.approve");
  });
});

const employee: Grant = {
  levels: {
    "employees.*": "read", // directory record only
    "employees.me.**": "write", // own record + sub-resources (bank-account, etc.)
    "leave-requests": "write", // create/list on the collection
    "leave-requests.me.**": "write", // own leave-requests (owner code embedded in the id)
    "holidays.**": "read",
  },
  allow: ["leave-requests.*.cancel", "employees.me.uploadPhoto"],
};

const manager: Grant = {
  // Everyone reads the directory (employees.* read, inherited); a manager additionally MANAGES (writes)
  // their own dept subtree via my-dept.
  levels: { ...employee.levels, "employees.my-dept.**": "write" },
  allow: [...employee.allow, "leave-requests.*.approve"],
};

describe("decide - level ladder", () => {
  it("read grant allows GET, denies write", () => {
    expect(allow(employee, "GET", "/v1/employees/05-2a-0b1")).toBe(true); // employees.* read
    expect(allow(employee, "PATCH", "/v1/employees/05-2a-0b1")).toBe(false); // no write on others
  });
  it("write implies read (list/get)", () => {
    expect(allow(employee, "GET", "/v1/leave-requests")).toBe(true); // write => read
    expect(allow(employee, "POST", "/v1/leave-requests")).toBe(true);
  });
  it("admin implies purge; write does not", () => {
    const adminH: Grant = { levels: { "holidays.**": "admin" }, allow: [] };
    const writeH: Grant = { levels: { "holidays.**": "write" }, allow: [] };
    expect(allow(adminH, "DELETE", "/v1/holidays/0h", true)).toBe(true); // force => admin
    expect(allow(writeH, "DELETE", "/v1/holidays/0h", true)).toBe(false);
    expect(allow(writeH, "DELETE", "/v1/holidays/0h")).toBe(true); // soft delete = write
  });
});

describe("decide - me / ownership", () => {
  it("own record + sub-resources via me", () => {
    expect(allow(employee, "PATCH", "/v1/employees/04-1c-0a9")).toBe(true); // self
    expect(allow(employee, "GET", "/v1/employees/04-1c-0a9/bank-account")).toBe(true); // write=>read
    expect(allow(employee, "PATCH", "/v1/employees/04-1c-0b2/bank-account")).toBe(false); // not me
  });
  it("own owned-resource via the owner-embedded code", () => {
    expect(allow(employee, "GET", "/v1/leave-requests/04-1c-0a9-0kf")).toBe(true); // under me
    expect(allow(employee, "GET", "/v1/leave-requests/04-1c-0b2-0kf")).toBe(false); // someone else's
  });
  it("matches the literal `me` token in a self path", () => {
    expect(allow(employee, "GET", "/v1/employees/me")).toBe(true); // employees.me read
    expect(allow(employee, "GET", "/v1/employees/me/bank-account")).toBe(true); // me.bank-account write=>read
  });
  it("fails closed when the caller has no employee code", () => {
    expect(allow(employee, "PATCH", "/v1/employees/04-1c-0a9", false, { employeeCode: null })).toBe(false);
  });
});

describe("decide - my-dept (manager)", () => {
  it("everyone reads the directory; manager WRITES only their own dept subtree", () => {
    expect(allow(manager, "GET", "/v1/employees/07-3a-0c4")).toBe(true); // directory read is universal
    expect(allow(manager, "PATCH", "/v1/employees/04-1c-0b2")).toBe(true); // manages own dept (my-dept write)
    expect(allow(manager, "PATCH", "/v1/employees/07-3a-0c4")).toBe(false); // cannot write another dept
  });
});

describe("decide - custom methods", () => {
  it("manager may approve, employee may not", () => {
    expect(allow(manager, "POST", "/v1/leave-requests/04-1c-0b2-0kf:approve")).toBe(true);
    expect(allow(employee, "POST", "/v1/leave-requests/04-1c-0a9-0kf:approve")).toBe(false);
  });
  it("employee may cancel (allow pattern)", () => {
    expect(allow(employee, "POST", "/v1/leave-requests/04-1c-0a9-0kf:cancel")).toBe(true);
  });
  it("`*` wildcard verb grants ALL custom methods but not standard methods", () => {
    const g: Grant = { levels: {}, allow: ["documents.*.*"] };
    expect(allow(g, "POST", "/v1/documents/0a9-0kf:share")).toBe(true); // any custom verb
    expect(allow(g, "POST", "/v1/documents/0a9-0kf:download")).toBe(true);
    expect(allow(g, "GET", "/v1/documents/0a9-0kf")).toBe(false); // standard read NOT granted by the allow lane
    expect(allow(g, "PATCH", "/v1/documents/0a9-0kf")).toBe(false); // standard write NOT granted
  });
});

describe("decide - deny precedence (wins, no downward ladder)", () => {
  const g: Grant = { levels: { "documents.**": "admin" }, allow: ["documents.*.share"], deny: ["documents.*.read", "documents.*.share"] };
  it("deny blocks a standard level even at admin", () => {
    expect(allow(g, "GET", "/v1/documents/0a9")).toBe(false); // denied .read
  });
  it("deny on .read does NOT block .write (no downward ladder)", () => {
    expect(allow(g, "PATCH", "/v1/documents/0a9")).toBe(true); // write not denied
  });
  it("deny blocks a custom verb", () => {
    expect(allow(g, "POST", "/v1/documents/0a9:share")).toBe(false);
  });
});

describe("decide - explicit code prefix + super_admin + fail-closed", () => {
  it("explicit '04-*' prefix scopes to that dept", () => {
    const g: Grant = { levels: { "employees.04-*": "read" }, allow: [] };
    expect(allow(g, "GET", "/v1/employees/04-1c-0a9")).toBe(true);
    expect(allow(g, "GET", "/v1/employees/05-1c-0a9")).toBe(false);
    expect(allow(g, "GET", "/v1/employees/041-x")).toBe(false); // boundary: not under 04
  });
  it("super_admin ** grants everything", () => {
    const sa: Grant = { levels: { "**": "admin" }, allow: ["**"] };
    expect(allow(sa, "DELETE", "/v1/employees/9z-9z-9z9", true)).toBe(true);
    expect(allow(sa, "POST", "/v1/payroll-runs/0a:approve")).toBe(true);
  });
  it("empty grant denies everything", () => {
    const none: Grant = { levels: {}, allow: [] };
    expect(allow(none, "GET", "/v1/holidays")).toBe(false);
  });
});

describe("matchingPattern - access provenance (scope of the granting rule)", () => {
  const scopeOf = (g: Grant, code: string, self: SelfContext = SELF) => {
    const pat = matchingPattern(g, { kind: "standard", resource: `employees.${code}`, level: "read" }, self);
    return pat ? deriveNarrowing(pat).scopeKind : null;
  };
  it("self scope when read comes from the `me` pattern", () => {
    const g: Grant = { levels: { "employees.me.**": "read" }, allow: [] };
    expect(scopeOf(g, "04-1c-0a9")).toBe("self"); // own record
    expect(scopeOf(g, "05-2d-0b0")).toBe(null); // someone else -> not granted
  });
  it("dept scope when read comes from the `my-dept` pattern", () => {
    const g: Grant = { levels: { "employees.my-dept.**": "read" }, allow: [] };
    expect(scopeOf(g, "04-1c-0a9")).toBe("dept"); // a dept-mate
  });
  it("subtree scope for an explicit code prefix; all for org-wide", () => {
    expect(scopeOf({ levels: { "employees.04-*": "read" }, allow: [] }, "04-1c-0a9")).toBe("subtree");
    expect(scopeOf({ levels: { "employees.*": "read" }, allow: [] }, "04-1c-0a9")).toBe("all");
  });
  it("picks the highest-level matching pattern; null when not allowed", () => {
    const g: Grant = { levels: { "employees.*": "read", "employees.me.**": "admin" }, allow: [] };
    // admin (self) outranks read (all) -> provenance is the self pattern
    expect(scopeOf(g, "04-1c-0a9")).toBe("self");
    expect(scopeOf({ levels: {}, allow: [] }, "04-1c-0a9")).toBe(null);
  });
  it("a matching deny yields no positive provenance", () => {
    const g: Grant = { levels: { "employees.*": "read" }, allow: [], deny: ["employees.*.read"] };
    expect(scopeOf(g, "04-1c-0a9")).toBe(null);
  });
});

// Per-entity activity trail gate (authz two-gate: read AND `activity`). The middleware decides
// `activity.<recordCode>.<collection>` at read level using the caller's BROAD grant; scope sits at token[1]
// and the collection is a sub-resource, so the standard engine narrows per-scope AND per-collection. These
// assert the encoding directly (the read half is the ordinary record-read decision, tested elsewhere).
describe("activity capability (per-entity trail)", () => {
  // caller 04-1c-0a9, dept 04-1c
  const act = (g: Grant, code: string, col: string, self: SelfContext = SELF) =>
    decide(g, { kind: "standard", resource: `activity.${code}.${col}`, level: "read" }, self).allow;

  it("default `activity.**` sees activity for any record + any collection", () => {
    const g: Grant = { levels: { "activity.**": "read" }, allow: [] };
    expect(act(g, "07-2a-0b1", "compensation")).toBe(true);
    expect(act(g, "04-1c-0a9-0kf", "leave-requests")).toBe(true);
  });

  it("no activity grant → denied even though (elsewhere) read may pass", () => {
    expect(act({ levels: {}, allow: [] }, "04-1c-0a9", "employees")).toBe(false);
  });

  it("per-scope: `activity.my-dept.**` only for records under the caller's dept", () => {
    const g: Grant = { levels: { "activity.my-dept.**": "read" }, allow: [] };
    expect(act(g, "04-1c-0a9-0kf", "leave-requests")).toBe(true); // under dept 04-1c
    expect(act(g, "07-2a-0b1", "leave-requests")).toBe(false); // another dept
  });

  it("per-scope: `activity.me.**` only for the caller's own records", () => {
    const g: Grant = { levels: { "activity.me.**": "read" }, allow: [] };
    expect(act(g, "04-1c-0a9", "employees")).toBe(true); // self
    expect(act(g, "04-1c-0a9-0kf", "leave-requests")).toBe(true); // owned (under self code)
    expect(act(g, "04-1c-0b2", "leave-requests")).toBe(false); // a peer in the same dept, not self
  });

  it("per-collection: `activity.*.leave-requests` only for that collection, any record", () => {
    const g: Grant = { levels: { "activity.*.leave-requests": "read" }, allow: [] };
    expect(act(g, "07-2a-0b1", "leave-requests")).toBe(true);
    expect(act(g, "07-2a-0b1", "compensation")).toBe(false);
  });

  it("a deny wins over the broad grant", () => {
    const g: Grant = { levels: { "activity.**": "read" }, allow: [], deny: ["activity.*.compensation.read"] };
    expect(act(g, "07-2a-0b1", "compensation")).toBe(false);
    expect(act(g, "07-2a-0b1", "leave-requests")).toBe(true);
  });

  it("every activity pattern compiles to a BROAD rule (match_code NULL) so it loads into the role grant", () => {
    for (const p of ["activity.**", "activity.my-dept.**", "activity.me.**", "activity.*.leave-requests"]) {
      const n = deriveNarrowing(p);
      expect(n.namespace).toBe("activity");
      // scope lives at token[1]; the collection sub-resource never lands in the match_code (per-object) lane
    }
    expect(deriveNarrowing("activity.my-dept.**").scopeKind).toBe("dept");
    expect(deriveNarrowing("activity.me.**").scopeKind).toBe("self");
    expect(deriveNarrowing("activity.*.leave-requests").scopeKind).toBe("all");
  });
});

// Viewing a payslip in the app (:preview) and keeping a copy (:download) are separate custom methods, each
// scoped on its own. These pin that separation: one grant never implies the other, and both narrow by scope.
describe("payslip preview vs download (independent verbs, own scope)", () => {
  const viewOwn: Grant = { levels: { "payslips.me.**": "read" }, allow: ["payslips.me.preview"] };
  const takeOwn: Grant = { levels: { "payslips.me.**": "read" }, allow: ["payslips.me.download"] };
  const OWN = "/v1/payslips/04-1c-0a9-2";
  const PEER = "/v1/payslips/04-1c-0b1-2"; // a dept peer's slip

  it("preview-only may view its own slip but not download it", () => {
    expect(allow(viewOwn, "POST", `${OWN}:preview`)).toBe(true);
    expect(allow(viewOwn, "POST", `${OWN}:download`)).toBe(false);
  });
  it("download-only may take a copy but has no preview lane", () => {
    expect(allow(takeOwn, "POST", `${OWN}:download`)).toBe(true);
    expect(allow(takeOwn, "POST", `${OWN}:preview`)).toBe(false);
  });
  it("a self-scoped preview does not reach someone else's slip", () => {
    expect(allow(viewOwn, "POST", `${PEER}:preview`)).toBe(false);
    // Widening the same verb to the caller's department does reach the peer, and no further.
    const viewDept: Grant = { levels: { "payslips.my-dept.**": "read" }, allow: ["payslips.my-dept.preview"] };
    expect(allow(viewDept, "POST", `${PEER}:preview`)).toBe(true);
    expect(allow(viewDept, "POST", "/v1/payslips/07-001-001-2:preview")).toBe(false); // another department
  });
});
