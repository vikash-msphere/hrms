/// <reference types="vite/client" />
// Where the money is about to go, checked before the file that sends it exists.
//
// Both findings are things that are legitimate SOMETIMES and fraud occasionally, which is what decides the
// design: neither can be refused outright without a control people route around, and neither should pass
// unremarked. So the tests here are as much about what is NOT flagged - a joiner with no history, a cosmetic
// re-typing of the same account - as about what is.
import { describe, it, expect } from "vitest";
import { checkPayouts, describePayoutFindings, type PayoutRow } from "../src/domain/payoutCheck";

const row = (employeeId: string, label: string, fingerprint: string): PayoutRow => ({ employeeId, label, fingerprint });
const kinds = (fs: ReturnType<typeof checkPayouts>) => fs.map((f) => f.kind).sort();

describe("checkPayouts", () => {
  it("says nothing about an ordinary run", () => {
    const rows = [row("a", "Asha", "h1"), row("b", "Ravi", "h2")];
    expect(checkPayouts(rows, new Map([["a", "h1"], ["b", "h2"]]))).toEqual([]);
  });

  it("finds two people being paid into one account", () => {
    // Either a copy-paste typo - one person unpaid, another paid twice - or a diversion. Both want stopping.
    const rows = [row("a", "Asha", "same"), row("b", "Ravi", "same"), row("c", "Meera", "other")];
    const findings = checkPayouts(rows, new Map());
    expect(findings.length).toBe(1);
    expect(findings[0]).toMatchObject({ kind: "shared_account" });
    expect((findings[0] as { labels: string[] }).labels).toEqual(["Asha", "Ravi"]);
  });

  it("reports one shared account once, naming everybody on it", () => {
    // Saying it per person makes a reader look for three problems where there is one.
    const rows = [row("a", "Asha", "same"), row("b", "Ravi", "same"), row("c", "Meera", "same")];
    const findings = checkPayouts(rows, new Map());
    expect(findings.length).toBe(1);
    expect((findings[0] as { labels: string[] }).labels).toEqual(["Asha", "Meera", "Ravi"]);
  });

  it("finds an account that changed since the last run that paid somebody", () => {
    const findings = checkPayouts([row("a", "Asha", "new")], new Map([["a", "old"]]));
    expect(findings).toEqual([{ kind: "account_changed", employeeId: "a", label: "Asha" }]);
  });

  it("says nothing about somebody with no payment history", () => {
    // A joiner cannot have changed an account they have never been paid into, and flagging their first
    // payment would put every new starter in the list every month somebody joins.
    expect(checkPayouts([row("a", "Asha", "h1")], new Map())).toEqual([]);
  });

  it("says nothing when the account is unchanged", () => {
    expect(checkPayouts([row("a", "Asha", "h1")], new Map([["a", "h1"]]))).toEqual([]);
  });

  it("finds both kinds in one run", () => {
    const rows = [row("a", "Asha", "same"), row("b", "Ravi", "same")];
    expect(kinds(checkPayouts(rows, new Map([["a", "old"]])))).toEqual(["account_changed", "shared_account"]);
  });

  it("describes findings by naming people, never numbers", () => {
    // THE PROPERTY THE FINGERPRINT EXISTS FOR. A reader is told who to ask, and the account number is not in
    // the message, the comparison or the stored column.
    const rows = [row("a", "Asha", "same"), row("b", "Ravi", "same")];
    const lines = describePayoutFindings(checkPayouts(rows, new Map([["a", "old"]])));
    expect(lines).toContain("Asha and Ravi are being paid into the same account");
    expect(lines).toContain("Asha's bank account has changed since the last run that paid them");
    for (const line of lines) expect(line).not.toMatch(/\d{6,}/); // no account-number-shaped digits anywhere
  });
});
