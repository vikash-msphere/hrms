/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// After a write, the SPA refreshes the collections that write touched (`affectedCollections` in
// web/src/lib/resourceStore.ts). For an ordinary create/update/delete that is just the collection in the URL.
// For a CUSTOM METHOD it is not: a verb is the one shape in the API that routinely writes somewhere else -
// `applications:hire` creates an employee, a transition, its tasks and a compensation row; `review-cycles:launch`
// creates the reviews; `goal-templates:apply` creates the goals - and the row it answers with says nothing
// about any of them.
//
// So `VERB_SIDE_EFFECTS` names those side effects, by hand. Hand-maintained is the problem this test exists
// for: the only signal for a missing entry was a DEV-only `console.debug`, and several entries were simply
// absent - `expenses:approve/reject/pay` notified the submitter and refreshed nothing, while the identical
// `reimbursements:*` one collection over were mapped and did. Nobody spots that by reading either entry; you
// have to hold the map against the handlers, which is what happens here.
//
// WHAT IS CHECKED, and what that is worth. For every custom method declared by a collection route, the verb's
// handler is resolved to the service function it calls, and that function (plus its same-module helpers) is
// read for two things: a `notify(` call, and an insert/update/delete against a table that backs a DIFFERENT
// collection. Whatever that finds, the map must cover.
//
// It is deliberately SHALLOW - one hop into the service module, and no further - because the alternative is a
// whole-program call graph whose false positives would force the map to invalidate half the app on every
// click, and every extra collection in an entry is a real D1 read on a free-plan database. Shallow means this
// test can MISS a side effect buried two modules down; it does not mean it can invent one. Everything it
// reports is a write that handler really makes.
//
// `notifications` is exempt from needing an entry, because the fallback in `affectedCollections` already adds
// it to every unmapped verb - see the note there. What the fallback cannot guess is a verb that writes a
// DIFFERENT COLLECTION, and that is precisely what must not be allowed to ride a default.
const routes = import.meta.glob("../src/routes/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const services = import.meta.glob("../src/services/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const authz = Object.values(
  import.meta.glob("../src/lib/authzResolve.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;
const indexTs = Object.values(
  import.meta.glob("../src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;
const resourceStore = Object.values(
  import.meta.glob("../web/src/lib/resourceStore.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0]!;

const base = (p: string) => p.split("/").pop()!.replace(/\.ts$/, "");

// schema table identifier -> wire collection. The registry authz already keeps, so this cannot drift from it.
const TABLE_TO_COLLECTION = new Map<string, string>();
{
  const block = authz.slice(authz.indexOf("export const TABLES"), authz.indexOf("export const RESOURCE_COLLECTIONS"));
  for (const m of block.matchAll(/(?:"([a-z0-9-]+)"|([a-zA-Z][A-Za-z0-9_]*)):\s*schema\.([A-Za-z0-9_]+)/g)) {
    TABLE_TO_COLLECTION.set(m[3]!, m[1] ?? m[2]!);
  }
}

// Route module export -> the path it is mounted at, for the route files that take their collection name from
// a shared CrudSpec instead of spelling it inline.
const MOUNTED_AS = new Map<string, string>();
for (const m of indexTs.matchAll(/app\.route\("\/v1\/([a-z0-9-]+)",\s*([A-Za-z0-9_]+)\)/g)) {
  if (!MOUNTED_AS.has(m[2]!)) MOUNTED_AS.set(m[2]!, m[1]!);
}

// Every module-level function of each service, exported or not, indexed PER MODULE. Per module because two
// services may each define a `decide` or a `setState`, and a global index let one stand in for the other -
// which reported every approval verb in the app as a writer of whatever collection happened to win the name.
const FUNCTIONS = new Map<string, Map<string, string>>();
for (const [path, src] of Object.entries(services)) {
  const marks: { name: string; at: number }[] = [];
  for (const m of src.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/gm)) marks.push({ name: m[1]!, at: m.index! });
  for (const m of src.matchAll(/^(?:export )?const ([A-Za-z0-9_]+)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/gm)) marks.push({ name: m[1]!, at: m.index! });
  marks.sort((a, b) => a.at - b.at);
  const mod = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1]!.at : src.length;
    if (!mod.has(marks[i]!.name)) mod.set(marks[i]!.name, src.slice(marks[i]!.at, end));
  }
  FUNCTIONS.set(base(path), mod);
}

// Plumbing the walk must not follow. These write bookkeeping rather than a collection anyone lists, and
// `emitEvent` is the event bus - following it would pull in whatever automations an org has configured, which
// is not something the SPA can invalidate against anyway (they run out of band).
const INFRASTRUCTURE = new Set(["audit", "auditMany", "emitEvent", "runBatch", "runBatchChecked", "insertBatches", "byIdChunks", "chunk", "groupBy", "notify"]);

/** Collections a function body writes: its own statements, plus one hop into helpers of the same module. */
function writesOf(mod: Map<string, string>, body: string, depth: number, seen: Set<string>): Set<string> {
  const out = new Set<string>();
  if (/\bnotify\(/.test(body)) out.add("notifications");
  for (const w of body.matchAll(/\.(?:insert|update|delete)\(schema\.([A-Za-z0-9_]+)\)/g)) {
    const c = TABLE_TO_COLLECTION.get(w[1]!);
    if (c) out.add(c);
  }
  if (depth > 0) {
    for (const call of body.matchAll(/\b([A-Za-z0-9_]+)\(/g)) {
      const name = call[1]!;
      if (INFRASTRUCTURE.has(name) || seen.has(name)) continue;
      const inner = mod.get(name);
      if (!inner) continue;
      seen.add(name);
      for (const c of writesOf(mod, inner, depth - 1, seen)) out.add(c);
    }
  }
  return out;
}

/** `<collection>:<verb>` -> the other collections its handler writes. */
function detectSideEffects(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [path, src] of Object.entries(routes)) {
    const inline = src.match(/collection:\s*"([a-z0-9-]+)"/)?.[1] ?? src.match(/const COL = "([a-z0-9-]+)"/)?.[1];
    const exported = [...src.matchAll(/^export const ([A-Za-z0-9_]+) = collectionRoutes/gm)].map((m) => m[1]!);
    const collection = inline ?? exported.map((e) => MOUNTED_AS.get(e)).find(Boolean);
    if (!collection) continue;

    // Which service module each imported identifier comes from - this is what keeps the resolution scoped.
    const moduleOf = new Map<string, string>();
    for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/services\/([A-Za-z0-9_]+)"/g)) {
      for (const raw of im[1]!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (name) moduleOf.set(name, im[2]!);
      }
    }

    const vi = src.indexOf("\n  verbs: {");
    if (vi < 0) continue;
    const block = src.slice(vi, src.indexOf("\n  },", vi) + 1);
    const keys = [...block.matchAll(/^ {4}([A-Za-z0-9_]+):\s*\{/gm)];
    for (let i = 0; i < keys.length; i++) {
      const verb = keys[i]![1]!;
      const body = block.slice(keys[i]!.index!, i + 1 < keys.length ? keys[i + 1]!.index! : block.length);
      const writes = new Set<string>();
      for (const call of body.matchAll(/\b([A-Za-z0-9_]+)\(/g)) {
        const name = call[1]!;
        if (INFRASTRUCTURE.has(name)) continue;
        const mod = FUNCTIONS.get(moduleOf.get(name) ?? "");
        const fn = mod?.get(name);
        if (!mod || !fn) continue;
        for (const c of writesOf(mod, fn, 1, new Set([name]))) if (c !== collection) writes.add(c);
      }
      if (writes.size) found.set(`${collection}:${verb}`, [...writes].sort());
    }
  }

  // THE COLLECTION-LEVEL METHODS THAT ARE THEIR OWN MOUNT, which the scan above cannot reach.
  //
  // A verb usually lives in its collection's `verbs:` block, and that block is what the loop reads. A handful
  // do not: a method addressed at the collection rather than at a record is mounted separately in src/index.ts
  // (`app.route("/v1/moderation:decide", ...)`) because `resolveRequest` would otherwise read the verb as an
  // item id. Those files carry no `verbs:` block at all, so the loop skipped them entirely and the SPA's map
  // could say nothing about them while nobody noticed - `moderation:decide` hides an announcement or a
  // suggestion, in a different collection from the one in its path, and rode the unmapped-verb default for its
  // whole life. That is precisely the case this test was written to catch, arriving through the one door it was
  // not watching.
  //
  // The handler is the WHOLE route file here rather than one property of an object literal: these mounts are a
  // few lines long and exist to call one service function, so the file is the body.
  for (const [, collection, verb, ident] of indexTs.matchAll(/app\.route\("\/v1\/([a-z0-9-]+):([A-Za-z0-9_]+)",\s*([A-Za-z0-9_]+)\)/g)) {
    const entry = Object.entries(routes).find(([, s]) => new RegExp(`^export const ${ident}\\b`, "m").test(s));
    if (!entry) continue;
    const src = entry[1];
    const moduleOf = new Map<string, string>();
    for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/services\/([A-Za-z0-9_]+)"/g)) {
      for (const raw of im[1]!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (name) moduleOf.set(name, im[2]!);
      }
    }
    const writes = new Set<string>();
    for (const call of src.matchAll(/\b([A-Za-z0-9_]+)\(/g)) {
      const name = call[1]!;
      if (INFRASTRUCTURE.has(name)) continue;
      const mod = FUNCTIONS.get(moduleOf.get(name) ?? "");
      const fn = mod?.get(name);
      if (!mod || !fn) continue;
      for (const c of writesOf(mod, fn, 1, new Set([name]))) if (c !== collection) writes.add(c);
    }
    if (writes.size) found.set(`${collection}:${verb}`, [...writes].sort());
  }
  return found;
}

/** The map as the SPA actually spells it. */
function mappedSideEffects(): Map<string, string[]> {
  const start = resourceStore.indexOf("const VERB_SIDE_EFFECTS");
  const block = resourceStore.slice(start, resourceStore.indexOf("\n};", start));
  const out = new Map<string, string[]>();
  for (const m of block.matchAll(/"([a-z0-9-]+:[A-Za-z0-9_]+)":\s*\[([^\]]*)\]/g)) {
    out.set(m[1]!, m[2]!.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean));
  }
  return out;
}

describe("custom-method invalidation", () => {
  // The scan is only worth anything while it still resolves handlers, and a rename in the routes or the
  // services would make it silently find nothing and pass for ever.
  it("resolves a meaningful number of verb handlers", () => {
    const detected = detectSideEffects();
    expect(detected.size).toBeGreaterThan(20);
    // The two the whole check exists for, as a canary on the resolution itself.
    expect(detected.get("review-cycles:launch")).toContain("reviews");
    expect(detected.get("expenses:approve")).toContain("notifications");
  });

  it("maps every verb that writes a collection other than its own", () => {
    const mapped = mappedSideEffects();
    const gaps: string[] = [];
    for (const [key, writes] of [...detectSideEffects()].sort()) {
      const entry = mapped.get(key);
      // No entry at all: the fallback covers the collection itself and `notifications`, and nothing else.
      const covered = entry ? writes.every((w) => entry.includes(w)) : writes.every((w) => w === "notifications");
      if (!covered) {
        const missing = writes.filter((w) => (entry ? !entry.includes(w) : w !== "notifications"));
        gaps.push(`${key} writes ${missing.join(", ")}${entry ? ` but maps ${entry.join(", ") || "[] (nothing)"}` : " and has no entry"}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it("has no entry for a verb that no longer exists", () => {
    const detected = detectSideEffects();
    const declared = new Set<string>();
    for (const [path, src] of Object.entries(routes)) {
      const inline = src.match(/collection:\s*"([a-z0-9-]+)"/)?.[1] ?? src.match(/const COL = "([a-z0-9-]+)"/)?.[1];
      const exported = [...src.matchAll(/^export const ([A-Za-z0-9_]+) = collectionRoutes/gm)].map((m) => m[1]!);
      const collection = inline ?? exported.map((e) => MOUNTED_AS.get(e)).find(Boolean);
      if (!collection) continue;
      void path;
      const vi = src.indexOf("\n  verbs: {");
      if (vi < 0) continue;
      const block = src.slice(vi, src.indexOf("\n  },", vi) + 1);
      for (const m of block.matchAll(/^ {4}([A-Za-z0-9_]+):\s*\{/gm)) declared.add(`${collection}:${m[1]}`);
    }
    // A dead entry is not harmless: it SHADOWS the fallback, so a renamed verb keeps the old key's answer and
    // silently stops refreshing anything the new one touches.
    //
    // Two kinds of verb are mounted outside a route's own `verbs:` block and so are excused rather than
    // deleted: the shared lifecycle methods the collection factory adds to every collection
    // (http/lifecycleVerb.ts), and the COLLECTION-level methods, which are their own mounts in src/index.ts
    // because they carry no resource id.
    const LIFECYCLE = ["enable", "disable", "lock", "unlock", "publish", "unpublish", "restore"];
    const collectionLevel = new Set(
      [...indexTs.matchAll(/app\.route\("\/v1\/([a-z0-9-]+):([A-Za-z0-9_]+)"/g)].map((m) => `${m[1]}:${m[2]}`),
    );
    const dead = [...mappedSideEffects().keys()].filter(
      (k) => !declared.has(k) && !collectionLevel.has(k) && !detected.has(k) && !LIFECYCLE.includes(k.split(":")[1]!),
    );
    expect(dead).toEqual([]);
  });
});
