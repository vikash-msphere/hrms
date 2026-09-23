/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
// @ts-expect-error - untyped module, runtime-only (same pattern as manifestCompleteness.test.ts)
import { load } from "js-yaml";

// Every route the worker mounts must exist in the OpenAPI contract. The local dev convention routes ALL
// traffic through the Prism contract proxy (:4010), so a mounted-but-unspecified route is dead on arrival
// there (Prism 404s "route not found in the specification file") - which is exactly how the whole
// workflow-engine surface (automations/automation-runs/workflow-instances/workflow-meta/event-log) shipped
// unusable once. This gate makes that class of drift impossible: add the paths to openapi.yaml when you
// mount a new route.
const rawSrc = import.meta.glob("../src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const indexTs = Object.values(rawSrc)[0]!;
const rawSpec = import.meta.glob("../openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const spec = load(Object.values(rawSpec)[0]!) as { paths: Record<string, unknown> };
const specPaths = Object.keys(spec.paths);

const mounts = [...indexTs.matchAll(/app\.route\("(\/v1\/[^"]+)"/g)].map((m) => m[1]!);

// A collection mount (e.g. /v1/employees) is covered by any spec path under it (itself, an item path, or a
// custom method); a collection-verb mount (e.g. /v1/bonuses:award) and a virtual singleton (/v1/workflow-meta)
// need their exact key.
const covered = (mount: string) =>
  specPaths.some((p) => p === mount || p.startsWith(`${mount}/`) || p.startsWith(`${mount}:`));

describe("every mounted /v1 route exists in the OpenAPI contract", () => {
  it("found the mounts (sanity: the regex still matches src/index.ts)", () => {
    expect(mounts.length).toBeGreaterThan(50);
  });
  it("has no mount missing from openapi.yaml", () => {
    const missing = mounts.filter((m) => !covered(m));
    expect(missing, "mounted in src/index.ts but absent from openapi.yaml - Prism will 404 these").toEqual([]);
  });
});

// Mount coverage is not enough: Prism resolves the ROUTE and then matches the METHOD, so a collection whose
// item path is specified but whose `:restore` is not fails with 405 "no method matched" instead of 404 - a
// mounted route that is dead on arrival through the proxy, which is how vendors, expense-categories and six
// others shipped un-restorable. `?force` on the DELETE is the factory's soft-delete signature
// (http/collectionRoute.ts mounts DELETE-with-force and `:restore` from the same `softDeletable` flag), so
// the two must always appear together in the contract.
type Operation = { parameters?: { name?: string }[] };
type PathItem = { parameters?: { name?: string }[]; delete?: Operation };
const pathItems = spec.paths as Record<string, PathItem>;

const takesForce = (path: string) => {
  const item = pathItems[path];
  if (!item?.delete) return false;
  return [...(item.parameters ?? []), ...(item.delete.parameters ?? [])].some((p) => p?.name === "force");
};
const restorePaths = new Set(specPaths.filter((p) => p.endsWith(":restore")).map((p) => p.slice(0, -":restore".length)));

describe("a soft-deletable collection specifies its :restore", () => {
  it("found the pairs (sanity: the shape still parses)", () => {
    expect(restorePaths.size).toBeGreaterThan(20);
  });
  it("every DELETE that takes ?force has a sibling :restore", () => {
    const missing = specPaths.filter((p) => takesForce(p) && !restorePaths.has(p));
    expect(missing, "soft-deletes in openapi.yaml but has no :restore - Prism will 405 the undo").toEqual([]);
  });
  it("every :restore has a sibling DELETE that takes ?force", () => {
    const orphans = [...restorePaths].filter((p) => !takesForce(p));
    expect(orphans, ":restore in openapi.yaml with no soft-delete to undo").toEqual([]);
  });
});

// The same 405 trap, one level down: `:restore` is only the verb the FACTORY mounts. A route file may declare
// any number of custom methods in its `verbs: {}` block, and each one is a POST Prism has to find in the
// contract - `cards:addTodos`, `:toggleTodo` and `:removeTodo` were mounted, used by the board's checklist,
// and specified nowhere, so every tick and every added item died with "Route resolved, but no method matched"
// for anyone running through the proxy. Reading the verb names out of the route files makes that impossible
// to repeat without editing this list.
const routeSrc = import.meta.glob("../src/routes/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every `<collection>:<verb>` a route file declares in its `verbs: {}` block. */
function declaredVerbs(): { collection: string; verb: string; file: string }[] {
  const out: { collection: string; verb: string; file: string }[] = [];
  for (const [file, src] of Object.entries(routeSrc)) {
    const collection = (src.match(/collection:\s*"([a-z-]+)"/) ?? src.match(/plural:\s*"([a-z-]+)"/) ?? [])[1];
    const at = src.indexOf("verbs: {");
    if (!collection || at < 0) continue;
    for (const m of src.slice(at + "verbs: {".length).matchAll(/\n {4}([a-zA-Z][a-zA-Z0-9]*):\s*\{/g)) {
      const verb = m[1]!;
      if (["schema", "run", "raw"].includes(verb)) continue;
      out.push({ collection, verb, file: file.split("/").pop()! });
    }
  }
  return out;
}

// One level down again, and the last of the three: `verbs: {}` is only what a route file declares BY HAND.
// The factory ALSO mounts the shared lifecycle members off the table's own columns - `:enable`/`:disable`
// wherever it has `disabled`, `:lock`/`:unlock` wherever it has `locked` (http/lifecycleVerb.ts) - so those
// paths appear in no route file and no `verbs` block, and nothing was checking them. Every one of them is a
// POST Prism has to find: "Disable" in the expense-category row menu was mounted, wired to a table that has
// the column, offered in the UI, and answered 405 through the proxy, so the menu item did nothing at all.
const schemaSrcRaw = import.meta.glob("../src/db/schema.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const serviceSrc = import.meta.glob("../src/services/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every column name each `schema.<table>` declares. Index names in a trailing `(t) => ({...})` come along
 *  harmlessly - only `disabled` and `locked` are ever asked for. */
function columnsByTable(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const block of Object.values(schemaSrcRaw)[0]!.split("\nexport const ")) {
    const name = block.match(/^(\w+) = sqliteTable\(/)?.[1];
    if (!name) continue;
    out.set(name, new Set([...block.matchAll(/\n {2}(\w+):/g)].map((m) => m[1]!)));
  }
  return out;
}

/** Which table each collection's CrudSpec is built on, read off the spec objects in src/services. */
function tableByCollection(): Map<string, string> {
  const out = new Map<string, string>();
  for (const src of Object.values(serviceSrc)) {
    for (const m of src.matchAll(/table:\s*schema\.(\w+),[\s\S]{0,400}?collection:\s*"([a-z-]+)"/g)) out.set(m[2]!, m[1]!);
    for (const m of src.matchAll(/collection:\s*"([a-z-]+)",[\s\S]{0,400}?table:\s*schema\.(\w+)/g)) if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

describe("a collection whose table carries a lifecycle column specifies those verbs", () => {
  const columns = columnsByTable();
  const tables = tableByCollection();
  const itemPathOf = (collection: string) => specPaths.find((p) => new RegExp(`^/v1/${collection}/\\{[a-z_]+\\}$`).test(p));

  it("found the collection -> table map (sanity: the spec shape still parses)", () => {
    expect(tables.size).toBeGreaterThan(40);
    expect(columns.get("expenseCategories")?.has("disabled")).toBe(true);
  });

  it("specifies :enable/:disable and :lock/:unlock wherever the factory mounts them", () => {
    const missing: string[] = [];
    for (const [collection, table] of tables) {
      const item = itemPathOf(collection);
      if (!item) continue; // not a routed collection (or specified under another shape)
      const cols = columns.get(table);
      if (!cols) continue;
      for (const [column, verbs] of [["disabled", ["enable", "disable"]], ["locked", ["lock", "unlock"]]] as const) {
        if (!cols.has(column)) continue;
        for (const verb of verbs) if (!specPaths.includes(`${item}:${verb}`)) missing.push(`${item}:${verb}`);
      }
    }
    expect(missing, "mounted from the table's own columns but unspecified - Prism answers 405 and the row menu does nothing").toEqual([]);
  });
});

describe("every custom method a route mounts is in the contract", () => {
  const verbs = declaredVerbs();

  it("found the verb blocks (sanity: the route shape still parses)", () => {
    expect(verbs.length).toBeGreaterThan(50);
  });

  it("specifies a path for each one", () => {
    const missing = verbs
      .filter(({ collection, verb }) => !specPaths.some((p) => p.includes(`/v1/${collection}`) && p.endsWith(`:${verb}`)))
      .map(({ collection, verb, file }) => `${collection}:${verb} (${file})`);
    expect([...new Set(missing)], "mounted but unspecified - Prism answers 405 and the feature is dead through the proxy").toEqual([]);
  });
});

// THE ANSWERS THE MIDDLEWARE GIVES, WHICH NO ROUTE DECLARES FOR ITSELF.
//
// Everything above this point checks that a route EXISTS in the contract. That is not the same as the
// contract being right about it, and it was not: 401, 413 and 429 appeared nowhere in openapi.yaml at all,
// 403 on 88 of 737 operations and 409 on 15 - while src/middleware/{auth,csrf,bodyLimit,rateLimit,authz}.ts
// produce all five on EVERY path under /v1. Measured through the dev proxy, one e2e run logged 138 Prism
// response violations, 116 of them DELETEs documented `204,404` answering 403.
//
// Nothing caught it. `npm run api:lint` lints the document, not the running app. Prism reports a violation
// per request into a log nobody reads. And the drift tests above ask only whether a path and a method are
// present. So the contract could say a private-by-default API never refuses a caller, and the generated
// client (src/http/openapi.d.ts, from `npm run api:types`) carried no shape for its single commonest answer.
//
// UNIFORM ON PURPOSE, including the pairings that look imprecise. A GET cannot really answer 409, and 413 is
// only reachable with a body - but every one of these is produced by a middleware that runs before any
// handler and that no operation can opt out of, so the set belongs to the LANE, not to the route. Declaring
// it per-method would make it a judgement call at each of 737 sites, which is the condition that produced
// the drift in the first place. Over-declaring an error a caller must already handle costs nothing;
// under-declaring the one they will actually meet is what this closes.
describe("every /v1 operation declares the middleware-level responses", () => {
  const METHODS = ["get", "post", "patch", "put", "delete"];
  // Each code with the shared component it must point at, so a future operation cannot satisfy the gate with
  // a bare inline description that says nothing about what the status means.
  const REQUIRED: Record<string, string> = {
    "401": "#/components/responses/Unauthenticated",
    "403": "#/components/responses/PermissionDenied",
    "409": "#/components/responses/Conflict",
    "413": "#/components/responses/PayloadTooLarge",
    "429": "#/components/responses/TooManyRequests",
  };
  type Operation = { responses?: Record<string, { $ref?: string }> };
  const operations = (): { key: string; op: Operation }[] => {
    const out: { key: string; op: Operation }[] = [];
    for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
      if (!path.startsWith("/v1/")) continue;
      for (const [method, op] of Object.entries(item ?? {})) {
        if (METHODS.includes(method)) out.push({ key: `${method.toUpperCase()} ${path}`, op: op as Operation });
      }
    }
    return out;
  };

  it("found the operations (sanity: the spec shape still parses)", () => {
    expect(operations().length).toBeGreaterThan(700);
  });

  it("declares 401/403/409/413/429 on every one of them", () => {
    const missing: string[] = [];
    for (const { key, op } of operations()) {
      const responses = op.responses ?? {};
      for (const code of Object.keys(REQUIRED)) if (!responses[code]) missing.push(`${key} is missing '${code}'`);
    }
    expect(missing, "every /v1 request passes auth, csrf, bodyLimit, rateLimit and authz, so every operation can answer these").toEqual([]);
  });

  it("points each of them at the shared component", () => {
    const wrong: string[] = [];
    for (const { key, op } of operations()) {
      for (const [code, ref] of Object.entries(REQUIRED)) {
        const declared = (op.responses ?? {})[code];
        if (declared && declared.$ref !== ref) wrong.push(`${key} '${code}' -> ${declared.$ref ?? "inline"} (expected ${ref})`);
      }
    }
    expect(wrong, "these statuses mean the same thing on every route, so they share one documented response").toEqual([]);
  });
});
