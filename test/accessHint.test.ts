import { describe, it, expect } from "vitest";
import { grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide } from "../src/domain/permissions";
import { computeCan, accessHint, withAccess, ACCESS_VERBS, KNOWN_VERBS } from "../src/http/accessHint";
import { COLLECTIONS } from "../src/domain/collections";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";
import type { AppUser } from "../src/env";

// M2: `access.can` is a UX HINT computed by the SAME engine. These prove computeCan never disagrees with the
// real request decision (so the UI hint can't claim an action the server would 403, nor hide one it allows),
// and that the verb table can't drift to a phantom collection/verb.

const SELF = { employeeCode: "04-002-001" }; // an employee in dept 04-002
const OWN_LR = "04-002-001-3"; // a leave-request owned by SELF (owner code embedded)
const DEPT_PEER_LR = "04-002-002-1"; // a dept peer's leave-request (under 04-002, not under self)
const OTHER_DEPT_LR = "07-001-001-1"; // another dept entirely

describe("computeCan agrees with decide() for every probed verb", () => {
  // For each (grant, collection, code), computeCan(v in can) must equal decide(allow) for the matching request.
  const cases = [
    { role: "employee", col: "leave-requests", code: OWN_LR },
    { role: "employee", col: "leave-requests", code: DEPT_PEER_LR },
    { role: "manager", col: "leave-requests", code: OWN_LR },
    { role: "manager", col: "leave-requests", code: DEPT_PEER_LR },
    { role: "manager", col: "leave-requests", code: OTHER_DEPT_LR },
    { role: "hr_admin", col: "employees", code: "04-002-002" },
    { role: "employee", col: "employees", code: "04-002-002" },
  ];
  const LEVEL: Record<string, "write" | "admin"> = { update: "write", delete: "write" };
  const req = (col: string, code: string, v: string) => {
    const level = LEVEL[v];
    return level
      ? decide(grantFor(cur.role), { kind: "standard", resource: `${col}.${code}`, level }, SELF)
      : decide(grantFor(cur.role), resolveRequest("POST", `/v1/${col}/${code}:${v}`), SELF);
  };
  let cur: { role: string; col: string; code: string };
  for (const c of cases) {
    it(`${c.role} on ${c.col}/${c.code}`, () => {
      cur = c;
      const can = computeCan(grantFor(c.role), SELF, c.col, c.code);
      for (const v of ACCESS_VERBS[c.col] ?? ["update", "delete"]) {
        expect(can.includes(v), `verb ${v}`).toBe(req(c.col, c.code, v).allow);
      }
    });
  }
});

describe("computeCan concrete expectations", () => {
  it("employee: own leave-request -> update/delete/cancel + document verbs; a peer's -> nothing", () => {
    // upload/download are the supporting-document slot (sick note), granted on OWN requests only.
    expect(computeCan(grantFor("employee"), SELF, "leave-requests", OWN_LR).sort()).toEqual(["cancel", "delete", "download", "update", "upload"]);
    expect(computeCan(grantFor("employee"), SELF, "leave-requests", DEPT_PEER_LR)).toEqual([]);
  });

  it("manager: a dept peer's leave-request -> approve/reject + read its document (not update/delete/cancel)", () => {
    expect(computeCan(grantFor("manager"), SELF, "leave-requests", DEPT_PEER_LR).sort()).toEqual(["approve", "download", "reject"]);
    // another dept -> my-dept does not match -> nothing
    expect(computeCan(grantFor("manager"), SELF, "leave-requests", OTHER_DEPT_LR)).toEqual([]);
  });
});

// THE CONTEXT THE SURFACES DECIDE WITH, which is not always the one the GATE decided with.
//
// `computeCan` above takes a SelfContext explicitly and the tests hand it one. The entry points a serializer
// actually calls - `accessHint(user, …)` and `withAccess(…)` - take an AppUser and used to rebuild the context
// as `{ employeeCode }`. That is a different context: `decide()` with no reporting line cannot match
// `my-reports` or `my-org`, so it refuses. A manager whose grant reaches their team through the chain was
// served the row (the middleware decided THAT with the full context, resolved once per request) carrying no
// verbs and with its redacted fields dropped, and nothing anywhere said why. `my-dept` hid it, because that
// token derives from the employee code the rebuild did carry.
describe("the access hint asks with the request's own matcher context", () => {
  const MANAGER = "04-002-001";
  const REPORT_LR = "07-001-004-2"; // a leave-request owned by a report who sits in ANOTHER department
  // A level for the read and an ALLOW for the custom method, which is how a verb is granted (a level grant
  // carries none) - the same shape the seeded manager holds, with the chain token in place of `my-dept`.
  const chainGrant = { levels: { "leave-requests.my-reports.**": "read" as const }, allow: ["leave-requests.my-reports.approve"] };
  // The caller as the middleware leaves them: `self` resolved and parked on the user (middleware/authz.ts).
  const withChain = {
    grant: chainGrant,
    employeeCode: MANAGER,
    self: { employeeCode: MANAGER, reportCodes: ["07-001-004"], orgCodes: ["07-001-004"] },
    policy: { ...DEFAULT_POLICY, redacted_fields: { "leave-requests": ["reason"] } },
  } as unknown as AppUser;
  // The same caller with the context missing, which is what every one of these surfaces used to build for
  // itself. Kept as a case rather than deleted: it is the fail-closed direction, and it is still what a
  // principal assembled outside a request (the cron tick, an internal dispatch) legitimately looks like.
  const noChain = { ...withChain, self: undefined } as unknown as AppUser;

  it("offers the verbs the gate would allow on a report's row", () => {
    expect(accessHint(withChain, "leave-requests", REPORT_LR).can).toContain("approve");
    expect(accessHint(noChain, "leave-requests", REPORT_LR).can).toEqual([]);
  });

  it("keeps a redacted field the caller may read through the reporting line", () => {
    const row = { path: `leave-requests/${REPORT_LR}`, reason: "hospital appointment" };
    expect(withAccess(row, withChain, "leave-requests", REPORT_LR)).toHaveProperty("reason");
    // ...and still drops it for a caller the engine refuses, which is what the manifest entry is FOR.
    expect(withAccess(row, noChain, "leave-requests", REPORT_LR)).not.toHaveProperty("reason");
  });
});

describe("ACCESS_VERBS drift gate", () => {
  it("only names real collections and known verbs", () => {
    for (const [col, verbs] of Object.entries(ACCESS_VERBS)) {
      expect(COLLECTIONS.has(col), `collection ${col}`).toBe(true);
      for (const v of verbs) expect(KNOWN_VERBS.has(v), `verb ${v}`).toBe(true);
    }
  });
});
