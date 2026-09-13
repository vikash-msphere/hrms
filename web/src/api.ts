// Single API client. /v1 base, Access cookie, CSRF header, RFC 9457 error parsing.
import { publishToAll, subscribeTopic } from "@/lib/crossTabBus";
import { getViewAs, stopViewAs } from "@/lib/viewAsStore";
import { problemText } from "@/lib/problemText";
import { purgeCachedData } from "@/lib/clientStore";

// `message` is the HUMAN sentence for this failure, translated once here from the problem details (see
// lib/problemText). Every toast, pinned form error and stray `(e as Error).message` in the app therefore reads
// like something a person wrote; the literal server text stays available on `.problem.detail`.
export class ApiError extends Error {
  status: number;
  problem: Problem | null;
  constructor(message: string, status: number, problem: Problem | null) {
    super(problemText(status, problem, message));
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

export type Problem = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /** Which request fields were rejected, on a body validation failure. Routed onto the fields by
   *  `lib/formError.ts#fieldErrors`, so a form shows each message where it belongs. */
  fields?: { field: string; message: string }[];
};

// A 401 means the session lapsed. /auth/login is the one door for every mode: under Cloudflare Access it
// bounces home (the edge re-challenges on the way), in direct-Google mode it starts the OAuth round-trip.
// With neither in front (local dev misconfig) that nav just 401s again = a loop - so fire the redirect at
// most once; after that, fall through to throwing the 401 so the app can show its in-app "Session expired"
// screen instead of looping.
let redirectedOn401 = false;
function redirectToLogin() {
  if (redirectedOn401) return;
  redirectedOn401 = true;
  window.location.href = "/auth/login";
}
// Mid-session expiry: once the app shell is up it registers a handler that shows a "sign in again" overlay
// IN PLACE - the page (and any half-typed form) stays mounted while the user re-authenticates in another
// tab. Before a handler exists (initial page load, nothing to preserve), the redirect path stands.
let sessionExpiredHandler: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null) {
  sessionExpiredHandler = fn;
}
/**
 * The session is gone: tell every sibling tab, drop the cached server data, and put the person in front of a
 * way back in. Returns the error the pending call should fail with.
 *
 * Broadcast with `publishToAll`, because the session is the BROWSER's: a tab running a "view as" simulation
 * answers as somebody else, and the ordinary identity-scoped publish would leave it sitting on a dead session
 * (see lib/crossTabBus.ts).
 *
 * IT RETURNS THE ERROR RATHER THAN THROWING IT so that a caller which SETTLES a promise instead of throwing
 * takes this path too. lib/getCoalescer.ts is that caller - it is the universal GET transport, and it had its
 * own 401 branch annotated "mirrors api()" which did none of this: a bare `location.href = "/"`, so no tab was
 * told, IndexedDB kept every row and photo the person had loaded, and `/` is not a sign-in door in direct-Google
 * mode. It was unreachable in practice (a batch sub-request cannot 401 - middleware/auth.ts reuses the
 * envelope's resolved caller), which is exactly how it drifted. One function, one behaviour, both lanes.
 */
export function sessionDead(): ApiError {
  publishToAll("auth", { op: "dead" });
  onAuthDead();
  return new ApiError("unauthenticated", 401, null);
}
function handle401(): never {
  throw sessionDead();
}
// The cached copies of server data come OFF THE DISK when the session dies, not only when somebody chooses
// "Sign out" from the menu. That menu item was the sole caller of a purge, so the ordinary exits - a 12-hour
// TTL lapsing, a browser closed and reopened tomorrow - left every collection this person had opened, and every
// colleague's photo, in IndexedDB for the seven days `MAX_AGE_MS` allows. On a shared machine that is the exact
// situation the sign-out purge exists to prevent, reached by the door most people use.
//
// `purgeCachedData`, not `purgeAll`: a 401 arrives mid-sentence rather than being asked for, so the person's own
// unsaved writing (the `draft` class) stays. See the note on that function for the split.
//
// Fired from `onAuthDead` so BOTH lapse paths are covered - the redirect and the in-place overlay - and so a
// sibling tab told "dead" over the bus purges too. Not awaited: nothing downstream depends on it, and an
// expired session must not wait on storage. It is idempotent, so the repeat calls a broadcast can produce cost
// one empty transaction each.
function onAuthDead() {
  void purgeCachedData();
  if (sessionExpiredHandler) sessionExpiredHandler();
  else redirectToLogin();
}
subscribeTopic<{ op: string }>("auth", (m) => {
  if (m.op === "dead") onAuthDead();
});

