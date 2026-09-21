/// <reference types="vite/client" />
// A payroll run posted as a journal, and the assertion that it balances.
//
// The balance is the reason this exists. Debits equal credits is a complete arithmetic check over the whole
// pricing engine expressed in one comparison, so the tests that matter are the ones asserting it holds over
// shapes nobody wrote by hand - and the ones asserting the journal is REFUSED rather than quietly made to
// balance by leaving money out.
import { describe, it, expect } from "vitest";
import { buildJournal, type ComponentAccounts, type JournalItem } from "../src/domain/payrollJournal";
import type { Line } from "../src/domain/payroll";

const GL = { netPayable: "2100", rounding: "6999" };

const accounts = (): ComponentAccounts => new Map([
  ["BASIC", { glCode: "6010", name: "Basic" }],
  ["HRA", { glCode: "6011", name: "HRA" }],
  ["EPF", { glCode: "2201", name: "Provident Fund" }],
  ["TDS", { glCode: "2301", name: "Tax deducted at source" }],
  ["ER_EPF", { glCode: "6110", name: "Employer PF" }],
  ["PERQ_LOAN", { glCode: null, name: "Loan perquisite" }],
]);

const earn = (code: string, amount: number): Line => ({ code, name: code, kind: "earning", amount });
const deduct = (code: string, amount: number): Line => ({ code, name: code, kind: "deduction", amount });
const employer = (code: string, amount: number): Line => ({ code, name: code, kind: "employer_contribution", amount });

/** One item whose net is computed the way `computeRunItem` computes it, so the fixture cannot be inconsistent
 *  with the thing the journal is checking. */
const item = (employeeId: string, departmentId: string | null, lines: Line[]): JournalItem => {
  const gross = lines.filter((l) => l.kind === "earning").reduce((s, l) => s + l.amount, 0);
  const deductions = lines.filter((l) => l.kind === "deduction").reduce((s, l) => s + l.amount, 0);
  return { employeeId, departmentId, lines, net: Math.round((gross - deductions) * 100) / 100 };
};

const at = (j: ReturnType<typeof buildJournal>, account: string, department: string | null = null) =>
  j.lines.find((l) => l.account === account && l.department === department);

