import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { BASES, EXCLUDED_BASES, RESERVED_SEGMENTS, SOURCES, SOURCE_PREFIX, TABLE_SOURCE_COLLECTIONS, columnAllowed, humanize } from "../src/domain/tableFields";
import { COLLECTIONS } from "../src/domain/collections";
import { TABLES } from "../src/lib/authzResolve";
import { columnOffered } from "../src/services/tableCatalog";
import { METRICS } from "../src/domain/peopleAnalytics";

// The table builder offers fields, and what it offers is what people will read. These are the properties that
// keep "offerable" honest: every base is a real, registered, listable collection; nothing excluded sneaks back
// in; no column that the wire deliberately hides can be projected around the serializer that hides it.

describe("table bases", () => {
  it("every base is a registered collection with a table behind it", () => {
    for (const base of Object.keys(BASES)) {
      expect(COLLECTIONS.has(base), `${base} is not in domain/collections COLLECTIONS`).toBe(true);
      expect(TABLES[base], `${base} has no table in authzResolve TABLES`).toBeTruthy();
    }
  });

  it("no collection is both registered and excluded", () => {
    for (const excluded of Object.keys(EXCLUDED_BASES)) {
      expect(BASES[excluded], `${excluded} is excluded but also registered as a base`).toBeUndefined();
    }
  });

  it("every excluded collection states WHY", () => {
    for (const [collection, reason] of Object.entries(EXCLUDED_BASES)) {
      expect(reason.length, `${collection} is excluded with no reason`).toBeGreaterThan(20);
    }
  });

  it("the collections a grid can touch are all real collections (the middleware fans out over this list)", () => {
    for (const collection of TABLE_SOURCE_COLLECTIONS) {
      expect(COLLECTIONS.has(collection), `${collection} is not a registered collection`).toBe(true);
    }
  });

  it("covers every measure's collection, or a metric column would be gated by a scope nobody resolved", () => {
    for (const m of METRICS) {
      expect(TABLE_SOURCE_COLLECTIONS).toContain(m.collection);
      for (const need of m.needs ?? []) expect(TABLE_SOURCE_COLLECTIONS).toContain(need);
    }
  });
});

describe("column exposure rules", () => {
  // Every column of every base, as the catalogue would offer it. Column names are the drizzle property names,
  // which is what columnAllowed is written against.
  const exposed = (base: string) => Object.keys(getTableColumns(TABLES[base])).filter((c) => columnAllowed(base, c));

  it("never offers an encrypted blob, a JSON blob, an object-store key or a secret", () => {
    const leaks: string[] = [];
    for (const base of Object.keys(BASES)) {
      for (const col of exposed(base)) {
        if (/(Enc|Json|Hash|Secret)$/.test(col)) leaks.push(`${base}.${col}`);
        // `keyPrefix` is a display value (a card's board prefix), the one documented exception.
        if (/Key$/.test(col) && col !== "keyPrefix") leaks.push(`${base}.${col}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("never offers the identity columns the wire does not carry", () => {
    for (const base of Object.keys(BASES)) {
      expect(exposed(base)).not.toContain("uuid");
      expect(exposed(base)).not.toContain("code");
      expect(exposed(base)).not.toContain("deleteTime");
    }
  });

  it("never offers a column that holds an internal id, singly or as a list", () => {
    // The rule that matters most here: `departments.manager_ids`, `interviews.interviewer_ids` and
    // `events.attendee_ids` are LISTS of employee ids in one column, and `bonuses.scope_ref` is a bare
    // department/employee id. The runner's guard only catches a cell that IS one id, so a list would have gone
    // out whole. Asserted against the real offering rule, so a new id-shaped column fails here first.
    const leaks: string[] = [];
    for (const base of Object.keys(BASES)) {
      for (const col of Object.keys(getTableColumns(TABLES[base]))) {
        if (columnOffered(base, col) && /(Id|Ids|By|Ref|Uuid)$/.test(col)) leaks.push(`${base}.${col}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(columnOffered("departments", "managerIds")).toBe(false);
    expect(columnOffered("events", "attendeeIds")).toBe(false);
    expect(columnOffered("bonuses", "scopeRef")).toBe(false);
    // And the rule stays narrow: an ordinary column is still offered.
    expect(columnOffered("departments", "name")).toBe(true);
  });

  it("hides the columns whose wire form is conditional (a serializer redacts them)", () => {
    // A suggestion's submitter is hidden when it is anonymous, so the raw column must not be projectable -
    // that would be a way round the anonymity the serializer promises.
    expect(exposed("suggestions")).not.toContain("submitterId");
    // An employee's notification preferences are a JSON blob nobody reads as a column.
    expect(exposed("employees")).not.toContain("notificationPrefs");
  });

  it("a source segment can never collide with a column name (`@identity.pan` must be unambiguous)", () => {
    // The prefix is what guarantees it: no column name may contain `@`, and every reserved segment starts
    // with one. `payslips.tax` and `transition-tasks.position` are why - both are real columns whose names
    // are also source keys.
    const collisions: string[] = [];
    for (const base of Object.keys(BASES)) {
      for (const col of Object.values(getTableColumns(TABLES[base])) as { name: string }[]) {
        if (col.name.includes(SOURCE_PREFIX)) collisions.push(`${base}.${col.name}`);
        if (RESERVED_SEGMENTS.has(col.name)) collisions.push(`${base}.${col.name}`);
      }
    }
    expect(collisions).toEqual([]);
    for (const seg of RESERVED_SEGMENTS) expect(seg.startsWith(SOURCE_PREFIX)).toBe(true);
  });

  it("every source names a collection that is fanned out to", () => {
    for (const s of SOURCES) {
      expect(TABLE_SOURCE_COLLECTIONS).toContain(s.collection);
      for (const need of s.needs ?? []) expect(TABLE_SOURCE_COLLECTIONS).toContain(need);
    }
  });
});

describe("labels", () => {
  it("humanizes a column name, with the acronyms spelled the way the app spells them", () => {
    expect(humanize("startDate")).toBe("Start date");
    expect(humanize("ctcAnnual")).toBe("Annual CTC");
    expect(humanize("epfEnrolled")).toBe("EPF enrolled");
    expect(humanize("workEmail")).toBe("Work email");
  });
});