// Permission walls: the app shell registers a handler that offers "request access" when a call 403s.
// Passive - the failed call still throws to its caller; this only adds the side-channel offer. The
// request-access probe itself must never re-trigger the handler (loop), so it opts out via a flag.
let forbiddenHandler: ((collection: string) => void) | null = null;
export function setForbiddenHandler(fn: ((collection: string) => void) | null) {
  forbiddenHandler = fn;
}

// ---- "View as" (access-mode simulation) -----------------------------------------------------------------
// While a simulation is open every request carries `X-View-As` and the SERVER answers as that person
// (src/lib/viewAs.ts) - the browser no longer pretends. Two carve-outs:
//   - the access-management endpoints are the admin's own tools (ACL modal, preview, the people picker), so
//     they always run as the real caller; asking the simulated user whether they may manage access would be
//     both wrong and self-locking (it would hide the exit),
//   - `asRealCaller` lets a caller opt out explicitly (App re-reads /users/me as the admin for the pill).
const REAL_CALLER_PATHS = /^\/access-rules/;
export type ApiInit = RequestInit & {
  skipForbiddenHandler?: boolean;
  asRealCaller?: boolean;
  /**
   * This call has no side effect, so a gateway that refuses it can simply be asked again.
   *
   * Method is the usual proxy for that, and it is wrong for the two calls the SPA leans on hardest: the read
   * batch (`batch:run`) and the avatar batch are POSTs because they carry a body, not because they change
   * anything - the batch envelope is GET-only sub-requests by construction. Left to the method rule they were
   * the only reads in the app with no retry, so one 503 from a restarting edge showed up as a page of missing
   * data rather than a moment's delay.
   */
  safeToRepeat?: boolean;
};

function viewAsHeader(path: string, init: ApiInit): Record<string, string> {
  const va = getViewAs();
  return va && !init.asRealCaller && !REAL_CALLER_PATHS.test(path) ? { "X-View-As": va.subject } : {};
}

// The server refuses every write while simulating; failing here keeps a stray button from surfacing a bare
// 403 and says what to do instead. `batch:run` is the read transport, so it passes.
function guardReadOnly(path: string, init: ApiInit): void {
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" || path === "/batch:run") return;
  if (!getViewAs() || init.asRealCaller || REAL_CALLER_PATHS.test(path)) return;
  throw new ApiError("Stop “view as” before making changes", 403, {
    title: "Read-only while viewing as someone else",
    status: 403,
    detail: "You're viewing the app as another user. Stop the simulation to act as yourself.",
  });
}

// A 403 whose detail is prefixed "view as:" means the SIMULATION is invalid (not permitted, subject gone,
// account disabled) - every request would fail the same way, so drop it and reload as the real caller.
function bailOnBrokenSimulation(status: number, problem: Problem | null): void {
  if (status === 403 && getViewAs() && problem?.detail?.startsWith("view as:")) stopViewAs();
}

// A fetch REJECTS (rather than resolving with a bad status) when the request never reached a server at all:
// no signal, aeroplane mode, DNS gone, the worker unreachable. The browser's own message for that is
// "Failed to fetch", and it was being surfaced verbatim - as the entire explanation - in the panel a page
// shows when its data will not load. On a phone this is the single most likely failure there is, so it gets
// named properly and carries `status: 0`, which is how callers can tell "the network" from "the server said
// no" without string-matching.
function networkError(): ApiError {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return new ApiError(
    offline
      ? "You're offline. This will work again as soon as you have a connection."
      : "Couldn't reach the server. Check your connection and try again.",
    0,
    null,
  );
}

// The identity request is started by web/public/theme-init.js, a blocking <head> script that runs while this
// bundle is still downloading, and parked on `window`. Claim it here rather than in useMe so the answer goes
// through the SAME 401/403/problem handling as any other call - a prefetch that bypassed that would have to
// re-implement the session-expiry path.
//
// Claimed at most once (a Response body can only be read once) and only for the exact request the prefetch
// made: GET /users/me with no extra headers and no view-as. `asRealCaller` is the read that only ever happens
// DURING a simulation, which is the case theme-init.js declines to prefetch - so it never matches, and never
// steals a Response answered for the wrong principal.
declare global {
  interface Window {
    __hrmsMePrefetch?: Promise<Response | null>;
  }
}

