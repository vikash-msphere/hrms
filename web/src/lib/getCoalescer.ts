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
import { ApiError, batchGet, sessionDead, type Problem } from "@/api";

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

/**
 * What a read resolves to: the body, and the validator THAT response carried.
 *
 * The etag rides with its own answer rather than being looked up by path afterwards. It used to live in a
 * `path -> etag` map that the caller read once its promise resolved, which is a race whenever the same path is
 * read twice concurrently (the store revalidating while a component reads it plainly - the pair this file's
 * dedup note already describes): the second response overwrites the entry before the first caller reads it, so
 * rows get stored against a validator that describes a DIFFERENT set of rows. The next revalidation then sends
 * that validator, is told 304, and pins the stale rows in place - re-stamped as current, with nothing left to
 * correct them.
 */
type Answer = { body: unknown; etag?: string };
type Settler = { resolve: (v: Answer) => void; reject: (e: unknown) => void };
// What a queued read IS: the path to request, and the validator to send with it if the caller had one.
type Pending = { path: string; etag?: string };

// DEDUP IS KEYED ON PATH **AND** VALIDATOR, not on the path alone.
//
// A 304 is only an answer the caller who sent the validator can use: it means "keep the rows you have". An
// unconditional `list()` has no rows to keep, so handing it NOT_MODIFIED is handing it a Symbol where a
// response body belongs - `r.results ?? []` then reads a property off a Symbol, gets undefined, and renders
// an empty list with no error at all. That was reachable: the access screens mount RolesManagePanel through
// the store (which revalidates `roles` with an etag) beside PermissionsPanel's plain `list<Role>("roles")`,
// and both compose the identical path.
//
// So the two are different reads and are not shared. In the overlap they cost one extra sub-request in the
// same batch, which is the right price: sharing was only ever safe when both callers wanted the same answer
// shape, and nothing here can know that from the path.
const keyOf = (path: string, etag?: string) => (etag ? `${path}\u0000${etag}` : path);

// DEDUP IS ALSO BOUNDED BY THE WRITE THAT ASKED FOR THE READ.
//
// Path + validator identifies the QUESTION, not the moment it was asked, so a read issued AFTER a write shares
// the in-flight request of one issued before it - and inherits an answer computed against the state that write
// just replaced. With a conditional read that answer is a 304, and a 304 is not something the caller can spot
// as stale: it says "keep what you have", so the pre-write rows are kept and re-stamped as current, and no
// later read is scheduled to correct them. That is what left a saved settings row still reading as unsaved,
// and its form dirty, for the rest of the page's life. A caller that has just written asks for a `fresh` read
// and gets a key nothing already on the wire can satisfy.
let freshSeq = 0;

const inflight = new Map<string, Promise<Answer>>(); // key -> shared promise (dedup while pending)
// The same read reduced to just its body. Held so two body-only readers of one key get the IDENTICAL promise,
// which is what "shares one in-flight promise" means to a caller; retired with its answer in `take`, so a read
// arriving after the answer lands starts a new request rather than being handed a settled one.
const bodies = new Map<string, Promise<unknown>>();
const settlers = new Map<string, Settler>(); // key -> its resolve/reject
const pending = new Map<string, Pending>(); // key -> what to request for it
let queue: string[] = []; // keys, in the order they were asked for
let timer: ReturnType<typeof setTimeout> | null = null;
let windowStart = 0; // when the current window's first read was queued

/**
 * What a conditional read resolves to when the server says the caller's copy is still current. Distinct from
 * `undefined` (an empty 2xx body), because "keep what you have" and "there is nothing" are different answers.
 */
export const NOT_MODIFIED = Symbol("not-modified");

// `path` is the resource path WITHOUT the /v1 prefix, e.g. "employees?max_page_size=200" or "settings/dashboard".
// `etag` makes the read CONDITIONAL: the server compares it and may answer NOT_MODIFIED, which costs one
// indexed row instead of a page of them (see src/http/listEtag.ts).
export function coalescedGet<T>(path: string, etag?: string, fresh = false): Promise<T> {
  const key = newKey(path, etag, fresh);
  const shared = bodies.get(key);
  if (shared) return shared as Promise<T>; // already pending -> the same promise, not merely the same answer
  const p = start(key, path, etag).then((a) => a.body as T);
  bodies.set(key, p);
  return p;
}

/** The same read, with the validator the response carried - for a caller that stores the rows and will
 *  revalidate them later. See the note on `Answer`: this must come from the response, never from a lookup. */
