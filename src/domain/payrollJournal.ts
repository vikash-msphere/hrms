// A payroll run as a journal entry, and the assertion that it balances.
//
// The module's output stops at a bank file today, so somebody re-keys the month into the accounting system
// from a payslip summary. That is the single largest piece of manual work payroll creates here, and nothing in
// the app knows it is happening.
//
// WHY THE BALANCE CHECK IS THE POINT, and not an accounting nicety. Debits equal credits is a complete
// arithmetic check over the whole pricing engine, expressed in one comparison: if gross minus deductions does
// not equal net, or an employer contribution is costed without the liability it creates, the entry will not
// balance and the run says so before anybody posts it. This file is worth having even for an org that never
// imports the journal, because it is a correctness proof the app otherwise does not have.
//
// WHICH SIDE EACH LINE POSTS TO is derived from the component's `kind`, never stored, so the two cannot
// disagree:
//   earning                -> DEBIT  salary expense            (what the work cost)
//   deduction              -> CREDIT a liability or receivable (withheld now, discharged later)
//   employer_contribution  -> DEBIT  employer cost expense AND CREDIT the matching liability - both, because
//                             the company incurs the cost and owes it to somebody
//   net pay                -> CREDIT the payable the bank file discharges
//   perquisite             -> nothing. Taxable VALUE the employee never receives in cash; it moves the tax
//                             base, not the money, and posting it would invent a transaction.
//
// The entry then balances by construction whenever the pricing is right: gross debits equal the deduction
// credits plus net, because net IS gross minus deductions, and each employer contribution balances itself.
import { round2 } from "./money";
import type { Line } from "./payroll";

/** One side of one posting. `department` is the cost centre the line is attributed to, null for org-wide. */
export type JournalLine = {
  account: string;
  department: string | null;
  debit: number;
  credit: number;
  /** What the line is, for a human reading the export before importing it. */
  label: string;
};

export type Journal = {
  lines: JournalLine[];
  totalDebit: number;
  totalCredit: number;
  /** debit - credit. Zero whenever the pricing and this file are both right; see the header. */
  residual: number;
  balanced: boolean;
  /** Components the run priced that carry no `gl_code`. A journal is NOT produced while this is non-empty:
   *  dropping an unmapped component would leave an entry that balances by omitting money. */
  unmapped: string[];
};

/** The accounts that are not derived from a pay component, because they are not components. */
export type JournalAccounts = {
  /** What the company owes employees until the bank file discharges it. */
  netPayable: string;
  /** Where the sub-rupee difference between the priced net and the paid net goes. Optional: an org whose
   *  currency has no rounding line never needs it. */
  rounding?: string;
};

/** One run item, reduced to what posting reads. */
export type JournalItem = {
  employeeId: string;
  departmentId: string | null;
  lines: Line[];
  net: number;
};

/** The account a component posts to, by line code, plus its display name for the label. */
export type ComponentAccounts = Map<string, { glCode: string | null; name: string }>;

// The payout rounding adjustment is an EARNING line by construction (services/payroll.ts settles net to the
// currency's precision with an explicit line), but it is not salary expense - it is the rounding difference,
// and posting it to the wage account would overstate the wage bill by a few paise a month for ever.
const ROUNDING_CODE = "ROUND";

export function buildJournal(items: readonly JournalItem[], accounts: ComponentAccounts, gl: JournalAccounts): Journal {
  const unmapped = new Set<string>();
  // Keyed by account + department + side, because a journal is posted as one line per account per cost
  // centre, not one line per employee: an import with four hundred identical-account rows is a worse artefact
  // than the same entry summed, and the per-person detail is what the run's own item list is for.
  const byKey = new Map<string, JournalLine>();
  const post = (account: string | null, department: string | null, label: string, debit: number, credit: number) => {
    if (!account) return; // unmapped; recorded separately and the journal is refused
    if (debit === 0 && credit === 0) return;
    const key = `${account}|${department ?? ""}`;
    const held = byKey.get(key);
    if (held) {
      held.debit = round2(held.debit + debit);
      held.credit = round2(held.credit + credit);
      return;
    }
    byKey.set(key, { account, department, label, debit: round2(debit), credit: round2(credit) });
  };

  for (const item of items) {
    const dept = item.departmentId;
    for (const l of item.lines) {
      const mapped = accounts.get(l.code);
      const account = mapped?.glCode ?? null;
      const label = mapped?.name ?? l.name;
      // A perquisite moves the tax base and no money; posting it would invent a transaction.
      if (l.kind === "perquisite") continue;
      if (l.code === ROUNDING_CODE) {
        // The rounding difference, to its own account when the org named one. An earning by construction, so
        // a positive amount is a debit exactly as a wage line is.
        if (gl.rounding) post(gl.rounding, dept, "Payout rounding", Math.max(0, l.amount), Math.max(0, -l.amount));
        else unmapped.add(l.code);
        continue;
      }
      if (!account) { unmapped.add(l.code); continue; }
      if (l.kind === "earning") {
        // A NEGATIVE earning is loss of pay - docked wage. It reduces the expense, which is a credit to the
        // same account rather than a debit somewhere else.
        post(account, dept, label, Math.max(0, l.amount), Math.max(0, -l.amount));
      } else if (l.kind === "deduction") {
        post(account, dept, label, Math.max(0, -l.amount), Math.max(0, l.amount));
      } else if (l.kind === "employer_contribution") {
        // BOTH sides, and to the same account code: the expense the company incurs and the liability it now
        // owes. An org that wants them in separate accounts splits the component, which is a chart-of-accounts
        // decision rather than something this file should guess at.
        post(account, dept, label, Math.max(0, l.amount), 0);
        post(account, dept, label, 0, Math.max(0, l.amount));
      }
    }
    // The payable. Net is what the bank file will discharge, and it is org-wide rather than per department:
    // the company owes one amount to one person, whatever cost centre carried the expense.
    post(gl.netPayable, null, "Net pay payable", Math.max(0, -item.net), Math.max(0, item.net));
  }

  const lines = [...byKey.values()].sort((a, b) => a.account.localeCompare(b.account) || (a.department ?? "").localeCompare(b.department ?? ""));
  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  const residual = round2(totalDebit - totalCredit);
  return {
    lines,
    totalDebit,
    totalCredit,
    residual,
    // Compared to the paisa, because both sides are already rounded. A residual of a few paise is still a
    // refusal: it means the pricing and this posting disagree, and "nearly balances" is not a thing a journal
    // can be.
    balanced: residual === 0 && unmapped.size === 0,
    unmapped: [...unmapped].sort(),
  };
}
