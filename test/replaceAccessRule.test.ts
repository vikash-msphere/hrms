/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccessRule } from "@/components/access/permMatrix";

// Editing a rule is a removal plus a create - the API has no in-place rewrite of a grant - and the ORDER of the
// two is the whole safety property: a failure between them must never leave the subject with less access than
// before while the screen reports only "could not update". Driven against a fake API that answers the way
// services/accessRules.ts does: a refused body is refused before any duplicate check, and a body that keeps a
// rule's pattern collides with it (409).
const h = vi.hoisted(() => ({
  calls: [] as string[],
  create: (_body: Record<string, unknown>): Promise<unknown> => Promise.reject(new Error("unset")),
  remove: (_path: string): Promise<void> => Promise.resolve(),
}));
vi.mock("@/api", () => ({
  create: (_collection: string, body: Record<string, unknown>) => {
    h.calls.push(`create ${String(body.level ?? body.verb ?? body.effect)}`);
    return h.create(body);
  },
  remove: (path: string) => {
    h.calls.push(`remove ${path}`);
    return h.remove(path);
  },
  invoke: () => Promise.resolve(),
}));
// Only putBack's "it is already back" branch reads the subject's rules, and nothing here takes it.
vi.mock("@/components/access/permMatrix", () => ({ fetchAllAccessRules: () => Promise.resolve([]) }));

const { replaceAccessRule, ruleBody } = await import("@/components/access/cloneRules");

const old: AccessRule = { path: "access-rules/old", etag: "e1", subject_kind: "role", subject: "employee", collection: "leave-requests", scope: "all", level: "read", effect: "allow", status: "active" };
const stored = (path: string, body: Record<string, unknown>) => ({ ...body, path, etag: "e2", effect: body.effect ?? "allow", status: "active" }) as AccessRule;
const exists = () => Promise.reject(new Error("an identical access rule already exists"));

beforeEach(() => {
  h.calls.length = 0;
  h.remove = () => Promise.resolve();
});

describe("replacing a rule", () => {
  it("leaves everything as it was when the server refuses the new body", async () => {
    h.create = () => Promise.reject(new Error("level must be read|write|admin"));
    const res = await replaceAccessRule(old, { ...ruleBody(old), level: "owner" });
    expect(res).toEqual({ ok: false, error: "level must be read|write|admin", rule: old });
    expect(h.calls).toEqual(["create owner"]);
  });

  it("creates a rule with a new pattern before it removes the old one", async () => {
    h.create = (b) => Promise.resolve(stored("access-rules/new", b));
    const res = await replaceAccessRule(old, { ...ruleBody(old), scope: "dept" });
    expect(res.ok && res.rule.path).toBe("access-rules/new");
    expect(h.calls).toEqual(["create read", "remove access-rules/old"]);
  });

  it("takes the old rule out first only when the new one collides with it", async () => {
    let n = 0;
    h.create = (b) => (n++ === 0 ? exists() : Promise.resolve(stored("access-rules/new", b)));
    const res = await replaceAccessRule(old, { ...ruleBody(old), level: "write" });
    expect(res.ok).toBe(true);
    expect(h.calls).toEqual(["create write", "remove access-rules/old", "create write"]);
  });

  it("puts the old rule back when the replacement fails after all, and says where it is now", async () => {
    let n = 0;
    h.create = (b) => {
      n++;
      if (n === 1) return exists();
      if (n === 2) return Promise.reject(new Error("network down"));
      return Promise.resolve(stored("access-rules/restored", b));
    };
    const res = await replaceAccessRule(old, { ...ruleBody(old), level: "write" });
    expect(res).toMatchObject({ ok: false, error: "network down", rule: { path: "access-rules/restored", level: "read" } });
    expect(h.calls).toEqual(["create write", "remove access-rules/old", "create write", "create read"]);
  });

  it("treats a collision with some OTHER rule as the answer, and keeps the rule being edited", async () => {
    h.create = exists;
    const res = await replaceAccessRule(old, { ...ruleBody(old), scope: "self" });
    expect(res).toMatchObject({ ok: false, rule: old });
    expect(h.calls).toEqual(["create read"]);
  });

  it("takes the new rule back when the old one will not come out", async () => {
    h.create = (b) => Promise.resolve(stored("access-rules/new", b));
    h.remove = (p) => (p === "access-rules/old" ? Promise.reject(new Error("precondition failed")) : Promise.resolve());
    const res = await replaceAccessRule(old, { ...ruleBody(old), scope: "dept" });
    expect(res).toEqual({ ok: false, error: "precondition failed", rule: old });
    expect(h.calls).toEqual(["create read", "remove access-rules/old", "remove access-rules/new"]);
  });
});

describe("a rule's create body", () => {
  it("carries the guards, without which it would grant more than the rule it was read from", () => {
    const guarded: AccessRule = {
      ...old,
      collection: "expenses",
      level: undefined,
      verb: "approve",
      condition: { field: "amount", op: "lte", value: 50_000 },
      window: { field: "incurred_on", within_days: 30 },
      from_ip: "198.51.100.0/24",
    };
    expect(ruleBody(guarded)).toMatchObject({
      condition: { field: "amount", op: "lte", value: 50_000 },
      window: { field: "incurred_on", within_days: 30 },
      from_ip: "198.51.100.0/24",
    });
  });
});
