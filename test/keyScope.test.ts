import { describe, it, expect } from "vitest";
import { GRANTS } from "../src/domain/grants";
import { resolveRequest, decide, type Grant } from "../src/domain/permissions";
import { narrowGrant, inScope, parseScope, scopeToWire, FULL_SCOPE, type KeyScope } from "../src/domain/keyScope";

// The API-key ceiling. The security claim under test (see docs/authz.md section 5.1) is that a key is NEVER
// stronger than its owner. The property test at the bottom is that claim stated executably; the unit tests
// above it pin the individual narrowing rules so a regression names itself.

const SUPER: Grant = { levels: { "**": "admin" }, allow: ["**"] };
const self = { employeeCode: "04-001" };

describe("narrowGrant - levels", () => {
  it("collapses a cross-collection `**` into one entry per allowed collection", () => {
    const g = narrowGrant(SUPER, { collections: ["employees", "leave-requests"], maxLevel: "read", verbs: "*" });
    expect(g.levels).toEqual({ "employees.**": "read", "leave-requests.**": "read" });
  });

  it("clamps every level down to the ceiling", () => {
    const g = narrowGrant({ levels: { "employees.**": "admin", "holidays.**": "read" }, allow: [] }, { collections: "*", maxLevel: "write", verbs: "*" });
    expect(g.levels).toEqual({ "employees.**": "write", "holidays.**": "read" });
  });

  it("never RAISES a level", () => {
    const g = narrowGrant({ levels: { "holidays.**": "read" }, allow: [] }, { collections: "*", maxLevel: "admin", verbs: "*" });
    expect(g.levels["holidays.**"]).toBe("read");
  });

  it("drops patterns whose collection is outside the scope", () => {
    const g = narrowGrant({ levels: { "employees.**": "read", "payslips.**": "read" }, allow: [] }, { collections: ["employees"], maxLevel: "read", verbs: "*" });
    expect(g.levels).toEqual({ "employees.**": "read" });
  });

  it("keeps the higher level when two patterns collapse onto one", () => {
    const g = narrowGrant({ levels: { "**": "read", "employees.**": "admin" }, allow: [] }, { collections: ["employees"], maxLevel: "admin", verbs: "*" });
    expect(g.levels["employees.**"]).toBe("admin");
  });

  it("an empty collection list grants nothing (a lock, not a wildcard)", () => {
    const g = narrowGrant(SUPER, { collections: [], maxLevel: "admin", verbs: "*" });
    expect(g.levels).toEqual({});
    expect(g.allow).toEqual([]);
  });

  it("substitutes a single-token `*` collection slot exactly", () => {
    const g = narrowGrant({ levels: { "*.me": "read" }, allow: [] }, { collections: ["payslips"], maxLevel: "read", verbs: "*" });
    expect(g.levels).toEqual({ "payslips.me": "read" });
  });
});

describe("narrowGrant - custom methods", () => {
  it("filters verbs by the allowlist", () => {
    const g = narrowGrant({ levels: {}, allow: ["leave-requests.**.approve", "leave-requests.**.reject"] }, { collections: "*", maxLevel: "admin", verbs: ["approve"] });
    expect(g.allow).toEqual(["leave-requests.**.approve"]);
  });

  it("expands a verb wildcard into one pattern per allowed verb", () => {
    const g = narrowGrant({ levels: {}, allow: ["leave-requests.**"] }, { collections: "*", maxLevel: "admin", verbs: ["approve", "cancel"] });
    expect(g.allow.sort()).toEqual(["leave-requests.**.approve", "leave-requests.**.cancel"]);
  });

  it("an expanded verb pattern still matches both item and collection level verbs", () => {
    const g = narrowGrant(SUPER, { collections: ["leave-requests"], maxLevel: "admin", verbs: ["approve"] });
    expect(decide(g, resolveRequest("POST", "/v1/leave-requests/04-001-002:approve"), self).allow).toBe(true);
    expect(decide(g, resolveRequest("POST", "/v1/leave-requests:approve"), self).allow).toBe(true);
    expect(decide(g, resolveRequest("POST", "/v1/leave-requests/04-001-002:reject"), self).allow).toBe(false);
  });

  it("an empty verb list allows no custom method", () => {
    const g = narrowGrant(SUPER, { collections: ["leave-requests"], maxLevel: "admin", verbs: [] });
    expect(g.allow).toEqual([]);
    expect(decide(g, resolveRequest("POST", "/v1/leave-requests/04-001-002:approve"), self).allow).toBe(false);
  });
});

describe("narrowGrant - deny", () => {
  it("carries every deny through, including out-of-scope collections", () => {
    const g = narrowGrant({ levels: { "employees.**": "admin" }, allow: [], deny: ["employees.**.bank-account.read", "payslips.**.read"] }, { collections: ["employees"], maxLevel: "admin", verbs: "*" });
    expect(g.deny).toEqual(["employees.**.bank-account.read", "payslips.**.read"]);
  });

  it("a denied path stays denied under a narrowed key", () => {
    const owner: Grant = { levels: { "employees.**": "admin" }, allow: [], deny: ["employees.**.bank-account.read"] };
    const g = narrowGrant(owner, { collections: ["employees"], maxLevel: "read", verbs: "*" });
    expect(decide(g, resolveRequest("GET", "/v1/employees/04-001/bank-account"), self).allow).toBe(false);
  });
});

