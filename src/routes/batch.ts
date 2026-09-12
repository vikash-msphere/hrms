import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { decodeWireIdsRequest } from "../middleware/decodeWireIds";
import { BATCH_MAX_SUB_READS } from "../middleware/rateLimit";
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
//
// Shared with the limiter, which charges an envelope its sub-read count against a budget denominated in
// sub-reads and clamps that cost to this same cap (middleware/rateLimit.ts). Two copies of the number would
// let one side bound work the other had already let through.
const MAX_REQUESTS = BATCH_MAX_SUB_READS;
// `etag` is the sub-request's `If-None-Match`. Every list read the SPA makes is coalesced through here, so
// without it conditional GET would be unreachable from the client that needs it most: a cached list whose
// freshness window has lapsed would go on re-reading a page of rows to learn nothing had changed. The
// sub-response carries the answer's own `etag` back for the client to store.
const schema = z
  .object({ requests: z.array(z.object({ method: z.string().optional(), path: z.string(), etag: z.string().max(200).optional() })).max(MAX_REQUESTS) })
  .strict();

export const batch = new Hono<AppEnv>().post("/", zValidator("json", schema), async (c) => {
  const { requests } = c.req.valid("json");
  const codec = getCodec(c.env);
  const origin = new URL(c.req.url).origin;

  // Resolve auth + Deps ONCE (already done by the chain for this envelope) and share them with every
  // sub-dispatch, so the fan-out pays one JWT verify + one HKDF key derivation total instead of one per
  // sub-request - the difference between fitting and blowing the Worker's 10ms CPU budget on a 27-read batch.
  // authz still runs per sub-request (it reads the shared user), so per-read gating is unchanged.
  const sharedDeps = c.get("deps");
  const sharedUser = c.get("user");

  const responses = await Promise.all(
    requests.map(async (r) => {
      const method = (r.method ?? "GET").toUpperCase();
      if (method !== "GET") return { status: 400, body: { title: "batch supports GET sub-requests only" } };
      // Build the URL FIRST, then check the prefix on the normalised pathname. Testing the raw string let a
      // traversal through: `/v1/../healthz` starts with `/v1/` but the parser resolves it to `/healthz`, so the
      // prefix stopped describing where the sub-request actually went. Nothing sensitive lives outside /v1
      // today, which is why this was invisible - but the envelope's guarantee is that every sub-request is
      // gated as a /v1 request, and that has to be true of the path that gets dispatched.
      let url: URL;
      try {
        url = new URL(r.path, origin);
      } catch {
        return { status: 400, body: { title: "sub-request path is not a valid path" } };
      }
      if (url.origin !== origin || !url.pathname.startsWith("/v1/")) {
        return { status: 400, body: { title: "sub-request path must start with /v1/" } };
      }
      const headers = new Headers({ "X-Requested-By": "hrms-spa" });
      if (r.etag) headers.set("If-None-Match", r.etag);
      // THE CLIENT METADATA TRAVELS WITH THE SUB-REQUEST.
      //
      // A sub-request re-enters the whole chain, so middleware/authz sets `user.reqMeta` from the headers IT
      // sees - and it used to see a request built from these two lines alone. `cf-connecting-ip` and
      // `user-agent` were not among them, so every audit row a batched read wrote recorded `ip: null,
      // user_agent: null` (lib/audit.ts stamps reqMeta). That is not a rare path: web/src/lib/getCoalescer.ts
      // is a UNIVERSAL GET coalescer, so essentially every read the SPA makes arrives here. The row it cost
      // most is `access.denied`, which exists to be the abuse signal and was being written without the half
      // that says where the probing came from.
      //
      // Copied rather than synthesized: `cf-connecting-ip` is the address the edge observed on the envelope,
      // which is the same connection every sub-request rides. Only these two - a sub-request must not inherit
      // the envelope's `Authorization`, `Content-Type` or conditional headers.
      for (const h of ["cf-connecting-ip", "user-agent"]) {
        const v = c.req.header(h);
        if (v) headers.set(h, v);
      }
      // A SHALLOW COPY of the caller per sub-request, not the one object twenty times.
      //
      // The sub-requests run concurrently (Promise.all), and the authz middleware WRITES to the user it is
      // handed: `user.audited = false` on the way in, `user.reqMeta = {...}`, and the write backstop reads
      // `audited` back after the handler. Sharing one object makes those interleave - one sub-request's reset
      // lands after another's handler set the flag, and the audit row is duplicated or lost. Today the GET-only
      // rule above keeps it inert (mutationAudit answers null for GET, so the flag is never consulted), but
      // that is a second guarantee resting on the first, invisibly. A copy costs one object per sub-request and
      // removes the coupling: `grant` and `policy` are shared by reference, so the CPU win is untouched.
      const sharedEnv = { ...c.env, __sharedCtx: { deps: sharedDeps, user: { ...sharedUser } } };
      const sub = await decodeWireIdsRequest(new Request(url, { method, headers }), codec);
      // `c.executionCtx` THROWS when the context has none (the test runner, and any in-process dispatch) rather
      // than returning undefined, so it cannot be read inline - see the same guard in middleware/auth.ts. The
      // sub-dispatch needs no waitUntil of its own, so passing undefined is the correct fallback.
      // Typed off `app.fetch`'s OWN third parameter rather than naming `ExecutionContext` here. The two are not
      // always the same type: `@cloudflare/workers-types` v5 made the global generic and added members
      // (`tracing`, `abort`) that Hono's narrower context does not declare, so a hand-written annotation stops
      // compiling on a types bump while the code is still correct. Deriving it means this line says "whatever
      // the thing I am about to call accepts", which is the only property it actually needs.
      let ctx: Parameters<typeof app.fetch>[2];
      try {
        ctx = c.executionCtx;
      } catch {
        /* no execution context */
      }
      const res = await app.fetch(sub, sharedEnv, ctx);
      const text = await res.text();
      let body: unknown = text || null;
      try {
        if (text) body = JSON.parse(text);
      } catch {
        /* non-JSON: leave as text */
      }
      // The validator rides back so the client can store it against the rows it just cached. A 304 carries one
      // and no body: the caller keeps what it has.
      const etag = res.headers.get("ETag") ?? undefined;
      return { status: res.status, body, ...(etag ? { etag } : {}) };
    }),
  );
  return c.json({ responses });
});
