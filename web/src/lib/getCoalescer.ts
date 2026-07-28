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
// Coalescing window (ms). Long enough to span the mount commits of one page load (shell providers -> lazy
// page chunk -> nested widgets) so they share one batch; short enough to be imperceptible against a network
// read (tens to hundreds of ms). 32ms (up from 16) spans slower mount cascades on slower devices / slower
// chunk parse, so a page's reads collapse into ONE batch:run instead of spilling into a second window. It does
// NOT (and should not) merge data-DEPENDENT reads a widget fires only after an earlier read resolves - those
// are a genuinely later phase. A cold reload whose page chunk arrives after the window still gets its own
// batch - that JS round-trip is inherent to code-splitting, not a coalescing miss.
const WINDOW_MS = 32;

type Settler = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const inflight = new Map<string, Promise<unknown>>(); // path -> shared promise (dedup while pending)
const settlers = new Map<string, Settler>(); // path -> its resolve/reject
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

// `path` is the resource path WITHOUT the /v1 prefix, e.g. "employees?max_page_size=200" or "settings/dashboard".
export function coalescedGet<T>(path: string): Promise<T> {
  const existing = inflight.get(path);
  if (existing) return existing as Promise<T>; // already pending -> share it (no duplicate request)
  const p = new Promise<T>((resolve, reject) => {
    settlers.set(path, { resolve: resolve as (v: unknown) => void, reject });
  });
  inflight.set(path, p as Promise<unknown>);
  queue.push(path);
  if (timer == null) timer = setTimeout(() => { timer = null; flush(); }, WINDOW_MS);
  return p;
}

function flush() {
  const paths = queue;
  queue = [];
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
