import { describe, it, expect } from "vitest";
import { computeCan } from "../src/http/accessHint";
import { denyingPattern, decide, resolveRequest, type Grant } from "../src/domain/permissions";

// "May edit, may never delete" - the most common request after read-only - was inexpressible: `levelFor`
// maps DELETE to the standard `write` level, so editing a record and destroying it are the SAME key. Adding a
// rung to the ladder would have re-decided every existing grant; the deny lane supplies the axis instead, and
// can only ever subtract from an allow the standard lane already made.
//
// The engine is untouched - `denyingPattern` is the existing deny pass, asked about a key the standard lane
// does not use. These tests pin that it stays subtractive: no grant anyone holds today is narrowed by it
// unless a deny names `delete` outright.

const self = { employeeCode: "04-1c-0a9" };
const OWN = "04-1c-0a9-01";
const OTHER = "07-1a-002-01";
const writer: Grant = { levels: { "goals.**": "write" }, allow: [] };

describe("denyingPattern", () => {
  it("answers only about explicit denies, and only for the key asked", () => {
    const g: Grant = { ...writer, deny: ["goals.*.delete"] };
    expect(denyingPattern(g, { kind: "custom", resource: `goals.${OWN}`, verb: "delete" }, self)).toBe("goals.*.delete");
    expect(denyingPattern(g, { kind: "custom", resource: `goals.${OWN}`, verb: "update" }, self)).toBeNull();
  });

  it("is null when there is no deny lane at all", () => {
    expect(denyingPattern(writer, { kind: "custom", resource: `goals.${OWN}`, verb: "delete" }, self)).toBeNull();
  });

  it("grants nothing on its own - it is the deny half, not a decision", () => {
    // A grant that ALLOWS the delete verb is still not an allow as far as this function is concerned: it
    // reports denies, so a caller cannot widen anything by holding one.
    const g: Grant = { levels: {}, allow: [`goals.*.delete`] };
    expect(denyingPattern(g, { kind: "custom", resource: `goals.${OWN}`, verb: "delete" }, self)).toBeNull();
  });
});

describe("the delete axis, as the row hint sees it", () => {
  it("write still carries delete when nothing denies it", () => {
    expect(computeCan(writer, self, "goals", OWN, ["update", "delete"])).toEqual(["update", "delete"]);
  });

  it("a deny on the delete verb removes delete and leaves edit", () => {
    const g: Grant = { ...writer, deny: ["goals.*.delete"] };
    expect(computeCan(g, self, "goals", OWN, ["update", "delete"])).toEqual(["update"]);
  });

  it("the deny is scoped like any other pattern", () => {
    // One department's records become read-and-edit-only while the rest stay fully deletable.
    const g: Grant = { ...writer, deny: ["goals.07-*.delete"] };
    expect(computeCan(g, self, "goals", OTHER, ["update", "delete"])).toEqual(["update"]);
    expect(computeCan(g, self, "goals", OWN, ["update", "delete"])).toEqual(["update", "delete"]);
  });

  it("does not disturb the standard lane", () => {
    // The point of doing this subtractively: the write level still decides updates, reads and creates exactly
    // as before, so no existing grant loses anything it had.
    const g: Grant = { ...writer, deny: ["goals.*.delete"] };
    expect(decide(g, resolveRequest("PATCH", `/v1/goals/${OWN}`), self).allow).toBe(true);
    expect(decide(g, resolveRequest("GET", `/v1/goals/${OWN}`), self).allow).toBe(true);
    expect(decide(g, resolveRequest("POST", "/v1/goals"), self).allow).toBe(true);
    // And the DELETE itself still passes the standard lane - it is the middleware's extra deny probe that
    // refuses it, which is what the two assertions above this file's middleware counterpart cover.
    expect(decide(g, resolveRequest("DELETE", `/v1/goals/${OWN}`), self).allow).toBe(true);
    expect(denyingPattern(g, { kind: "custom", resource: `goals.${OWN}`, verb: "delete" }, self)).toBe("goals.*.delete");
  });
});
