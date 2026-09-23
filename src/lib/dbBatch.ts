import type { DB } from "../deps";

// One D1 round-trip for a group of writes. D1 executes a batch as a single implicit transaction, so the
// group is ATOMIC (all-or-nothing) as well as cheap: N statements cost ONE subrequest against the
// per-invocation budget (50 on the free plan) instead of N. This is the write-side primitive the payroll
// build, run deletion and cron fan-outs are shaped around - collect statements, flush once.
//
// Statements are drizzle query builders passed UNAWAITED (a builder only executes when awaited or batched).
// The D1 100-bound-params-per-statement cap still applies to each statement individually - build multi-row
// inserts with `insertBatches` (which MEASURES the cap instead of guessing at columns) and chunk inArray
// lists (~90 ids) BEFORE pushing them here; chunked statements inside one batch still cost the one subrequest.
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

/** D1 binds at most this many parameters per statement. Not a tunable - exceeding it is `D1_ERROR: too many
 *  SQL variables`, which is a runtime failure the size of whatever batch happened to be large enough. */
export const PARAM_CAP = 100;

/**
 * Multi-row INSERTs for `rows`, split so each statement stays inside the parameter cap.
 *
 * The row count per statement is MEASURED off the real query rather than guessed from the columns the caller
 * sets: drizzle also binds every JS-defaulted column (uuid, created_at, updated_at), so a 13-field object is
 * a 15-parameter row - and counting by hand is exactly how "too many SQL variables" ships. `build` turns one
 * group into one statement, so it stays the caller's query.
 *
 *   await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.assets).values(group)));
 */
export function insertBatches<T extends object>(rows: T[], build: (group: T[]) => BatchStmt): BatchStmt[] {
  if (!rows.length) return [];
  // Measured off the union of the rows' DEFINED keys, not off whichever row has the most keys.
  //
  // What drizzle actually emits is the whole table's column list once, and per row a parameter for every value
  // the row HAS and the literal `default` for the rest. So a row's cost is its own count of defined values -
  // and `Object.keys().length` is not that count: a key set to `undefined` is a key that binds nothing. Two
  // rows can therefore carry the same number of keys and bind a different number of parameters (measured on
  // `assets`: 8 keys each, 9 against 11), and picking by key count - keeping the first on a tie, as `reduce`
  // with `>` does - can land on the CHEAPER row. The group is then sized for 9 and filled with rows that bind
  // 11: `D1_ERROR: too many SQL variables`, on a list whose rows all looked the same width.
  //
  // The probe carries every key that is defined ANYWHERE in the list, so its measurement is at least what the
  // widest row binds. Keys that are `undefined` in every row are left out, because drizzle leaves them out of
  // the real statement too. Erring high costs an extra statement in a batch that is still one subrequest;
  // erring low costs the whole batch.
  const probe = {} as Record<string, unknown>;
  for (const row of rows) for (const [k, v] of Object.entries(row)) if (v !== undefined && !(k in probe)) probe[k] = v;
  const measured = build([probe as T]) as unknown as { toSQL?: () => { params: unknown[] } };
  const perRow = Math.max(1, measured.toSQL?.().params.length ?? PARAM_CAP);
  return chunk(rows, Math.max(1, Math.floor(PARAM_CAP / perRow))).map(build);
}

/**
 * Ids per `IN` list, for a read whose WHERE also binds a few parameters of its own.
 *
 * `inArray` spends one bound parameter per id against PARAM_CAP, so a list sized AT the cap leaves nothing for
 * anything else in the same statement - and the predicates that ride alongside an id list are exactly the ones
 * that bind: `applyScope` spends one for a dept/own breadth and two per per-object share or deny, a date window
 * spends two. That made the failure depend on WHO was asking: an `all`-breadth admin bound nothing extra and
 * was fine, while a department-scoped caller on a full page got `D1_ERROR: too many SQL variables`. The margin
 * is what those predicates are allowed to cost.
 */
export const ID_CHUNK = 90;

/**
 * Run one id-keyed read in cap-sized chunks and concatenate the rows.
 *
 * Takes a BUILDER rather than a table + column, for the same reason `insertBatches` does: the query stays the
 * caller's, so each reader keeps its own extra predicates - `isNull(delete_time)`, a scope, a date window - and
 * keeps drizzle's inferred row type instead of being widened to a generic. A list inside the cap runs as one
 * statement exactly as before; past it, chunks run in sequence, because two subrequests for a page of a hundred
 * is the right price for a statement that executes at all.
 */
export async function byIdChunks<T>(ids: string[], run: (group: string[]) => PromiseLike<T[]>): Promise<T[]> {
  if (!ids.length) return [];
  if (ids.length <= ID_CHUNK) return run(ids);
  const out: T[] = [];
  for (const group of chunk(ids, ID_CHUNK)) out.push(...(await run(group)));
  return out;
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
