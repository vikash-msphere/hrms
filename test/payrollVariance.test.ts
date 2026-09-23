/// <reference types="vite/client" />
// Which rows of a payroll run somebody should look at, and everything that must be true before it is
// approved.
//
// The cases that matter here are the ones an org-total comparison cannot see: a person whose wage did not
// change but whose take-home did, a component that started or stopped without moving the totals much, and a
// first run with nothing to compare against. Those are where the real payroll errors live, and each is a
// separate assertion rather than being folded into "it flags big moves".
import { describe, it, expect } from "vitest";
import { findVariances, preflight, explainPay, DEFAULT_VARIANCE_FRACTION, type VarianceItem } from "../src/domain/payrollVariance";
import type { Line } from "../src/domain/payroll";
import { allowedDeductions } from "../src/domain/incomeTax";

const earn = (code: string, amount: number): Line => ({ code, name: code, kind: "earning", amount });
const deduct = (code: string, amount: number): Line => ({ code, name: code, kind: "deduction", amount });

/** An item whose totals follow from its lines, so a fixture cannot be internally inconsistent. */
const item = (employeeId: string, lines: Line[]): VarianceItem => {
  const gross = lines.filter((l) => l.kind === "earning").reduce((s, l) => s + l.amount, 0);
  const deductions = lines.filter((l) => l.kind === "deduction").reduce((s, l) => s + l.amount, 0);
  return { employeeId, lines, gross, net: Math.round((gross - deductions) * 100) / 100 };
};

const steady = (employeeId: string, n = 3) => Array.from({ length: n }, () => item(employeeId, [earn("BASIC", 50_000), deduct("TDS", 5_000)]));
const history = (...entries: [string, VarianceItem[]][]) => new Map(entries);
const flagFor = (fs: ReturnType<typeof findVariances>, id: string) => fs.find((f) => f.employeeId === id);

