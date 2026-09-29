/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
// @ts-expect-error - untyped module, runtime-only (same pattern as openapiRoutesDrift.test.ts)
import { load } from "js-yaml";
import { ACCESS_VERBS } from "../src/http/accessHint";
import { COLLECTION_METHODS, CUSTOM_METHODS, STANDARD_METHODS, isCustomMethod } from "../web/src/components/access/customMethods";

const rawSpec = import.meta.glob("../openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const specPaths = Object.keys((load(Object.values(rawSpec)[0]!) as { paths: Record<string, unknown> }).paths);

// The ACL modal's custom-method vocabulary (web) is a mirror of the server's ACCESS_VERBS, minus the standard
// methods. This guards against the two drifting (a method offered in the UI that the server doesn't know, or
// vice versa) - the web bundle can't import from src/, so the constant is duplicated and pinned here.
describe("web CUSTOM_METHODS stays in sync with server ACCESS_VERBS", () => {
  it("equals ACCESS_VERBS minus the standard methods, for every collection", () => {
    const expected: Record<string, string[]> = {};
    for (const [col, verbs] of Object.entries(ACCESS_VERBS)) expected[col] = verbs.filter((v) => !STANDARD_METHODS.has(v));
    expect(CUSTOM_METHODS).toEqual(expected);
  });
  it("the standard methods are exactly update + delete (the level-ladder methods)", () => {
    expect([...STANDARD_METHODS].sort()).toEqual(["delete", "update"]);
    expect(isCustomMethod("approve")).toBe(true);
    expect(isCustomMethod("update")).toBe(false);
    expect(isCustomMethod(undefined)).toBe(false);
  });
});

// Which methods act on a collection rather than a record decides how a rule for one reads and which scope the
// ACL modal lets it be written at (web COLLECTION_METHODS). The contract is where that fact lives: the
// method is mounted at `/v1/<collection>:<verb>`, with no record in the path.
describe("COLLECTION_METHODS is exactly the contract's collection-level custom methods", () => {
  it("equals every /v1/<collection>:<verb> path in openapi.yaml", () => {
    const expected: Record<string, string[]> = {};
    for (const p of specPaths) {
      const m = /^\/v1\/([a-z-]+):([a-zA-Z]+)$/.exec(p);
      if (m) (expected[m[1]!] ??= []).push(m[2]!);
    }
    for (const verbs of Object.values(expected)) verbs.sort();
    const actual = Object.fromEntries(Object.entries(COLLECTION_METHODS).map(([c, v]) => [c, [...v].sort()]));
    expect(actual).toEqual(expected);
  });
  it("no verb is both collection-level and item-level on the same collection", () => {
    const both = Object.entries(COLLECTION_METHODS).flatMap(([c, verbs]) =>
      verbs.filter((v) => specPaths.some((p) => p.startsWith(`/v1/${c}/`) && p.endsWith(`}:${v}`))).map((v) => `${c}:${v}`),
    );
    expect(both, "a verb with both forms needs a per-rule answer, not a per-verb one").toEqual([]);
  });
});
