import { describe, it, expect } from "vitest";
import { parseValue, bodyToRows, rowsToBody } from "@/components/workflows/bodyValue";

// THE GUIDED EDITOR'S BODY ROUND-TRIP HAS TO BE LOSSLESS.
//
// components/workflows/ActionList.tsx renders an apiCall action's body as key/value text rows and parses them
// back on every edit - and it re-serialises ALL of them when any one row changes, so touching an unrelated
// field is enough to rewrite a value the author never looked at. Its own header states the invariant and the
// bug it was written for (arrays and objects coming back as strings).
//
// The remaining hole was the other direction: any numeric-LOOKING string was coerced to a number. A rule
// authored through the JSON hatch (WorkflowBuilder's raw editor) or seeded server-side can perfectly well hold
// "0042" as a string, and opening the guided editor turned it into 42. Three silent cases, all pinned below.
describe("workflow apiCall body: text that is not a number stays a string", () => {
  it("keeps a numeric string that would not round-trip (leading zeros)", () => {
    expect(parseValue("0042")).toBe("0042");
    expect(parseValue("007")).toBe("007");
  });

  it("keeps `Infinity`, which JSON.stringify would otherwise write out as null", () => {
    expect(parseValue("Infinity")).toBe("Infinity");
    expect(parseValue("-Infinity")).toBe("-Infinity");
  });

  it("keeps whitespace, which Number() reads as 0", () => {
    expect(parseValue(" ")).toBe(" ");
    expect(parseValue("\t")).toBe("\t");
  });

  it("keeps the empty string", () => {
    expect(parseValue("")).toBe("");
  });
});

describe("workflow apiCall body: everything that did round-trip still does", () => {
  it("parses real numbers", () => {
    expect(parseValue("42")).toBe(42);
    expect(parseValue("4.5")).toBe(4.5);
    expect(parseValue("-3")).toBe(-3);
    expect(parseValue("0")).toBe(0);
  });

  it("parses booleans and null", () => {
    expect(parseValue("true")).toBe(true);
    expect(parseValue("false")).toBe(false);
    expect(parseValue("null")).toBeNull();
  });

  it("parses arrays and objects - the case the header was written for", () => {
    expect(parseValue('["employees/a1"]')).toEqual(["employees/a1"]);
    expect(parseValue('{"a":1}')).toEqual({ a: 1 });
  });

  it("leaves a template alone, whatever it looks like", () => {
    expect(parseValue("{{event.employee}}")).toBe("{{event.employee}}");
    // A template that resolves to a number is still a string at authoring time.
    expect(parseValue("{{event.days}}")).toBe("{{event.days}}");
  });

  it("leaves unparseable JSON-looking text as text rather than dropping it", () => {
    expect(parseValue("{not json")).toBe("{not json");
  });
});

describe("workflow apiCall body: a whole body survives the round-trip", () => {
  it("comes back as it went in - which is what editing one row does to all of them", () => {
    // The amplification the module header describes: touching any row re-serialises every row, so the
    // property that matters is the whole body, not one value.
    const body = { employees: ["employees/a1"], count: 3, flag: true, note: null, code: "0042", when: "{{event.date}}" };
    expect(rowsToBody(bodyToRows(body))).toEqual(body);
  });

  it("writes no body at all for an empty form, rather than an empty object", () => {
    expect(rowsToBody([])).toBeUndefined();
    expect(rowsToBody([{ key: "  ", value: "x" }])).toBeUndefined();
  });
});
