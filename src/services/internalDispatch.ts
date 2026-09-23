// Internal API dispatch: run an action as a real HTTP call through the app's OWN middleware chain (auth ->
// authz -> route), exactly like /v1/batch:run re-dispatches sub-requests. This is what lets an automation
// action be "call any endpoint" instead of a bespoke function - it reuses authz, Zod validation, the wire-id
// codec, and serialization. The call runs as the system principal (injected via env.__sharedCtx.user), so it
// passes authz with super authority; the privileged act is authoring the rule, not running it.
//
// `app` + `getCodec` are imported LAZILY (inside the closure) so this module can be wired into makeDeps without
// creating an import cycle at load time (index -> routes -> services -> here -> index).
import type { Bindings } from "../env";
import type { Deps } from "../deps";
import { systemActor } from "../lib/systemActor";

export type DispatchResult = { status: number; body: unknown };
export type Dispatch = (method: string, path: string, body?: unknown) => Promise<DispatchResult>;

const ORIGIN = "http://internal";

/**
 * The shape a dispatched path may have: `/v1/<collection>[/<id>][:verb]`, and nothing else.
 *
 * A `startsWith("/v1/")` test is NOT this check, which is the bug this replaces. The string a caller hands in
 * is not where the request goes - `new URL()` normalises it first, and `"/v1/../healthz"` starts with `/v1/`
 * and resolves to `/healthz`. routes/batch.ts learned exactly this ("a raw `startsWith` would take
 * `/v1/../healthz` for a /v1 request") and builds the URL before testing the pathname; this sibling
 * dispatcher, which runs its request as SUPER, kept the raw test.
 *
 * The id segment excludes `.` entirely, so a traversal cannot hide in it either - and the whole pattern is an
 * allowlist rather than a set of forbidden shapes, because the set of legitimate paths here is small and
 * knowable while the set of hostile ones is not.
 */
const DISPATCH_PATH_RE = /^\/v1\/[a-z][a-z0-9-]*(?:\/[A-Za-z0-9_-]+)?(?::[a-zA-Z][A-Za-z0-9]*)?$/;

/**
 * The URL a dispatched path resolves to, or why it is refused. Exported so the rule is unit-testable without a
 * Worker - the shapes it has to reject are exactly the ones no scenario test naturally produces.
 *
 * THE CALLER'S PATH IS PART USER DATA. An automation's `apiCall` path is templated at run time
 * (services/automationEngine.ts) and the values folded into it are ordinary user input - the same input
 * `templateHtml` escapes before it reaches an email body, and for the same stated reason: the author's text is
 * trusted, what is substituted into it is not. A substituted value carrying `/`, `:` or `?` otherwise
 * redirects the request to another collection, another record, another verb - executed with the super grant.
 *
 * `force` is named because it is the one parameter in the app that LIFTS a request's required level (see
 * http/query.ts): `?force=true` turns a soft delete into the irreversible hard purge, and under this
 * principal it would never be refused. Nothing legitimate dispatches it - a rule that genuinely needs to purge
 * should say so as its own action - while a templated id that happens to carry it is a silent cascade delete.
 * Every other query parameter is left alone: two seeded rules filter with one (`/v1/asset-requests?state=…`).
 */
export function parseDispatchPath(path: string): { url: URL; error?: undefined } | { url?: undefined; error: string } {
  let url: URL;
  try {
    url = new URL(path, ORIGIN);
  } catch {
    return { error: "path is not a valid path" };
  }
  if (url.origin !== ORIGIN) return { error: "path must be a relative /v1 path" };
  if (!DISPATCH_PATH_RE.test(url.pathname)) return { error: "path must be /v1/<collection>[/<id>][:verb]" };
  if (url.searchParams.has("force")) return { error: "force is not dispatchable" };
  return { url };
}

// Build the dispatcher bound to this Worker env + the request's Deps (so the sub-call reuses the same DB session
// and HKDF-derived codec instead of re-deriving them).
export function makeDispatch(env: Bindings, deps: Deps): Dispatch {
  return async (method, path, body) => {
    // Parsed FIRST, then judged - so what is checked is where the request actually goes.
    const { url, error } = parseDispatchPath(path);
    if (!url) return { status: 400, body: { title: error } };
    const { app, getCodec } = await import("../index");
    const { decodeWireIdsRequest } = await import("../middleware/decodeWireIds");
    const headers = new Headers({ "X-Requested-By": "hrms-spa", "Content-Type": "application/json" });
    const init: RequestInit = { method: method.toUpperCase(), headers };
    if (body !== undefined && method.toUpperCase() !== "GET") init.body = JSON.stringify(body);
    // Built from the NORMALISED url, not from the raw string, so the request that runs is the one that was
    // judged above - and any fragment is dropped here rather than being reinterpreted downstream.
    const req = await decodeWireIdsRequest(new Request(ORIGIN + url.pathname + url.search, init), getCodec(env));
    const sharedEnv = { ...env, __sharedCtx: { deps, user: systemActor() } } as Bindings;
    const res = await app.fetch(req, sharedEnv);
    const text = await res.text();
    let parsed: unknown = text || null;
    try {
      if (text) parsed = JSON.parse(text);
    } catch {
      /* non-JSON: leave as text */
    }
    return { status: res.status, body: parsed };
  };
}
