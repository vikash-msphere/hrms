import type { DB } from "../deps";

// One D1 round-trip for a group of writes. D1 executes a batch as a single implicit transaction, so the
// group is ATOMIC (all-or-nothing) as well as cheap: N statements cost ONE subrequest against the
// per-invocation budget (50 on the free plan) instead of N. This is the write-side primitive the payroll
// build, run deletion and cron fan-outs are shaped around - collect statements, flush once.
//
// Statements are drizzle query builders passed UNAWAITED (a builder only executes when awaited or batched).
// The D1 100-bound-params-per-statement cap still applies to each statement individually - chunk multi-row
// inserts (~8 rows) and inArray lists (~90 ids) BEFORE pushing them here; chunked statements inside one
// batch still cost the one subrequest.
export type BatchStmt = PromiseLike<unknown>;

export async function runBatch(db: DB, stmts: BatchStmt[]): Promise<void> {
  if (!stmts.length) return;
  if (stmts.length === 1) {
    await stmts[0]!; // a lone statement needs no batch envelope
    return;
  }
  await db.batch(stmts as unknown as Parameters<DB["batch"]>[0]);
}

// A statement whose effect must be verified: `expect` is how many rows it MUST touch. Only meaningful for a
// statement built with `.returning(...)`, whose batch result is the array of rows it actually wrote.
export type CheckedStmt = { stmt: BatchStmt; expect: number; label: string };
const isChecked = (s: BatchStmt | CheckedStmt): s is CheckedStmt => typeof s === "object" && s !== null && "stmt" in s;

// Same single-round-trip batch as runBatch, but reports the labels of any checked statement that did NOT
// touch its expected number of rows. This is how a writer detects that a guarded write lost a race: the
// guard (e.g. "only if this payable is still unpaid") keeps the wrong write from landing, and the short
// count tells the caller its own view of the world was stale, so it can undo and fail loudly rather than
// ship a half-applied result. An empty return means every checked statement did exactly what it intended.
export async function runBatchChecked(db: DB, stmts: (BatchStmt | CheckedStmt)[]): Promise<string[]> {
  if (!stmts.length) return [];
  const plain = stmts.map((s) => (isChecked(s) ? s.stmt : s));
  const results: readonly unknown[] =
    plain.length === 1 ? [await plain[0]!] : await db.batch(plain as unknown as Parameters<DB["batch"]>[0]);
  const short: string[] = [];
  stmts.forEach((s, i) => {
    if (!isChecked(s)) return;
    const rows = results[i];
    if (!Array.isArray(rows) || rows.length !== s.expect) short.push(s.label);
  });
  return short;
}

/** Split `items` into runs of at most `size` (D1 param-cap chunking for IN lists / multi-row inserts). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Group rows by a key - the read-side companion of runBatch (one whole-table select, grouped in JS). */
export function groupBy<T>(rows: T[], key: (row: T) => string | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const arr = out.get(k);
    if (arr) arr.push(r);
    else out.set(k, [r]);
  }
  return out;
}
