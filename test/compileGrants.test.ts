import { describe, it, expect } from "vitest";
import { GRANTS, grantFor } from "../bootstrap/authz/grants";
import { resolveRequest, decide, type Decision } from "../src/domain/permissions";
import { compileGrant, rulesToGrant, deriveNarrowing } from "../src/domain/compileGrants";

// P0 BOLA oracle. The compiler flattens a Grant into access_rules rows; `rulesToGrant` rebuilds a Grant
// from those rows (the runtime reconstructor P1 feeds the narrowed rows to). The security-critical claim of
// P0 is that this projection is DECISION-LOSSLESS: deciding over compile->reconstruct yields the EXACT same
// verdict as deciding over the original blob, for every request and every caller. If the compiler ever
// widened a self/dept scope into something broader (a BOLA hole), a generated case below would diverge.
//
// The engine (`decide`) is the unchanged authority; this proves the new storage feeds it faithfully.

const ROLES = Object.keys(GRANTS);

// A broad request space: collections x id-position tokens x sub-resource tails, standard + custom methods.
const COLLECTIONS = [
  "employees", "leave-requests", "leave-balances", "payslips", "personal-documents", "org-documents",
  "operations", "holidays", "departments", "compensation", "payroll-runs", "users", "preferences",
  "settings", "holiday-selections", "announcements", "pay-periods", "pay-components", "leave-types",
];
// Includes a prefix-collision pair (04-002 vs 04-0029) so a sloppy prefix match would be caught.
const IDS = ["me", "04-001", "04-002", "04-002-001", "04-0029", "04-0029-001", "07-001", "07-002-003"];
const TAILS = ["", "/bank-account", "/identity", "/personal-info", "/department", "/manager"];
const VERBS = ["approve", "reject", "cancel", "download", "getPhoto", "uploadPhoto", "clearPhoto"];
const SELVES: (string | null)[] = [null, "04-001", "04-002", "04-002-001", "04-0029-001", "07-001"];

type Req = { method: string; path: string; force: boolean };
function* requests(): Generator<Req> {
  for (const col of COLLECTIONS) {
    yield { method: "GET", path: `/v1/${col}`, force: false }; // collection list
    yield { method: "POST", path: `/v1/${col}`, force: false }; // collection create
    for (const id of IDS) {
      for (const tail of TAILS) {
        const base = `/v1/${col}/${id}${tail}`;
        yield { method: "GET", path: base, force: false }; // read
        yield { method: "PATCH", path: base, force: false }; // write
        yield { method: "DELETE", path: base, force: false }; // write (soft delete)
        yield { method: "DELETE", path: base, force: true }; // admin (force purge)
      }
      for (const verb of VERBS) yield { method: "POST", path: `/v1/${col}/${id}:${verb}`, force: false };
    }
  }
}

const REQS = [...requests()];

function sameVerdict(a: Decision, b: Decision): boolean {
  return a.allow === b.allow;
}

describe("compileGrants - compile->reconstruct is decision-lossless (BOLA oracle)", () => {
  for (const role of ROLES) {
    it(`${role}: every request decides identically vs the blob`, () => {
      const blob = grantFor(role);
      const round = rulesToGrant(compileGrant(blob));
      for (const self of SELVES) {
        const ctx = { employeeCode: self };
        for (const r of REQS) {
          const resolved = resolveRequest(r.method, r.path, r.force);
          const want = decide(blob, resolved, ctx);
          const got = decide(round, resolved, ctx);
          expect(
            sameVerdict(want, got),
            `${role} self=${self} ${r.method} ${r.path}${r.force ? "?force" : ""}: blob=${want.allow} compiled=${got.allow}`,
          ).toBe(true);
        }
      }
    });
  }

  it("reconstruction is structurally identical to the original (lossless round-trip)", () => {
    for (const role of ROLES) {
      const blob = grantFor(role);
      const round = rulesToGrant(compileGrant(blob));
      expect(round.levels).toEqual(blob.levels);
      expect([...round.allow].sort()).toEqual([...blob.allow].sort());
      expect([...(round.deny ?? [])].sort()).toEqual([...(blob.deny ?? [])].sort());
    }
  });
});

