/// <reference types="vite/client" />
// Matching a card statement to the claims people filed. The rule decides what somebody is asked to go and do,
// so the cases that matter are the ones where a plausible-looking match would be WRONG: two identical charges
// in a week, a claim that has already accounted for one of them, and a near-miss on the amount.
import { describe, it, expect } from "vitest";
import { reconcileStatement, merchantAgrees, POSTING_LAG_DAYS, type StatementRow, type MatchCandidate } from "../src/domain/cardStatement";
import { importKeyFor } from "../src/services/cardStatements";

const day = (d: number) => Date.UTC(2026, 5, d);
const row = (id: string, d: number, amount: number, merchant: string | null = null): StatementRow => ({ id, postedOn: day(d), amount, merchant });
const claim = (id: string, d: number | null, amount: number, payee: string | null = null): MatchCandidate => ({ id, incurredOn: d === null ? null : day(d), amount, payee });

describe("reconcileStatement", () => {
  it("matches a claim to the charge that paid for it", () => {
    const r = reconcileStatement([row("t1", 12, 1200, "SQ *THE COFFEE CO 4471")], [claim("e1", 10, 1200, "Coffee Co")]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ rowId: "t1", expenseId: "e1" });
    expect(r.unmatchedRows).toEqual([]);
    expect(r.unmatchedExpenses).toEqual([]);
  });

  it("calls it exact only when the merchant agrees and the dates nearly do", () => {
    const near = reconcileStatement([row("t1", 11, 900, "UBER   *TRIP")], [claim("e1", 10, 900, "Uber")]);
    expect(near.matches[0]!.confidence).toBe("exact");
    // Same amount, same week, nothing recognisable in common: a match worth a glance, not a certainty.
    const loose = reconcileStatement([row("t1", 14, 900, "SQ *4471")], [claim("e1", 10, 900, "Stationery")]);
    expect(loose.matches[0]!.confidence).toBe("likely");
  });

  it("will not match on a different amount, however well everything else lines up", () => {
    // THE NON-NEGOTIABLE. Two records of one purchase agree on what it cost; if they do not, they are records
    // of two purchases, and pairing them would clear a charge nobody has actually accounted for.
    const r = reconcileStatement([row("t1", 10, 1000, "Coffee Co")], [claim("e1", 10, 1001, "Coffee Co")]);
    expect(r.matches).toEqual([]);
    expect(r.unmatchedRows).toEqual(["t1"]);
    expect(r.unmatchedExpenses).toEqual(["e1"]);
  });

  it("allows for the card posting days after the purchase", () => {
    expect(reconcileStatement([row("t1", 15, 500)], [claim("e1", 15 - POSTING_LAG_DAYS, 500)]).matches).toHaveLength(1);
    expect(reconcileStatement([row("t1", 15, 500)], [claim("e1", 15 - POSTING_LAG_DAYS - 1, 500)]).matches).toEqual([]);
  });

  it("clears two identical charges only when two claims were filed", () => {
    // THE CASE A NAIVE MATCHER GETS WRONG. Two lunches at the same price in one week, one claim filed. A
    // matcher that let one claim satisfy both rows would drop the unfiled lunch off the list of things to do,
    // which is the entire work this feature exists to surface.
    const one = reconcileStatement([row("t1", 10, 400, "Cafe"), row("t2", 12, 400, "Cafe")], [claim("e1", 10, 400, "Cafe")]);
    expect(one.matches).toHaveLength(1);
    expect(one.unmatchedRows).toEqual(["t2"]);

    const both = reconcileStatement(
      [row("t1", 10, 400, "Cafe"), row("t2", 12, 400, "Cafe")],
      [claim("e1", 10, 400, "Cafe"), claim("e2", 12, 400, "Cafe")],
    );
    expect(both.matches).toHaveLength(2);
    expect(both.unmatchedRows).toEqual([]);
  });

  it("pairs the nearer dates when two of each could match", () => {
    // Greedy over a best-first sort: the closest pairing is taken first, so the remaining pair is the other
    // closest rather than whatever was left over.
    const r = reconcileStatement(
      [row("t1", 10, 700, "Cafe"), row("t2", 14, 700, "Cafe")],
      [claim("e1", 14, 700, "Cafe"), claim("e2", 10, 700, "Cafe")],
    );
    expect(r.matches.find((m) => m.rowId === "t1")!.expenseId).toBe("e2");
    expect(r.matches.find((m) => m.rowId === "t2")!.expenseId).toBe("e1");
  });

  it("reconciles the same statement the same way every time", () => {
    // Ties break on the ids, so the answer does not depend on the order rows came out of the database - a
    // list of things to chase that reshuffled between two reads would be untrustworthy on its face.
    const rows = [row("t2", 10, 300, "Cafe"), row("t1", 10, 300, "Cafe")];
    const claims = [claim("e2", 10, 300, "Cafe"), claim("e1", 10, 300, "Cafe")];
    const a = reconcileStatement(rows, claims);
    const b = reconcileStatement([...rows].reverse(), [...claims].reverse());
    expect(a.matches).toEqual(b.matches);
  });

  it("names both kinds of leftover", () => {
    // The two halves of the answer: what nobody filed, and what was filed with no charge behind it.
    const r = reconcileStatement(
      [row("t1", 10, 100, "Cafe"), row("t2", 11, 999, "Hotel")],
      [claim("e1", 10, 100, "Cafe"), claim("e2", 11, 555, "Taxi")],
    );
    expect(r.matches).toHaveLength(1);
    expect(r.unmatchedRows).toEqual(["t2"]);
    expect(r.unmatchedExpenses).toEqual(["e2"]);
  });

  it("cannot match a claim that never said when it happened", () => {
    expect(reconcileStatement([row("t1", 10, 100)], [claim("e1", null, 100)]).unmatchedRows).toEqual(["t1"]);
  });
});

