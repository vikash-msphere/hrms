// Importing a corporate card statement and reconciling it against the claims people filed.
//
// The matching rule itself is pure and lives in domain/cardStatement.ts. This file is the part that touches
// the database: making an import idempotent, bounding what it reads, and writing the match back.
//
// WHAT THIS DELIBERATELY DOES NOT DO: parse a card issuer's file format. The import takes rows that have
// already been turned into (date, amount, merchant, reference) - the SPA does that for a CSV, and a
// per-issuer parser belongs beside services/bankFormats.ts, which already holds exactly that kind of
// column-mapping configuration for the outbound direction. Writing one blind, with no real statement to test
// against, would be inventing a format rather than supporting one.
import { and, eq, gte, lte, inArray, isNull, isNotNull, desc, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { round2 } from "../domain/money";
import { allocFlatCode } from "./codeAlloc";
import { byIdChunks } from "../lib/dbBatch";
import { reconcileStatement, POSTING_LAG_DAYS, type MatchCandidate, type StatementRow } from "../domain/cardStatement";

/** One row as the caller hands it over, already out of whatever file it arrived in. */
export type ImportedRow = {
  posted_on: string; // YYYY-MM-DD
  amount: number;
  merchant?: string | null;
  reference?: string | null;
  card_last4?: string | null;
  employee?: string | null; // "employees/<id>", when the caller can resolve the cardholder
};

const dayMs = (s: string) => Date.parse(`${s}T00:00:00Z`);

/** How far back automatic matching looks. A year covers a statement imported late, a claim filed slowly and
 *  a whole financial year's tidy-up, without letting one permanently-unexplained charge from three years ago
 *  decide the cost of reconciling this month. */
const RECONCILE_LOOKBACK_DAYS = 365;

/**
 * The key that makes importing the same statement twice a no-op.
 *
 * Derived from the row's own content rather than from a line number, because the same charge appears at a
 * different position in an overlapping statement period - which is the normal way people re-import. Where the
 * issuer gives a reference it does the work on its own; where it does not, the card, the date, the amount and
 * the merchant together are what identifies a charge.
 *
 * Two genuinely separate identical charges on one card on one day at one merchant collapse to a single row
 * under this key, and that is a real limitation rather than an oversight: nothing in the data distinguishes
 * them, and inventing a distinction (an index within the upload) would make a re-import duplicate everything.
 * An issuer reference is what solves it properly, which is why it is preferred when present.
 */
export function importKeyFor(row: { cardLast4?: string | null; postedOn: number; amount: number; merchant?: string | null; reference?: string | null }): string {
  const card = (row.cardLast4 ?? "").trim().toLowerCase();
  const ref = (row.reference ?? "").trim().toLowerCase();
  if (ref) return `${card}|ref:${ref}`;
  const day = new Date(row.postedOn).toISOString().slice(0, 10);
  const merchant = (row.merchant ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${card}|${day}|${round2(row.amount).toFixed(2)}|${merchant}`;
}

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

/**
 * Store a batch of statement rows, skipping any already held.
 *
 * Returns what happened rather than a count alone: an importer that says "42 imported" when 40 were already
 * there has told somebody nothing about whether the upload worked.
 */
export async function importStatement(deps: Deps, actor: AppUser, rows: ImportedRow[]): Promise<{ imported: number; duplicates: number }> {
  if (!rows.length) throw invalidArgument("the statement has no rows");
  const prepared = rows.map((r) => {
    const postedOn = dayMs(r.posted_on);
    if (Number.isNaN(postedOn)) throw invalidArgument(`"${r.posted_on}" is not a date (expected YYYY-MM-DD)`);
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount === 0) throw invalidArgument("every statement row needs a non-zero amount");
    return {
      postedOn,
      amount: round2(amount),
      merchant: r.merchant?.trim() || null,
      reference: r.reference?.trim() || null,
      cardLast4: r.card_last4?.trim() || null,
      employeeId: idFromPath(r.employee) ?? null,
    };
  });

  // One read for the whole batch: which of these keys do we already hold? Cheaper than a failed insert per
  // row, and it lets the answer distinguish "already imported" from "imported now".
  const keys = prepared.map((p) => importKeyFor(p));
  const held = new Set(
    (await byIdChunks(keys, (group) =>
      deps.db.select({ importKey: schema.cardTransactions.importKey }).from(schema.cardTransactions).where(inArray(schema.cardTransactions.importKey, group)),
    )).map((r) => r.importKey),
  );

  let imported = 0;
  // Also de-duplicated WITHIN the batch: a file that lists the same charge twice would otherwise fail the
  // unique index halfway through and leave a partial import.
  const seen = new Set<string>();
  for (let i = 0; i < prepared.length; i++) {
    const key = keys[i]!;
    if (held.has(key) || seen.has(key)) continue;
    seen.add(key);
    const p = prepared[i]!;
    await deps.db.insert(schema.cardTransactions).values({
      code: await allocFlatCode(deps, schema.cardTransactions),
      ...p,
      // The column is a timestamp; `prepared` carries UTC ms because that is what the key derivation and the
      // matcher both work in.
      postedOn: new Date(p.postedOn),
      importKey: key,
    });
    imported++;
  }
  await audit(deps, actor, "card_transaction.import", "card-transactions", undefined, { rows: rows.length, imported, duplicates: rows.length - imported });
  return { imported, duplicates: rows.length - imported };
}

/**
 * Match the unmatched transactions against the claims that might account for them, and write the pairings.
 *
 * BOUNDED BY THE TRANSACTIONS, not by the expense ledger: the candidate read is the date span the unmatched
 * rows actually cover, widened by the posting lag, rather than every expense the org has ever filed. Without
 * that this would be the unbounded scan `duplicateClaimOf` had to be rescued from.
 *
 * Only expenses NOT already accounted for by another transaction are candidates, so running this twice cannot
 * move a claim from one charge to another.
 */
export async function reconcileCardStatement(deps: Deps, actor: AppUser, asOf: Date = new Date()): Promise<{ matched: number; unmatchedRows: number; unmatchedExpenses: number }> {
  // BOUNDED, and it has to be. "Every transaction with no claim behind it" grows for ever: a charge nobody
  // ever files against stays unmatched permanently, so the set only accumulates. Worse, the candidate read
  // below spans the transactions it is given - so ONE ancient unmatched row would widen the expense read to
  // every claim between then and now, and the cost of reconciling this month's statement would grow with the
  // age of the oldest thing nobody ever explained.
  //
  // Older rows are not abandoned: they are exactly what `unclaimedCardCharges` lists, and a late claim filed
  // against one can still be linked by hand. What they stop being is a candidate for AUTOMATIC matching,
  // which is right - the matcher's own date window is days, so an old charge could only ever have paired with
  // an equally old claim, and if that pairing existed it would have been made when the charge was current.
  const since = new Date(asOf.getTime() - RECONCILE_LOOKBACK_DAYS * 86_400_000);
  const open = await deps.db
    .select()
    .from(schema.cardTransactions)
    .where(and(isNull(schema.cardTransactions.expenseId), gte(schema.cardTransactions.postedOn, since)))
    .orderBy(desc(schema.cardTransactions.postedOn));
  if (!open.length) return { matched: 0, unmatchedRows: 0, unmatchedExpenses: 0 };

  const lag = POSTING_LAG_DAYS * 86_400_000;
  const from = new Date(Math.min(...open.map((t) => t.postedOn.getTime())) - lag);
  const to = new Date(Math.max(...open.map((t) => t.postedOn.getTime())) + lag);

  const taken = new Set(
    (await deps.db
      .select({ expenseId: schema.cardTransactions.expenseId })
      .from(schema.cardTransactions)
      .where(isNotNull(schema.cardTransactions.expenseId))
    ).map((r) => r.expenseId!),
  );
  const claims = (await deps.db
    .select({ uuid: schema.expenses.uuid, incurredOn: schema.expenses.incurredOn, amount: schema.expenses.amount, description: schema.expenses.description, vendorId: schema.expenses.vendorId })
    .from(schema.expenses)
    .where(and(
      eq(schema.expenses.isRecurring, false),
      inArray(schema.expenses.state, ["DRAFT", "SUBMITTED", "APPROVED", "PAID"]),
      gte(schema.expenses.incurredOn, from),
      lte(schema.expenses.incurredOn, to),
    )))
    .filter((e) => !taken.has(e.uuid));

  // The payee as a person would read it: the vendor's name where there is one, else whatever the claim says
  // it was for.
  const vendorIds = [...new Set(claims.map((c) => c.vendorId).filter((v): v is string => !!v))];
  const vendorName = new Map(
    vendorIds.length
      ? (await deps.db.select({ uuid: schema.vendors.uuid, name: schema.vendors.name }).from(schema.vendors).where(inArray(schema.vendors.uuid, vendorIds))).map((v) => [v.uuid, v.name])
      : [],
  );

  const rows: StatementRow[] = open.map((t) => ({ id: t.uuid, postedOn: t.postedOn.getTime(), amount: t.amount, merchant: t.merchant }));
  const candidates: MatchCandidate[] = claims.map((c) => ({
    id: c.uuid,
    incurredOn: c.incurredOn ? c.incurredOn.getTime() : null,
    amount: c.amount,
    payee: (c.vendorId ? vendorName.get(c.vendorId) : null) ?? c.description ?? null,
  }));

  const result = reconcileStatement(rows, candidates);
  const at = new Date();
  for (const m of result.matches) {
    await deps.db
      .update(schema.cardTransactions)
      .set({ expenseId: m.expenseId, matchConfidence: m.confidence, matchedAt: at, updatedAt: at })
      // Guarded on the row still being unmatched, so two reconciles running at once cannot both claim it.
      .where(and(eq(schema.cardTransactions.uuid, m.rowId), isNull(schema.cardTransactions.expenseId)));
  }
  if (result.matches.length) {
    await audit(deps, actor, "card_transaction.reconcile", "card-transactions", undefined, {
      matched: result.matches.length,
      exact: result.matches.filter((m) => m.confidence === "exact").length,
    });
  }
  return { matched: result.matches.length, unmatchedRows: result.unmatchedRows.length, unmatchedExpenses: result.unmatchedExpenses.length };
}

/**
 * Charges nobody has filed a claim for, older than the grace period - item 39's chase.
 *
 * A grace period rather than "any unmatched row", because a charge from yesterday is not a delinquency, it is
 * a charge from yesterday. Named by cardholder where the statement resolved one, because the useful form of
 * this is a question to a person and not a total.
 */
export async function unclaimedCardCharges(deps: Deps, olderThanDays = 14, asOf: Date = new Date()) {
  const cutoff = new Date(asOf.getTime() - olderThanDays * 86_400_000);
  return deps.db
    .select()
    .from(schema.cardTransactions)
    .where(and(isNull(schema.cardTransactions.expenseId), lte(schema.cardTransactions.postedOn, cutoff)))
    .orderBy(desc(schema.cardTransactions.postedOn));
}

/**
 * The same question as `unclaimedCardCharges`, asked as a COUNT rather than as a list.
 *
 * The close checklist wants "how many, worth how much" and nothing else, and loading every unmatched charge
 * ever recorded in order to length-and-sum it in the isolate is the shape this module refuses elsewhere. The
 * chase list still returns rows, because naming the cardholder is the point of it; a checklist line is not.
 */
export async function unclaimedCardTotals(deps: Deps, olderThanDays = 14, asOf: Date = new Date()): Promise<{ count: number; amount: number }> {
  const cutoff = new Date(asOf.getTime() - olderThanDays * 86_400_000);
  const row = (await deps.db
    .select({
      count: sql<number>`count(*)`,
      amount: sql<number>`coalesce(sum(${schema.cardTransactions.amount}), 0)`,
    })
    .from(schema.cardTransactions)
    .where(and(isNull(schema.cardTransactions.expenseId), lte(schema.cardTransactions.postedOn, cutoff))))[0];
  return { count: Number(row?.count ?? 0), amount: round2(Number(row?.amount ?? 0)) };
}

/** Link or unlink a charge by hand. A person overruling the matcher is recorded as `manual`, so an approver
 *  can tell "the amount and the week agreed" from "somebody said so". */
export async function setCardTransactionMatch(deps: Deps, actor: AppUser, id: string, expensePath: string | null) {
  const row = (await deps.db.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.uuid, id)).limit(1))[0];
  if (!row) throw notFound("card transaction not found");
  const expenseId = idFromPath(expensePath) ?? null;
  if (expenseId) {
    const claim = (await deps.db.select({ uuid: schema.expenses.uuid }).from(schema.expenses).where(eq(schema.expenses.uuid, expenseId)).limit(1))[0];
    if (!claim) throw invalidArgument("that expense is unavailable");
  }
  const at = new Date();
  const [updated] = await deps.db
    .update(schema.cardTransactions)
    .set({ expenseId, matchConfidence: expenseId ? "manual" : null, matchedAt: expenseId ? at : null, updatedAt: at })
    .where(eq(schema.cardTransactions.uuid, id))
    .returning();
  await audit(deps, actor, "card_transaction.match", "card-transactions", id, { expense: expensePath ?? null }, updated);
  return updated!;
}
