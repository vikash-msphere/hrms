import { describe, it, expect } from "vitest";
import { ACCESS_VERBS } from "../src/http/accessHint";
import { CUSTOM_METHODS, STANDARD_METHODS, isCustomMethod } from "../web/src/components/access/customMethods";

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