describe("merchantAgrees", () => {
  it("sees through a card descriptor to the name inside it", () => {
    expect(merchantAgrees("SQ *THE COFFEE CO 4471", "Coffee Co")).toBe(true);
    expect(merchantAgrees("AMZN Mktp IN*2A4BC", "Amazon")).toBe(false); // abbreviated past recognition, and says so
    expect(merchantAgrees("UBER   *TRIP", "Uber India")).toBe(true);
  });

  it("is not fooled by the words every descriptor has", () => {
    // Without the stop list, "THE ... LTD" would agree with "THE ... LTD" for any two companies at all.
    expect(merchantAgrees("THE LTD", "THE LTD")).toBe(false);
    expect(merchantAgrees("Hotel Ltd", "Taxi Ltd")).toBe(false);
  });

  it("says nothing rather than yes when there is nothing to read", () => {
    expect(merchantAgrees(null, "Coffee Co")).toBe(false);
    expect(merchantAgrees("", "")).toBe(false);
    expect(merchantAgrees("SQ *4471", "Coffee Co")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The import key. Not part of the matching rule, but it is what makes uploading the same statement twice
// safe, and the failure it prevents (a duplicated charge that the matcher then has to be clever about) is
// silent.
// ---------------------------------------------------------------------------------------------------------

describe("importKeyFor", () => {
  const base = { cardLast4: "4471", postedOn: Date.UTC(2026, 5, 10), amount: 1200, merchant: "SQ *COFFEE" };

  it("gives the same charge the same key however it is re-read", () => {
    expect(importKeyFor(base)).toBe(importKeyFor({ ...base }));
    // Whitespace and case in a descriptor are not a different charge.
    expect(importKeyFor({ ...base, merchant: "sq  *coffee" })).toBe(importKeyFor(base));
  });

  it("separates charges that differ in anything that identifies them", () => {
    expect(importKeyFor({ ...base, amount: 1201 })).not.toBe(importKeyFor(base));
    expect(importKeyFor({ ...base, postedOn: Date.UTC(2026, 5, 11) })).not.toBe(importKeyFor(base));
    expect(importKeyFor({ ...base, cardLast4: "9999" })).not.toBe(importKeyFor(base));
    expect(importKeyFor({ ...base, merchant: "SQ *TAXI" })).not.toBe(importKeyFor(base));
  });

  it("prefers the issuer's reference when there is one", () => {
    // A reference is the only thing that can tell two genuinely identical same-day charges apart, so where
    // the format carries one it decides on its own and the descriptor stops mattering.
    const withRef = { ...base, reference: "TXN-99" };
    expect(importKeyFor(withRef)).not.toBe(importKeyFor(base));
    expect(importKeyFor({ ...withRef, merchant: "anything else", amount: 1 })).toBe(importKeyFor(withRef));
  });

  it("collapses two identical same-day charges when the format gives no reference", () => {
    // A REAL LIMITATION, pinned so it is a known one. Nothing in the data distinguishes them, and inventing a
    // distinction (a position within the upload) would make every re-import duplicate the whole statement.
    expect(importKeyFor(base)).toBe(importKeyFor({ ...base }));
  });
});

// ---------------------------------------------------------------------------------------------------------
// The reconcile window. Not a matching rule - a bound on what automatic matching considers - but the reason
// for it is worth pinning: without it one permanently-unexplained charge from years ago decides the cost of
// reconciling this month, because the candidate read spans the transactions it is handed.
// ---------------------------------------------------------------------------------------------------------

describe("the reconcile lookback", () => {
  it("still matches a charge inside the window", () => {
    // A statement imported late, or a claim filed slowly, is the ordinary case and must keep working.
    const old = Date.UTC(2025, 11, 1);
    const r = reconcileStatement(
      [{ id: "t1", postedOn: old, amount: 500, merchant: "Cafe" }],
      [{ id: "e1", incurredOn: old - 2 * 86_400_000, amount: 500, payee: "Cafe" }],
    );
    expect(r.matches).toHaveLength(1);
  });

  it("leaves an old charge unmatched rather than reaching for a recent claim", () => {
    // THE PROPERTY THE BOUND RELIES ON. Even unbounded, an ancient charge could only ever pair with an
    // equally ancient claim, because the matcher's own window is days. So excluding it from automatic
    // matching loses no match that would have been made - it only stops the read spanning years.
    const ancient = Date.UTC(2023, 0, 10);
    const recent = Date.UTC(2026, 5, 10);
    const r = reconcileStatement(
      [{ id: "t-old", postedOn: ancient, amount: 500, merchant: "Cafe" }],
      [{ id: "e-new", incurredOn: recent, amount: 500, payee: "Cafe" }],
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedRows).toEqual(["t-old"]);
    expect(r.unmatchedExpenses).toEqual(["e-new"]);
  });
});