export function coalescedGetDetailed<T>(path: string, etag?: string, fresh = false): Promise<{ body: T; etag?: string }> {
  return start(newKey(path, etag, fresh), path, etag) as Promise<{ body: T; etag?: string }>;
}

// A read asking for FRESH rows takes a key nothing already on the wire can satisfy, so it is minted per call.
const newKey = (path: string, etag?: string, fresh = false) =>
  fresh ? `${keyOf(path, etag)} !${++freshSeq}` : keyOf(path, etag);

function start(key: string, path: string, etag?: string): Promise<Answer> {
  const existing = inflight.get(key);
  if (existing) return existing; // already pending -> share it (no duplicate request)
  const p = new Promise<Answer>((resolve, reject) => {
    settlers.set(key, { resolve, reject });
  });
  inflight.set(key, p);
  pending.set(key, { path, etag });
  const now = Date.now();
  if (queue.length === 0) windowStart = now;
  queue.push(key);
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
  const keys = queue;
  queue = [];
  if (import.meta.env?.DEV && keys.length) {
    // What ended up in one request, and how long the window stayed open - the two things you need to see when a
    // page still makes several batches (a second batch here means a genuinely later, dependent read).
    console.debug(`[coalescer] batch:run x${keys.length} after ${Date.now() - windowStart}ms`, keys.map((k) => pending.get(k)?.path ?? k));
  }
  for (let i = 0; i < keys.length; i += MAX) {
    void runChunk(keys.slice(i, i + MAX));
  }
}

// A hard ceiling on the round trip. `batchGet` is a plain `fetch()` with no `AbortController` of its own, so a
// request that stalls without ever erroring - a dropped connection, a Worker instance that stopped answering -
// leaves every read sharing this chunk (and, by dedup, every OTHER caller of the same path) waiting forever:
// the button that needed one of these rows to validate stays disabled, the page that needed them to render
// stays on its skeleton, indefinitely, with nothing on screen to say why. Timing out turns that into an
// ordinary failed read, which the rest of the app already knows how to show (`failedRead.spec.ts`'s own "Try
// again" panel, a toast, a disabled control whose reason names a caught error) - a real answer beats a forever.
const CHUNK_TIMEOUT_MS = 30_000;

async function runChunk(keys: string[]) {
  // Held so the loser of the race below can be CANCELLED. Left running, every batch this page makes parks a
  // 30-second timer that fires long after its answer landed, and a busy page makes a lot of batches - each
  // one holding its keys and its closure alive until it goes off, for a deadline nothing is waiting on.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // A read with no validator stays a bare path, so an ordinary batch body is byte-identical to before.
    const responses = await Promise.race([
      batchGet(
        keys.map((k) => {
          const p = pending.get(k)!;
          return p.etag ? { path: `/v1/${p.path}`, etag: p.etag } : `/v1/${p.path}`;
        }),
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new ApiError("timed out waiting for a response", 0, null)), CHUNK_TIMEOUT_MS);
      }),
    ]);
    keys.forEach((k, idx) => settle(k, responses[idx]));
  } catch (e) {
    keys.forEach((k) => fail(k, e)); // whole-batch failure (including a timeout): reject every waiter in the chunk
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

/** Retire a queued read and hand back its settler. */
function take(key: string): Settler | undefined {
  const settler = settlers.get(key);
  settlers.delete(key);
  inflight.delete(key);
  bodies.delete(key);
  pending.delete(key);
  return settler;
}

function fail(key: string, e: unknown) {
  take(key)?.reject(e);
}

function settle(key: string, r: { status: number; body: unknown; etag?: string } | undefined) {
  const s = take(key);
  if (!s) return;
  if (!r) return s.reject(new ApiError("missing batch response", 0, null));
  // The session lapsed. Through `sessionDead` (api.ts), which is the ONE session-death path: it tells the
  // sibling tabs, purges the cached server data off the disk, and shows the re-sign-in overlay or redirects to
  // the actual login door. This branch used to do a bare `location.href = "/"` under a comment claiming it
  // mirrored api(), doing none of those three - see the note on `sessionDead` for why it drifted.
  if (r.status === 401) return s.reject(sessionDead());
  // "You already have this." The caller keeps its rows and only re-stamps their freshness.
  if (r.status === 304) return s.resolve({ body: NOT_MODIFIED, etag: r.etag });
  if (r.status >= 200 && r.status < 300) {
    return s.resolve({ body: r.body === null || r.body === "" ? undefined : r.body, etag: r.etag });
  }
  const problem = (r.body && typeof r.body === "object" ? r.body : null) as Problem | null;
  s.reject(new ApiError(problem?.detail ?? problem?.title ?? `request failed (${r.status})`, r.status, problem));
}
