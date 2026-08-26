import { describe, it, expect } from "vitest";
import { grantFor } from "../src/domain/grants";
import { resolveRequest, decide } from "../src/domain/permissions";

// A leave request can carry a supporting document (sick note, travel paperwork) through the generic attachment
// slot, reached as `:upload` / `:download` on the request itself. Who may do that is policy, and policy is what
// silently rots: the verbs exist on the route either way, so without this the feature would degrade to
// super-only (a 403 the UI can only render as a dead button). grantFor reads the typed GRANTS seed;
// seedDrift.test.ts pins the DB seed to the same source.
const EMP_CODE = "04-002-001"; // the caller's own employee code (self scope)
const OWN = `/v1/leave-requests/${EMP_CODE}-0001:upload`;
const OWN_DL = `/v1/leave-requests/${EMP_CODE}-0001:download`;
const OTHER_DEPT = "/v1/leave-requests/09-100-001-0001:download";
const SAME_DEPT = "/v1/leave-requests/04-002-002-0001:download";

const can = (role: string, path: string, method = "POST") =>
  decide(grantFor(role), resolveRequest(method, path), { employeeCode: EMP_CODE }).allow;

describe("leave request document authz", () => {
  it("resolves to a custom verb on the request, not a sub-collection read", () => {
    expect(resolveRequest("POST", OWN)).toEqual({ kind: "custom", resource: `leave-requests.${EMP_CODE}-0001`, verb: "upload" });
  });

  it("an employee may attach and read back a document on their OWN request", () => {
    expect(can("employee", OWN)).toBe(true);
    expect(can("employee", OWN_DL)).toBe(true);
  });

  it("an employee may not read someone else's document", () => {
    expect(can("employee", SAME_DEPT)).toBe(false);
    expect(can("employee", OTHER_DEPT)).toBe(false);
  });

  it("a manager may read their own department's documents, but not another department's", () => {
    expect(can("manager", SAME_DEPT)).toBe(true);
    expect(can("manager", OTHER_DEPT)).toBe(false);
  });

  it("HR may read any request's document", () => {
    expect(can("hr_admin", OTHER_DEPT)).toBe(true);
  });
});
