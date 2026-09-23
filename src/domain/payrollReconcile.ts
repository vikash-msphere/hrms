// Why this month's payroll costs what it costs, as a statement that closes.
//
// The run already compares itself with the previous one at the level of four totals: headcount, gross, tax,
// net (`buildRunItems` writes them into the build audit). That says the gross moved by 4.2 lakh and stops. The
// reviewer's actual question is which movements add up to that figure, and the app holds everything needed to
// answer it - two sets of per-employee line arrays - and has never subtracted them.
//
// THE DECOMPOSITION IS EXHAUSTIVE BY CONSTRUCTION. Every employee in either run falls into exactly one of
// joined / left / continuing, and every earning line of a continuing employee falls into exactly one of
// carried-over / added / dropped. So the movements sum to the gross difference exactly, and `residual` is
// always zero.
//
// That is the point rather than a weakness. A residual which is zero by construction turns the statement into
// a CHECK ON THIS FILE: if it ever prints a non-zero, the bucketing has a hole in it and the breakdown beside
// it is not to be trusted. It is the same argument as a journal that has to balance - the assertion is worth
// having precisely because it cannot fail while the arithmetic is right. test/payrollReconcile.test.ts holds
// it against generated shapes, and the service surfaces the number rather than hiding it.
//
// WHAT THIS IS NOT. It does not judge a movement, name a person, or decide that anything is wrong. A run with
// three joiners and a bonus cycle has a large, entirely correct gross movement, and the statement's job is to
// let a reviewer see that in one line instead of reconstructing it. Per-employee suspicion is a different
// feature with a different design (the variance sentinel), and deliberately not this one.
import { round2 } from "./money";
import type { Line } from "./payroll";

/** One run item, reduced to what reconciliation reads. `lines` is the parsed `lines_json`. */
export type RunItemSnapshot = { employeeId: string; lines: Line[] };

/** One row of the statement. `employees` is how many people contributed to it, which is what separates "one
 *  person's 8 lakh joining bonus" from "eighty people's raises" at the same amount. */
export type ReconcileMovement = {
  key: MovementKey;
  employees: number;
  amount: number;
};

export type MovementKey = "joiners" | "leavers" | "recurring" | "added" | "dropped";

/** Fixed order, because a statement is read top to bottom and the order is the argument: who arrived, who
 *  left, what changed for everyone who stayed, then the one-offs on top. */
export const MOVEMENT_ORDER: readonly MovementKey[] = ["joiners", "leavers", "recurring", "added", "dropped"];

export const MOVEMENT_LABEL: Readonly<Record<MovementKey, string>> = {
  joiners: "People this run pays who the last one did not",
  leavers: "People the last run paid who this one does not",
  recurring: "Pay changes for people in both runs",
  added: "Pay lines that appear only in this run",
  dropped: "Pay lines that appeared only in the last run",
};

export type Reconciliation = {
  opening: { employees: number; gross: number };
  closing: { employees: number; gross: number };
  movements: ReconcileMovement[];
  /** closing.gross - opening.gross - sum(movements). Zero whenever this file is correct; see the header. */
  residual: number;
  /** opening.employees + joiners - leavers - closing.employees. Zero for the same reason. */
  headcountResidual: number;
};

// Only earnings make gross. Deductions, employer contributions and perquisites are each their own question and
// folding them in here would produce a number that reconciles to nothing anybody is looking at.
const grossOf = (lines: readonly Line[]): number =>
  lines.reduce((sum, l) => (l.kind === "earning" ? sum + l.amount : sum), 0);

// A line's identity across two runs is its CODE, not its name: a component renamed between two months is the
// same component, and treating the rename as a dropped line plus an added one would report a raise and a cut
// that both happened to be the same size.
function earningsByCode(lines: readonly Line[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (l.kind !== "earning") continue;
    out.set(l.code, (out.get(l.code) ?? 0) + l.amount);
  }
  return out;
}