function claimMePrefetch(path: string, init: ApiInit): Promise<Response | null> | undefined {
  if (path !== "/users/me") return undefined;
  if ((init.method ?? "GET").toUpperCase() !== "GET") return undefined;
  if (init.headers || init.asRealCaller || getViewAs()) return undefined;
  const pending = window.__hrmsMePrefetch;
  window.__hrmsMePrefetch = undefined;
  return pending;
}

// A gateway saying "not right now": the edge is between isolates, the origin is starting, a proxy is
// reloading. None of them mean anything about the request, and all of them are over in a moment.
const TRANSIENT = new Set([502, 503, 504]);
// Only READS are retried, and only twice. A read has no side effect, so asking again is free; a write may
// have landed before the gateway gave up on the response, and repeating it is how one expense becomes two.
const READ_ATTEMPTS = 3;
const settle = (attempt: number) => new Promise((r) => setTimeout(r, 150 * attempt));

// A 429 is the per-caller budget in middleware/rateLimit.ts (or an isolate floor on a public lane). Unlike a
// gateway blip it is not over in a moment, so it gets its OWN rule rather than joining TRANSIENT:
//
//  - the server ALWAYS says how long to wait, in `Retry-After`, and a client that ignores a header the server
//    took the trouble to send just fails work it could have completed. The budgets are per minute, and the
//    header carries what is LEFT of the window - at the end of one that is a second or two.
//  - but only when the wait is SHORT and only for a READ. Parking a click for 45 seconds behind a spinner is
//    worse than saying "too many requests"; and a write may have landed before the refusal, so repeating it is
//    how one expense becomes two - the same reason TRANSIENT is read-only.
//
// Past the cap the error is thrown, and the server's own detail names the wait ("retry in 47s"), so the
// message the person reads is actionable either way.
const RETRY_AFTER_CAP_MS = 3_000;

