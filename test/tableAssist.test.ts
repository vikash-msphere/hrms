/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { coerceBase, coerceSpec, rankFields, systemFor, systemForBases } from "../src/services/tableAssist";
import { FILTER_OPS, MAX_COLUMNS, MAX_FILTERS } from "../src/domain/tableFields";
import type { ResolvedField } from "../src/services/tableCatalog";

// The whole safety argument for putting a model near the table builder is that the output space is CLOSED:
// a spec can only name fields that already exist, with operators from a fixed list. `coerceSpec` is where
// that is enforced, so it is where the tests are.
//
// Pure functions, no D1: the catalogue is passed in, because what is being checked is what happens to the
// model's answer rather than how the catalogue was built (that has its own tests, and its access filtering
// is `buildCatalogue`'s job, done before this file sees anything).

const field = (key: string, label = key, kind = "text"): ResolvedField =>
  ({ key, label, group: "g", kind, collection: "tickets", path: [] } as unknown as ResolvedField);

const OFFERED = [
  field("subject", "Subject"),
  field("state", "State", "enum"),
  field("priority", "Priority", "enum"),
  field("created_at", "Created", "date"),
  field("employee_id.department_id.name", "Requester department"),
];

describe("only catalogue keys survive", () => {
  it("keeps known fields and reports the invented ones", () => {
    const raw = JSON.stringify({
      columns: [{ field: "subject" }, { field: "sentiment_score" }, { field: "state" }],
      filters: [],
      sort: [],
    });
    const { spec, unmatched } = coerceSpec(raw, OFFERED);
    expect(spec.columns.map((c) => c.field)).toEqual(["subject", "state"]);
    // Reported, not silently dropped: a grid quietly narrower than what somebody described is worse than one
    // that says which part it could not do.
    expect(unmatched).toEqual(["sentiment_score"]);
  });

  it("refuses a label used in place of a key", () => {
    const raw = JSON.stringify({ columns: [{ field: "Subject" }] });
    const { spec, unmatched } = coerceSpec(raw, OFFERED);
    expect(spec.columns).toEqual([]);
    expect(unmatched).toEqual(["Subject"]);
  });

  it("de-duplicates a column the model listed twice", () => {
    const raw = JSON.stringify({ columns: [{ field: "subject" }, { field: "subject" }] });
    expect(coerceSpec(raw, OFFERED).spec.columns).toEqual([{ field: "subject" }]);
  });

  it("checks filter and sort fields against the same list", () => {
    const raw = JSON.stringify({
      columns: [{ field: "subject" }],
      filters: [{ field: "made_up", op: "eq", value: "x" }, { field: "state", op: "eq", value: "OPEN" }],
      sort: [{ field: "nope", dir: "asc" }, { field: "created_at", dir: "desc" }],
    });
    const { spec, unmatched } = coerceSpec(raw, OFFERED);
    expect(spec.filters).toEqual([{ field: "state", op: "eq", value: "OPEN" }]);
    expect(spec.sort).toEqual([{ field: "created_at", dir: "desc" }]);
    expect(unmatched.sort()).toEqual(["made_up", "nope"]);
  });
});

describe("operators and values", () => {
  it("drops an operator that is not in the fixed list", () => {
    const raw = JSON.stringify({ columns: [{ field: "subject" }], filters: [{ field: "state", op: "regex", value: "^O" }] });
    expect(coerceSpec(raw, OFFERED).spec.filters).toEqual([]);
  });

  it("accepts every operator the app actually has", () => {
    for (const op of FILTER_OPS) {
      const needsValue = op !== "empty" && op !== "not_empty";
      const raw = JSON.stringify({ columns: [{ field: "subject" }], filters: [{ field: "state", op, ...(needsValue ? { value: "x" } : {}) }] });
      expect(coerceSpec(raw, OFFERED).spec.filters.length, `${op} should survive`).toBe(1);
    }
  });

  it("drops a value-taking operator with no value, and keeps empty/not_empty without one", () => {
    const missing = JSON.stringify({ columns: [{ field: "subject" }], filters: [{ field: "state", op: "eq" }] });
    expect(coerceSpec(missing, OFFERED).spec.filters).toEqual([]);
    const blank = JSON.stringify({ columns: [{ field: "subject" }], filters: [{ field: "state", op: "not_empty" }] });
    expect(coerceSpec(blank, OFFERED).spec.filters).toEqual([{ field: "state", op: "not_empty" }]);
  });

  it("normalises a sort direction rather than trusting it", () => {
    const raw = JSON.stringify({ columns: [{ field: "subject" }], sort: [{ field: "state", dir: "sideways" }] });
    expect(coerceSpec(raw, OFFERED).spec.sort).toEqual([{ field: "state", dir: "asc" }]);
  });
});

describe("a model cannot ask for more work than the builder could", () => {
  it("clamps columns, filters and sorts to the saved-view ceilings", () => {
    const many = (n: number) => Array.from({ length: n }, () => ({ field: "subject" }));
    const wide = [...OFFERED, ...Array.from({ length: 200 }, (_, i) => field(`f${i}`))];
    const raw = JSON.stringify({
      columns: Array.from({ length: 200 }, (_, i) => ({ field: `f${i}` })),
      filters: Array.from({ length: 200 }, (_, i) => ({ field: `f${i}`, op: "eq", value: "x" })),
      sort: Array.from({ length: 20 }, (_, i) => ({ field: `f${i}`, dir: "asc" })),
    });
    const { spec } = coerceSpec(raw, wide);
    expect(spec.columns.length).toBe(MAX_COLUMNS);
    expect(spec.filters.length).toBe(MAX_FILTERS);
    expect(spec.sort.length).toBe(4);
    expect(many(1).length).toBe(1); // keeps the helper honest
  });
});

