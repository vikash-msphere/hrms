import { describe, it, expect } from "vitest";
import { ruleSentence, ruleFlags, denyBlocking, expiryLabel } from "../web/src/components/access/ruleLogic";
import type { AccessRule } from "../web/src/components/access/permMatrix";

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
