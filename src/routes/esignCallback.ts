// Public e-sign provider webhook: POST /esign/callback/:provider. Mounted OUTSIDE /v1, so the session
// auth/authz/csrf middleware (scoped to /v1/*) does NOT run - the request is authenticated solely by the
// provider's HMAC signature, verified inside the driver's parseWebhook. Builds its own Deps from env because
// the /v1 dbContext middleware is not in this path. Returns 200 on success, 400 on invalid/unrecognized
// payload, 404 on an unknown provider. Never echoes PII.
//
// RAW means raw. The signature covers the bytes the provider sent, so nothing between the socket and
// parseWebhook may reshape them - which is why the inbound wire-id edge stops at /v1 (middleware/
// decodeWireIds.ts): it used to read this body and hand on `JSON.stringify(JSON.parse(text))`, and a MAC over
// re-serialized JSON does not match a MAC over the original.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { makeDeps } from "../deps";
import { getProvider } from "../services/esign";
import { handleEsignCallback } from "../services/esign/callback";
import { readCappedBody } from "../services/documentsCommon";
import { counter } from "../lib/isolateRate";

// A webhook envelope is a few hundred bytes; this is generous for one and small enough that an unauthenticated
// POST cannot spend the isolate. It is a real cap, not a measurement: `c.req.text()` reads to the end of the
// stream, and middleware/bodyLimit can only refuse what declares a `Content-Length`, so a chunked body used to
// pass both and buffer whole. Its own error shape (400 "invalid webhook") is what a provider retries on.
const MAX_WEBHOOK_BYTES = 256 * 1024;

// A FLOOR on an unauthenticated route (see lib/isolateRate.ts - the control is the WAF rule). Every accepted
// delivery costs an HMAC verify, a DB read and, for a completed signature, a PDF download from the vendor, and
// nothing here is behind a credential: the signature is checked, but only after the request has been taken.
// Generous against real traffic - a busy day is a handful of signings and their retries - and a rejection is
// the 429 every provider's delivery worker already backs off on.
const deliveries = counter(300);

export const esignCallback = new Hono<AppEnv>().post("/callback/:provider", async (c) => {
  const providerId = c.req.param("provider");
  if (!getProvider(providerId)) return c.json({ error: "unknown provider" }, 404);
  if (deliveries.throttled(Date.now())) {
    return c.json({ error: "too many deliveries" }, 429, { "Retry-After": String(deliveries.retryAfterSeconds) });
  }
  const raw = await readCappedBody(c.req.raw, MAX_WEBHOOK_BYTES);
  if (!raw) return c.json({ error: "invalid webhook" }, 400);
  const rawBody = new TextDecoder().decode(raw);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const deps = makeDeps(c.env);
  const result = await handleEsignCallback(deps, providerId, headers, rawBody);
  if (!result.ok) return c.json({ error: "invalid webhook" }, 400);
  return c.json({ ok: true, status: result.status ?? null });
});