/**
 * Let go of a response this call is about to replace with another attempt.
 *
 * A `fetch` response holds a live body stream, and the browser cannot release the connection it is riding
 * until that stream is read or cancelled. A retried read therefore left one parked per attempt, reclaimed only
 * whenever the response object happened to be collected - and the retry paths are precisely the moments the
 * connection pool is already under strain: a gateway rolling between isolates (502/503/504) or a budget
 * refusal that every coalesced read in the window hits at once. Cancelling is immediate and costs nothing,
 * since the body of a response we have decided to discard is by definition not wanted.
 *
 * Never throws: a body already consumed or a stream that died with the connection would otherwise turn a
 * recoverable retry into a failed request, which is the opposite of what this is for.
 */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed or gone - nothing to release */
  }
}
/** The `Retry-After` delay in ms when it is present, parseable and inside the cap; otherwise null. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (!raw) return null;
  const secs = Number(raw.trim());
  // Seconds-form only. The HTTP-date form is legal but nothing in this app sends it, and mis-parsing a date
  // as NaN must not become a zero-delay hot retry.
  if (!Number.isFinite(secs) || secs < 0) return null;
  const ms = secs * 1000;
  return ms <= RETRY_AFTER_CAP_MS ? ms : null;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  guardReadOnly(path, init);
  let res: Response;
  // `?? await fetch(...)`: the prefetch resolves to null when it failed, so a dead one falls straight
  // through to a real request rather than turning a transient boot-time blip into a failed sign-in. It is
  // claimed OUTSIDE the retry - it is a single in-flight response, not a request that can be made again.
  const prefetched = await claimMePrefetch(path, init);
  const isRead = (init.method ?? "GET").toUpperCase() === "GET" || !!init.safeToRepeat;
  const attempts = isRead ? READ_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      res =
        (attempt === 1 ? prefetched : undefined) ??
        (await fetch(`/v1${path}`, {
          ...init,
          headers: { "Content-Type": "application/json", "X-Requested-By": "hrms-spa", ...viewAsHeader(path, init), ...(init.headers ?? {}) },
          credentials: "include",
        }));
    } catch {
      // The request never reached anybody: worth another go for a read, and the offline banner for the rest.
      if (attempt >= attempts) throw networkError();
      await settle(attempt);
      continue;
    }
    if (attempt >= attempts) break;
    if (TRANSIENT.has(res.status)) {
      await discard(res);
      await settle(attempt);
      continue;
    }
    // Budget refusal: wait exactly as long as the server asked, and only when that is short (see above).
    if (res.status === 429 && isRead) {
      const wait = retryAfterMs(res);
      if (wait === null) break;
      await discard(res);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break;
  }
  if (res.status === 401) handle401();
  if (!res.ok) {
    // Only user ACTIONS get the request-access offer: background reads legitimately 403 while the UI is
    // settling (and gated reads shouldn't fire at all) - a toast for those would nag constantly.
    const method = (init.method ?? "GET").toUpperCase();
    const problem = (await res.json().catch(() => null)) as Problem | null;
    // Not every 403 is a permission wall. The attendance clock's network fence, for one, refuses a caller who
    // holds the verb perfectly well - offering them "request access to attendance" would send them to an
    // admin who cannot help. So a 403 that NAMES a non-permission problem type skips the offer; one with no
    // type (or the permission-denied type) still gets it, which is every real wall.
    const isPermissionWall = !problem?.type || problem.type.endsWith("/permission-denied");
    if (res.status === 403 && isPermissionWall && forbiddenHandler && !init.skipForbiddenHandler && method !== "GET") {
      // First path segment = the collection the wall belongs to ("/leave-requests/..." -> leave-requests).
      const collection = path.replace(/^\//, "").split(/[/?:]/)[0] ?? "";
      if (collection) forbiddenHandler(collection);
    }
    bailOnBrokenSimulation(res.status, problem);
    throw new ApiError(problem?.detail ?? problem?.title ?? res.statusText, res.status, problem);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// After any write, refresh the shared cache for the affected collection(s) so every mounted view updates.
import { invalidateCollections, affectedCollections, broadcastInvalidation } from "@/lib/resourceStore";
async function withInvalidation<T>(path: string, verb: string | undefined, p: Promise<T>): Promise<T> {
  const r = await p;
  // Refetch affected collections we're showing here, then tell sibling tabs about the ones we couldn't (they
  // adopt the ones we did refetch for free via the store's row broadcast).
  broadcastInvalidation(invalidateCollections(affectedCollections(path, verb)));
  return r;
}

// Merge-patch helper for Update. Pass the resource etag for optimistic concurrency.
// `path` is the resource path without a leading slash, e.g. "departments/abc".
//
// ## No nulls on the wire
//
// A request body carries VALUES, never `null`. An optional field the caller has nothing to say about is left
// out of the object, and an emptied text box, date or reference is sent as `""` - which every service reads as
// "clear it" (`patch.x?.trim() || null`, `x ? ref(x) : null`). openapi.yaml types these fields as `string`, so
// a `null` fails contract validation at the Prism proxy the dev server goes through (`npm run dev:proxy`) with
// a 422 the worker never sees - which is exactly how creating a document, an expense and a card broke there
// while working against the worker directly.
//
// The distinction that survives is between OMITTED and PRESENT, and it is load-bearing on a merge patch: the
// services test `hasOwnProperty`, so an omitted key leaves the stored value alone and `""` empties it. Do not
// "tidy" an empty string into an omitted field, or an edit that clears a note will silently keep the old one.
export function patch<T>(path: string, body: Record<string, unknown>, etag?: string, init?: ApiInit) {
  return withInvalidation(path, undefined, api<T>(`/${path}`, {
    ...init,
    method: "PATCH",
    // The caller's own headers are kept, not replaced: spreading `init` and then assigning `headers` dropped
    // every one of them, so an `init` carrying a header would have been honoured on `api()` and silently lost
    // here. Ours go first so the content type and the validator still win, which is what this helper is for.
    headers: { ...(init?.headers ?? {}), "Content-Type": "application/merge-patch+json", ...(etag ? { "If-Match": etag } : {}) },
    body: JSON.stringify(body),
  }));
}

import { coalescedGet, coalescedGetDetailed, NOT_MODIFIED } from "@/lib/getCoalescer";
import { saveBlob, filenameFromDisposition } from "@/lib/download";

// ---- AEP-shaped helpers -----------------------------------------------------

export type AepResource = {
  path: string;
  uid?: string;
  etag?: string;
  create_time?: string;
  update_time?: string;
  delete_time?: string;
  disabled?: boolean;
  locked?: boolean;
  locked_by?: string;
  published?: boolean;
  // Per-object access hint (server-computed; UX only). `can` = verbs the caller may perform on this row;
  // `why` = the SCOPE by which they hold read access (self/dept/subtree/exact/all), shown as provenance.
  access?: { can?: string[]; why?: "all" | "subtree" | "exact" | "self" | "dept" };
};

export type ListResponse<T> = { results: T[]; next_page_token?: string };

export type ListOptions = { max?: number; showDeleted?: boolean; deletedOnly?: boolean; q?: string; pageToken?: string; params?: Record<string, string> };

/** The request path for a list read. One place, because three things must agree on it byte for byte: the
 *  coalescer's dedup key, the etag it holds for that path, and the store's own cache key. */