describe("inScope", () => {
  // `write`, not `read`: the verb axis sits under the level ceiling (a custom method runs a service, so it is
  // a write), and this block is about the COLLECTION and VERB axes. Pinned at read it would have been testing
  // the ceiling instead, and the verb assertions below could never be reached.
  const scope: KeyScope = { collections: ["employees"], maxLevel: "write", verbs: ["getPhoto"] };

  it("rejects an out-of-scope collection", () => {
    expect(inScope(resolveRequest("GET", "/v1/payslips"), scope)).toBe(false);
    expect(inScope(resolveRequest("GET", "/v1/employees"), scope)).toBe(true);
  });

  it("rejects a level above the ceiling", () => {
    expect(inScope(resolveRequest("PATCH", "/v1/employees/04-001"), scope)).toBe(true); // write, at the ceiling
    expect(inScope(resolveRequest("DELETE", "/v1/employees/04-001", true), scope)).toBe(false); // ?force = admin
    const readOnly: KeyScope = { ...scope, maxLevel: "read" };
    expect(inScope(resolveRequest("PATCH", "/v1/employees/04-001"), readOnly)).toBe(false);
  });

  it("rejects an unlisted verb", () => {
    expect(inScope(resolveRequest("POST", "/v1/employees/04-001:getPhoto"), scope)).toBe(true);
    expect(inScope(resolveRequest("POST", "/v1/employees/04-001:uploadPhoto"), scope)).toBe(false);
  });

  it("the full scope admits everything", () => {
    expect(inScope(resolveRequest("DELETE", "/v1/payslips/04-001", true), FULL_SCOPE)).toBe(true);
  });
});

describe("parseScope / scopeToWire", () => {
  const known = new Set(["employees", "holidays"]);

  it("accepts a well-formed scope and dedupes", () => {
    expect(parseScope({ collections: ["employees", "employees"], max_level: "write", verbs: "*" }, known)).toEqual({ collections: ["employees"], maxLevel: "write", verbs: "*" });
    // At `read` the verb axis is emptied as it is parsed - see "the level ceiling covers custom methods".
    expect(parseScope({ collections: ["employees", "employees"], max_level: "read", verbs: "*" }, known)).toEqual({ collections: ["employees"], maxLevel: "read", verbs: [] });
  });

  it("rejects an unknown collection", () => {
    expect(parseScope({ collections: ["nope"], max_level: "read", verbs: "*" }, known)).toBeNull();
  });

  it("rejects a bad level, bad shape, and non-string axis entries", () => {
    expect(parseScope({ collections: "*", max_level: "root", verbs: "*" })).toBeNull();
    expect(parseScope(null)).toBeNull();
    expect(parseScope("*")).toBeNull();
    expect(parseScope({ collections: [1], max_level: "read", verbs: "*" })).toBeNull();
    expect(parseScope({ collections: "all", max_level: "read", verbs: "*" })).toBeNull();
    // camelCase is the INTERNAL shape only: the stored/wire form is snake_case, and accepting both would
    // mean a typo'd `maxLevel` silently produced some other scope instead of being rejected.
    expect(parseScope({ collections: "*", maxLevel: "read", verbs: "*" })).toBeNull();
  });

  it("round-trips through the wire shape", () => {
    const scope: KeyScope = { collections: ["employees"], maxLevel: "write", verbs: ["approve"] };
    expect(parseScope(scopeToWire(scope))).toEqual(scope);
  });
});

// ---- Invariant 1, stated executably ----------------------------------------------------------------------
//
// For every seeded role grant, every scope, and a broad spread of requests: if the NARROWED grant allows a
// request, the ORIGINAL grant must allow it too. A narrowing that ever widened - a botched `**` expansion, a
// dropped deny, a level clamp applied in the wrong direction - fails here.

const COLLECTIONS = ["employees", "leave-requests", "payslips", "holidays", "compensation", "payroll-runs", "personal-documents"];
const IDS = ["", "/me", "/04-001", "/04-002", "/04-002-001", "/07-001"];
const TAILS = ["", "/bank-account", "/identity"];
const VERBS = ["approve", "reject", "cancel", "getPhoto", "download"];
const METHODS: [string, boolean][] = [["GET", false], ["POST", false], ["PATCH", false], ["DELETE", false], ["DELETE", true]];

const SCOPES: KeyScope[] = [
  FULL_SCOPE,
  { collections: "*", maxLevel: "read", verbs: "*" },
  { collections: "*", maxLevel: "write", verbs: [] },
  { collections: ["employees"], maxLevel: "read", verbs: "*" },
  { collections: ["employees", "leave-requests"], maxLevel: "write", verbs: ["approve"] },
  { collections: ["payslips"], maxLevel: "admin", verbs: ["download"] },
  { collections: [], maxLevel: "admin", verbs: "*" },
];

