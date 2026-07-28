// Public e-sign provider webhook: POST /esign/callback/:provider. Mounted OUTSIDE /v1, so the session
// auth/authz/csrf middleware (scoped to /v1/*) does NOT run - the request is authenticated solely by the
// provider's HMAC signature, verified inside the driver's parseWebhook. Builds its own Deps from env because
// the /v1 dbContext middleware is not in this path. Returns 200 on success, 400 on invalid/unrecognized
// payload, 404 on an unknown provider. Never echoes PII.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { makeDeps } from "../deps";
import { getProvider } from "../services/esign";
import { handleEsignCallback } from "../services/esign/callback";

export const esignCallback = new Hono<AppEnv>().post("/callback/:provider", async (c) => {
  const providerId = c.req.param("provider");
  if (!getProvider(providerId)) return c.json({ error: "unknown provider" }, 404);
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const deps = makeDeps(c.env);
  const result = await handleEsignCallback(deps, providerId, headers, rawBody);
  if (!result.ok) return c.json({ error: "invalid webhook" }, 400);
  return c.json({ ok: true, status: result.status ?? null });
});
