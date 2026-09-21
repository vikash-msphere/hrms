// Which rows in a payroll run somebody should actually look at, and why.
//
// The run already compares itself with the previous one at the level of four totals. Payroll mistakes are not
// totals: a proration bug, a missed component, an EMI that started a month early or a grade change applied to
// the wrong person all land as ONE person's net moving, while the org figure moves by an amount nobody would
// look twice at. A reviewer with a 240-row table and no pointer reads the first screen and approves.
//
// TWO HALVES, and the second is what makes the first usable. Finding a movement is subtraction. Saying WHY it
// moved is what stops the flag sending somebody to four other pages - and the causes are already in the line
// arrays being compared, so the reason costs nothing beyond looking. A flag with no identified cause is not a
// failure of this file; it is the most interesting row in the run, and it says so.
//
// WHAT THIS IS NOT. It does not score, rank or judge a person - it points at arithmetic that changed. The
// threshold is the org's, because the trade-off is symmetric and somebody who knows their own payroll should
// set it: too loose and the band cries wolf every month until people stop opening it, too strict and the one
// wrong row goes out.
import { round2 } from "./money";
import type { Line } from "./payroll";

/** Why a row is worth a look. Ordered by how much a reviewer should care, which is also the sort order. */
export type VarianceKind =
  | "net_moved_gross_flat" // the same wage, a different take-home: a deduction changed
  | "net_moved"
  | "gross_moved"
  | "component_added"
  | "component_removed"
  | "first_run"; // no history to compare against - not a variance, a row to confirm once

export type VarianceFlag = {
  employeeId: string;
  kind: VarianceKind;
  /** Signed, in currency. Zero for `first_run`, where there is nothing to have moved. */
  delta: number;
  /** The move as a fraction of the baseline, for sorting and for saying "12% down". */
  fraction: number;
  /** What changed in the line set, in plain words. Empty when nothing in the lines explains it, which is
   *  itself the finding: a move with no identified cause is the row to open first. */
  reasons: string[];
};

/** One run item as the comparison reads it. */
export type VarianceItem = { employeeId: string; lines: Line[]; gross: number; net: number };

/** How far a person's pay may move from their own recent median before it is worth a look. A fraction, and
 *  the org's to set; 0.15 is a starting point rather than a finding. */
export const DEFAULT_VARIANCE_FRACTION = 0.15;

/** Ignore movements smaller than this in absolute terms however large the fraction, so a person paid a token
 *  amount one month does not produce a flag for a few rupees. */
const MIN_ABSOLUTE_MOVE = 100;

const KIND_RANK: Record<VarianceKind, number> = {
  net_moved_gross_flat: 0,
  net_moved: 1,
  gross_moved: 2,
  component_added: 3,
  component_removed: 4,
  first_run: 5,
};

// What a line code means when it appears, disappears or moves. Keyed by the codes services/payroll.ts emits,
// because a reason is only useful if it names the thing the reviewer would go and look at.
const CAUSE: Record<string, string> = {
  LOP: "unpaid leave",
  ARREARS: "backdated raise arrears",
  LOAN: "loan or advance recovery",
  BONUS: "a bonus",
  OVERTIME: "overtime",
  REIMB: "a reimbursement payout",
  ENCASH: "leave encashment",
  TDS: "a change in tax withheld",
  EPF: "a change in provident fund",
  ESI: "a change in ESI",
  PT: "a change in professional tax",
  BASIC: "a change in basic pay",
};

const byCode = (lines: readonly Line[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (l.kind === "employer_contribution" || l.kind === "perquisite") continue; // neither is paid or withheld
    out.set(l.code, round2((out.get(l.code) ?? 0) + l.amount));
  }
  return out;
};

/** The median of a person's own recent figures. A median rather than a mean for the reason it always is here:
 *  one unusual month - a bonus, a month of unpaid leave - would drag a mean far enough to hide the next real
 *  movement behind it, or to invent one. */
function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Flag the rows in `current` worth a reviewer's attention, against each person's own recent history.
 *
 * `history` is that employee's trailing items, most recent first; an employee absent from it is on their first
 * run here and is reported as `first_run` rather than as a movement - their "delta" against nothing would be
 * their whole salary, which is true and useless.
 */