export function listPath(collection: string, opts: ListOptions): string {
  // 100 is what the server actually grants (http/pagination.ts clampPageSize caps there), so asking for more
  // just made every caller's stated page size a fiction. Truncation is reported through `next_page_token`
  // either way; the two numbers should agree so nobody sizes a view against a page they will never get.
  //
  // And the clamp SAYS SO in development, because seven call sites had been written in the belief that they
  // had raised the window (the settings snapshot, two "who is off" overlays, the ops history, tab activity,
  // preferences) - each reading one page as the whole set. A silent ceiling is how that belief forms: nothing
  // on the request, the response or the screen contradicts it. A caller that genuinely needs more than a page
  // follows the cursor (`all: true` on useCollection, `listAll`/`getAllPages` here).
  if (import.meta.env.DEV && (opts.max ?? 0) > 100) {
    console.warn(`[api] max_page_size ${opts.max} on "${collection}" is clamped to 100 by the server; follow the cursor instead (useCollection { all: true }, listAll, getAllPages)`);
  }
  const params = new URLSearchParams({ max_page_size: String(Math.min(opts.max ?? 100, 100)) });
  // Three states, two params (`show_deleted` stays a boolean, as AEP requires): `deleted_only` is what lets a
  // "Deleted" view be its own fetch. Including the live rows and
  // filtering them off in the client would spend the page budget on rows nobody asked for - and on a list
  // longer than one page it would show an EMPTY trash while deleted rows sat past the cursor.
  if (opts.deletedOnly) params.set("deleted_only", "true");
  else if (opts.showDeleted) params.set("show_deleted", "true");
  // Collection-specific list filters the server understands (e.g. leave-requests' `leave_type`, tickets'
  // `state`/`department`). Sorted so the same filter set always produces the same URL - and so the coalescer
  // and the store's cache key agree on it.
  for (const [k, v] of Object.entries(opts.params ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (v) params.set(k, v);
  }
  // Server-side text filter (FTS-backed). Present only when the page offers a search box, so an ordinary
  // list request is byte-identical to before and keeps sharing its cache entry.
  if (opts.q) params.set("q", opts.q);
  // Cursor from a previous page's next_page_token - used by the store's loadMore to follow the server cursor.
  if (opts.pageToken) params.set("page_token", opts.pageToken);
  return `${collection}?${params.toString()}`;
}

/** List a collection. `collection` is the kebab path segment, e.g. "employees". Routed through the GET
 *  coalescer, so all reads fired in the same tick collapse into one /v1/batch:run request. */
export function list<T>(collection: string, opts: ListOptions = {}): Promise<ListResponse<T>> {
  return coalescedGet<ListResponse<T>>(listPath(collection, opts));
}

/**
 * The same read, made CONDITIONAL on a copy the caller already holds.
 *
 * Only the resource store calls this, and only when its cached page has gone stale by its own freshness window.
 * That revalidation is where the reads were going: a twenty-second window means a page that stays open re-reads
 * up to a hundred rows several times a minute, almost always to be handed back what it had. With a validator
 * the server answers from one indexed row (src/http/listEtag.ts) and this resolves `notModified`, which costs
 * the store nothing but a new timestamp.
 *
 * `etag` is what came back with the rows being held; the fresh one rides back so it can be stored with them.
 */
export async function listConditional<T>(
  collection: string,
  opts: ListOptions = {},
  etag?: string,
  fresh = false,
): Promise<{ notModified: true } | { notModified?: false; response: ListResponse<T>; etag?: string }> {
  const path = listPath(collection, opts);
  // The validator comes back WITH this response, never from a path lookup afterwards - two concurrent reads of
  // one path would otherwise hand each other's etag over (see the note on `Answer` in lib/getCoalescer.ts).
  const answer = await coalescedGetDetailed<ListResponse<T> | typeof NOT_MODIFIED>(path, etag, fresh);
  if (answer.body === NOT_MODIFIED) return { notModified: true };
  return { response: answer.body, etag: answer.etag };
}

/**
 * Follow the cursor to the end: EVERY row of a collection (the server caps a page at 100). For pickers
 * that must be complete (the view-as / add-user dropdowns) - not for list pages, which stay paged.
 *
 * BOUNDED, like `getAllPages` below it, and for a reason the unfiltered form makes worse rather than better.
 * The loop used to be `do { ... } while (pageToken)` with no ceiling and no check that the cursor was moving:
 * a server cursor that ever failed to advance - a keyset key that ties across more rows than a page holds, a
 * filter change mid-walk, a bug in a route's own `list` hook - turns a picker into an infinite request loop
 * that spends the caller's whole rate budget and never resolves, with a spinner on screen and nothing saying
 * why. Two guards, because they catch different failures: a repeated token catches a cursor that is stuck, and
 * the page ceiling catches one that advances but never ends.
 *
 * Stopping early yields a SHORT list rather than an error, which is the right failure for the surface this
 * serves (a picker missing entries beats a picker that never opens) - and MAX_PAGES x 100 rows is far past any
 * collection these callers read.
 */
const LIST_ALL_MAX_PAGES = 50;

export async function listAll<T>(collection: string): Promise<T[]> {
  const all: T[] = [];
  let pageToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < LIST_ALL_MAX_PAGES; page++) {
    const res = await list<T>(collection, { max: 100, pageToken });
    all.push(...(res.results ?? []));
    pageToken = res.next_page_token;
    if (!pageToken || seen.has(pageToken)) break;
    seen.add(pageToken);
  }
  return all;
}

