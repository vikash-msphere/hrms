import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { decodeWireIdsRequest } from "../middleware/decodeWireIds";
import { app, getCodec } from "../index";

// Multi-read batch (Google-style). One HTTP request carries several GET sub-requests; each is re-dispatched
// through `app.fetch` so it re-runs the ENTIRE middleware chain (csrf -> auth -> authz) and its real route
// handler. There is NO per-collection code here and NO access shortcut: every sub-request is independently
// gated exactly as if called directly. The `batch.run` envelope grant only says "may use the batch transport".
//
// Two edge details:
//  - Sub-paths in the body carry WIRE tokens; the OUTER decode wrapper (index.ts) doesn't touch them (they're
//    `/v1/...` strings, not bare `collection/token` refs), so we run `decodeWireIdsRequest` per sub-request here.
//  - Each sub-response is already wire-encoded by the encodeWireIds middleware; we embed it verbatim. The batch
//    envelope's own response also passes encodeWireIds, but the embedded bodies hold 26-char tokens (not 13-char
//    internal ids), so they don't re-match and aren't double-encoded.
//
// GET-only by design: mutations through a batch raise partial-failure / atomicity / audit questions and carry
// no request-count win (writes are already one-per-action). Reject anything else with a per-sub 400.

// Cap sub-requests per batch. With shared auth/deps (one verify + one HKDF) the per-sub cost is a route +
// in-memory decide + the data query; a modest cap bounds total CPU/DB work per request. The client coalescer
// splits larger ticks across multiple batches.
const MAX_REQUESTS = 20;
const schema = z
  .object({ requests: z.array(z.object({ method: z.string().optional(), path: z.string() })).max(MAX_REQUESTS) })
  .strict();

export const batch = new Hono<AppEnv>().post("/", zValidator("json", schema), async (c) => {
  const { requests } = c.req.valid("json");
  const codec = getCodec(c.env);
  const origin = new URL(c.req.url).origin;

  // Resolve auth + Deps ONCE (already done by the chain for this envelope) and share them with every
  // sub-dispatch, so the fan-out pays one JWT verify + one HKDF key derivation total instead of one per
  // sub-request - the difference between fitting and blowing the Worker's 10ms CPU budget on a 27-read batch.
  // authz still runs per sub-request (it reads the shared user), so per-read gating is unchanged.
  const sharedEnv = { ...c.env, __sharedCtx: { deps: c.get("deps"), user: c.get("user") } };

  const responses = await Promise.all(
    requests.map(async (r) => {
      const method = (r.method ?? "GET").toUpperCase();
      if (method !== "GET") return { status: 400, body: { title: "batch supports GET sub-requests only" } };
      if (!r.path.startsWith("/v1/")) return { status: 400, body: { title: "sub-request path must start with /v1/" } };
      const headers = new Headers({ "X-Requested-By": "hrms-spa" });
      const sub = await decodeWireIdsRequest(new Request(origin + r.path, { method, headers }), codec);
      const res = await app.fetch(sub, sharedEnv, c.executionCtx);
      const text = await res.text();
      let body: unknown = text || null;
      try {
        if (text) body = JSON.parse(text);
      } catch {
        /* non-JSON: leave as text */
      }
      return { status: res.status, body };
    }),
  );
  return c.json({ responses });
});
