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
// A route that writes its OWN value for two of these, like /found (an inline-style CSP) and /calendar/holidays
// (the cache directives a calendar client polls against) do.
app.get("/own", (c) =>
  c.body("<p>hi</p>", 200, {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "Cache-Control": "private, max-age=0, no-store",
  }),
);

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

describe("a route's own header wins", () => {
  // securityHeaders FILLS IN rather than overwrites, because it is now registered globally as well as
  // per-mount (src/index.ts) - and the outer `finally` runs LAST, so "set" would clobber the inner route's
  // value. Two real routes depend on keeping theirs: the /found page needs a CSP that permits its inline
  // <style> (under `default-src 'none'` it renders unstyled), and the holiday feed sets the cache directives
  // its subscribers poll against.
  it("keeps the more specific CSP and Cache-Control, and still fills the rest in", async () => {
    const res = await app.request("/own");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
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

// And that a response produced ABOVE a mount carries them. `bodyLimit` is registered before any mount's own
// securityHeaders (it has to be - it must cover /auth, /found and /esign too), so its 413 was the single /v1
// answer in the app shipping with no `nosniff`, no `frame-ancestors` and no `Cache-Control`. The fix is the
// worker-wide registration in src/index.ts, and this is the case that proves it is doing something.
describe("a refusal from middleware above the mounts is hardened too", () => {
  // 400, not 413: services/documentsCommon.ts#bodyTooLarge is `invalidArgument`, deliberately, so that every
  // place enforcing the cap agrees on one status and one wording. The status is not the point here - the
  // headers on it are.
  it("the body ceiling's refusal", async () => {
    const res = await realApp.request(
      "/v1/employees",
      { method: "POST", headers: { "content-length": String(1024 * 1024 * 1024), "content-type": "application/json" } },
      env as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(400);
    for (const [header, value] of Object.entries(EXPECTED)) expect(res.headers.get(header), header).toBe(value);
  });
});
