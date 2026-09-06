/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { EMBEDDED_COLLECTIONS } from "../src/services/changes";

// A serializer that embeds another collection's rows creates a stale copy nobody can correct.
//
// `GET /v1/changes` names the collections that were written to, and the SPA gives up exactly those stored
// copies (web/src/lib/resourceStore.ts). A write to an EMBEDDED collection - the 360 feedback inside a
// review, the tasks inside a transition - stamps only itself, because no outer row is touched. The outer
// copy is then wrong and is never re-read: the manager keeps seeing "Pending" after their colleague
// answered, through reloads, for as long as that copy lives.
//
// `src/services/changes.ts` fixes it by declaring which collection is embedded in which. Nothing at runtime
// fails when a NEW embed is added and not declared - it is a silent wrong answer in somebody's browser - so
// the map gets a gate: every route-attached embed in the serializer has to be accounted for here.
const files = import.meta.glob("../src/http/serialize.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const serialize = Object.values(files)[0] ?? "";

describe("the change feed knows what embeds what", () => {
  it("reads the serializer", () => {
    expect(serialize.length, "serialize.ts not found - fix the glob").toBeGreaterThan(1000);
  });

  it("declares one embed relationship per route-attached embed", () => {
    // Route-attached embeds are written as `if (r._<field> !== undefined) {` - the field is not on the row,
    // it is hung on it by the route that read the children.
    const embeds = [...serialize.matchAll(/if \(r\._(\w+) !== undefined\)/g)].map((m) => m[1]!);
    const declared = Object.values(EMBEDDED_COLLECTIONS).flat().length;
    expect(
      embeds.length,
      `serialize.ts embeds ${embeds.join(", ")}; EMBEDDED_IN in src/services/changes.ts declares ${declared}. ` +
        "An undeclared embed leaves the outer collection's stored copy stale forever - declare which collection " +
        "is embedded in which, or the client will never be told to re-read it.",
    ).toBe(declared);
  });

  it("names collections on both sides, not tables", () => {
    // The feed's answer is filtered by what the caller may LIST, and that list is keyed by wire collection in
    // kebab (`review-feedback`). A snake_case table name here matches nothing and can never be reported.
    const named = [...Object.keys(EMBEDDED_COLLECTIONS), ...Object.values(EMBEDDED_COLLECTIONS).flat()];
    expect(named.filter((c) => c.includes("_")), "an embed keyed by table name can never be reported").toEqual([]);
  });
});
