import { describe, it, expect } from "vitest";
import { resolveRequest, decide } from "../src/domain/permissions";
import { compileGrant, rulesToGrant, deriveNarrowing, type CompiledRule } from "../src/domain/compileGrants";
import { buildPattern } from "../src/services/accessRules";
import type { Deps } from "../src/deps";

// A custom method is either COLLECTION-level (`POST /v1/announcements:markAllRead` -> the 2-token key
// `announcements.markAllRead`) or ITEM-level (`.../<code>:approve` -> 3 tokens). Both forms have to be
// grantable AND revocable, or the ACL says one thing and the engine does another:
//   - grant: an all-scope verb rule must reach the collection-level key (it used to compile to
//     `<col>.*.<verb>`, which can only ever match the item form, so the rule was inert),
//   - revoke: a 2-token verb DENY must ride the broad lane (it used to keep match_code=<verb>, which
//     policyLoad only ever loads by object-ancestor code - so the deny never loaded and FAILED OPEN).

const SELF = { employeeCode: "04-002-001" };
const allows = (g: ReturnType<typeof rulesToGrant>, method: string, path: string) => decide(g, resolveRequest(method, path), SELF).allow;
const rule = (pattern: string, effect: "allow" | "deny"): CompiledRule => {
  const n = deriveNarrowing(pattern);
  return { namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeKind === "exact" ? n.scopeCode : null, level: null, effect };
};

describe("collection-level custom methods: the all-scope verb pattern", () => {
  const all = rulesToGrant([rule("announcements.**.markAllRead", "allow")]);

  it("reaches BOTH the collection-level and the item-level key", () => {
    expect(allows(all, "POST", "/v1/announcements:markAllRead")).toBe(true);
    expect(allows(all, "POST", "/v1/announcements/04-002-001-9:markAllRead")).toBe(true);
  });

  it("does not leak to another verb or another collection", () => {
    expect(allows(all, "POST", "/v1/announcements:post")).toBe(false);
    expect(allows(all, "POST", "/v1/notifications:markAllRead")).toBe(false);
  });

  it("does not leak into the standard lane (custom allows are consulted for custom keys only)", () => {
    expect(allows(all, "GET", "/v1/announcements")).toBe(false);
    expect(allows(all, "PATCH", "/v1/announcements/04-002-001-9")).toBe(false);
  });

  it("the old `<col>.*.<verb>` form could NOT reach the collection-level key (the bug)", () => {
    const old = rulesToGrant([rule("announcements.*.markAllRead", "allow")]);
    expect(allows(old, "POST", "/v1/announcements/04-002-001-9:markAllRead")).toBe(true);
    expect(allows(old, "POST", "/v1/announcements:markAllRead")).toBe(false);
  });

  it("stays a broad (match_code NULL) rule, so loadRoleGrant loads it", () => {
    expect(deriveNarrowing("announcements.**.markAllRead")).toEqual({ namespace: "announcements", scopeKind: "all", scopeCode: "" });
  });
});

describe("buildPattern: the ACL input -> pattern mapping for verbs", () => {
  const base = { subjectKind: "role", subject: "employee", collection: "announcements", effect: "allow" } as const;
  const deps = {} as Deps; // the all/self/dept scopes never touch the DB (only exact/subtree resolve a ref)

  it("scope=all + verb -> `<col>.**.<verb>` (collection-level AND item-level)", async () => {
    expect(await buildPattern(deps, { ...base, scope: "all", verb: "markAllRead" })).toBe("announcements.**.markAllRead");
  });

  it("scope=self/dept + verb keep their id token (those scopes ARE per-object)", async () => {
    expect(await buildPattern(deps, { ...base, scope: "self", verb: "cancel" })).toBe("announcements.me.cancel");
    expect(await buildPattern(deps, { ...base, scope: "dept", verb: "cancel" })).toBe("announcements.my-dept.cancel");
  });

  it("a field rule still uses the single-token `*` id (a field is always per-object)", async () => {
    expect(await buildPattern(deps, { ...base, collection: "employees", scope: "all", field: "manager", level: "read" })).toBe("employees.*.manager.**");
  });
});

describe("a 2-token verb DENY revokes the capability (it must not fail open)", () => {
  it("compiles to a broad rule (match_code NULL), like the matching allow", () => {
    const [denyRule] = compileGrant({ levels: {}, allow: [], deny: ["announcements.markAllRead"] });
    expect(denyRule).toMatchObject({ scopeKind: "all", scopeCode: "", matchCode: null, effect: "deny" });
  });

  it("actually blocks the collection-level call once loaded alongside the allow", () => {
    const g = rulesToGrant(compileGrant({ levels: {}, allow: ["announcements.markAllRead"], deny: ["announcements.markAllRead"] }));
    expect(allows(g, "POST", "/v1/announcements:markAllRead")).toBe(false);
  });

  it("a per-object rule is unaffected: 3-token `<col>.<code>.**` keeps its exact match_code", () => {
    const [objRule] = compileGrant({ levels: {}, allow: [], deny: ["announcements.04-002-001-9.**"] });
    expect(objRule).toMatchObject({ scopeKind: "exact", scopeCode: "04-002-001-9", matchCode: "04-002-001-9", effect: "deny" });
  });
});

// The wildcard-verb rule (access rule verb:"*") is how a role is granted "every custom method of this
// collection" in one line - it is what hr_admin holds on assets in the seed. A collection-level verb has to be
// inside it, or adding one (`assets:batchCreate`) silently 403s the role that was granted everything.
describe("the wildcard-verb rule covers a collection-level custom method", () => {
  const all = rulesToGrant([rule("assets.**", "allow")]);

  it("allows both key shapes of a custom method, and stays out of the standard lane", () => {
    expect(allows(all, "POST", "/v1/assets:batchCreate")).toBe(true);
    expect(allows(all, "POST", "/v1/assets/04-002-001-9:verify")).toBe(true);
    expect(allows(all, "GET", "/v1/assets")).toBe(false); // reading is a level grant, a separate rule
    expect(allows(all, "POST", "/v1/stocktakes:batchCreate")).toBe(false); // and it is one collection's
  });

  it("a verb deny still revokes one method out of it", () => {
    const denied = rulesToGrant([rule("assets.**", "allow"), rule("assets.**.batchCreate", "deny")]);
    expect(allows(denied, "POST", "/v1/assets:batchCreate")).toBe(false);
    expect(allows(denied, "POST", "/v1/assets/04-002-001-9:verify")).toBe(true);
  });
});
