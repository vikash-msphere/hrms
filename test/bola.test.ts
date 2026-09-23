import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide, withOwnerResource } from "../src/domain/permissions";
import { OWNER_REFS, isPublicState } from "../src/domain/manifests";
import { guardAllows, parseCondition, parseFromIp, type GuardIndex } from "../src/domain/ruleCondition";

// DoD #3 acceptance suite: free of BOLA. Every owner-scoped item decision resolves the object's code and
// matches it against the caller's scope (me / my-dept). These assert object-level isolation directly on the
// engine: a caller may reach their OWN owned objects, never another employee's or another dept's, except
// where policy explicitly grants breadth (manager dept, hr/payroll base records, super everything).
//
// Codes are owner-embedded: an employee's code IS the employees item code; their leave-requests/payslips/
// documents/operations/leave-balances codes are nested under it. (The wire token is decoded to this code
// before the decision; opaque tokens are defense-in-depth, never the guard - so we test the code path.)
const SELF = "04-002-001"; // caller, dept 04-002
const PEER = "04-002-002"; // same dept, different employee
const OTHER = "07-001-001"; // different dept

const owned = (code: string) => `${code}-0`; // an owner-embedded child (leave-request/payslip/doc/op/balance)
const d = (role: string, method: string, path: string, self: string | null = SELF) =>
  decide(grantFor(role), resolveRequest(method, path), { employeeCode: self }).allow;

const OWNED_COLLECTIONS = ["leave-requests", "payslips", "personal-documents", "operations", "leave-balances"] as const;

// STATE-GATED VISIBILITY, widened past booleans. `public_when` could only compare flags, so every state the app
// would actually want to gate - a draft payroll run, a cancelled requisition, an offer in negotiation, a
// terminated employee - was inexpressible. These pin the semantics the item gate and the list filter now SHARE,
// because the two disagreeing is the failure this mechanism keeps producing in other lanes.
describe("state visibility - public_when compares flags, strings and sets alike", () => {
  it("keeps the original boolean semantics, NULL included", () => {
    const rule = { requires: "write" as const, public_when: { published: true, disabled: false } };
    expect(isPublicState({ published: true, disabled: false }, rule)).toBe(true);
    expect(isPublicState({ published: false, disabled: false }, rule)).toBe(false);
    // A null flag coerces to false, so it is public only where the rule wants false.
    expect(isPublicState({ published: null, disabled: null }, rule)).toBe(false);
    expect(isPublicState({ published: true, disabled: null }, rule)).toBe(true);
  });

  it("compares a string status, and any of a set", () => {
    const one = { requires: "write" as const, public_when: { status: "published" } };
    expect(isPublicState({ status: "published" }, one)).toBe(true);
    expect(isPublicState({ status: "draft" }, one)).toBe(false);
    const many = { requires: "write" as const, public_when: { status: ["extended", "accepted"] } };
    expect(isPublicState({ status: "extended" }, many)).toBe(true);
    expect(isPublicState({ status: "accepted" }, many)).toBe(true);
    expect(isPublicState({ status: "negotiating" }, many)).toBe(false);
  });

  // FAIL CLOSED. An unset status is not a public one: a gate that treated "no value" as public would expose
  // exactly the half-created rows it exists to hide.
  it("treats an absent or null string status as restricted", () => {
    const rule = { requires: "write" as const, public_when: { status: "published" } };
    for (const state of [{}, { status: null }, { status: undefined }]) expect(isPublicState(state, rule)).toBe(false);
  });

  it("needs EVERY clause to hold, not any", () => {
    const rule = { requires: "write" as const, public_when: { status: "open", disabled: false } };
    expect(isPublicState({ status: "open", disabled: false }, rule)).toBe(true);
    expect(isPublicState({ status: "open", disabled: true }, rule)).toBe(false);
    expect(isPublicState({ status: "closed", disabled: false }, rule)).toBe(false);
  });
});

