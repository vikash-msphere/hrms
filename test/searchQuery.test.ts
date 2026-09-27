import { describe, it, expect } from "vitest";
import { explains, matchExpression, normalizeSynonymGroups, queryTerms, startOfPeriod } from "../src/domain/searchQuery";

// The expression both ⌘K and the list-page search boxes run against the FTS index (domain/searchQuery.ts).

describe("matchExpression", () => {
  it("makes each typed word an ANDed prefix term", () => {
    expect(matchExpression("ali kap")).toBe('"ali"* AND "kap"*');
  });

  // FTS5 takes AND-by-juxtaposition between plain phrases only; a parenthesised group beside another term
  // without the operator is a syntax error, which is what ⌘K answered 500 on for "Log overtime".
  it("joins a synonym group to its neighbours with an explicit AND", () => {
    expect(matchExpression("log overtime")).toBe('"log"* AND ("overtime"* OR "ot")');
    expect(matchExpression("overtime log")).toBe('("overtime"* OR "ot") AND "log"*');
  });

  it("leaves no FTS5 operator from the query text in the expression", () => {
    expect(matchExpression('printer" OR x NEAR(y) *')).toBe('"printer"* AND "or"* AND "x"* AND "near"* AND "y"*');
    expect(matchExpression("  -- ;; ")).toBeNull();
  });

  it("widens a finished word to its synonym group", () => {
    const expr = matchExpression("pto")!;
    expect(expr.startsWith('("pto"* OR ')).toBe(true);
    expect(expr).toContain('"earned leave"');
    expect(expr).toContain('"vacation"*');
  });

  it("does not widen a half-typed word", () => {
    expect(matchExpression("vacat")).toBe('"vacat"*');
  });

  it("matches a phrase member across typed words, and keeps the other words", () => {
    const terms = queryTerms("work from home policy");
    expect(terms.map((t) => t.typed.join(" "))).toEqual(["work from home", "policy"]);
    expect(terms[0]!.alternatives.map((a) => a.join(" "))).toContain("wfh");
  });

  it("uses a short alternative exactly, so `ot` does not also find `other`", () => {
    expect(matchExpression("overtime")).toBe('("overtime"* OR "ot")');
  });
});

describe("explains", () => {
  it("accepts any spelling of every term", () => {
    const terms = queryTerms("pto request");
    expect(explains("earned leave request for june", terms)).toBe(true);
    expect(explains("earned leave for june", terms)).toBe(false); // "request" is still required
  });
});

describe("startOfPeriod", () => {
  it("reads a month or a day as the UTC instant it starts", () => {
    expect(startOfPeriod("2026-01")).toBe(Date.UTC(2026, 0, 1));
    expect(startOfPeriod("2026-03-15")).toBe(Date.UTC(2026, 2, 15));
  });

  it("refuses anything that is not a real month or day", () => {
    for (const bad of ["2026-02-30", "2026-13", "jan", "2026-1", ""]) expect(startOfPeriod(bad)).toBeNull();
  });
});

describe("an org's own synonym groups", () => {
  it("widen a word the built-in groups do not know, beside the built-in ones", () => {
    const org = normalizeSynonymGroups([["Zeus", "Project Thunderbolt"]]);
    expect(matchExpression("zeus laptop", org)).toBe('("zeus"* OR "project thunderbolt") AND ("laptop"* OR "notebook"* OR "macbook"*)');
    // Without them the same word is just a word.
    expect(matchExpression("zeus")).toBe('"zeus"*');
  });

  it("are cleaned on the way in: case, punctuation, repeats, and groups too small to widen anything", () => {
    expect(normalizeSynonymGroups([["CL", "cl", "Casual-Leave!"], ["alone"], "not a group", [1, 2]])).toEqual([["cl", "casual leave"]]);
    expect(normalizeSynonymGroups("nonsense")).toEqual([]);
  });
});