describe("bad output never throws", () => {
  it("returns an empty spec for prose, empty input and broken JSON", () => {
    for (const raw of ["I cannot help with that", "", "{", "{oops}"]) {
      const { spec, unmatched } = coerceSpec(raw, OFFERED);
      expect(spec.columns).toEqual([]);
      expect(unmatched).toEqual([]);
    }
  });

  it("tolerates JSON wrapped in prose or a code fence", () => {
    const wrapped = 'Sure:\n```json\n{"columns":[{"field":"subject"}]}\n```';
    expect(coerceSpec(wrapped, OFFERED).spec.columns).toEqual([{ field: "subject" }]);
  });

  it("ignores columns that are not objects", () => {
    const raw = JSON.stringify({ columns: ["subject", null, 7, { field: "state" }] });
    expect(coerceSpec(raw, OFFERED).spec.columns).toEqual([{ field: "state" }]);
  });
});

describe("the prompt", () => {
  it("lists the offered keys and the real operator vocabulary", () => {
    const system = systemFor(OFFERED);
    for (const f of OFFERED) expect(system).toContain(f.key);
    for (const op of FILTER_OPS) expect(system).toContain(op);
    // The model must answer with keys, and the prompt has to say so: a label is ambiguous across groups.
    expect(system).toMatch(/do not use a label in place of a key/i);
  });
});

// The base is the other thing the model may choose, and it is chosen out of the caller's own base picker.
// Same closed output space, same enforcement point: an answer that is not one of the offered collections is
// no answer, and the caller is asked to point at one rather than being given the nearest match.
describe("only an offered base survives", () => {
  const BASES = [{ collection: "tickets" }, { collection: "employees" }, { collection: "leave-requests" }];

  it("keeps a collection that was offered", () => {
    expect(coerceBase(JSON.stringify({ base: "tickets" }), BASES)).toBe("tickets");
  });

  it("refuses one that was not, a label in place of a name, and a non-string", () => {
    for (const raw of [{ base: "payslips" }, { base: "Tickets" }, { base: 7 }, { base: "" }, {}]) {
      expect(coerceBase(JSON.stringify(raw), BASES)).toBeNull();
    }
  });

  it("never throws on prose, empty input or broken JSON", () => {
    for (const raw of ["I would use tickets", "", "{", "{oops}"]) expect(coerceBase(raw, BASES)).toBeNull();
  });

  it("tolerates JSON wrapped in prose or a code fence", () => {
    expect(coerceBase('Sure:\n```json\n{"base":"employees"}\n```', BASES)).toBe("employees");
  });

  it("offers every base by name and says to answer with the name", () => {
    const system = systemForBases([{ collection: "leave-requests", label: "Leave requests" }, { collection: "employees", label: "People" }]);
    expect(system).toContain("leave-requests (Leave requests)");
    expect(system).toContain("employees (People)");
    // The distinction that decides whether the grid has one row per person or one per request.
    expect(system).toMatch(/what the description counts/i);
  });
});

describe("field ranking", () => {
  it("floats the fields whose words the question used", () => {
    const ranked = rankFields(OFFERED, "show me the requester department for each ticket");
    expect(ranked[0]!.key).toBe("employee_id.department_id.name");
  });

  it("is stable when nothing matches, so the cap still gets a representative spread", () => {
    const ranked = rankFields(OFFERED, "zzzz");
    expect(ranked.map((f) => f.key)).toEqual(OFFERED.map((f) => f.key));
  });

  it("does not let a stopword score against a word that merely CONTAINS it", () => {
    // The two failures this had together, and they only bite once the catalogue is bigger than the cap -
    // which is exactly what walking the link tree produced. "the" was a search term (over two letters), and
    // matching was `includes`, so it scored against "Other" and "Further". Hundreds of fields each gained a
    // spurious point and the one the person actually named was pushed out of the offered set, which the
    // model then reported as a field that does not exist.
    const noise = [field("other_ref", "Other reference"), field("further_notes", "Further notes"), field("name", "Name")];
    expect(rankFields(noise, "the further other").map((f) => f.key)).toEqual(noise.map((f) => f.key));
  });

  it("matches a word to its plural without a stemmer, but not to a longer word sharing a stem", () => {
    const fields = [field("a.b", "Departments: Name"), field("dependant_id", "Dependant"), field("z", "Zulu")];
    // "department" reaches "Departments"...
    expect(rankFields(fields, "department").map((f) => f.key)[0]).toBe("a.b");
    // ...and "dep" reaches neither, because a three-letter prefix is a syllable rather than a stem.
    expect(rankFields(fields, "dep").map((f) => f.key)).toEqual(fields.map((f) => f.key));
  });

  it("ignores short words that would match everything", () => {
    // "the" and "for" are in half the labels in any catalogue; letting them score would make the ranking noise.
    const ranked = rankFields(OFFERED, "the for and");
    expect(ranked.map((f) => f.key)).toEqual(OFFERED.map((f) => f.key));
  });
});