// PER-RULE THRESHOLDS (domain/ruleCondition.ts). The property that matters is not "a limit works" but that a
// limit can only ever SUBTRACT: it is consulted after decide() has allowed, it never turns a refusal into an
// allow, and holding an unconditional rule alongside a capped one leaves the unconditional one winning - or
// granting somebody an extra rule would take access away.
describe("per-rule conditions subtract from a grant and never add to it", () => {
  const PATTERN = "expenses.my-dept.approve";
  const capped = (value: number): GuardIndex => new Map([[PATTERN, [{ condition: { field: "amount", op: "lte" as const, value }, fromIp: null, window: null }]]]);

  it("allows a row inside the limit and refuses one over it", () => {
    expect(guardAllows(capped(50_000), PATTERN, { row: { amount: 500 } })).toBe(true);
    expect(guardAllows(capped(50_000), PATTERN, { row: { amount: 50_000 } })).toBe(true); // lte is inclusive
    expect(guardAllows(capped(50_000), PATTERN, { row: { amount: 500_000 } })).toBe(false);
  });

  it("leaves a pattern with no condition untouched - the fast path for almost every request", () => {
    expect(guardAllows(capped(50_000), "expenses.me.**", { row: { amount: 500_000 } })).toBe(true);
    expect(guardAllows(undefined, PATTERN, { row: { amount: 500_000 } })).toBe(true);
  });

  // THE UNION PROPERTY. Authority in this app unions - roles, `everyone`, the user's own rules - so a second
  // rule must never make a caller worse off. An unconditional rule on the same pattern wins outright.
  it("lets an unconditional rule beat a capped one on the same pattern", () => {
    const both: GuardIndex = new Map([[PATTERN, [{ condition: { field: "amount", op: "lte", value: 50_000 }, fromIp: null, window: null }, { condition: null, fromIp: null, window: null }]]]);
    expect(guardAllows(both, PATTERN, { row: { amount: 500_000 } })).toBe(true);
  });

  // FAIL CLOSED. "I could not check the limit" has to mean the same as "over the limit", or a cap evaporates
  // exactly when the value is missing - which is when a caller would most want it to.
  it("refuses when the value is absent, unparseable, or the row never loaded", () => {
    for (const row of [{}, { amount: null }, { amount: "" }, { amount: "abc" }, null, undefined]) {
      expect(guardAllows(capped(50_000), PATTERN, { row })).toBe(false);
    }
  });

  // A NETWORK fence is the other half of the same gate, and the shape differs in one way that matters: it is a
  // predicate on the REQUEST, so it applies with or without a row.
  it("fences a rule to an address range, with or without a row to measure", () => {
    const fenced: GuardIndex = new Map([[PATTERN, [{ condition: null, fromIp: parseFromIp("198.51.100.0/24"), window: null }]]]);
    expect(guardAllows(fenced, PATTERN, { ip: "198.51.100.7" })).toBe(true);
    expect(guardAllows(fenced, PATTERN, { ip: "203.0.113.9" })).toBe(false);
    // No row at all - a collection-level request - is still fenced, unlike a threshold.
    expect(guardAllows(fenced, PATTERN, { row: null, ip: "198.51.100.7" })).toBe(true);
  });

  // FAIL CLOSED, matching the attendance clock's fence: an address the edge could not establish is not "inside".
  it("refuses a fenced rule when the caller's address is unknown", () => {
    const fenced: GuardIndex = new Map([[PATTERN, [{ condition: null, fromIp: parseFromIp("198.51.100.0/24"), window: null }]]]);
    for (const ip of [undefined, null, ""]) expect(guardAllows(fenced, PATTERN, { ip })).toBe(false);
  });

  it("needs BOTH halves of a rule that carries a limit and a fence", () => {
    const both: GuardIndex = new Map([
      [PATTERN, [{ condition: { field: "amount", op: "lte", value: 50_000 }, fromIp: parseFromIp("198.51.100.0/24"), window: null }]],
    ]);
    expect(guardAllows(both, PATTERN, { row: { amount: 500 }, ip: "198.51.100.7" })).toBe(true);
    expect(guardAllows(both, PATTERN, { row: { amount: 500 }, ip: "203.0.113.9" })).toBe(false); // wrong network
    expect(guardAllows(both, PATTERN, { row: { amount: 500_000 }, ip: "198.51.100.7" })).toBe(false); // over the limit
  });

  // A TIME WINDOW bounds which ROWS a rule reaches, which a rule's own `expires_at` cannot say - that bounds
  // when the rule is alive. Symmetric, so recent and upcoming both qualify.
  it("reaches rows dated near now, in either direction, and nothing further out", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const DAY = 86_400_000;
    const windowed: GuardIndex = new Map([[PATTERN, [{ condition: null, fromIp: null, window: { field: "incurred_on", within_days: 30 } }]]]);
    const at = (offsetDays: number) => guardAllows(windowed, PATTERN, { row: { incurred_on: now + offsetDays * DAY }, now });
    expect(at(0)).toBe(true);
    expect(at(-29)).toBe(true);
    expect(at(29)).toBe(true); // upcoming counts - a scheduled row is not "old"
    expect(at(-31)).toBe(false);
    expect(at(31)).toBe(false);
  });

  it("reads a windowed date however the row carries it, and fails closed when it cannot", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const windowed: GuardIndex = new Map([[PATTERN, [{ condition: null, fromIp: null, window: { field: "incurred_on", within_days: 30 } }]]]);
    for (const v of [new Date(now), now, "2026-06-01T00:00:00Z"]) {
      expect(guardAllows(windowed, PATTERN, { row: { incurred_on: v }, now })).toBe(true);
    }
    for (const v of [null, undefined, "", "not a date"]) {
      expect(guardAllows(windowed, PATTERN, { row: { incurred_on: v }, now })).toBe(false);
    }
    // No row at all - a collection-level request - has no date to be inside the window.
    expect(guardAllows(windowed, PATTERN, { row: null, now })).toBe(false);
  });

  it("refuses a malformed stored condition rather than treating it as absent", () => {
    for (const bad of ["{}", '{"field":"amount"}', '{"field":"amount","op":"like","value":1}', '{"field":"amount","op":"lte","value":"1"}', "not json"]) {
      expect(parseCondition(bad)).toBeNull();
    }
    expect(parseCondition('{"field":"amount","op":"lte","value":50000}')).toEqual({ field: "amount", op: "lte", value: 50_000 });
  });
});

