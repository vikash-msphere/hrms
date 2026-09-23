// Matching a card statement against the expenses people filed, and saying what is left over on each side.
//
// This inverts the module. Today filing an expense is something a person has to remember to do, and the app
// has no idea what they forgot: an unclaimed transaction is invisible because nothing in the database knows
// it happened. Once the statement is imported, the STATEMENT is the list - the rows nobody has filed are the
// work, and the claims with no transaction behind them are the ones to ask about.
//
// PURE, and deliberately: the matching rule is the whole feature, it is the thing most likely to be argued
// with, and it should be testable without a statement file or a database.
//
// NOTHING HERE DECIDES ANYTHING ABOUT A PERSON. A match is a statement about two records; an unmatched
// transaction is a statement about paperwork. The word "unmatched" is doing no work beyond "we cannot see a
// claim for this", which is why the chase in item 39 names a cardholder and asks, rather than concluding.
import { round2 } from "./money";

/** A row off the statement, already parsed out of whatever format the card issuer sends. */
export type StatementRow = {
  id: string;
  /** The date the card issuer posted it, as UTC ms. */
  postedOn: number;
  amount: number;
  merchant: string | null;
};

/** An expense that could account for a statement row. `payee` is the vendor name where there is one, else the
 *  description - whatever a person would read as "who was this paid to". */
export type MatchCandidate = {
  id: string;
  /** The date the claim says the money was spent, as UTC ms. Null when nobody recorded one. */
  incurredOn: number | null;
  amount: number;
  payee: string | null;
};

/**
 * How far apart the two dates may be.
 *
 * A card POSTS a transaction days after it is made - a weekend, a foreign merchant, a hotel holding the
 * authorisation until checkout. Five days covers the ordinary lag without being so wide that two genuinely
 * separate charges of the same amount start claiming each other.
 */
export const POSTING_LAG_DAYS = 5;

/** Within a day, and with a recognisable merchant, is a different quality of answer from "same amount, same
 *  week". Both are offered; only the caller decides whether a `likely` one is worth a person's glance. */
export type MatchConfidence = "exact" | "likely";

export type StatementMatch = { rowId: string; expenseId: string; confidence: MatchConfidence; daysApart: number };

export type StatementReconciliation = {
  matches: StatementMatch[];
  /** Statement rows with no claim behind them: the expenses nobody has filed. */
  unmatchedRows: string[];
  /** Claims with no statement row behind them: filed against a card but never charged to it, or paid another way. */
  unmatchedExpenses: string[];
};

const DAY = 86_400_000;

/**
 * Merchant text reduced to comparable tokens.
 *
 * Card descriptors are not names: "SQ *THE COFFEE CO 4471", "AMZN Mktp IN*2A4BC", "UBER   *TRIP". So the
 * comparison keeps alphabetic tokens of three letters or more and throws away the issuer's prefixes, the
 * reference numbers and the padding. It is a weak signal by design - it never creates a match on its own, it
 * only promotes one the amount and the date have already made.
 */
export function merchantTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const skip = new Set(["the", "ltd", "llc", "inc", "pvt", "limited", "and", "for", "com", "www"]);
  return new Set(
    text.toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !skip.has(t)),
  );
}

/** Do these two descriptions share a recognisable word? Not a similarity score: one shared token is the whole
 *  test, because a card descriptor rarely keeps more than one word of the real name. */
export function merchantAgrees(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = merchantTokens(a);
  if (!left.size) return false;
  for (const token of merchantTokens(b)) if (left.has(token)) return true;
  return false;
}

/**
 * Reconcile a statement against the claims that might account for it.
 *
 * THE AMOUNT IS NON-NEGOTIABLE. Two records of the same purchase agree on what it cost; if they do not, they
 * are not the same purchase, whatever else lines up. Everything else - the date window, the merchant - only
 * chooses BETWEEN candidates that already agree on the amount.
 *
 * ONE TO ONE. A statement row accounts for exactly one claim and a claim for exactly one row, so two identical
 * charges on the same day need two claims to clear them both. Without that, one filed lunch would silently
 * clear both of the week's identical lunches and the second would vanish from the list of things to file -
 * which is precisely the work this exists to surface.
 *
 * The assignment is greedy over candidates sorted best-first, which is not guaranteed optimal in the abstract
 * but is the right behaviour here: the sort puts exact matches ahead of likely ones and nearer dates ahead of
 * further, so a greedy pass takes the confident pairings first and leaves the ambiguous remainder unmatched
 * rather than guessing at it. Ties break on the ids so the same statement reconciles the same way every time.
 */
export function reconcileStatement(
  rows: readonly StatementRow[],
  candidates: readonly MatchCandidate[],
  lagDays: number = POSTING_LAG_DAYS,
): StatementReconciliation {
  type Pair = { row: StatementRow; candidate: MatchCandidate; confidence: MatchConfidence; daysApart: number };
  const pairs: Pair[] = [];

  for (const row of rows) {
    for (const candidate of candidates) {
      if (candidate.incurredOn === null) continue; // nothing to compare a date against
      if (Math.abs(round2(candidate.amount) - round2(row.amount)) > 0.005) continue;
      const daysApart = Math.round(Math.abs(row.postedOn - candidate.incurredOn) / DAY);
      if (daysApart > lagDays) continue;
      // A claim filed for a date AFTER the card posted it is possible (somebody typing the wrong date) but it
      // is not the ordinary direction, so it stays `likely` however close it is.
      const sameish = daysApart <= 1 && candidate.incurredOn <= row.postedOn;
      const confidence: MatchConfidence = sameish && merchantAgrees(row.merchant, candidate.payee) ? "exact" : "likely";
      pairs.push({ row, candidate, confidence, daysApart });
    }
  }

  pairs.sort((a, b) =>
    (a.confidence === b.confidence ? 0 : a.confidence === "exact" ? -1 : 1)
    || a.daysApart - b.daysApart
    || a.row.id.localeCompare(b.row.id)
    || a.candidate.id.localeCompare(b.candidate.id));

  const takenRows = new Set<string>();
  const takenExpenses = new Set<string>();
  const matches: StatementMatch[] = [];
  for (const p of pairs) {
    if (takenRows.has(p.row.id) || takenExpenses.has(p.candidate.id)) continue;
    takenRows.add(p.row.id);
    takenExpenses.add(p.candidate.id);
    matches.push({ rowId: p.row.id, expenseId: p.candidate.id, confidence: p.confidence, daysApart: p.daysApart });
  }

  return {
    matches,
    unmatchedRows: rows.filter((r) => !takenRows.has(r.id)).map((r) => r.id),
    unmatchedExpenses: candidates.filter((c) => !takenExpenses.has(c.id)).map((c) => c.id),
  };
}