export function findVariances(
  current: readonly VarianceItem[],
  history: ReadonlyMap<string, readonly VarianceItem[]>,
  fraction: number = DEFAULT_VARIANCE_FRACTION,
): VarianceFlag[] {
  const limit = Math.max(0, fraction);
  const out: VarianceFlag[] = [];

  for (const item of current) {
    const past = history.get(item.employeeId) ?? [];
    if (!past.length) {
      out.push({ employeeId: item.employeeId, kind: "first_run", delta: 0, fraction: 0, reasons: ["no earlier run to compare against"] });
      continue;
    }
    const netBase = median(past.map((p) => p.net));
    const grossBase = median(past.map((p) => p.gross));
    const netDelta = round2(item.net - netBase);
    const grossDelta = round2(item.gross - grossBase);
    const netFraction = netBase > 0 ? netDelta / netBase : 0;
    const grossFraction = grossBase > 0 ? grossDelta / grossBase : 0;

    // Compared against the MOST RECENT prior run, not the median: "which lines changed" is a question about
    // the step from last month, while "is this figure unusual" is a question about the person's normal.
    const now = byCode(item.lines);
    const then = byCode(past[0]!.lines);
    const reasons: string[] = [];
    const appeared: string[] = [];
    const vanished: string[] = [];
    for (const [code, amount] of now) {
      const before = then.get(code);
      if (before === undefined) { appeared.push(code); reasons.push(`${CAUSE[code] ?? code} started`); }
      else if (Math.abs(round2(amount - before)) >= 1) reasons.push(`${CAUSE[code] ?? code}`);
    }
    for (const code of then.keys()) {
      if (!now.has(code)) { vanished.push(code); reasons.push(`${CAUSE[code] ?? code} stopped`); }
    }

    const netMoved = Math.abs(netFraction) >= limit && Math.abs(netDelta) >= MIN_ABSOLUTE_MOVE;
    const grossMoved = Math.abs(grossFraction) >= limit && Math.abs(grossDelta) >= MIN_ABSOLUTE_MOVE;

    // THE MOST INFORMATIVE SHAPE FIRST. Gross flat while net moved means the wage did not change and a
    // deduction did - which is where a wrongly-started EMI, a new statutory line or a tax swing hides, and it
    // is exactly the case an org-total comparison can never show.
    if (netMoved && !grossMoved) {
      out.push({ employeeId: item.employeeId, kind: "net_moved_gross_flat", delta: netDelta, fraction: netFraction, reasons });
    } else if (netMoved) {
      out.push({ employeeId: item.employeeId, kind: "net_moved", delta: netDelta, fraction: netFraction, reasons });
    } else if (grossMoved) {
      out.push({ employeeId: item.employeeId, kind: "gross_moved", delta: grossDelta, fraction: grossFraction, reasons });
    } else if (appeared.length) {
      // A component that appeared without moving the totals enough to trip the threshold is still a change to
      // what somebody is paid, and it is cheap to say so.
      out.push({ employeeId: item.employeeId, kind: "component_added", delta: netDelta, fraction: netFraction, reasons });
    } else if (vanished.length) {
      out.push({ employeeId: item.employeeId, kind: "component_removed", delta: netDelta, fraction: netFraction, reasons });
    }
  }

  // Worst shape first, then biggest move. A reviewer works down this list and stops when they are satisfied,
  // so the order is the whole of the prioritisation.
  return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || Math.abs(b.delta) - Math.abs(a.delta));
}

// ---- Why my pay is different this month (item 8) --------------------------------------------------------

/** How one component moved between two payslips. `before` is 0 for a line that was not there. */
export type PayChange = { code: string; name: string; kind: Line["kind"]; before: number; now: number; delta: number };

export type PayExplanation = {
  changes: PayChange[];
  /** A sentence per change, in the same vocabulary the run review uses, so the employee and the payroll
   *  officer are reading the same words about the same event. */
  reasons: string[];
  netBefore: number;
  netNow: number;
  netDelta: number;
};

/**
 * What changed between an employee's last payslip and this one, component by component.
 *
 * The most common payroll question in any organisation, and the app already holds both answers - it has
 * simply never subtracted them. The value is the JOIN, not the prose: somebody who can see that their net
 * fell by the exact amount of a new loan line has their answer, and somebody who cannot see that raises a
 * ticket.
 *
 * Employer contributions and perquisites are excluded for the same reason they are everywhere else: neither
 * is paid to the employee nor withheld from them, so neither explains a change in what they received.
 */