// The MANAGER CHAIN (domain/permissions.ts SelfContext). `my-dept` was standing in for "my team", and the two
// are different relationships: these assert the token reaches a report who sits in ANOTHER department (which
// `my-dept` never could) and does NOT reach a department peer the caller does not manage (which `my-dept`
// wrongly did). The fourth case is the one that matters most - an unloaded report set matches nothing.
describe("BOLA - my-reports / my-org reach the reporting line, not the department", () => {
  const REPORT_ELSEWHERE = "07-001-004"; // reports to SELF, sits in a different department
  const SKIP = "07-001-009"; // reports to REPORT_ELSEWHERE - inside my-org, outside my-reports
  const readAs = (pattern: string, code: string, self: Parameters<typeof decide>[2]) =>
    decide({ levels: { [pattern]: "read" }, allow: [] }, resolveRequest("GET", `/v1/leave-requests/${code}`), self).allow;
  const withReports = { employeeCode: SELF, reportCodes: [REPORT_ELSEWHERE], orgCodes: [REPORT_ELSEWHERE, SKIP] };

  it("reaches a report's owned rows wherever they sit in the org chart", () => {
    expect(readAs("leave-requests.my-reports.**", owned(REPORT_ELSEWHERE), withReports)).toBe(true);
    // ...and the report's own record, not only rows composed under it.
    expect(readAs("leave-requests.my-reports.**", REPORT_ELSEWHERE, withReports)).toBe(true);
    // `my-dept` could never have answered this - the report is in another department entirely.
    expect(readAs("leave-requests.my-dept.**", owned(REPORT_ELSEWHERE), withReports)).toBe(false);
  });

  it("does not reach a department peer the caller does not manage", () => {
    expect(readAs("leave-requests.my-reports.**", owned(PEER), withReports)).toBe(false);
    expect(readAs("leave-requests.my-org.**", owned(PEER), withReports)).toBe(false);
  });

  it("separates direct reports from the whole reporting line", () => {
    expect(readAs("leave-requests.my-reports.**", owned(SKIP), withReports)).toBe(false); // a report's report
    expect(readAs("leave-requests.my-org.**", owned(SKIP), withReports)).toBe(true);
  });

  // THE FAIL-CLOSED DIRECTION. The sets are loaded only when the grant uses the tokens, so "not loaded" is a
  // state the matcher genuinely sees - and it must mean nothing matches, never everything.
  it("matches nothing when the reporting line was not resolved", () => {
    const noSets = { employeeCode: SELF };
    expect(readAs("leave-requests.my-reports.**", owned(REPORT_ELSEWHERE), noSets)).toBe(false);
    expect(readAs("leave-requests.my-org.**", owned(REPORT_ELSEWHERE), noSets)).toBe(false);
    // ...including for the caller's own rows: the token is about other people, and `me` is a separate grant.
    expect(readAs("leave-requests.my-reports.**", owned(SELF), noSets)).toBe(false);
  });
});