describe("compileGrants - narrowing keys", () => {
  it("only super_admin compiles to a namespace='*' rule; every other role is collection-scoped", () => {
    for (const role of ROLES) {
      const wildcard = compileGrant(grantFor(role)).filter((r) => r.namespace === "*");
      if (role === "super_admin") expect(wildcard.length).toBeGreaterThan(0);
      else expect(wildcard, `${role} must not compile a cross-collection rule`).toEqual([]);
    }
  });

  it("every compiled rule's namespace is the pattern's first token (or '*' for '**')", () => {
    for (const role of ROLES) {
      for (const r of compileGrant(grantFor(role))) {
        const first = r.pattern.split(".")[0];
        expect(r.namespace).toBe(first === "**" ? "*" : first);
      }
    }
  });

  it("a rule's match_code is set iff it is an exact-scope (per-object) rule", () => {
    // The seed roles use only scope patterns (no literal codes), so every role rule is match_code NULL today -
    // the split broad/narrowed load is a NO-OP for current data.
    for (const role of ROLES) {
      for (const r of compileGrant(grantFor(role))) expect(r.matchCode).toBe(r.scopeKind === "exact" ? r.scopeCode : null);
    }
    // An exact pattern (added via a grant edit) carries its code as match_code so it rides the narrowed lane:
    const exactRule = compileGrant({ levels: { "leave-requests.04-002-001.**": "read" }, allow: [] })[0]!;
    expect(exactRule).toMatchObject({ scopeKind: "exact", scopeCode: "04-002-001", matchCode: "04-002-001" });
    // ...and reconstructs losslessly (match_code is reconstruction-blind; the decision rides the verbatim pattern).
    expect(rulesToGrant([exactRule]).levels).toEqual({ "leave-requests.04-002-001.**": "read" });
  });

  it("derives scope kinds from the id-position token", () => {
    expect(deriveNarrowing("**")).toEqual({ namespace: "*", scopeKind: "all", scopeCode: "" });
    expect(deriveNarrowing("employees")).toEqual({ namespace: "employees", scopeKind: "all", scopeCode: "" });
    expect(deriveNarrowing("employees.me")).toEqual({ namespace: "employees", scopeKind: "self", scopeCode: "" });
    expect(deriveNarrowing("employees.me.bank-account.**")).toEqual({ namespace: "employees", scopeKind: "self", scopeCode: "" });
    expect(deriveNarrowing("leave-requests.my-dept.**")).toEqual({ namespace: "leave-requests", scopeKind: "dept", scopeCode: "" });
    expect(deriveNarrowing("employees.*")).toEqual({ namespace: "employees", scopeKind: "all", scopeCode: "" });
    // A collection-scope custom-method rule (buildPattern emits `<col>.*.<verb>`): the `*` keeps it a broad
    // all-scope rule (matchCode NULL), NOT an exact rule keyed on the verb token.
    expect(deriveNarrowing("leave-requests.*.approve")).toEqual({ namespace: "leave-requests", scopeKind: "all", scopeCode: "" });
    expect(deriveNarrowing("documents.04-*")).toEqual({ namespace: "documents", scopeKind: "subtree", scopeCode: "04" });
    expect(deriveNarrowing("leave-requests.04-002-001")).toEqual({ namespace: "leave-requests", scopeKind: "exact", scopeCode: "04-002-001" });
  });
});

// Two rows can carry the SAME pattern at different levels. The write path refuses an identical
// (subject, pattern, effect) - but that is a check-then-insert with no unique index behind it, and
// bootstrap.sql seeds rows directly, so it is storable. The rows then arrive from an unordered `select`, and
// "whichever came last" is not an answer: it would hand the same role `write` on one replica and `read` on
// another. The max is the only order-independent reading, and it is the one `mergeGrants` already takes.
describe("rulesToGrant - a repeated pattern takes the highest level, whatever order the rows arrive in", () => {
  const rows = (levels: ("read" | "write" | "admin")[]) =>
    levels.map((level) => ({
      namespace: "leave-requests",
      pattern: "leave-requests.**",
      scopeKind: "all" as const,
      scopeCode: "",
      matchCode: null,
      level,
      effect: "allow" as const,
    }));

  it("keeps the higher level regardless of row order", () => {
    expect(rulesToGrant(rows(["read", "write"])).levels["leave-requests.**"]).toBe("write");
    expect(rulesToGrant(rows(["write", "read"])).levels["leave-requests.**"]).toBe("write");
    expect(rulesToGrant(rows(["admin", "read", "write"])).levels["leave-requests.**"]).toBe("admin");
    expect(rulesToGrant(rows(["read", "admin", "write"])).levels["leave-requests.**"]).toBe("admin");
  });

  it("leaves the ordinary single-row case exactly as it was", () => {
    expect(rulesToGrant(rows(["read"])).levels).toEqual({ "leave-requests.**": "read" });
  });

  it("still decides with the higher level, not just stores it", () => {
    const grant = rulesToGrant(rows(["read", "write"]));
    const write = decide(grant, resolveRequest("POST", "/v1/leave-requests/04-002-001"), { employeeCode: "04-002-001" });
    expect(write.allow).toBe(true);
  });
});

// A collection addressed by NAME (`/v1/settings/attendance`) has no object code, so the token after it is a name
// and a rule naming one must be BROAD. Compiled as a literal code it became an exact per-object row the runtime
// never loads (nothing resolves a settings key to a code), which silently voided every per-key settings grant:
// HR's `settings.attendance` write 403'd on the live server while an in-memory `decide` over the same Grant said
// yes. This pins the whole path the server takes - compile, keep only the broad rows the role loader reads,
// reconstruct, decide.
describe("compileGrants - name-keyed collections compile broad", () => {
  const liveGrant = (levels: Record<string, "read" | "write">) =>
    rulesToGrant(compileGrant({ levels, allow: [] }).filter((r) => r.matchCode === null));

  it("a per-key settings rule reaches that key through the broad lane, and no other key", () => {
    const g = liveGrant({ "settings.**": "read", "settings.attendance": "write" });
    const self = { employeeCode: "04-002-001" };
    expect(decide(g, resolveRequest("PATCH", "/v1/settings/attendance"), self).allow).toBe(true);
    expect(decide(g, resolveRequest("PATCH", "/v1/settings/ai"), self).allow).toBe(false);
    expect(decide(g, resolveRequest("GET", "/v1/settings/ai"), self).allow).toBe(true);
  });

  it("every name-keyed collection narrows to all, whatever its second token", () => {
    for (const p of ["settings.attendance", "roles.manager", "bank-formats.IDFC FIRST Bank", "payroll-debit-accounts.HDFC"]) {
      expect(deriveNarrowing(p).scopeKind, p).toBe("all");
    }
    expect(deriveNarrowing("employees.04-1c-0a9").scopeKind).toBe("exact"); // a code-bearing collection is unchanged
  });

  it("every seeded per-key settings rule is on the broad lane", () => {
    for (const [role, g] of Object.entries(GRANTS)) {
      for (const r of compileGrant(g)) if (r.namespace === "settings") expect(r.matchCode, `${role} ${r.pattern}`).toBeNull();
    }
  });
});