export function explainPay(current: readonly Line[], previous: readonly Line[]): PayExplanation {
  const relevant = (l: Line) => l.kind === "earning" || l.kind === "deduction";
  const index = (lines: readonly Line[]) => {
    const out = new Map<string, { name: string; kind: Line["kind"]; amount: number }>();
    for (const l of lines) {
      if (!relevant(l)) continue;
      const held = out.get(l.code);
      out.set(l.code, { name: l.name, kind: l.kind, amount: round2((held?.amount ?? 0) + l.amount) });
    }
    return out;
  };
  const now = index(current);
  const before = index(previous);

  const changes: PayChange[] = [];
  for (const code of new Set([...now.keys(), ...before.keys()])) {
    const a = before.get(code);
    const b = now.get(code);
    const delta = round2((b?.amount ?? 0) - (a?.amount ?? 0));
    if (delta === 0) continue;
    changes.push({ code, name: b?.name ?? a?.name ?? code, kind: b?.kind ?? a?.kind ?? "earning", before: a?.amount ?? 0, now: b?.amount ?? 0, delta });
  }
  // Biggest effect on take-home first: a deduction that grew and an earning that shrank both reduce pay, so
  // the sort is by the direction the money actually moved rather than by the raw delta.
  const effect = (c: PayChange) => (c.kind === "deduction" ? -c.delta : c.delta);
  changes.sort((x, y) => Math.abs(effect(y)) - Math.abs(effect(x)));

  const netOf = (lines: readonly Line[]) =>
    round2(lines.filter((l) => l.kind === "earning").reduce((s, l) => s + l.amount, 0) -
      lines.filter((l) => l.kind === "deduction").reduce((s, l) => s + l.amount, 0));
  const netBefore = netOf(previous);
  const netNow = netOf(current);

  return {
    changes,
    reasons: changes.map((c) => {
      const cause = CAUSE[c.code] ?? c.name;
      if (c.before === 0) return `${cause} started`;
      if (c.now === 0) return `${cause} stopped`;
      return `${cause} ${c.delta > 0 ? "went up" : "went down"}`;
    }),
    netBefore,
    netNow,
    netDelta: round2(netNow - netBefore),
  };
}

// ---- The pre-flight gate (item 3) ------------------------------------------------------------------------

/** One reason a run should not be approved yet. `blocking` decides whether it stops the transition or is
 *  merely said: "net greater than gross" is arguably a bug in this app, while "no bank account" is arguably a
 *  person paid by cheque, and the difference is a judgement rather than a severity. */
export type PreflightIssue = { employeeId: string | null; code: string; detail: string; blocking: boolean };

export type PreflightInput = {
  items: readonly VarianceItem[];
  /** Employees with no bank account on file, by id. */
  missingBankAccount: ReadonlySet<string>;
  /** Line codes the build could not price. */
  unpriced: readonly string[];
  /** Employees who had tax withheld in the previous run, by id - a zero this month is worth a question. */
  taxedLastRun: ReadonlySet<string>;
};

/**
 * Everything that should be true before a run is approved.
 *
 * AT THE TRANSITION, not at bank-file time. Discovering a missing account number while producing the payout
 * file means the run is already approved and the fix is a rebuild; every check here is cheap and every one of
 * them is something somebody finds out eventually, later and more expensively.
 */
export function preflight(input: PreflightInput): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  for (const it of input.items) {
    if (it.net < 0) {
      out.push({ employeeId: it.employeeId, code: "negative_net", detail: `net is ${round2(it.net)}`, blocking: true });
    } else if (it.net === 0 && it.gross > 0) {
      // Earned something and takes home nothing: legitimate under heavy recovery, and never what anybody
      // intended without knowing. Said, not blocked.
      out.push({ employeeId: it.employeeId, code: "zero_net", detail: "earned this period but takes home nothing", blocking: false });
    }
    if (round2(it.net) > round2(it.gross)) {
      // Net above gross is not a policy question - the arithmetic is wrong.
      out.push({ employeeId: it.employeeId, code: "net_above_gross", detail: `net ${round2(it.net)} exceeds gross ${round2(it.gross)}`, blocking: true });
    }
    if (input.missingBankAccount.has(it.employeeId) && it.net > 0) {
      out.push({ employeeId: it.employeeId, code: "no_bank_account", detail: "payable, but no bank account on file", blocking: false });
    }
    const hasTax = it.lines.some((l) => l.code === "TDS" && l.amount > 0);
    if (!hasTax && input.taxedLastRun.has(it.employeeId)) {
      out.push({ employeeId: it.employeeId, code: "tax_stopped", detail: "tax was withheld last run and none is this run", blocking: false });
    }
  }
  for (const code of input.unpriced) {
    out.push({ employeeId: null, code: "unpriced_component", detail: `${code} could not be priced`, blocking: false });
  }
  return out;
}
