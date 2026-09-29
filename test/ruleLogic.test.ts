import { describe, it, expect } from "vitest";
import { ruleSentence, ruleFlags, denyBlocking, expiryLabel } from "../web/src/components/access/ruleLogic";
import type { AccessRule } from "../web/src/components/access/permMatrix";
import { registerRoleLabels } from "../web/src/lib/roles";

// Role labels are data the SPA learns from the server (users/me, the roles collection); stand in that load.
registerRoleLabels([{ name: "hr_admin", label: "HR Admin" }]);

// The reading side of the access UI: rules rendered as sentences, and the lint that says which rules the
// engine will never actually use. Both are pure, and both are claims ABOUT the engine's semantics (deny
// wins; a broader allow subsumes a narrower one), so they are worth pinning.
const rule = (o: Partial<AccessRule>): AccessRule => ({
  path: `access-rules/${Math.random().toString(36).slice(2)}`,
  subject_kind: "role",
  subject: "hr_admin",
  collection: "leave-requests",
  scope: "all",
  effect: "allow",
  level: "read",
  status: "active",
  ...o,
});

describe("ruleSentence", () => {
  it("reads as one plain sentence per rule shape", () => {
    expect(ruleSentence(rule({ scope: "dept", level: "write" }))).toBe("HR Admin has write access to their department's leave requests");
    expect(ruleSentence(rule({ scope: "self" }))).toContain("their own leave requests");
    expect(ruleSentence(rule({ scope: "create", level: "write" }))).toBe("HR Admin can create leave requests");
    expect(ruleSentence(rule({ verb: "approve", level: undefined }))).toContain("can use");
    expect(ruleSentence(rule({ effect: "deny", level: undefined }))).toContain("is denied all access");
    expect(ruleSentence(rule({ level: "admin" }))).toContain("full access (delete + purge)");
  });

  it("names the subject the caller passes (the modal's commit line uses an email)", () => {
    expect(ruleSentence(rule({ subject_kind: "user", subject: "users/x" }), "ana@test.example")).toMatch(/^ana@test\.example has read access/);
  });

  // `access-rules:requestAccess` reaches no access rule - it notifies the admins - so "on every access rule in
  // the workspace" described a power the rule does not grant. An item-level method still names its records.
  it("names no records for a method that acts on the collection as a whole", () => {
    const ask = rule({ subject: "everyone", collection: "access-rules", verb: "requestAccess", level: undefined });
    expect(ruleSentence(ask, "Everyone")).toBe('Everyone can use the "Request access" method');
    expect(ruleSentence(rule({ verb: "approve", level: undefined }))).toMatch(/ on all leave requests$/);
  });
});

describe("ruleFlags - a collection-level method only takes an org-wide rule", () => {
  // Decided on the two-token key `leave-requests.importHistory`, which `leave-requests.my-dept.importHistory`
  // can never match: the rule is listed as live and never applies.
  it("flags a narrower rule for one as never used, and leaves the org-wide rule alone", () => {
    const dept = rule({ collection: "leave-requests", verb: "importHistory", scope: "dept", level: undefined });
    const all = rule({ collection: "leave-requests", verb: "importHistory", scope: "all", level: undefined });
    expect(ruleFlags(dept, [dept]).map((f) => f.kind)).toContain("unscoped");
    expect(ruleFlags(all, [all]).map((f) => f.kind)).not.toContain("unscoped");
    // An item-level method at a narrower scope is an ordinary rule.
    const approve = rule({ verb: "approve", scope: "dept", level: undefined });
    expect(ruleFlags(approve, [approve]).map((f) => f.kind)).not.toContain("unscoped");
  });
});

describe("ruleFlags (dead-rule lint)", () => {
  it("flags an allow that a deny on the same target overrides", () => {
    const allow = rule({});
    const deny = rule({ effect: "deny", level: undefined });
    expect(ruleFlags(allow, [allow, deny]).map((f) => f.kind)).toContain("denied");
  });

  it("counts an `everyone` deny against a role's allow (the engine unions everyone into every role)", () => {
    const allow = rule({ subject: "hr_admin" });
    const deny = rule({ subject: "everyone", effect: "deny", level: undefined });
    expect(ruleFlags(allow, [allow, deny]).map((f) => f.kind)).toContain("denied");
  });

  it("flags a rule already covered by a broader allow of the same subject", () => {
    const narrow = rule({ scope: "dept", level: "read" });
    const broad = rule({ scope: "all", level: "write" });
    expect(ruleFlags(narrow, [narrow, broad]).map((f) => f.kind)).toContain("shadowed");
  });

  it("does not call a narrower rule dead when the broader one grants LESS", () => {
    const narrow = rule({ scope: "dept", level: "admin" });
    const broad = rule({ scope: "all", level: "read" });
    expect(ruleFlags(narrow, [narrow, broad]).map((f) => f.kind)).not.toContain("shadowed");
  });

  it("keeps different targets apart: a deny on one method says nothing about another", () => {
    const allow = rule({ verb: "approve", level: undefined });
    const deny = rule({ verb: "reject", level: undefined, effect: "deny" });
    expect(ruleFlags(allow, [allow, deny]).map((f) => f.kind)).not.toContain("denied");
  });

  it("surfaces lifecycle state (pending approval, expiry) as its own flag", () => {
    expect(ruleFlags(rule({ status: "pending" }), []).map((f) => f.kind)).toContain("pending");
    expect(ruleFlags(rule({ expire_time: new Date(Date.now() + 3 * 86400000).toISOString() }), []).map((f) => f.kind)).toContain("expiring");
  });
});