/**
 * Reconcile two runs' gross, and their headcount, into movements that sum exactly to the difference.
 *
 * `prior` may be empty, which is the first run an organisation ever builds: everybody is a joiner, which is
 * both true and the correct thing for the statement to say.
 */
export function reconcileRuns(prior: readonly RunItemSnapshot[], current: readonly RunItemSnapshot[]): Reconciliation {
  const before = new Map(prior.map((i) => [i.employeeId, i]));
  const after = new Map(current.map((i) => [i.employeeId, i]));

  const bucket: Record<MovementKey, { employees: Set<string>; amount: number }> = {
    joiners: { employees: new Set(), amount: 0 },
    leavers: { employees: new Set(), amount: 0 },
    recurring: { employees: new Set(), amount: 0 },
    added: { employees: new Set(), amount: 0 },
    dropped: { employees: new Set(), amount: 0 },
  };
  const add = (key: MovementKey, employeeId: string, amount: number) => {
    if (amount === 0) return;
    bucket[key].employees.add(employeeId);
    bucket[key].amount += amount;
  };

  // Membership, counted separately from money. `add` ignores a zero amount - a movement of nothing is not a
  // movement and should not put a name in a count - but ARRIVING is an event even when the arithmetic comes to
  // zero. Somebody who joined on the last day of the period and priced at nothing is still a joiner, and
  // counting them only when their gross was non-zero would leave `headcountResidual` non-zero for a run that
  // is entirely correct, which is the one thing that number must never do.
  const joinerIds = new Set<string>();
  const leaverIds = new Set<string>();

  for (const [employeeId, item] of after) {
    const was = before.get(employeeId);
    if (!was) {
      // A joiner's whole gross is the movement: there is no prior amount to take a delta against.
      joinerIds.add(employeeId);
      add("joiners", employeeId, grossOf(item.lines));
      continue;
    }
    const nowCodes = earningsByCode(item.lines);
    const wasCodes = earningsByCode(was.lines);
    for (const [code, amount] of nowCodes) {
      const previously = wasCodes.get(code);
      // A code in both runs moved by the difference (a raise, a proration, a changed EMI-free month); a code
      // only in this run is the whole of itself (a bonus, an arrear, an overtime payout).
      if (previously === undefined) add("added", employeeId, amount);
      else add("recurring", employeeId, amount - previously);
    }
    for (const [code, amount] of wasCodes) {
      if (!nowCodes.has(code)) add("dropped", employeeId, -amount);
    }
  }
  for (const [employeeId, item] of before) {
    // A leaver removes everything they were paid. Negative, so the statement reads as a sum throughout and a
    // reader never has to work out which rows to subtract.
    if (after.has(employeeId)) continue;
    leaverIds.add(employeeId);
    add("leavers", employeeId, -grossOf(item.lines));
  }

  const opening = { employees: before.size, gross: round2(prior.reduce((s, i) => s + grossOf(i.lines), 0)) };
  const closing = { employees: after.size, gross: round2(current.reduce((s, i) => s + grossOf(i.lines), 0)) };
  // Joiners and leavers are counted by membership; the other three by who actually moved.
  const headcountOf = (key: MovementKey) =>
    key === "joiners" ? joinerIds.size : key === "leavers" ? leaverIds.size : bucket[key].employees.size;
  const movements = MOVEMENT_ORDER.map((key) => ({
    key,
    employees: headcountOf(key),
    amount: round2(bucket[key].amount),
  }));

  // Summed from the ROUNDED movements, which is what a reader adds up on screen. Rounding each movement and
  // then checking against an unrounded difference would print a residual of a few paise and teach everybody to
  // ignore the one number that is supposed to always read zero.
  const moved = round2(movements.reduce((s, m) => s + m.amount, 0));
  return {
    opening,
    closing,
    movements,
    residual: round2(closing.gross - opening.gross - moved),
    headcountResidual: opening.employees + joinerIds.size - leaverIds.size - closing.employees,
  };
}
