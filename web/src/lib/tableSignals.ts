// Two readings of a table's own rows that no column can express on its own: which rows REPEAT each other,
// and which rows are unlike the rest of their population.
//
// WHY A SHARED FILE. Both were about to be written on five pages each (a double-claimed expense, a
// twice-registered asset serial, an invoice number a vendor sent twice, a check open three times as long as
// that vendor's usual), and both are easy to get subtly wrong: a duplicate check that ignores case finds
// nothing, a "twice the average" outlier check reports half the rows the moment one row is huge, because the
// one huge row is what moved the average.
//
// HOW PAGES USE THIS. An insight chip must narrow the table to exactly the rows it counted, and no filter
// grammar can say "is a duplicate". So the page turns the answer into a COLUMN: compute the flagged ids
// here, give the table a select column whose accessor reads the flag, and the chip then filters on that
// column like any other. The flag is a real column, so it sorts, exports, and can be turned off.

/**
 * Rows that share a key with at least one other row, keyed by that shared value.
 *
 * `keyOf` returns the identity being tested - usually several fields joined ("payee|amount|day") - or null
 * for a row that cannot take part (nothing to compare). Keys are compared case-insensitively with their
 * outer whitespace removed, because "ACME Ltd " and "acme ltd" are the duplicate everyone is looking for.
 */
export function duplicateGroups<T>(rows: T[], keyOf: (row: T) => string | null | undefined): Map<string, T[]> {
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const raw = keyOf(r);
    if (raw == null) continue;
    const key = String(raw).trim().toLowerCase();
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }
  for (const [key, bucket] of byKey) if (bucket.length < 2) byKey.delete(key);
  return byKey;
}

/** The ids of every row that repeats another, ready to back a flag column. */
export function duplicateIds<T>(rows: T[], keyOf: (row: T) => string | null | undefined, idOf: (row: T) => string): Set<string> {
  const out = new Set<string>();
  for (const bucket of duplicateGroups(rows, keyOf).values()) for (const r of bucket) out.add(idOf(r));
  return out;
}

/** The median of a list of numbers, or null when there is nothing to take a median of. */
export function median(values: number[]): number | null {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
}

/**
 * Rows whose value is far above the middle of their own population.
 *
 * Measured against the MEDIAN, not the mean, and only reported once there are enough rows for "the middle"
 * to mean anything (`minRows`, default 5). The mean is the wrong centre here by construction: the outlier
 * being hunted is the row that dragged the mean, so a mean-based test either misses it or, on a small set,
 * flags half the table with it.
 *
 * `factor` is how many times the median counts as far (default 3). `groupOf` compares a row against its OWN
 * population rather than the whole table - an expense against its category, a check against its vendor -
 * which is what makes the answer worth acting on: ₹40,000 is unremarkable for hardware and absurd for coffee.
 */
export function outlierIds<T>(
  rows: T[],
  {
    valueOf,
    idOf,
    groupOf,
    factor = 3,
    minRows = 5,
  }: {
    valueOf: (row: T) => number | null | undefined;
    idOf: (row: T) => string;
    groupOf?: (row: T) => string;
    factor?: number;
    minRows?: number;
  },
): Set<string> {
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    const v = valueOf(r);
    if (v == null || !Number.isFinite(Number(v))) continue;
    const key = groupOf ? groupOf(r) : "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  }
  const out = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < minRows) continue;
    const mid = median(bucket.map((r) => Number(valueOf(r))));
    if (mid == null || mid <= 0) continue; // a population centred on zero has no "times the middle"
    const cutoff = mid * factor;
    for (const r of bucket) if (Number(valueOf(r)) > cutoff) out.add(idOf(r));
  }
  return out;
}

/**
 * Count rows of another collection against a key, from what is loaded. The shape behind every "N with no X"
 * and "nothing references this" chip, written once so the pages that do it cannot each invent their own
 * handling of a missing key.
 */
export function countBy<T>(rows: T[], keyOf: (row: T) => string | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}
