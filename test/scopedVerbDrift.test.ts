/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { SCOPE_READING_VERBS, MULTI_SCOPE_VERBS } from "../src/middleware/authz";

// A custom method usually acts on the record its path names, so the authz middleware does not pay for the
// per-object exception read on one - that read is for lists, and `announcements:markRead` fires on dwell.
//
// Two verbs break that premise: they answer with OTHER records, found by similarity and re-decided in SQL
// through `applyScope`. `applyScope` can only subtract the denies it is handed, so a verb that lists rows
// without an entry in `SCOPE_READING_VERBS` is filtered by BREADTH ALONE - and a record an ACL deny hides from
// somebody is handed straight back to them.
//
// Nothing about a handler announces which kind it is. What it does announce is that it reads `c.get("scope")`,
// which is the scope it would then bind, so that is what this holds the set against: every item-level verb
// whose handler takes the list scope must be named, and every name must still be such a verb.
const routes = import.meta.glob("../src/routes/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const indexTs = Object.values(
  import.meta.glob("../src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;

// Route module export -> the path it is mounted at, for the files that take their collection name from a
// shared CrudSpec instead of spelling it inline. Same resolution test/verbInvalidationDrift.test.ts uses.
const MOUNTED_AS = new Map<string, string>();
for (const m of indexTs.matchAll(/app\.route\("\/v1\/([a-z0-9-]+)",\s*([A-Za-z0-9_]+)\)/g)) {
  if (!MOUNTED_AS.has(m[2]!)) MOUNTED_AS.set(m[2]!, m[1]!);
}

/** `<collection>:<verb>` for every item-level verb whose handler body reads one of the fan-out scope maps. */
function multiScopeVerbs(): Map<string, string> {
  const found = new Map<string, string>();
  const keys = [...new Set([...MULTI_SCOPE_VERBS.values()].map((v) => v.key))];
  for (const src of Object.values(routes)) {
    const inline = src.match(/collection:\s*"([a-z0-9-]+)"/)?.[1] ?? src.match(/const COL = "([a-z0-9-]+)"/)?.[1];
    const exported = [...src.matchAll(/^export const ([A-Za-z0-9_]+) = collectionRoutes/gm)].map((m) => m[1]!);
    const collection = inline ?? exported.map((e) => MOUNTED_AS.get(e)).find(Boolean);
    if (!collection) continue;
    const vi = src.indexOf("\n  verbs: {");
    if (vi < 0) continue;
    const block = src.slice(vi, src.indexOf("\n  },", vi) + 1);
    const verbKeys = [...block.matchAll(/^ {4}([A-Za-z0-9_]+):\s*\{/gm)];
    for (let i = 0; i < verbKeys.length; i++) {
      const verb = verbKeys[i]![1]!;
      const body = block.slice(verbKeys[i]!.index!, i + 1 < verbKeys.length ? verbKeys[i + 1]!.index! : block.length);
      for (const key of keys) if (body.includes(`c.get("${key}")`)) found.set(`${collection}:${verb}`, key);
    }
  }
  return found;
}

/** `<collection>:<verb>` for every item-level verb whose handler body reads the list scope. */
function scopeReadingVerbs(): Set<string> {
  const found = new Set<string>();
  for (const src of Object.values(routes)) {
    const inline = src.match(/collection:\s*"([a-z0-9-]+)"/)?.[1] ?? src.match(/const COL = "([a-z0-9-]+)"/)?.[1];
    const exported = [...src.matchAll(/^export const ([A-Za-z0-9_]+) = collectionRoutes/gm)].map((m) => m[1]!);
    const collection = inline ?? exported.map((e) => MOUNTED_AS.get(e)).find(Boolean);
    if (!collection) continue;

    const vi = src.indexOf("\n  verbs: {");
    if (vi < 0) continue;
    const block = src.slice(vi, src.indexOf("\n  },", vi) + 1);
    const keys = [...block.matchAll(/^ {4}([A-Za-z0-9_]+):\s*\{/gm)];
    for (let i = 0; i < keys.length; i++) {
      const verb = keys[i]![1]!;
      const body = block.slice(keys[i]!.index!, i + 1 < keys.length ? keys[i + 1]!.index! : block.length);
      if (/c\.get\("scope"\)/.test(body)) found.add(`${collection}:${verb}`);
    }
  }
  return found;
}

describe("item verbs that list other records", () => {
  it("resolves the verb blocks at all", () => {
    // The scan is worth nothing if a rename makes it silently find nothing and pass for ever.
    expect(scopeReadingVerbs().size).toBeGreaterThan(0);
  });

  it("names every item verb that binds the caller's list scope", () => {
    const missing = [...scopeReadingVerbs()].filter((k) => !SCOPE_READING_VERBS.has(k));
    // A missing name is a per-object DENY that stops applying - see the note on the map itself.
    expect(missing).toEqual([]);
  });

  it("has no name for a verb that no longer reads the scope", () => {
    // A stale name is not free: it costs an indexed read on every call of a verb that does not need one.
    const stale = [...SCOPE_READING_VERBS.keys()].filter((k) => !scopeReadingVerbs().has(k));
    expect(stale).toEqual([]);
  });

  it("names every item verb that binds a whole map of list scopes", () => {
    // Same class of bug one axis wider: a verb reading `evidenceScopes` without an entry in MULTI_SCOPE_VERBS
    // gets an empty map, so every section of its answer is silently empty for everybody.
    const missing = [...multiScopeVerbs().keys()].filter((k) => !MULTI_SCOPE_VERBS.has(k));
    expect(missing).toEqual([]);
    const stale = [...MULTI_SCOPE_VERBS.keys()].filter((k) => !multiScopeVerbs().has(k));
    expect(stale).toEqual([]);
  });

  it("names the context key each multi-scope verb actually reads", () => {
    for (const [key, spec] of MULTI_SCOPE_VERBS) {
      expect(multiScopeVerbs().get(key), `${key} must read ${spec.key}`).toBe(spec.key);
      expect(spec.collections.length).toBeGreaterThan(0);
    }
  });

  it("binds a collection, not a verb name", () => {
    // The VALUE is the collection whose rows the handler lists, which is not always the one in the path:
    // `review-cycles:variablePay` lists reviews. A typo here would scope the wrong table without failing.
    for (const [key, bound] of SCOPE_READING_VERBS) {
      expect(bound, `${key} must name a collection`).toMatch(/^[a-z0-9-]+$/);
      expect(bound).not.toContain(":");
    }
  });
});
