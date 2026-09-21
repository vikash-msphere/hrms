// The two payout-fraud checks, as arithmetic over FINGERPRINTS rather than account numbers.
//
// Handing the bank file over is where the money actually leaves, and it was the one step in the module with
// nothing looking at where it is going. Two things are worth catching there, and both are classics:
//
//   THE SAME ACCOUNT FOR TWO PEOPLE. Either a copy-paste typo, in which case one person is not paid and
//   another is paid twice, or a diversion. Rare enough to be worth stopping every time it happens.
//   AN ACCOUNT THAT CHANGED since the run that last paid this person. Entirely legitimate - people move bank -
//   and also the single highest-signal event in payroll fraud, which is why it wants a human to say yes
//   rather than being refused or ignored.
//
// WHY FINGERPRINTS. Comparing the numbers would mean holding a list of decrypted account numbers to compare,
// and reporting a match would mean naming one. A fingerprint answers "same or different" and answers nothing
// else: it cannot be read back into an account number, it is what gets STORED on the run item for the next
// run to compare against, and the message a human sees names PEOPLE rather than digits.
//
// This file is pure and takes fingerprints already computed, so nothing here ever sees an account number.

/** A run item's payout, reduced to what the checks read. */
export type PayoutRow = { employeeId: string; label: string; fingerprint: string };

export type PayoutFinding =
  // Two or more people in this run share one destination account.
  | { kind: "shared_account"; employees: string[]; labels: string[] }
  // This person's destination account is not the one the last run paid them at.
  | { kind: "account_changed"; employeeId: string; label: string };

/**
 * Both checks over one run's payout rows.
 *
 * `previous` maps an employee to the fingerprint the last run that paid them used; an employee absent from it
 * has no payment history here and cannot have changed anything, which is the correct answer for a joiner
 * rather than something to flag.
 */
export function checkPayouts(rows: readonly PayoutRow[], previous: ReadonlyMap<string, string>): PayoutFinding[] {
  const out: PayoutFinding[] = [];

  // Shared accounts. Grouped by fingerprint so the finding names everybody involved in one message - telling
  // somebody "this account is shared" twice, once per person, makes them look for two problems.
  const byAccount = new Map<string, PayoutRow[]>();
  for (const r of rows) {
    const held = byAccount.get(r.fingerprint);
    if (held) held.push(r);
    else byAccount.set(r.fingerprint, [r]);
  }
  for (const group of byAccount.values()) {
    if (group.length < 2) continue;
    out.push({
      kind: "shared_account",
      employees: group.map((g) => g.employeeId),
      labels: group.map((g) => g.label).sort(),
    });
  }

  for (const r of rows) {
    const before = previous.get(r.employeeId);
    if (before && before !== r.fingerprint) {
      out.push({ kind: "account_changed", employeeId: r.employeeId, label: r.label });
    }
  }
  return out;
}

/** The message a human reads before deciding. Names people, never numbers - which is the whole reason the
 *  comparison is done on fingerprints. */
export function describePayoutFindings(findings: readonly PayoutFinding[]): string[] {
  return findings.map((f) =>
    f.kind === "shared_account"
      ? `${f.labels.join(" and ")} are being paid into the same account`
      : `${f.label}'s bank account has changed since the last run that paid them`,
  );
}
