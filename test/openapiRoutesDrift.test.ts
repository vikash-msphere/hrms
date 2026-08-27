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
