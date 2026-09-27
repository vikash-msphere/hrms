import { describe, it, expect } from "vitest";
import { ROLE_TEMPLATES, templateRuleBody, templateSize } from "../web/src/components/access/roleTemplates";
import { validateAccessRule } from "../src/domain/policyValidate";
import { DEFAULT_POLICY, SUPPORTED_SCOPES } from "../bootstrap/authz/policy";
import { COLLECTIONS } from "../src/domain/collections";

// Starter packs for a new role, which is otherwise deny-all (`services/roles.ts` writes no rules).
//
// A template is only ever a named bundle of rule BODIES replayed through `POST /v1/access-rules`, so the
// thing worth testing is that every body it will send is one the server actually accepts. A template whose
// rules are rejected one by one is worse than no template: the admin sees "6 rejected" and has no idea which
// half of the role they now have. This runs the real validator over every rule of every template.

describe("role templates", () => {
  it("every rule is one the access-rule validator accepts", () => {
    const bad: string[] = [];
    for (const t of ROLE_TEMPLATES) {
      for (const r of t.rules) {
        try {
          validateAccessRule(templateRuleBody("role", "manager", r), DEFAULT_POLICY);
        } catch (e) {
          bad.push(`${t.key}: ${r.collection}${r.field ? `.${r.field}` : ""}${r.verb ? `:${r.verb}` : ""} - ${(e as Error).message}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("names only real collections", () => {
    const unknown = ROLE_TEMPLATES.flatMap((t) => t.rules.map((r) => r.collection)).filter((c) => !COLLECTIONS.has(c));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("never uses a scope tier the collection does not support", () => {
    // An inert rule is the failure mode a template must not ship: it reads as granted and decides nothing.
    const inert = ROLE_TEMPLATES.flatMap((t) =>
      t.rules
        .filter((r) => r.scope === "dept" || r.scope === "self")
        .filter((r) => !(SUPPORTED_SCOPES[r.collection] ?? ["all"]).includes(r.scope as "dept" | "self"))
        .map((r) => `${t.key}: ${r.collection} has no ${r.scope} tier`),
    );
    expect(inert).toEqual([]);
  });

  it("pairs every row-scoped rule with something that opens the list", () => {
    // The same trap the ACL's ensureListGate closes: a scoped rule decides items and 403s the page, because
    // a list is decided on the one-token key no scoped pattern matches. A template that shipped one without
    // the other would hand out a role whose pages are all walls.
    const missing: string[] = [];
    for (const t of ROLE_TEMPLATES) {
      const opens = new Set(t.rules.filter((r) => r.scope === "create" || (r.scope === "all" && !r.verb && !r.field)).map((r) => r.collection));
      for (const r of t.rules) {
        if ((r.scope === "dept" || r.scope === "self") && !opens.has(r.collection)) missing.push(`${t.key}: ${r.collection}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("has a stable key, a label, a summary and at least one rule each", () => {
    const keys = ROLE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of ROLE_TEMPLATES) {
      expect(t.label.length, t.key).toBeGreaterThan(0);
      expect(t.summary.length, t.key).toBeGreaterThan(0);
      expect(templateSize(t), t.key).toBeGreaterThan(0);
    }
  });

  it("the auditor template grants no write anywhere", () => {
    // The one template whose whole point is that it cannot change anything - worth asserting rather than
    // trusting the list to stay read-only as collections are added to it.
    const auditor = ROLE_TEMPLATES.find((t) => t.key === "auditor")!;
    for (const r of auditor.rules) {
      expect(r.verb, `${r.collection} carries a verb`).toBeUndefined();
      expect(r.level, `${r.collection} is not read`).toBe("read");
    }
  });
});