// The OWNER KEY (domain/permissions.ts Resolved#ownerResource). `assets` and `users` carry a FLAT code with an
// owner column, so their item lane could not answer `me` / `my-dept` at all - the list returned a row that
// `GET /v1/assets/<id>` then refused. The key closes that, and these are the four properties that have to hold
// for it: it reaches the holder's own row, it does NOT reach somebody else's, a deny on the row's own code
// still bites through it, and a collection without the key is untouched.
describe("BOLA - the owner key on flat-coded owner-column collections", () => {
  const FLAT = "0a"; // an asset's own code: flat, so no scope token can ever match it
  const selfScoped = { levels: { "assets.me.**": "read" as const }, allow: [] };
  const deptScoped = { levels: { "assets.my-dept.**": "read" as const }, allow: [] };
  const read = (grant: Parameters<typeof decide>[0], ownerCode: string | null, self: string | null = SELF) =>
    decide(
      grant,
      ownerCode
        ? withOwnerResource({ kind: "standard", resource: `assets.${FLAT}`, level: "read" }, ownerCode)
        : { kind: "standard", resource: `assets.${FLAT}`, level: "read" },
      { employeeCode: self },
    ).allow;

  it("reaches the row whose owner is the caller, and not one owned by anybody else", () => {
    expect(read(selfScoped, SELF)).toBe(true);
    expect(read(selfScoped, PEER)).toBe(false);
    expect(read(selfScoped, OTHER)).toBe(false);
    // A row with no owner at all (an asset in stock) is decided on its flat code alone - i.e. refused.
    expect(read(selfScoped, null)).toBe(false);
  });

  it("answers my-dept by the owner's department, not the row's flat code", () => {
    expect(read(deptScoped, PEER)).toBe(true); // same dept as SELF
    expect(read(deptScoped, OTHER)).toBe(false);
  });

  // THE LEAK DIRECTION. The allow lanes take EITHER key; the deny lane must take BOTH, or a deny authored on
  // the row's own code is simply stepped around by the owner key.
  it("still refuses when the deny names the row's own code", () => {
    const denied = { levels: { "assets.me.**": "read" as const }, allow: [], deny: [`assets.${FLAT}.read`] };
    expect(read(denied, SELF)).toBe(false);
  });

  it("changes nothing for a collection that gets no owner key", () => {
    // Same grant shape on an owner-CODED collection: the row code already carries the owner, so the answer is
    // whatever it was before the key existed.
    expect(d("employee", "GET", `/v1/leave-requests/${owned(SELF)}`)).toBe(true);
    expect(d("employee", "GET", `/v1/leave-requests/${owned(PEER)}`)).toBe(false);
  });
});

