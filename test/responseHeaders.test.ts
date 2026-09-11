/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { app as realApp } from "../src/index";
import type { AppEnv } from "../src/env";
import { securityHeaders } from "../src/middleware/securityHeaders";
import { forbidden } from "../src/lib/errors";
import { errorHandler } from "../src/middleware/errorHandler";

// The response headers every /v1 answer carries. They are set in a `finally`, which is the point: an ERROR
// response is still a response, and a 403 that arrives without them is as frameable and as cacheable as a 200.

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.use("*", securityHeaders);
app.get("/ok", (c) => c.json({ ok: true }));
app.get("/denied", () => {
  throw forbidden("nope");
});

const EXPECTED = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  // No directive at all is NOT "do not cache": a 200 carrying a validator - which every collection list does,
  // see http/listEtag.ts - is heuristically cacheable under RFC 9111 §4.2.2, and a /v1 body is written for ONE
  // caller (per-object access hints and field redactions are computed for whoever asked). Through an
  // intermediate cache that is one person's payslip list stored for the first reader and served to the second.
  "Cache-Control": "private, no-store",
};

describe("every /v1 response carries the full header set", () => {
  it("on a success", async () => {
    const res = await app.request("/ok");
    expect(res.status).toBe(200);
    for (const [header, value] of Object.entries(EXPECTED)) expect(res.headers.get(header), header).toBe(value);
  });

  it("and on an error, which is the case the `finally` exists for", async () => {
    const res = await app.request("/denied");
    expect(res.status).toBe(403);
    for (const [header, value] of Object.entries(EXPECTED)) expect(res.headers.get(header), header).toBe(value);
  });
});

// The two above prove the MIDDLEWARE. This proves it is actually MOUNTED on the unauthenticated probes, which
// is a different claim and the one that was false: /healthz and /readyz are registered before every other
// mount in src/index.ts, so they shipped with no headers at all while every /v1 answer had the full set.
// Asserted against the real app rather than the fixture above, because "is it wired up" is the whole question.
describe("the unauthenticated health probes carry them too", () => {
  it.each(["/healthz", "/readyz"])("%s", async (path) => {
    const res = await realApp.request(path, {}, env as unknown as Record<string, unknown>);
    for (const [header, value] of Object.entries(EXPECTED)) expect(res.headers.get(header), `${path} ${header}`).toBe(value);
  });
});
