// What changed in this payroll run, in a sentence.
//
// DETERMINISTIC, AND THAT IS THE DESIGN RATHER THAN A FALLBACK. The plan's version of this item (6) used the
// `analyticsNarrate` shape - arithmetic finds the movements, a model phrases them - which for payroll needs a
// third `CONSENTED_PATHS` entry, because `payroll-runs` is on the denied list and `assertMayReachModel`
// throws. That entry is not worth spending here: the sentence below is built from the SAME decomposition the
// reconciliation statement already computes, and a model rephrasing five labelled figures adds wording, not
// information. `services/budgetNarrate.ts` documents the same reasoning from the other side - budgets are not
// denied, so the model path cost nothing to argue there.
//
// ONE SOURCE OF TRUTH ABOUT WHAT MOVED. Everything here reads `domain/payrollReconcile.ts`'s output and
// computes no comparison of its own. A second, cruder run-to-run diff would eventually disagree with the
// statement on the same screen, and the reader would have no way to tell which was right. The reconciliation
// is exhaustive by construction (its residual is zero or it is a bug), so a sentence over it cannot omit a
// movement that exists.
import { MOVEMENT_ORDER, type MovementKey, type Reconciliation } from "./payrollReconcile";

/** How each movement reads inside a sentence - shorter than `MOVEMENT_LABEL`, which heads a table column. */
const PHRASE: Readonly<Record<MovementKey, (n: number) => string>> = {
  joiners: (n) => `${n} ${n === 1 ? "joiner" : "joiners"}`,
  leavers: (n) => `${n} ${n === 1 ? "leaver" : "leavers"}`,
  recurring: (n) => `pay changes for ${n} ${n === 1 ? "person" : "people"}`,
  added: (n) => `one-off pay for ${n} ${n === 1 ? "person" : "people"}`,
  dropped: (n) => `one-offs ending for ${n} ${n === 1 ? "person" : "people"}`,
};

export type PayrollNarration = {
  text: string;
  /** The movements the sentence is built from, largest first, so a caller can render them beside the prose. */
  drivers: { key: MovementKey; employees: number; amount: number }[];
  /** Absent when there was no previous run to compare against. */
  compared: boolean;
};

const round0 = (n: number) => Math.round(n);

/** Money as a bare rounded number. The CALLER formats currency: this module has no access to the org's
 *  currency and a hard-coded symbol here would be wrong for every org that does not use it. */
const fmt = (n: number): string => String(Math.abs(round0(n)));

/**
 * The sentence, from a reconciliation.
 *
 * Reads as: the direction and size of the whole movement, then the two or three drivers that account for
 * most of it, largest by absolute amount. Not every movement - five clauses is a table read aloud, which is
 * the thing `budgetNarrate` also refuses.
 *
 * `maxDrivers` is a parameter rather than a constant because the run page and a digest line want different
 * lengths from the same arithmetic.
 */
export function narrateRun(r: Reconciliation, maxDrivers = 3): PayrollNarration {
  const delta = round0(r.closing.gross - r.opening.gross);
  // Every movement that actually moved something, largest first. A zero-amount movement with a headcount
  // (somebody joined and somebody left at the same wage) is still not a DRIVER of the total, so it is not
  // named here - the statement below it shows the headcount either way.
  const drivers = r.movements
    .filter((m) => round0(m.amount) !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map((m) => ({ key: m.key, employees: m.employees, amount: m.amount }));

  // No previous run. Saying "unchanged" would be a claim about a comparison that never happened.
  if (!r.opening.employees && !r.opening.gross) {
    return {
      text: `First run to compare against: ${r.closing.employees} ${r.closing.employees === 1 ? "person" : "people"}, ${fmt(r.closing.gross)} gross.`,
      drivers,
      compared: false,
    };
  }

  if (delta === 0 && !drivers.length) {
    return { text: "Gross is unchanged from the previous run, with nothing moving underneath it.", drivers, compared: true };
  }

  // A zero NET movement with drivers underneath it is the interesting case, not a boring one: a raise exactly
  // offset by a leaver reads as "nothing happened" to anybody looking only at the total.
  const head = delta === 0
    ? "Gross is unchanged from the previous run, but not because nothing moved"
    : `Gross is ${delta > 0 ? "up" : "down"} ${fmt(delta)} on the previous run`;

  // Ordered by size for the sentence, then re-sorted into MOVEMENT_ORDER so the clause order matches the
  // statement's own rows - a reader comparing the two should not have to re-map them.
  const named = drivers.slice(0, Math.max(1, maxDrivers));
  const ordered = [...named].sort((a, b) => MOVEMENT_ORDER.indexOf(a.key) - MOVEMENT_ORDER.indexOf(b.key));
  const clauses = ordered.map((d) => `${PHRASE[d.key](d.employees)} (${d.amount > 0 ? "+" : "-"}${fmt(d.amount)})`);

  // "and" before the last clause, commas before the rest. Two clauses take no comma.
  const list = clauses.length === 1
    ? clauses[0]!
    : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;

  const rest = drivers.length - named.length;
  const tail = rest > 0 ? `, plus ${rest} smaller ${rest === 1 ? "movement" : "movements"}` : "";
  return { text: `${head}: ${list}${tail}.`, drivers, compared: true };
}
