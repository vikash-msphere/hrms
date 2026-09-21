import { describe, it, expect } from "vitest";
import { fullHeader, headerForms, headerLabels, type HeaderField } from "../src/domain/tableHeaders";

// Naming a grid's columns is a property of the SET, not of any one field: the same column is "Name" in a
// table that has one and "Manager -> Department" in a table that has three. These pin both halves of that -
// nothing is qualified that nothing collides with, and nothing stays ambiguous that does.

const f = (key: string, label: string, trail?: string[], extra: Partial<HeaderField> = {}): HeaderField => ({ key, label, trail, ...extra });

describe("how far a header is qualified", () => {
  it("leaves a name alone when nothing beside it collides", () => {
    expect(headerLabels([f("first_name", "First name"), f("department_id.name", "Name", ["Department"], { nodeName: true })]))
      .toEqual(["First name", "Department"]);
    // Two hops away and still unique: only the LAST hop is spent, because the hops above it are what tells
    // columns apart and nothing here needs telling apart.
    expect(headerLabels([f("first_name", "First name"), f("manager_id.department_id.head_count", "Head count", ["Manager", "Department"])]))
      .toEqual(["First name", "Department: Head count"]);
  });

  it("grows only the columns that share a name, and only by as much as it takes", () => {
    const names = headerLabels([
      f("first_name", "First name"),
      f("department_id.name", "Name", ["Department"], { nodeName: true }),
      f("manager_id.department_id.name", "Name", ["Manager", "Department"], { nodeName: true }),
    ]);
    expect(names).toEqual(["First name", "Department", "Manager -> Department"]);
  });

  it("keeps growing when the next form lands on a THIRD column", () => {
    // "Manager: Personal email" would collide with the column already called that, so both go one hop further
    // - which is the round the one-pass version got wrong.
    const names = headerLabels([
      f("manager_id.@personal.personal_email", "Personal email", ["Manager"]),
      f("manager_id.manager_id.@personal.personal_email", "Personal email", ["Manager", "Manager"]),
    ]);
    expect(names).toEqual(["Manager: Personal email", "Manager -> Manager: Personal email"]);
  });

  it("names the rest AROUND a header the author wrote, and never touches theirs", () => {
    const names = headerLabels([
      f("manager_id.first_name", "First name", ["Manager"], { fixed: "Manager" }),
      f("department_id.name", "Name", ["Department"], { nodeName: true }),
      f("first_name", "First name"),
    ]);
    // The author's "Manager" stands; the department's name cannot also be "Department"... it can, nothing
    // else is called that - what it must not be is "Manager".
    expect(names).toEqual(["Manager", "Department", "First name"]);
    // ...and when the author takes the short name, the catalogue's own column gives way instead.
    expect(headerLabels([f("x", "anything", [], { fixed: "Department" }), f("department_id.name", "Name", ["Department"], { nodeName: true })]))
      .toEqual(["Department", "Department: Name"]);
  });

  it("does not say the same word twice", () => {
    expect(headerForms(f("department_id.head_count", "Department head count", ["Department"]))).toEqual(["Department: Head count"]);
  });

  it("never shortens a linked column to a name the base row would claim", () => {
    // "Personal email" on a grid of people is the person's, so the manager's never gets to be called that -
    // even alone, with nothing to collide with.
    expect(headerLabels([f("manager_id.@personal.personal_email", "Personal email", ["Manager"])])).toEqual(["Manager: Personal email"]);
    expect(headerForms(f("manager_id.first_name", "First name", ["Manager"]))).toEqual(["Manager: First name"]);
  });

  it("stops rather than loops when two columns cannot be told apart", () => {
    // Two different fields of the SAME node, named the same by an author. There is no trail left to spend.
    expect(headerLabels([f("a", "Total", [], { fixed: "Total" }), f("b", "Total", [], { fixed: "Total" })])).toEqual(["Total", "Total"]);
    // The same column asked for twice is one column, not a collision to resolve.
    expect(headerLabels([f("first_name", "First name"), f("first_name", "First name")])).toEqual(["First name", "First name"]);
  });

  it("spells the whole trail out for a tooltip, whatever the header ended up saying", () => {
    expect(fullHeader(f("manager_id.department_id.name", "Name", ["Manager", "Department"], { nodeName: true }))).toBe("Manager -> Department: Name");
    expect(fullHeader(f("manager_id.@comp.ctc_annual", "Annual CTC", ["Manager"]))).toBe("Manager: Annual CTC");
    expect(fullHeader(f("first_name", "First name"))).toBe("First name");
  });
});