describe("invariant: a key is never stronger than its owner", () => {
  const selves = [{ employeeCode: "04-001" }, { employeeCode: "04-002-001" }, { employeeCode: null }];

  for (const [role, owner] of Object.entries({ ...GRANTS, super: SUPER })) {
    for (const [i, scope] of SCOPES.entries()) {
      it(`${role} narrowed by scope #${i} allows nothing the owner does not`, () => {
        const narrowed = narrowGrant(owner, scope);
        const widened: string[] = [];
        for (const col of COLLECTIONS) {
          for (const id of IDS) {
            for (const tail of TAILS) {
              const path = `/v1/${col}${id}${tail}`;
              for (const [method, force] of METHODS) {
                const r = resolveRequest(method, path, force);
                for (const s of selves) {
                  if (decide(narrowed, r, s).allow && !decide(owner, r, s).allow) widened.push(`${method} ${path}`);
                }
              }
              for (const verb of VERBS) {
                const r = resolveRequest("POST", `${path}:${verb}`);
                for (const s of selves) {
                  if (decide(narrowed, r, s).allow && !decide(owner, r, s).allow) widened.push(`POST ${path}:${verb}`);
                }
              }
            }
          }
        }
        expect(widened).toEqual([]);
      });
    }
  }
});

// The mirror check: the ceiling must actually BITE, or the invariant above would pass vacuously on a
// narrowing that did nothing at all.
describe("the ceiling actually restricts", () => {
  it("a read-only super key cannot write", () => {
    const g = narrowGrant(SUPER, { collections: "*", maxLevel: "read", verbs: "*" });
    expect(decide(g, resolveRequest("GET", "/v1/employees/04-001"), self).allow).toBe(true);
    expect(decide(g, resolveRequest("PATCH", "/v1/employees/04-001"), self).allow).toBe(false);
    expect(decide(g, resolveRequest("DELETE", "/v1/employees/04-001", true), self).allow).toBe(false);
  });

  it("a collection-scoped super key cannot reach another collection", () => {
    const g = narrowGrant(SUPER, { collections: ["holidays"], maxLevel: "admin", verbs: "*" });
    expect(decide(g, resolveRequest("GET", "/v1/holidays"), self).allow).toBe(true);
    expect(decide(g, resolveRequest("GET", "/v1/payslips"), self).allow).toBe(false);
  });
});

// The VERB AXIS is under the level ceiling too. A custom method runs a service, so it is a write whatever the
// verb is called - the same stance lib/viewAs.ts takes for a read-only simulation, which refuses every `:verb`
// including `:pdf` and `:download`. Before this, `max_level: "read"` bounded only the standard methods, so a
// key every surface described as "read only" could approve a leave request and publish a payroll run.
describe("the level ceiling covers custom methods", () => {
  it("empties the verb axis of a read scope as it is parsed", () => {
    expect(parseScope({ collections: "*", max_level: "read", verbs: "*" })).toEqual({ collections: "*", maxLevel: "read", verbs: [] });
    expect(parseScope({ collections: "*", max_level: "read", verbs: ["approve"] })!.verbs).toEqual([]);
    // Untouched above the ceiling.
    expect(parseScope({ collections: "*", max_level: "write", verbs: ["approve"] })!.verbs).toEqual(["approve"]);
    expect(parseScope({ collections: "*", max_level: "admin", verbs: "*" })!.verbs).toEqual("*");
  });

  // NORMALISED, never refused: this function parses STORED scopes on the authentication path, so returning
  // null would kill a key minted before the rule existed rather than narrowing it.
  it("still parses a legacy read+verbs scope rather than rejecting it", () => {
    expect(parseScope({ collections: ["payslips"], max_level: "read", verbs: "*" })).not.toBeNull();
  });

  it("refuses a custom method under a read ceiling, even from a scope stored before the rule", () => {
    const legacy: KeyScope = { collections: "*", maxLevel: "read", verbs: "*" };
    expect(inScope(resolveRequest("POST", "/v1/payroll-runs/04-1:publish"), legacy)).toBe(false);
    expect(inScope(resolveRequest("POST", "/v1/leave-requests/04-001-1:approve"), legacy)).toBe(false);
    // The reads it was actually labelled with still work.
    expect(inScope(resolveRequest("GET", "/v1/payroll-runs/04-1"), legacy)).toBe(true);
    // And a key minted to act still acts.
    expect(inScope(resolveRequest("POST", "/v1/payroll-runs/04-1:publish"), FULL_SCOPE)).toBe(true);
  });

  it("drops the allow patterns from a read-ceilinged grant, so the hints agree with the gate", () => {
    expect(narrowGrant(SUPER, { collections: "*", maxLevel: "read", verbs: "*" }).allow).toEqual([]);
    expect(decide(narrowGrant(SUPER, { collections: "*", maxLevel: "read", verbs: "*" }), resolveRequest("POST", "/v1/payroll-runs/04-1:publish"), self).allow).toBe(false);
    expect(narrowGrant(SUPER, FULL_SCOPE).allow.length).toBeGreaterThan(0);
  });
});
