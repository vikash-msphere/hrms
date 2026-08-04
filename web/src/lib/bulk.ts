import { invoke } from "@/api";
import { idOf } from "@/lib/utils";

// The shape every bulk-actionable row shares: an id path, optimistic-concurrency etag, per-object verb hints.
export type BulkRow = { path: string; etag?: string; access?: { can?: string[] } };

/** Run a custom verb over many rows, tolerating per-row failures (a stale etag or per-object ACL on one row
 *  must not abort the rest). Returns counts for the caller's summary toast. */
export type BulkResult<R extends BulkRow = BulkRow> = {
  ok: number;
  failed: number;
  firstError?: string;
  okRows: R[];
  failedRows: R[];
};

export async function bulkInvoke<R extends BulkRow>(
  collection: string,
  verb: string,
  rows: R[],
  body?: Record<string, unknown>
): Promise<BulkResult<R>> {
  const results = await Promise.allSettled(rows.map((r) => invoke(`${collection}/${idOf(r.path)}`, verb, r.etag, body)));
  const okRows: R[] = [];
  const failedRows: R[] = [];
  let firstError: string | undefined;
  results.forEach((res, i) => {
    if (res.status === "fulfilled") okRows.push(rows[i]!);
    else {
      failedRows.push(rows[i]!);
      firstError ??= (res.reason as Error)?.message;
    }
  });
  return { ok: okRows.length, failed: failedRows.length, firstError, okRows, failedRows };
}

/** Merge several per-collection BulkResults (a mixed selection spans collections) into one summary. */
export function mergeBulkResults<R extends BulkRow>(parts: BulkResult<R>[]): BulkResult<R> {
  return {
    ok: parts.reduce((n, p) => n + p.ok, 0),
    failed: parts.reduce((n, p) => n + p.failed, 0),
    firstError: parts.find((p) => p.firstError)?.firstError,
    okRows: parts.flatMap((p) => p.okRows),
    failedRows: parts.flatMap((p) => p.failedRows),
  };
}

/** Standard summary-toast copy for a bulk verb run: "Approved 4" / "Approved 3 · 1 failed (...)". */
export function bulkSummary(pastTense: string, r: { ok: number; failed: number; firstError?: string }): {
  title: string;
  description?: string;
  variant: "success" | "destructive";
} {
  if (r.failed === 0) return { title: `${pastTense} ${r.ok}`, variant: "success" };
  return {
    title: `${pastTense} ${r.ok} · ${r.failed} failed`,
    description: r.firstError,
    variant: r.ok > 0 ? "success" : "destructive",
  };
}