describe("BOLA - employee: own only, never another employee", () => {
  it("reaches own employee record + owned objects", () => {
    expect(d("employee", "GET", `/v1/employees/${SELF}`)).toBe(true);
    expect(d("employee", "PATCH", `/v1/employees/${SELF}/bank-account`)).toBe(true); // own PII
    expect(d("employee", "PATCH", `/v1/employees/${SELF}/bio`)).toBe(true); // own public about-me
    for (const col of OWNED_COLLECTIONS) expect(d("employee", "GET", `/v1/${col}/${owned(SELF)}`)).toBe(true);
  });
  it("cannot reach a dept peer's or another dept's objects", () => {
    for (const victim of [PEER, OTHER]) {
      expect(d("employee", "GET", `/v1/employees/${victim}`)).toBe(false);
      expect(d("employee", "PATCH", `/v1/employees/${victim}`)).toBe(false);
      expect(d("employee", "GET", `/v1/employees/${victim}/bank-account`)).toBe(false);
      expect(d("employee", "PATCH", `/v1/employees/${victim}/bio`)).toBe(false); // never another's bio
      for (const col of OWNED_COLLECTIONS) expect(d("employee", "GET", `/v1/${col}/${owned(victim)}`)).toBe(false);
    }
  });
});

// THE EMERGENCY CARD, which is the reason this block exists by name rather than as one more `personal-info`
// line above. Who to call, blood group, allergies and free-text medical notes are the only medical fields in
// the app, and they moved from a dialog behind a header button to a CARD ON THE DEFAULT TAB of a record page
// anybody can open. What stops it being a disclosure is the sub-resource gate, decided per employee - so it is
// pinned per role, on both halves, including the per-FIELD keys the editor writes one at a time.
describe("BOLA - emergency details are the owner's, whoever is looking", () => {
  const EMERGENCY_FIELDS = ["emergency_name", "emergency_phone", "emergency_relation", "blood_group", "allergies", "medical_notes"];

  it("the owner reads and writes their own, field by field", () => {
    expect(d("employee", "GET", `/v1/employees/${SELF}/personal-info`)).toBe(true);
    expect(d("employee", "PATCH", `/v1/employees/${SELF}/personal-info`)).toBe(true);
    for (const f of EMERGENCY_FIELDS) {
      expect(d("employee", "PATCH", `/v1/employees/${SELF}/personal-info/${f}`), f).toBe(true);
    }
  });

  it("nobody else does - not a teammate, not their manager, not HR, not payroll", () => {
    for (const role of ["employee", "manager", "hr_admin", "payroll_admin"] as const) {
      for (const victim of [PEER, OTHER]) {
        expect(d(role, "GET", `/v1/employees/${victim}/personal-info`), `${role} read ${victim}`).toBe(false);
        expect(d(role, "PATCH", `/v1/employees/${victim}/personal-info`), `${role} write ${victim}`).toBe(false);
        // And not one field of it either: the editor sends only what changed, so the per-field key is the one
        // a narrow write would actually travel on.
        for (const f of EMERGENCY_FIELDS) {
          expect(d(role, "PATCH", `/v1/employees/${victim}/personal-info/${f}`), `${role} write ${victim}.${f}`).toBe(false);
        }
      }
    }
  });
});

describe("BOLA - manager: own dept subtree, never cross-dept, never PII", () => {
  it("reads a dept peer's base record + dept leave, but not their PII", () => {
    expect(d("manager", "GET", `/v1/employees/${PEER}`)).toBe(true); // dept peer base record
    expect(d("manager", "GET", `/v1/employees/${PEER}/bank-account`)).toBe(false); // peer PII - never
    expect(d("manager", "GET", `/v1/leave-requests/${owned(PEER)}`)).toBe(true); // dept leave
    expect(d("manager", "POST", `/v1/leave-requests/${owned(PEER)}:approve`)).toBe(true); // dept approve (P3a fix)
  });
  it("cannot reach another department", () => {
    expect(d("manager", "GET", `/v1/employees/${OTHER}`)).toBe(false);
    expect(d("manager", "GET", `/v1/leave-requests/${owned(OTHER)}`)).toBe(false);
    expect(d("manager", "POST", `/v1/leave-requests/${owned(OTHER)}:approve`)).toBe(false); // cross-dept approve denied
  });
});