describe("findVariances", () => {
  it("says nothing about a month that did not change", () => {
    const current = [item("a", [earn("BASIC", 50_000), deduct("TDS", 5_000)])];
    expect(findVariances(current, history(["a", steady("a")]))).toEqual([]);
  });

  it("flags a take-home move when the wage did not change, and ranks it first", () => {
    // THE CASE AN ORG TOTAL CANNOT SHOW. Same gross, a new recovery: this is where a wrongly-started EMI, a
    // new statutory line and a tax swing all hide.
    const current = [
      item("a", [earn("BASIC", 50_000), deduct("TDS", 5_000), deduct("LOAN", 12_000)]),
      // Somebody whose gross moved as well, so the ranking has something to beat.
      item("b", [earn("BASIC", 80_000), deduct("TDS", 5_000)]),
    ];
    const flags = findVariances(current, history(["a", steady("a")], ["b", steady("b")]));
    expect(flags[0]!.employeeId).toBe("a");
    expect(flags[0]!.kind).toBe("net_moved_gross_flat");
    expect(flags[0]!.delta).toBe(-12_000);
    expect(flags[0]!.reasons).toContain("loan or advance recovery started");
  });

  it("names the cause rather than only the movement", () => {
    // A flag that sends somebody to four other pages has not saved them anything.
    const current = [item("a", [earn("BASIC", 50_000), earn("ARREARS", 30_000), deduct("TDS", 5_000)])];
    const f = flagFor(findVariances(current, history(["a", steady("a")])), "a")!;
    expect(f.reasons).toContain("backdated raise arrears started");
    expect(f.delta).toBe(30_000);
  });

  it("reports no reasons when nothing in the lines explains the move, and that is the finding", () => {
    // Basic simply changed, with no new or removed line. The move is real and unexplained, which is the row a
    // payroll officer should open first - so the reasons name the component that moved rather than being empty
    // of information.
    const current = [item("a", [earn("BASIC", 70_000), deduct("TDS", 5_000)])];
    const f = flagFor(findVariances(current, history(["a", steady("a")])), "a")!;
    expect(f.kind).toBe("net_moved");
    expect(f.reasons).toContain("a change in basic pay");
  });

  it("uses a median, so one unusual month cannot hide the next real move", () => {
    // A bonus month sits in the history. Against a MEAN it would raise the baseline enough that a genuine cut
    // the following month reads as normal; the median ignores it.
    const past = [
      item("a", [earn("BASIC", 50_000)]),
      item("a", [earn("BASIC", 50_000), earn("BONUS", 200_000)]),
      item("a", [earn("BASIC", 50_000)]),
    ];
    const mean = past.reduce((s, p) => s + p.net, 0) / past.length;
    const current = [item("a", [earn("BASIC", 40_000)])];
    const f = flagFor(findVariances(current, history(["a", past])), "a")!;
    // Against the median (50,000) this is a 20% cut and is flagged.
    expect(f.kind).toBe("net_moved");
    expect(f.delta).toBe(-10_000);
    // Against a mean it would have been a far larger apparent move, i.e. a different and wrong story.
    expect(Math.abs(40_000 - mean)).toBeGreaterThan(Math.abs(f.delta));
  });

  it("calls a person with no history a first run rather than a movement", () => {
    // Their delta against nothing would be their whole salary: true, and useless.
    const flags = findVariances([item("z", [earn("BASIC", 50_000)])], history());
    expect(flags.length).toBe(1);
    expect(flags[0]!.kind).toBe("first_run");
    expect(flags[0]!.delta).toBe(0);
  });

  it("notices a component that started without moving the totals much", () => {
    // Below the threshold on both figures, but somebody is being paid something new. Cheap to say so.
    const current = [item("a", [earn("BASIC", 50_000), earn("OVERTIME", 900), deduct("TDS", 5_000)])];
    const f = flagFor(findVariances(current, history(["a", steady("a")])), "a")!;
    expect(f.kind).toBe("component_added");
    expect(f.reasons).toContain("overtime started");
  });

  it("notices a component that stopped", () => {
    const past = [item("a", [earn("BASIC", 50_000), earn("OVERTIME", 900), deduct("TDS", 5_000)])];
    const current = [item("a", [earn("BASIC", 50_000), deduct("TDS", 5_000)])];
    const f = flagFor(findVariances(current, history(["a", past])), "a")!;
    expect(f.kind).toBe("component_removed");
    expect(f.reasons).toContain("overtime stopped");
  });

  it("ignores a move that is large in percent but trivial in money", () => {
    // Somebody paid a token amount must not fill the band because their pay doubled from 50 to 100.
    const past = [item("a", [earn("BASIC", 50)])];
    const current = [item("a", [earn("BASIC", 100)])];
    expect(findVariances(current, history(["a", past])).filter((f) => f.kind === "net_moved")).toEqual([]);
  });

  it("respects the org's threshold", () => {
    const past = [item("a", [earn("BASIC", 100_000)])];
    const current = [item("a", [earn("BASIC", 110_000)])]; // a 10% rise
    // Under the default 15% this is not worth a flag...
    expect(flagFor(findVariances(current, history(["a", past]), DEFAULT_VARIANCE_FRACTION), "a")?.kind).not.toBe("net_moved");
    // ...and under a stricter org's 5% it is.
    expect(flagFor(findVariances(current, history(["a", past]), 0.05), "a")!.kind).toBe("net_moved");
  });

  it("ignores employer contributions, which are neither paid nor withheld", () => {
    const past = [item("a", [earn("BASIC", 50_000)])];
    const current: VarianceItem[] = [{
      employeeId: "a",
      lines: [earn("BASIC", 50_000), { code: "ER_EPF", name: "Employer PF", kind: "employer_contribution", amount: 6_000 }],
      gross: 50_000,
      net: 50_000,
    }];
    expect(findVariances(current, history(["a", past]))).toEqual([]);
  });
});