/**
 * Follow the cursor on an ARBITRARY list path (one carrying its own filters), up to a row ceiling.
 *
 * `listAll` above is the unfiltered, unbounded form and it only suits a small catalog. The callers here are
 * the views whose ANSWER IS WRONG rather than merely short when the rows run past one page: a week's roster
 * with blank cells for shifts that exist, a policy's acknowledgement progress listing signed employees as
 * pending, a free-slot search that offers a time the panel is on leave. Each of them used to ask for
 * `max_page_size=500`, which the server clamps to 100 (http/pagination.ts) without saying so, and then read
 * the first page as the whole set.
 *
 * BOUNDED, not unbounded: each page is a request, so an unfiltered call on a large collection would be a loop
 * of them. The ceiling is the caller's, sized for what its own filters can legitimately return, and
 * `truncated` says the ceiling was reached so the view can admit it rather than present a window as the total.
 */
export async function getAllPages<T>(path: string, cap: number): Promise<{ results: T[]; truncated: boolean }> {
  const results: T[] = [];
  let pageToken: string | undefined;
  // The row ceiling bounds a cursor that ADVANCES; it does not bound one that does not. A page that comes back
  // empty (or short) while still handing over a token adds nothing to `results`, so `cap` is never reached and
  // the loop runs forever - see the note on `listAll` for how a cursor gets stuck. Remembering the tokens costs
  // one Set and ends that walk as truncated, which is what the caller already knows how to show.
  const seen = new Set<string>();
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page = await coalescedGet<ListResponse<T>>(pageToken ? `${path}${sep}page_token=${encodeURIComponent(pageToken)}` : path);
    results.push(...(page.results ?? []));
    pageToken = page.next_page_token;
    if (results.length >= cap) return { results: results.slice(0, cap), truncated: !!pageToken || results.length > cap };
    if (pageToken && seen.has(pageToken)) return { results, truncated: true };
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return { results, truncated: false };
}

export function get<T>(path: string): Promise<T> {
  return coalescedGet<T>(path);
}

// `authz_version` stamps what the caller may currently do (src/domain/authzVersion.ts). It is separate from
// `collections` because it invalidates differently: a stored row carries the access hints and field redactions
// computed for the caller who fetched it, so a DIFFERENT version gives up every stored copy rather than any
// named collection. Compared for inequality, not order - it is a hash, not a clock.
export type ChangesResponse = { now: number; collections?: string[]; unknown_window?: boolean; authz_version?: string };

/** Which collections have been written to since `since` (epoch ms). One indexed read that lets the store keep
 *  its stored copies instead of revalidating them - see lib/resourceStore.ts#syncChanges. Rides the coalescer
 *  like every other GET, so it joins the page's first batch rather than adding a round trip. */