describe("BOLA - hr_admin / payroll_admin: base records broad, others' PII never", () => {
  it("read any base record but not anyone else's PII", () => {
    for (const role of ["hr_admin", "payroll_admin"] as const) {
      expect(d(role, "GET", `/v1/employees/${OTHER}`)).toBe(true); // base record
      for (const sub of ["bank-account", "identity", "personal-info"]) {
        expect(d(role, "GET", `/v1/employees/${OTHER}/${sub}`)).toBe(false); // PII is super-only
      }
    }
  });
  it("payroll cannot write employee records; hr can", () => {
    expect(d("payroll_admin", "PATCH", `/v1/employees/${OTHER}`)).toBe(false);
    expect(d("hr_admin", "PATCH", `/v1/employees/${OTHER}`)).toBe(true);
    expect(d("hr_admin", "PATCH", `/v1/employees/${OTHER}/bio`)).toBe(true); // HR may tidy any public about-me
  });
});

describe("BOLA - super_admin reaches every object (the only ** principal)", () => {
  it("reads/writes anyone's record and PII", () => {
    expect(d("super_admin", "GET", `/v1/employees/${OTHER}/bank-account`, null)).toBe(true);
    expect(d("super_admin", "PATCH", `/v1/employees/${OTHER}`, null)).toBe(true);
    for (const col of OWNED_COLLECTIONS) expect(d("super_admin", "GET", `/v1/${col}/${owned(OTHER)}`, null)).toBe(true);
  });
});

// THE WRITE HALF OF THE SAME PROPERTY, which is decided by a manifest rather than by the engine.
//
// A body field that names the new row's OWNER assigns who it belongs to, and middleware/authz.ts gates it by
// iterating the collection's `OWNER_REFS` entry - so a collection ABSENT from that map has its owner field
// accepted exactly as sent, whatever the caller's scope. The map's own comment states the rule ("if any of
// these is ever granted at a narrow (self/dept) scope via the ACL, create-on-behalf-of-another is blocked ...
// closing a BOLA-write gap"), and two collections whose services take their owner from the body were not in it:
//
//   - `approval-delegations.delegator` decides whose approval notifications are copied to the delegate
//     (services/notifications.ts), so an undeclared field meant naming somebody else as the delegator and
//     yourself as the delegate - an unconsented subscription to that person's approval queue.
//   - `background-checks.employee` is settable on create, so a check could be filed under another person's
//     record. (The patch half of that gap is closed by the subject being immutable: the row's code is allocated
//     under it, so a re-point is refused outright rather than gated.)
//
// Listed by name rather than derived: the point is that adding a collection whose owner comes off the body
// means adding it here too.
describe("BOLA - a body-supplied owner is declared, so the middleware can gate it", () => {
  const OWNER_BEARING: [collection: string, field: string][] = [
    ["leave-requests", "employee"],
    ["reimbursements", "employee"],
    ["tickets", "employee"],
    ["compensation", "employee"],
    ["bonuses", "employee"],
    ["settlements", "employee"],
    ["leave-encashments", "employee"],
    ["positions", "employee"],
    ["approval-delegations", "delegator"],
    ["background-checks", "employee"],
    // A day mark names the person whose day it re-values, in the create body - so the owner gate is what
    // stops a caller scoped to one department filing one against somebody outside it.
    ["attendance-day-marks", "employee"],
  ];
  it("names the owner field of every collection that accepts one", () => {
    for (const [collection, field] of OWNER_BEARING) {
      expect(OWNER_REFS[collection]?.[field], `${collection}.${field}`).toEqual({ collection: "employees" });
    }
  });
});
