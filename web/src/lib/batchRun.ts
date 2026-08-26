// Running one per-record write over a list, honestly.
//
// Year-end work is a list: Form 16 for everyone, an increment letter for forty people. The server's verbs are
// per-employee (each one renders a PDF and files a document), so the client walks the list - sequentially, on
// purpose: these are heavy calls, and a burst of forty parallel renders is what trips the platform's
// subrequest limits and turns a slow job into a failed one.
//
// The other half is honesty. A batch where record 12 fails must not report success, and must not stop either:
// each failure is collected with the name it belongs to, so the caller can say exactly who was missed.

export type BatchFailure = { label: string; message: string };
export type BatchProgress = { done: number; total: number; failures: BatchFailure[]; current?: string };

export async function runSequential<T>(
  items: T[],
  label: (item: T) => string,
  run: (item: T) => Promise<unknown>,
  onProgress?: (p: BatchProgress) => void,
): Promise<BatchProgress> {
  const failures: BatchFailure[] = [];
  let done = 0;
  for (const item of items) {
    onProgress?.({ done, total: items.length, failures: [...failures], current: label(item) });
    try {
      await run(item);
    } catch (e) {
      failures.push({ label: label(item), message: e instanceof Error ? e.message : String(e) });
    }
    done++;
  }
  const final = { done, total: items.length, failures };
  onProgress?.(final);
  return final;
}

/** "38 of 40 done, 2 couldn't be" - the one sentence a batch owes its operator. */
export function batchSummary(p: BatchProgress, noun: string): string {
  const ok = p.done - p.failures.length;
  if (p.failures.length === 0) return `${ok} ${ok === 1 ? noun : `${noun}s`} done.`;
  return `${ok} of ${p.total} done; ${p.failures.length} couldn't be.`;
}