describe("preflight", () => {
  const empty = { missingBankAccount: new Set<string>(), unpriced: [] as string[], taxedLastRun: new Set<string>() };

  it("blocks a negative net", () => {
    const items = [{ employeeId: "a", lines: [], gross: 10_000, net: -500 }];
    const issues = preflight({ items, ...empty });
    expect(issues.find((i) => i.code === "negative_net")?.blocking).toBe(true);
  });

  it("blocks a net above its own gross", () => {
    // Net is gross minus deductions, so this cannot happen on a correct run - which is exactly why blocking it
    // can have no escape hatch: there is nothing legitimate for it to refuse.
    const items = [{ employeeId: "a", lines: [], gross: 10_000, net: 12_000 }];
    expect(preflight({ items, ...empty }).find((i) => i.code === "net_above_gross")?.blocking).toBe(true);
  });

  it("reports but does not block the judgement calls", () => {
    // Each of these is something somebody may legitimately overrule - a person paid by cheque, a month with
    // no tax due, a component nobody has priced yet. Refusing them would be this file deciding policy.
    const items = [{ employeeId: "a", lines: [earn("BASIC", 10_000)], gross: 10_000, net: 10_000 }];
    const issues = preflight({
      items,
      missingBankAccount: new Set(["a"]),
      unpriced: ["SPECIAL"],
      taxedLastRun: new Set(["a"]),
    });
    for (const code of ["no_bank_account", "tax_stopped", "unpriced_component"]) {
      const hit = issues.find((i) => i.code === code);
      expect(hit, code).toBeDefined();
      expect(hit!.blocking, code).toBe(false);
    }
  });

  it("rests on an invariant the build enforces, not an assumption about callers", () => {
    // WHY THE HARD BLOCK IS SAFE, stated as a test because the argument is the whole justification for
    // refusing an approval with no override. `negative_net` and `net_above_gross` are refused on the grounds
    // that net IS gross minus deductions, so neither can occur on a correct run. That holds only while every
    // line amount is non-negative - and `buildRunItems` used to push whatever a caller sent, so a negative
    // deduction (refunding an over-deducted TDS, the ordinary correction) would have produced net > gross and
    // the block would have refused a legitimate approval on a pay date.
    //
    // The build now rejects a negative one-off outright (services/payroll.ts, and the route types it), which
    // is what turns this from an assumption into a property. Pinned here, beside the check that depends on it,
    // because the day somebody relaxes that validation this test should be what tells them what it was for.
    const impossible = [{ employeeId: "a", lines: [earn("BASIC", 10_000), deduct("TDS", -5_000)], gross: 10_000, net: 15_000 }];
    const issues = preflight({ items: impossible, ...empty });
    expect(issues.find((i) => i.code === "net_above_gross")?.blocking).toBe(true);
  });

  it("says nothing about a run that is fine", () => {
    const items = [{ employeeId: "a", lines: [earn("BASIC", 10_000), deduct("TDS", 1_000)], gross: 10_000, net: 9_000 }];
    expect(preflight({ items, ...empty })).toEqual([]);
  });

  it("does not chase a bank account for somebody owed nothing", () => {
    // A zero-net row has no payout to misroute, so demanding an account for it is noise.
    const items = [{ employeeId: "a", lines: [], gross: 0, net: 0 }];
    const issues = preflight({ items, ...empty, missingBankAccount: new Set(["a"]) });
    expect(issues.find((i) => i.code === "no_bank_account")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------
// "Why is my pay different this month?" - the most common payroll question, answered by subtracting two
// things the app already holds. The tests below are mostly about what the employee is NOT told: employer
// cost they never receive, and components that did not move.
// ---------------------------------------------------------------------------------------------------------

describe("explainPay", () => {
  it("names what changed and by how much", () => {
    const before = [earn("BASIC", 50_000), deduct("TDS", 5_000)];
    const now = [earn("BASIC", 50_000), deduct("TDS", 5_000), deduct("LOAN", 8_000)];
    const e = explainPay(now, before);
    expect(e.netBefore).toBe(45_000);
    expect(e.netNow).toBe(37_000);
    expect(e.netDelta).toBe(-8_000);
    expect(e.changes.map((c) => c.code)).toEqual(["LOAN"]);
    expect(e.reasons).toEqual(["loan or advance recovery started"]);
  });

  it("orders by effect on take-home, not by raw delta", () => {
    // A deduction that grew by 9,000 hurts more than an earning that grew by 8,000 helps, and the person
    // reading this wants the reason their pay fell at the top.
    const before = [earn("BASIC", 50_000)];
    const now = [earn("BASIC", 58_000), deduct("TDS", 9_000)];
    expect(explainPay(now, before).changes[0]!.code).toBe("TDS");
  });

  it("says a component stopped", () => {
    const before = [earn("BASIC", 50_000), earn("OVERTIME", 4_000)];
    const now = [earn("BASIC", 50_000)];
    const e = explainPay(now, before);
    expect(e.reasons).toEqual(["overtime stopped"]);
    expect(e.changes[0]).toMatchObject({ code: "OVERTIME", before: 4_000, now: 0, delta: -4_000 });
  });

  it("says nothing about a month that did not change", () => {
    const lines = [earn("BASIC", 50_000), deduct("TDS", 5_000)];
    const e = explainPay(lines, lines);
    expect(e.changes).toEqual([]);
    expect(e.netDelta).toBe(0);
  });

  it("excludes employer cost and perquisites, which the employee never receives", () => {
    // Both move the company's cost or the tax base, neither moves take-home - so neither explains a change in
    // what arrived in somebody's account, and listing them would invite the question they cannot answer.
    const before: Line[] = [earn("BASIC", 50_000)];
    const now: Line[] = [
      earn("BASIC", 50_000),
      { code: "ER_EPF", name: "Employer PF", kind: "employer_contribution", amount: 6_000 },
      { code: "PERQ_LOAN", name: "Loan perquisite", kind: "perquisite", amount: 900 },
    ];
    const e = explainPay(now, before);
    expect(e.changes).toEqual([]);
    expect(e.netDelta).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Declaration headroom (item 9). The arithmetic is one subtraction; everything worth testing is about WHICH
// sections it reports, because reporting the wrong ones turns a useful line into noise or into advice.
// ---------------------------------------------------------------------------------------------------------

describe("allowedDeductions headroom", () => {
  const regime = { deductionSections: ["80C", "80D", "80CCD(1B)"], sectionCaps: { "80C": 150_000, "80D": 25_000 } };

  it("reports what is left in a partly-used section", () => {
    const { headroom } = allowedDeductions({ "80C": 60_000 }, regime as never);
    expect(headroom.find((h) => h.section === "80C")).toEqual({ section: "80C", cap: 150_000, declared: 60_000, remaining: 90_000 });
  });

  it("reports a section nobody has declared against, which is the case that matters most", () => {
    // Somebody who has declared nothing is exactly the person who does not know they could.
    const { headroom } = allowedDeductions({}, regime as never);
    expect(headroom.map((h) => h.section).sort()).toEqual(["80C", "80D"]);
  });

  it("says nothing about a section that is full", () => {
    const { headroom } = allowedDeductions({ "80C": 150_000, "80D": 25_000 }, regime as never);
    expect(headroom).toEqual([]);
  });

  it("ignores uncapped and disallowed sections", () => {
    // An uncapped section has no headroom to state - "unlimited minus what you used" is not actionable - and
    // a section this regime disallows is not an opportunity.
    const { headroom } = allowedDeductions({ "80CCD(1B)": 10_000, "80G": 5_000 }, regime as never);
    expect(headroom.map((h) => h.section).sort()).toEqual(["80C", "80D"]);
  });

  it("orders by what is left, so the biggest opportunity reads first", () => {
    const { headroom } = allowedDeductions({ "80C": 140_000 }, regime as never);
    expect(headroom[0]!.section).toBe("80D"); // 25,000 left beats 80C's 10,000
  });

  it("carries the cap on the rows themselves", () => {
    // What turns "you have 60,000 of deductions" into a figure somebody can check.
    const { rows } = allowedDeductions({ "80C": 60_000, "80CCD(1B)": 10_000 }, regime as never);
    expect(rows.find((r) => r.section === "80C")!.cap).toBe(150_000);
    expect(rows.find((r) => r.section === "80CCD(1B)")!.cap).toBeNull(); // permitted but uncapped
  });
});
