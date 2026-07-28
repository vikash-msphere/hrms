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

// Build the dispatcher bound to this Worker env + the request's Deps (so the sub-call reuses the same DB session
// and HKDF-derived codec instead of re-deriving them).
export function makeDispatch(env: Bindings, deps: Deps): Dispatch {
  return async (method, path, body) => {
    if (!path.startsWith("/v1/")) return { status: 400, body: { title: "path must start with /v1/" } };
    const { app, getCodec } = await import("../index");
    const { decodeWireIdsRequest } = await import("../middleware/decodeWireIds");
    const origin = "http://internal";
    const headers = new Headers({ "X-Requested-By": "hrms-spa", "Content-Type": "application/json" });
    const init: RequestInit = { method: method.toUpperCase(), headers };
    if (body !== undefined && method.toUpperCase() !== "GET") init.body = JSON.stringify(body);
    // Wire tokens in the path are decoded here (the outer edge only decodes real inbound requests). Run as
    // system: authz sees the super grant via __sharedCtx.user; deps is shared so no re-derivation.
    const req = await decodeWireIdsRequest(new Request(origin + path, init), getCodec(env));
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
