import { describe, it, expect } from "vitest";
import { resolveRequest, decide } from "../src/domain/permissions";
import { rulesToGrant, deriveNarrowing, type CompiledRule } from "../src/domain/compileGrants";
import { validateAccessRule } from "../src/domain/policyValidate";
import { DEFAULT_POLICY } from "../src/domain/manifests";

// The "New X" buttons grant the CREATE gate: the 1-token `<collection>` write pattern, which gates the
// collection-level POST (and list) but NOT writes on individual objects - distinct from `<collection>.**`
// (write on every object). These prove the distinction against the real engine, and that the validator
// accepts scope:create while rejecting field/verb on it.
const SELF = { employeeCode: "04-002-001" };
const grantOf = (pattern: string, level: "read" | "write" | "admin"): ReturnType<typeof rulesToGrant> => {
  const n = deriveNarrowing(pattern);
  const rule: CompiledRule = { namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeKind === "exact" ? n.scopeCode : null, level, effect: "allow" };
  return rulesToGrant([rule]);
};
const allow = (g: ReturnType<typeof rulesToGrant>, method: string, path: string) => decide(g, resolveRequest(method, path), SELF).allow;

describe("create gate: 1-token collection write grants create, not write-all", () => {
  it("`tickets` write allows creating a ticket (collection-level POST)", () => {
    expect(allow(grantOf("tickets", "write"), "POST", "/v1/tickets")).toBe(true);
  });
  it("`tickets` write does NOT allow writing an existing ticket object", () => {
    expect(allow(grantOf("tickets", "write"), "PATCH", "/v1/tickets/04-002-002-7")).toBe(false);
  });
  it("`tickets.**` write (the OLD over-broad grant) DOES allow writing every object - the bug we're fixing", () => {
    expect(allow(grantOf("tickets.**", "write"), "PATCH", "/v1/tickets/04-002-002-7")).toBe(true);
  });
});

describe("validateAccessRule accepts scope:create and keeps it collection-level", () => {
  const base = { subject_kind: "role", subject: "manager", collection: "tickets", effect: "allow" };
  it("accepts a create-gate rule (scope:create, level:write)", () => {
    const r = validateAccessRule({ ...base, scope: "create", level: "write" }, DEFAULT_POLICY);
    expect(r.scope).toBe("create");
    expect(r.level).toBe("write");
  });
  it("rejects a field on a create rule", () => {
    expect(() => validateAccessRule({ ...base, scope: "create", level: "write", field: "subject" }, DEFAULT_POLICY)).toThrow();
  });
  it("rejects a verb on a create rule", () => {
    expect(() => validateAccessRule({ ...base, scope: "create", verb: "approve" }, DEFAULT_POLICY)).toThrow();
  });
});
