import { describe, it, expect } from "vitest";
import { decide, type Grant } from "../src/domain/permissions";

// A SELF-SCOPED GRANT MUST NEVER WIDEN WHEN THE CALLER'S SCOPE KEY IS MISSING.
//
// `me` and `my-dept` resolve to a code PREFIX and then ask domain/codes.ts#isUnder whether the row's code
// sits under it. `isUnder("")` used to answer true - "no prefix" read as "every prefix" - and the guard in
// front of it tested `employeeCode !== null`. `employees.code` is a nullable TEXT column with no CHECK, so
// `''` is not NULL: a caller whose code was blank passed the guard, asked `isUnder('', <any code>)`, and
// matched every row in the collection. `leave-requests.me.**` became `leave-requests.**`, for exactly the
// person whose record was least complete, with nothing logged and nothing to notice.
//
// Two more spellings of the same hole: a code beginning with `-` gives `my-dept` an empty dept prefix, and a
// pattern written `-*` asks for the empty prefix directly. All three are now denied - by isUnder refusing an
// empty prefix, and by the guards testing truthiness rather than null.
//
// Reachable through codeAlloc today? No. That is not what makes it worth pinning: this is the function where
// a value that went missing must not read as authority.

const OTHER = "05-2d-1b8"; // somebody else's record, in another department
const scoped: Grant = { levels: { "leave-requests.me.**": "write", "employees.my-dept.**": "read" }, allow: [] };
const read = (resource: string, self: { employeeCode: string | null }) =>
  decide(scoped, { kind: "standard", resource, level: "read" }, self).allow;

describe("self-scoped grants fail closed on a missing scope key", () => {
  it("still works for a caller who HAS a code (the control)", () => {
    const self = { employeeCode: "04-1c-0a9" };
    expect(read("leave-requests.04-1c-0a9-0kf", self), "own leave request").toBe(true);
    expect(read("employees.04-1c-0aa", self), "a colleague in the same dept").toBe(true);
    expect(read(`leave-requests.${OTHER}`, self), "someone else's leave request").toBe(false);
  });

  it("an empty employee code grants nothing, the way a null one does", () => {
    for (const employeeCode of ["", null]) {
      const self = { employeeCode };
      expect(read(`leave-requests.${OTHER}`, self), `me with code ${JSON.stringify(employeeCode)}`).toBe(false);
      expect(read("employees.04-1c-0a9", self), `my-dept with code ${JSON.stringify(employeeCode)}`).toBe(false);
    }
  });

  it("a code with a leading delimiter does not turn my-dept into every dept", () => {
    // segments("-0kf") is ["", "0kf"], so the dept prefix is the empty string.
    const self = { employeeCode: "-0kf" };
    expect(read("employees.04-1c-0a9", self)).toBe(false);
    expect(read(`employees.${OTHER}`, self)).toBe(false);
  });

  it("a `-*` pattern matches nothing rather than everything", () => {
    const grant: Grant = { levels: { "employees.-*.**": "admin" }, allow: [] };
    const self = { employeeCode: "04-1c-0a9" };
    expect(decide(grant, { kind: "standard", resource: `employees.${OTHER}`, level: "read" }, self).allow).toBe(false);
    expect(decide(grant, { kind: "standard", resource: "employees.04-1c-0a9", level: "read" }, self).allow).toBe(false);
  });

  it("the `me` literal path segment still resolves for a caller with no code", () => {
    // `/v1/employees/me` never carries a code - the token IS "me", matched literally, and the service
    // resolves it to the caller. That must keep working; only the code-prefix half is what tightened.
    expect(read("leave-requests.me", { employeeCode: "" })).toBe(true);
    expect(read("leave-requests.me", { employeeCode: null })).toBe(true);
  });
});