describe("denyBlocking (author-time warning)", () => {
  it("finds the deny that would make the rule about to be written inert", () => {
    const deny = rule({ subject: "everyone", effect: "deny", level: undefined });
    expect(denyBlocking({ subject_kind: "role", subject: "hr_admin", collection: "leave-requests", scope: "dept" }, [deny])).toBe(deny);
    expect(denyBlocking({ subject_kind: "role", subject: "hr_admin", collection: "holidays", scope: "dept" }, [deny])).toBeUndefined();
  });
});

describe("expiryLabel", () => {
  it("distinguishes a live temporary grant from a lapsed one", () => {
    expect(expiryLabel(undefined)).toBeNull();
    expect(expiryLabel(new Date(Date.now() - 1000).toISOString())).toBe("expired");
    expect(expiryLabel(new Date(Date.now() + 3 * 86400000).toISOString())).toMatch(/^expires in/);
  });
});

// The half-working rule. A row-scoped grant decides every individual record correctly and CANNOT open the
// list: the engine decides `GET /v1/leave-requests` on the one-token key `leave-requests.read`, and
// `leave-requests.me.**` needs a second token that key does not have. So the page 403s while every rule on
// screen says the access is configured - and the client cannot warn either, because `capabilitiesOf` strips
// the scope off a grant, so the SPA believes the collection is readable and fires the request that fails.
//
// The seeded roles never hit it (each holds the bare collection grant alongside its scoped rules). Rules
// authored in the ACL had no such pairing, which is why the narrow tiers looked broken rather than narrow.
describe("ruleFlags - unlistable", () => {
  const unlistable = (flags: ReturnType<typeof ruleFlags>) => flags.find((f) => f.kind === "unlistable");

  it("flags a row-scoped rule with nothing that opens the collection", () => {
    const r = rule({ scope: "self" });
    expect(unlistable(ruleFlags(r, [r]))?.note).toMatch(/open the list/);
    // The manager chain is in this list too, and was the one row-scoped shape the lint did not know about:
    // `<collection>.my-reports.**` is a two-token pattern like every other one here, so it decides each
    // report's record and leaves the page they are on refusing the caller.
    for (const scope of ["dept", "subtree", "exact", "reports", "org"]) {
      const s = rule({ scope, scope_ref: "departments/abc" });
      expect(unlistable(ruleFlags(s, [s])), `scope ${scope}`).toBeTruthy();
    }
  });

  it("is silent once something reaches the collection", () => {
    // The two shapes that match the one-token list key: the create gate (the bare rule) and org-wide
    // (`<collection>.**`, whose `**` matches zero trailing tokens).
    const scoped = rule({ scope: "self" });
    for (const gate of [rule({ scope: "create", level: "read" }), rule({ scope: "all" })]) {
      expect(unlistable(ruleFlags(scoped, [scoped, gate]))).toBeFalsy();
    }
  });

  it("counts what the subject INHERITS - `everyone`, and a person's role", () => {
    const scoped = rule({ scope: "self" });
    const everyone = rule({ subject: "everyone", scope: "create", level: "read" });
    expect(unlistable(ruleFlags(scoped, [scoped, everyone]))).toBeFalsy();

    const person = rule({ subject_kind: "user", subject: "users/u1", scope: "self" });
    const viaRole = rule({ subject_kind: "role", subject: "manager", scope: "create", level: "read" });
    // Without the caller passing the person's role, the rule row alone cannot know it applies...
    expect(unlistable(ruleFlags(person, [person, viaRole]))).toBeTruthy();
    // ...and with it, the inherited gate counts.
    expect(unlistable(ruleFlags(person, [person, viaRole], "manager"))).toBeFalsy();
  });

  it("does not fire on a verb rule, a create gate, or an org-wide rule", () => {
    for (const r of [rule({ scope: "self", verb: "approve", level: undefined }), rule({ scope: "create", level: "write" }), rule({ scope: "all" })]) {
      expect(unlistable(ruleFlags(r, [r]))).toBeFalsy();
    }
  });

  it("a pending gate does not count - it grants nothing yet", () => {
    const scoped = rule({ scope: "self" });
    const pendingGate = rule({ scope: "create", level: "read", status: "pending" });
    expect(unlistable(ruleFlags(scoped, [scoped, pendingGate]))).toBeTruthy();
  });
});

describe("ruleSentence - a department anchor reads as a department", () => {
  it("distinguishes a named-department subtree from an object subtree", () => {
    expect(ruleSentence(rule({ scope: "subtree", scope_ref: "departments/sales" }))).toContain("one department's leave requests");
    expect(ruleSentence(rule({ scope: "subtree", scope_ref: "leave-requests/req-1" }))).toContain("and everything below it");
  });
});