describe("buildJournal", () => {
  it("posts a month and balances", () => {
    const j = buildJournal(
      [item("a", "eng", [earn("BASIC", 50_000), earn("HRA", 20_000), deduct("EPF", 1_800), deduct("TDS", 8_000), employer("ER_EPF", 1_800)])],
      accounts(),
      GL,
    );
    expect(j.balanced).toBe(true);
    expect(j.residual).toBe(0);
    expect(j.unmapped).toEqual([]);

    // Earnings debit their expense account, against the cost centre the item was stamped with.
    expect(at(j, "6010", "eng")).toMatchObject({ debit: 50_000, credit: 0 });
    // Employee deductions credit a liability.
    expect(at(j, "2301", "eng")).toMatchObject({ debit: 0, credit: 8_000 });
    // Net pay is the balancing payable, and org-wide: the company owes one person one amount, whatever cost
    // centre carried the expense.
    expect(at(j, "2100", null)).toMatchObject({ debit: 0, credit: 60_200 });
  });

  it("posts an employer contribution to BOTH sides", () => {
    // The company incurs the cost AND owes it to somebody. Posting only the expense would leave the entry
    // short by the contribution, and posting only the liability would understate what the month cost.
    const j = buildJournal([item("a", null, [earn("BASIC", 10_000), employer("ER_EPF", 1_200)])], accounts(), GL);
    expect(at(j, "6110", null)).toMatchObject({ debit: 1_200, credit: 1_200 });
    expect(j.balanced).toBe(true);
  });

  it("posts nothing for a perquisite", () => {
    // Taxable VALUE the employee never receives in cash. It moves the tax base, not the money, so posting it
    // would invent a transaction - and it is deliberately NOT reported as unmapped despite having no account.
    const perq: Line = { code: "PERQ_LOAN", name: "Loan perquisite", kind: "perquisite", amount: 900 };
    const j = buildJournal([item("a", null, [earn("BASIC", 10_000), perq])], accounts(), GL);
    expect(at(j, "6010", null)).toMatchObject({ debit: 10_000 });
    expect(j.unmapped).toEqual([]);
    expect(j.balanced).toBe(true);
  });

  it("credits the wage account for loss of pay rather than debiting elsewhere", () => {
    // A negative earning is docked pay. It REDUCES the expense, so it belongs on the other side of the same
    // account; inventing a "loss of pay" expense would overstate both the wage bill and the contra.
    const j = buildJournal([item("a", null, [earn("BASIC", 10_000), earn("LOP", -2_000)])], new Map([
      ["BASIC", { glCode: "6010", name: "Basic" }],
      ["LOP", { glCode: "6010", name: "Loss of pay" }],
    ]), GL);
    expect(at(j, "6010", null)).toMatchObject({ debit: 10_000, credit: 2_000 });
    expect(at(j, "2100", null)).toMatchObject({ credit: 8_000 });
    expect(j.balanced).toBe(true);
  });

  it("sums one line per account per cost centre, not one per employee", () => {
    const j = buildJournal(
      [
        item("a", "eng", [earn("BASIC", 10_000)]),
        item("b", "eng", [earn("BASIC", 20_000)]),
        item("c", "sales", [earn("BASIC", 30_000)]),
      ],
      accounts(),
      GL,
    );
    expect(j.lines.filter((l) => l.account === "6010").length).toBe(2); // one per department, not three
    expect(at(j, "6010", "eng")!.debit).toBe(30_000);
    expect(at(j, "6010", "sales")!.debit).toBe(30_000);
    expect(j.balanced).toBe(true);
  });

  it("REFUSES rather than balancing by leaving money out", () => {
    // THE CASE THAT MATTERS MOST. An unmapped component silently dropped would still produce an entry whose
    // debits equal its credits - it would simply be an entry for less money than the run actually paid. So an
    // unmapped code makes `balanced` false even when the arithmetic of what remains adds up.
    const partial: ComponentAccounts = new Map([["BASIC", { glCode: "6010", name: "Basic" }]]);
    const j = buildJournal([item("a", null, [earn("BASIC", 10_000), earn("HRA", 5_000)])], partial, GL);
    expect(j.unmapped).toEqual(["HRA"]);
    expect(j.balanced).toBe(false);
  });

  it("refuses when the organisation has mapped no net-pay account", () => {
    // Nowhere to post the payable is the same problem as an unmapped component: the entry would be all debits.
    const j = buildJournal([item("a", null, [earn("BASIC", 10_000)])], accounts(), { netPayable: "" });
    expect(j.balanced).toBe(false);
    expect(j.residual).not.toBe(0);
  });

  it("sends the payout rounding line to its own account", () => {
    // ROUND is an earning by construction, but it is not salary expense - posting it to the wage account
    // would overstate the wage bill by a few paise a month for ever.
    const j = buildJournal([item("a", null, [earn("BASIC", 10_000), earn("ROUND", 0.4)])], accounts(), GL);
    expect(at(j, "6999", null)).toMatchObject({ debit: 0.4 });
    expect(at(j, "6010", null)!.debit).toBe(10_000);
    expect(j.balanced).toBe(true);
  });

  it("reports the rounding line as unmapped when no rounding account is set", () => {
    const j = buildJournal([item("a", null, [earn("BASIC", 10_000), earn("ROUND", 0.4)])], accounts(), { netPayable: "2100" });
    expect(j.unmapped).toEqual(["ROUND"]);
    expect(j.balanced).toBe(false);
  });

  it("balances an empty run", () => {
    const j = buildJournal([], accounts(), GL);
    expect(j.lines).toEqual([]);
    expect(j.balanced).toBe(true);
    expect(j.residual).toBe(0);
  });

  it("balances over randomly generated runs", () => {
    // THE PROPERTY, not an example. The entry balances by construction whenever the pricing is right, so any
    // shape that produces a residual has found a posting rule this file got wrong - which is exactly what a
    // hand-written case cannot be relied on to contain.
    let seed = 20260921;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const money = () => Math.round(rnd() * 500_000) / 100;

    for (let round = 0; round < 200; round++) {
      const built: JournalItem[] = [];
      const people = Math.floor(rnd() * 6);
      for (let p = 0; p < people; p++) {
        const lines: Line[] = [earn("BASIC", money())];
        if (rnd() > 0.4) lines.push(earn("HRA", money()));
        if (rnd() > 0.5) lines.push(deduct("EPF", money()));
        if (rnd() > 0.5) lines.push(deduct("TDS", money()));
        if (rnd() > 0.6) lines.push(employer("ER_EPF", money()));
        // Docked pay: a negative earning, the sign case most likely to be got backwards.
        if (rnd() > 0.7) lines.push(earn("BASIC", -money()));
        built.push(item(`e${p}`, pick(["eng", "sales", null]), lines));
      }
      const j = buildJournal(built, accounts(), GL);
      expect(j.residual).toBe(0);
      expect(j.unmapped).toEqual([]);
    }
  });
});
