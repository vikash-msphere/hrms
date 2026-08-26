// Universal GET coalescer. Two jobs:
//   1. Coalesce — reads fired within a short WINDOW are buffered and flushed as ONE `POST /v1/batch:run`.
//      A page's first load fires reads across SEVERAL React commits, not one: the shell's session providers
//      mount first, then the lazy page's code chunk resolves and mounts, then its tabs/nested widgets. A
//      microtask-only window groups a single commit, so each commit became its own batch:run (the 3-calls
//      bug). A brief time window instead spans those adjacent commits, collapsing them into one request.
//   2. Dedup — identical paths requested concurrently (or across StrictMode's double-mount, or by multiple
//      components) share ONE in-flight promise, so the same path is never fetched twice while pending.
// Generalises the photoCache queue/flush pattern to ALL collection/resource reads, zero per-page wiring.
//
// Parity with api(): resolves the sub-response body on 2xx (empty -> undefined like a 204), redirects on 401,
// rejects with an equivalent ApiError otherwise (so per-widget "404 -> empty" branches keep working).
import { ApiError, batchGet, type Problem } from "@/api";

const MAX = 20; // matches the batch:run sub-request cap; >MAX reads in a window split into multiple batches.
// KEEP AT 20 on the Cloudflare Workers FREE plan: each batch:run sub-request runs its own D1 queries (authz
// resolve + list + enrichment ≈ 1-3 subrequests), and a Worker invocation is capped at 50 subrequests total.
// ~20 subs is already near that ceiling; raising it risks whole-batch failure. Raising needs BOTH this and the
// server cap (routes/batch.ts) moved together, and really only pays off on Workers Paid.
// The window is a TRAILING one, not a fixed one from the first read.
//
// A page load does not fire its reads in a single burst: the shell's providers mount, then the lazy page chunk
// resolves and mounts, then a workspace's sibling tabs, then a widget whose parent had to render first. Those
// waves are milliseconds apart, but a FIXED window from the first read cuts wherever it happens to land - a wave
// arriving one millisecond late became its own `batch:run`, which is why pages showed several small batches.
//
// So each new read extends the window by IDLE_MS (waves keep merging while they keep coming), bounded by
// MAX_WAIT_MS from the first queued read so nothing is ever held for long. Both are imperceptible against a
// network read of tens to hundreds of ms; the cap is what stops a steady drip of reads from delaying the batch
// indefinitely.
//
// What this deliberately does NOT do is merge data-DEPENDENT reads - a widget that reads only after an earlier
// read resolves is a genuinely later phase, and its batch is a second round-trip by nature.
const IDLE_MS = 24; // quiet gap that ends a window
const MAX_WAIT_MS = 120; // hard cap from the first queued read

type Settler = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const inflight = new Map<string, Promise<unknown>>(); // path -> shared promise (dedup while pending)
const settlers = new Map<string, Settler>(); // path -> its resolve/reject
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let windowStart = 0; // when the current window's first read was queued

// `path` is the resource path WITHOUT the /v1 prefix, e.g. "employees?max_page_size=200" or "settings/dashboard".
export function coalescedGet<T>(path: string): Promise<T> {
  const existing = inflight.get(path);
  if (existing) return existing as Promise<T>; // already pending -> share it (no duplicate request)
  const p = new Promise<T>((resolve, reject) => {
    settlers.set(path, { resolve: resolve as (v: unknown) => void, reject });
  });
  inflight.set(path, p as Promise<unknown>);
  const now = Date.now();
  if (queue.length === 0) windowStart = now;
  queue.push(path);
  // Extend to the next quiet gap, but never past the cap (which may already have elapsed -> flush next tick).
  const wait = Math.max(0, Math.min(IDLE_MS, MAX_WAIT_MS - (now - windowStart)));
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, wait);
  return p;
}

function flush() {
  const paths = queue;
  queue = [];
  if (import.meta.env?.DEV && paths.length) {
    // What ended up in one request, and how long the window stayed open - the two things you need to see when a
    // page still makes several batches (a second batch here means a genuinely later, dependent read).
    console.debug(`[coalescer] batch:run x${paths.length} after ${Date.now() - windowStart}ms`, paths);
  }
  for (let i = 0; i < paths.length; i += MAX) {
    void runChunk(paths.slice(i, i + MAX));
  }
}

async function runChunk(paths: string[]) {
  try {
    const responses = await batchGet(paths.map((p) => `/v1/${p}`));
    paths.forEach((p, idx) => settle(p, responses[idx]));
  } catch (e) {
    paths.forEach((p) => fail(p, e)); // whole-batch failure: reject every waiter in the chunk
  }
}

function take(path: string): Settler | undefined {
  const s = settlers.get(path);
  settlers.delete(path);
  inflight.delete(path);
  return s;
}

function fail(path: string, e: unknown) {
  take(path)?.reject(e);
}

function settle(path: string, r: { status: number; body: unknown } | undefined) {
  const s = take(path);
  if (!s) return;
  if (!r) return s.reject(new ApiError("missing batch response", 0, null));
  if (r.status === 401) {
    window.location.href = "/"; // let Cloudflare Access re-challenge (mirrors api())
    return s.reject(new ApiError("unauthenticated", 401, null));
  }
  if (r.status >= 200 && r.status < 300) {
    return s.resolve(r.body === null || r.body === "" ? undefined : r.body);
  }
  const problem = (r.body && typeof r.body === "object" ? r.body : null) as Problem | null;
  s.reject(new ApiError(problem?.detail ?? problem?.title ?? `request failed (${r.status})`, r.status, problem));
}