export function changesSince(since: number): Promise<ChangesResponse> {
  return coalescedGet<ChangesResponse>(`changes?since=${Math.floor(since)}`);
}

/** Execute several GET reads in ONE request via /v1/batch:run. Each entry is a full sub-request path, e.g.
 *  "/v1/leave-requests?max_page_size=200", optionally with the `etag` the caller already holds for it - the
 *  sub-request then carries it as `If-None-Match` and may come back 304 with no body. Returns per-sub
 *  {status, body, etag} in order. Reads only - no cache invalidation. */
export async function batchGet(reads: (string | { path: string; etag?: string })[]): Promise<{ status: number; body: unknown; etag?: string }[]> {
  if (!reads.length) return [];
  const resp = await api<{ responses: { status: number; body: unknown; etag?: string }[] }>(`/batch:run`, {
    method: "POST",
    safeToRepeat: true,
    body: JSON.stringify({
      requests: reads.map((r) => {
        const { path, etag } = typeof r === "string" ? { path: r, etag: undefined } : r;
        return { method: "GET", path, ...(etag ? { etag } : {}) };
      }),
    }),
  });
  return resp.responses ?? [];
}

export function create<T>(collection: string, body: Record<string, unknown>): Promise<T> {
  return withInvalidation(collection, undefined, api<T>(`/${collection}`, { method: "POST", body: JSON.stringify(body) }));
}

/** Soft delete (DELETE). The resource is marked deleted and can be restored. */
export function remove(path: string, etag?: string): Promise<void> {
  return withInvalidation(path, undefined, api<void>(`/${path}`, {
    method: "DELETE",
    headers: etag ? { "If-Match": etag } : {},
  }));
}

/** Permanently delete (DELETE ?force=true). Server gates this to super_admin. */
export function purge(path: string, etag?: string): Promise<void> {
  return withInvalidation(path, undefined, api<void>(`/${path}?force=true`, {
    method: "DELETE",
    headers: etag ? { "If-Match": etag } : {},
  }));
}

/** Restore a soft-deleted resource. */
export function restore<T>(path: string): Promise<T> {
  return withInvalidation(path, "restore", api<T>(`/${path}:restore`, { method: "POST" }));
}

/** Upload raw file bytes to a resource's `:upload` custom method, preserving the
 *  original filename (and thus extension) and MIME type via query params. */
