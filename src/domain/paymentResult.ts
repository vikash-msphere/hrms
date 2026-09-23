// What the bank did with the payout file, matched back onto the run that produced it.
//
// `bank_file_at` records the moment the money left; nothing recorded what happened next. A wrong account
// number, a closed account or a bank-side rejection was discovered when the employee said they had not been
// paid - which is late, and which puts the person owed the money in charge of noticing.
//
// THIS FILE IS THE MATCHING, not the parsing. Every bank returns a different file, exactly as every bank
// takes a different one (services/bankFormats.ts holds the outbound shapes), so the caller hands over rows
// that have already been read out of whatever arrived. Keeping the two apart means a new bank is a parser and
// not a change to how a payment is reconciled.
//
// WHAT IT REFUSES TO GUESS. A row that names nobody the run paid is reported as unmatched rather than
// dropped: a response file that does not line up with the run is the single loudest sign that somebody has
// uploaded the wrong file, and silently ignoring the rows that did not fit would turn that into "nothing
// happened".

/** One line read out of a bank's response, already normalised by whatever parsed it. */
export type PaymentResultRow = {
  /** The employee the run paid. Matching is on the employee rather than on a bank reference, because the
   *  reference is the bank's and a file that omits it is common; the run knows who it paid. */
  employeeId: string;
  status: "paid" | "failed" | "returned";
  /** The bank's own reference, so a failure can be chased in their terms. */
  reference?: string | null;
  /** Why it did not land, in the bank's words - "account closed" and "name mismatch" send different people
   *  to do different things, so the reason is the whole value of a failure row. */
  reason?: string | null;
};

export type PaymentMatch = {
  employeeId: string;
  status: "paid" | "failed" | "returned";
  reference: string | null;
  reason: string | null;
};

export type PaymentReconciliation = {
  /** Rows that name somebody this run paid. These are the writes. */
  matched: PaymentMatch[];
  /** Rows naming somebody the run did not pay. Almost always the wrong file for the run. */
  unmatched: string[];
  /** People the run paid who the response says nothing about - sent, nothing heard. Not a failure, and not a
   *  success either, which is why it is counted separately rather than defaulted to one of them. */
  unreported: string[];
  counts: { paid: number; failed: number; returned: number; unreported: number };
};

/**
 * Line up a bank response against the people a run actually paid.
 *
 * `payable` is the set of employees the payout file carried - not everybody in the run, because a zero-net
 * row was never sent and cannot come back.
 *
 * A DUPLICATE ROW FOR ONE PERSON takes the LAST word: banks re-send corrections, and a later line about the
 * same payment is the newer fact. Taking the first would make a re-sent file assert the failure it was sent
 * to retract.
 */
export function reconcilePayments(payable: ReadonlySet<string>, rows: readonly PaymentResultRow[]): PaymentReconciliation {
  const byEmployee = new Map<string, PaymentMatch>();
  const unmatched: string[] = [];

  for (const r of rows) {
    if (!payable.has(r.employeeId)) {
      unmatched.push(r.employeeId);
      continue;
    }
    byEmployee.set(r.employeeId, {
      employeeId: r.employeeId,
      status: r.status,
      reference: r.reference?.trim() || null,
      reason: r.reason?.trim() || null,
    });
  }

  const matched = [...byEmployee.values()];
  const unreported = [...payable].filter((id) => !byEmployee.has(id)).sort();
  return {
    matched,
    unmatched: [...new Set(unmatched)].sort(),
    unreported,
    counts: {
      paid: matched.filter((m) => m.status === "paid").length,
      failed: matched.filter((m) => m.status === "failed").length,
      returned: matched.filter((m) => m.status === "returned").length,
      unreported: unreported.length,
    },
  };
}