export async function upload<T>(path: string, file: File, opts: { verb?: string; params?: Record<string, string> } = {}): Promise<T> {
  const buf = await file.arrayBuffer();
  const params = new URLSearchParams({ file_name: file.name, ...(opts.params ?? {}) });
  if (file.type) params.set("content_type", file.type);
  return withInvalidation(path, opts.verb ?? "upload", api<T>(`/${path}:${opts.verb ?? "upload"}?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  }));
}

/** Invoke an AEP custom method, e.g. invoke("payroll-runs/abc", "approve", etag). Pass `body` for verbs
 *  that take arguments (e.g. tickets :assign / :comment / :prioritize), `params` for the few that are
 *  addressed by query instead (e.g. letterheads :deleteImage, which names an image slot). */
export function invoke<T>(path: string, verb: string, etag?: string, body?: Record<string, unknown>, params?: Record<string, string>): Promise<T> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
  return withInvalidation(path, verb, api<T>(`/${path}:${verb}${qs}`, {
    method: "POST",
    headers: etag ? { "If-Match": etag } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

type BinaryOpts = { verb?: string; params?: Record<string, string>; body?: Record<string, unknown>; signal?: AbortSignal };

/** POST a binary-returning custom method and hand back the raw bytes, plus the name the server asked it to be
 *  saved under when it sent one (see lib/download.ts#filenameFromDisposition). Shared by `download` (save to
 *  disk) and `blobUrl` (view inline), so both speak the same auth/CSRF/Problem-error contract. */
async function postBinary(path: string, opts: BinaryOpts): Promise<{ blob: Blob; filename?: string }> {
  // Binary methods are POSTs, so a simulation cannot carry them (the server is read-only there). Refuse with
  // the same message the other writes get rather than letting a download 403 opaquely.
  guardReadOnly(`/${path}`, { method: "POST" });
  const qs = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : "";
  let res: Response;
  // RETRIED on a transient status, exactly as a read is in `api` above. A binary method is a POST for transport
  // reasons only - it renders bytes (a payslip, a letterhead preview, a bank file) and files nothing - so asking
  // again is as free as re-reading a list, and NOT asking again is expensive: these are the requests that carry
  // a whole PDF render behind them, and a gateway blip on one used to dead-end the screen that asked (the
  // letterhead designer showing "the server had a problem" with no preview and no way back to one until the
  // design was edited again).
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`/v1/${path}:${opts.verb ?? "download"}${qs}`, {
        method: "POST",
        headers: { "X-Requested-By": "hrms-spa", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
        credentials: "include",
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e; // cancelled on purpose - let the caller's own abort handling see it, not a network-error toast
      if (attempt >= READ_ATTEMPTS) throw networkError(); // a download is the request most likely to be attempted on a bad connection
      await settle(attempt);
      continue;
    }
    // A BUDGET REFUSAL IS HONOURED HERE TOO, on the same rule `api()` applies to a read: the server always
    // says how long to wait, and waiting that long is free when the wait is short. This loop retried only
    // TRANSIENT gateway statuses, so the ONE surface with a dedicated per-caller budget (`render` in
    // middleware/rateLimit.ts, 40/min - these ARE the requests it bounds) was also the one that never backed
    // off: a 429 arriving a second before the window rolled dead-ended a payslip or a letterhead preview that
    // one pause would have completed. Safe for the same reason the retries above it are - a binary method
    // renders bytes and files nothing, so asking again changes nothing but the wait.
    if (res.status === 429 && attempt < READ_ATTEMPTS && !opts.signal?.aborted) {
      const wait = retryAfterMs(res);
      if (wait !== null) {
        await discard(res);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
    }
    if (!TRANSIENT.has(res.status) || attempt >= READ_ATTEMPTS || opts.signal?.aborted) break;
    // Let go of the response this attempt is about to replace - see `discard`. These are the requests that
    // carry a whole PDF render behind them, so a parked body stream here holds a connection for exactly as
    // long as the retry path takes, on the retry paths (a gateway rolling between isolates) where the pool is
    // already under strain. `api()` above has always done this; this loop was the copy that did not.
    await discard(res);
    await settle(attempt);
  }
  if (res.status === 401) handle401();
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as Problem | null;
    bailOnBrokenSimulation(res.status, problem);
    throw new ApiError(problem?.detail ?? problem?.title ?? res.statusText, res.status, problem);
  }
  return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get("Content-Disposition")) };
}

/** Fetch a binary custom method and hand back the bytes themselves - for a renderer that reads the file
 *  (pdf.js) rather than handing it to the browser's own viewer, so no object URL is minted or leaked. */
export async function blobOf(path: string, opts: BinaryOpts = {}): Promise<Blob> {
  return (await postBinary(path, opts)).blob;
}

/**
 * Fetch a binary custom method as a DATA URL - a plain string that stays valid for as long as it is held.
 *
 * For an `<img>` that lives as long as its component, this is the right tool and an object URL is the wrong
 * one: object URLs have to be revoked by hand, and a component that re-fetches (a new upload, a switched tab)
 * races its own cleanup, revoking the URL the DOM is still displaying and blanking the image. Nothing to
 * revoke here, so nothing to get wrong. Use `blobUrl` for big things a viewer streams, like a PDF.
 */
export async function dataUrl(path: string, opts: BinaryOpts = {}): Promise<string> {
  const { blob } = await postBinary(path, opts);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the image"));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

/** Fetch a binary custom method for INLINE viewing and return an object URL (feed it to an iframe).
 *  The caller owns the URL and must `URL.revokeObjectURL` it when the viewer closes. */
export async function blobUrl(path: string, opts: BinaryOpts = {}): Promise<string> {
  return URL.createObjectURL((await postBinary(path, opts)).blob);
}

/**
 * Download a binary via a `:download` (or custom `verb`) method and trigger a browser save.
 *
 * `filename` is the FALLBACK. When the response says what the file should be called, that wins - it is the
 * only side that knows what a stored attachment actually is (the uploader's own name, and the extension its
 * content type implies), and the names passed here for those are extensionless by construction. See
 * lib/download.ts#filenameFromDisposition.
 */
export async function download(path: string, filename: string, opts: BinaryOpts = {}): Promise<void> {
  const { blob, filename: served } = await postBinary(path, opts);
  saveBlob(blob, served ?? filename);
}
