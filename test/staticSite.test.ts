/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// The static-site gate (src/http/staticSite.ts): a signed-out browser must not be able to download the app.
//
// What is pinned here is the property, not just the status codes: on every refusal the asset store is NEVER
// ASKED for anything - the spy below records each request it receives - so a refusal cannot depend on, or
// reveal, whether the file exists. Then the signed-in half: the site behaves exactly as it did before the gate
// (asset pass-through, honest 404 for a missing file, the shell for a client-side route), and hands out the
// media cookie the WAF rule checks. Finally the edge rule builder, whose output goes into the dashboard by hand
// and so has no other test.
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { sealSession } from "../src/lib/session";
import type { Bindings } from "../src/env";
import { EDGE_COOKIE, EDGE_COOKIE_MAX_AGE_S, EDGE_PATHS, WAF_EXPRESSION_MAX, edgeRuleExpression, isEdgeKey } from "../src/http/assetPaths";
import { isNavigation } from "../src/http/staticSite";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const OTHER_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const EDGE_KEY = "Edge_Key-0123456789abcdefghijklmnopqrstuvwxyz";

type File = { status?: number; body?: string; headers?: Record<string, string>; etag?: string };

// The shell and two chunks, with the headers `_headers` would give them.
const SITE: Record<string, File> = {
  "/": { body: "<!doctype html><title>shell</title>", headers: { "Content-Type": "text/html", "Cache-Control": "private, no-cache" }, etag: '"shell-1"' },
  "/index.html": { body: "<!doctype html><title>shell</title>", headers: { "Content-Type": "text/html", "Cache-Control": "private, no-cache" } },
  "/assets/index-abc123.js": { body: "export{}", headers: { "Content-Type": "text/javascript", "Cache-Control": "private, max-age=31536000, immutable" } },
  "/assets/index-abc123.css": { body: "body{}", headers: { "Content-Type": "text/css" } },
};

/** An asset store that records every request it is asked for. Answers 304 to a matching If-None-Match, the
 *  way the real one does, so a revalidation can be seen to reach it. */
function spyAssets(files: Record<string, File> = SITE) {
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input));
    const { pathname } = new URL(req.url);
    calls.push(pathname);
    const f = files[pathname];
    if (!f) return new Response("missing", { status: 404 });
    if (f.etag && req.headers.get("If-None-Match") === f.etag) return new Response(null, { status: 304, headers: { ETag: f.etag } });
    return new Response(f.body ?? "", { status: f.status ?? 200, headers: { ...f.headers, ...(f.etag ? { ETag: f.etag } : {}) } });
  };
  return { calls, binding: { fetch } };
}

// Google mode with the dev bypass OFF (the suite's default env turns it on - see vitest.config.ts).
const googleEnv = (assets: ReturnType<typeof spyAssets>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(env as unknown as Bindings),
  ASSETS: assets.binding,
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-secret",
  AUTH_SESSION_KEY: KEY,
  DEV_FAKE_EMAIL: undefined,
  ALLOW_DEV_AUTH: undefined,
  EDGE_KEY,
  ...extra,
});

const NAV = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Accept: "text/html,application/xhtml+xml" };
const SCRIPT = { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "script", Accept: "*/*" };

async function session(over: { key?: string; iat?: number; exp?: number; payload?: string } = {}): Promise<string> {
  const now = Date.now();
  const token = await sealSession({ email: "ada@example.com", iat: over.iat ?? now, exp: over.exp ?? now + 60 * 60_000 }, over.key ?? KEY);
  // A forged payload keeps the real signature: only the MAC check can refuse it.
  return `hrms_session=${over.payload ? `${over.payload}.${token.split(".")[1]}` : token}`;
}

describe("static-site gate: signed out", () => {
  const now = Date.now();
  const forgedPayload = Buffer.from(JSON.stringify({ email: "root@example.com", iat: now, exp: now + 60_000 })).toString("base64url");
  const credentials: [string, () => Promise<Record<string, string>>][] = [
    ["no cookie", async () => ({})],
    ["an expired session", async () => ({ cookie: await session({ iat: now - 120_000, exp: now - 60_000 }) })],
    ["a session signed with another key", async () => ({ cookie: await session({ key: OTHER_KEY }) })],
    ["a forged payload", async () => ({ cookie: await session({ payload: forgedPayload }) })],
    ["an iat in the future", async () => ({ cookie: await session({ iat: now + 600_000, exp: now + 900_000 }) })],
    // The media key is not a session: holding it must not open the code tier.
    ["only the media cookie", async () => ({ cookie: `${EDGE_COOKIE}=${EDGE_KEY}` })],
  ];

  for (const [label, credential] of credentials) {
    it(`${label}: a navigation is sent to sign-in, a chunk is refused, and the asset store is never asked`, async () => {
      const assets = spyAssets();
      const e = googleEnv(assets);
      const cookie = await credential();

      const home = await app.request("/", { headers: { ...NAV, ...cookie } }, e);
      expect(home.status).toBe(302);
      expect(home.headers.get("location")).toBe("/auth/login");
      expect(await home.text()).toBe("");

      const deep = await app.request("/leave/123?tab=history", { headers: { ...NAV, ...cookie } }, e);
      expect(deep.status).toBe(302);
      expect(deep.headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent("/leave/123?tab=history")}`);

      // An existing chunk and a missing one get the SAME answer: the gate is not an oracle for file names.
      for (const path of ["/assets/index-abc123.js", "/assets/no-such-chunk.js", "/assets/index-abc123.css", "/index.html"]) {
        const res = await app.request(path, { headers: { ...SCRIPT, ...cookie } }, e);
        expect(res.status, path).toBe(401);
        expect(await res.text(), path).toBe("");
        expect(res.headers.get("cache-control"), path).toBe("no-store");
        expect(res.headers.getSetCookie(), path).toEqual([]);
      }

      const head = await app.request("/", { method: "HEAD", headers: { ...NAV, ...cookie } }, e);
      expect(head.status).toBe(302);
      const post = await app.request("/leave", { method: "POST", headers: { ...SCRIPT, ...cookie } }, e);
      expect(post.status).toBe(401);

      expect(assets.calls).toEqual([]);
    });
  }

  it("a refusal keeps nothing and sends no Referer onward", async () => {
    const res = await app.request("/payroll/runs", { headers: NAV }, googleEnv(spyAssets()));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("without Sec-Fetch headers, a GET that accepts HTML is a navigation and anything else is not", async () => {
    const e = googleEnv(spyAssets());
    expect((await app.request("/leave", { headers: { Accept: "text/html" } }, e)).status).toBe(302);
    expect((await app.request("/leave", { headers: { Accept: "*/*" } }, e)).status).toBe(401);
    expect((await app.request("/leave", {}, e)).status).toBe(401);
  });

  it("Access mode refuses a navigation with 401, never a redirect (its /auth/login bounces to /, which would loop)", async () => {
    const assets = spyAssets();
    const e = googleEnv(assets, {
      GOOGLE_CLIENT_ID: undefined,
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud",
    });
    const res = await app.request("/", { headers: NAV }, e);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(assets.calls).toEqual([]);
  });
});

describe("static-site gate: signed in", () => {
  it("serves the shell, and hands out the media cookie the edge rule checks", async () => {
    const assets = spyAssets();
    const res = await app.request("/", { headers: { ...NAV, cookie: await session() } }, googleEnv(assets));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>shell</title>");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toBe(`${EDGE_COOKIE}=${EDGE_KEY}; Max-Age=${EDGE_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    expect(assets.calls).toEqual(["/"]);
  });

  it("does not re-issue a current media cookie, and replaces a stale one", async () => {
    const cookie = await session();
    const current = await app.request("/", { headers: { ...NAV, cookie: `${cookie}; ${EDGE_COOKIE}=${EDGE_KEY}` } }, googleEnv(spyAssets()));
    expect(current.headers.getSetCookie()).toEqual([]);
    const stale = await app.request("/", { headers: { ...NAV, cookie: `${cookie}; ${EDGE_COOKIE}=previous-key-previous-key-previous-key` } }, googleEnv(spyAssets()));
    expect(stale.headers.getSetCookie()[0]).toContain(`${EDGE_COOKIE}=${EDGE_KEY};`);
  });

  it("issues no media cookie when EDGE_KEY is unset or malformed", async () => {
    const cookie = await session();
    for (const EDGE of [undefined, "", "too-short", 'has"a-quote-in-it-and-is-long-enough-for-the-rest']) {
      const res = await app.request("/", { headers: { ...NAV, cookie } }, googleEnv(spyAssets(), { EDGE_KEY: EDGE }));
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie(), String(EDGE)).toEqual([]);
    }
  });

  it("passes chunks through with their own headers, and refuses nothing it did not have to", async () => {
    const assets = spyAssets();
    const res = await app.request("/assets/index-abc123.js", { headers: { ...SCRIPT, cookie: await session() } }, googleEnv(assets));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("export{}");
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(assets.calls).toEqual(["/assets/index-abc123.js"]);
  });

  it("hands the request itself to the store, so a revalidation comes back 304", async () => {
    const res = await app.request("/", { headers: { ...NAV, cookie: await session(), "If-None-Match": '"shell-1"' } }, googleEnv(spyAssets()));
    expect(res.status).toBe(304);
  });

  it("answers a missing FILE with an honest 404, and a client-side route with the shell", async () => {
    const assets = spyAssets();
    const e = googleEnv(assets);
    const cookie = await session();
    const missing = await app.request("/assets/gone-after-a-deploy.js", { headers: { ...SCRIPT, cookie } }, e);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe("application/problem+json");
    const route = await app.request("/leave/123", { headers: { ...NAV, cookie } }, e);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>shell</title>");
    expect(assets.calls).toEqual(["/assets/gone-after-a-deploy.js", "/leave/123", "/index.html"]);
  });

  it("is read-only: a write to an app route is 405, not the shell", async () => {
    const assets = spyAssets();
    const res = await app.request("/leave", { method: "POST", headers: { ...SCRIPT, cookie: await session() } }, googleEnv(assets));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(assets.calls).toEqual([]);
  });

  it("lets the local dev bypass through with no cookie", async () => {
    const res = await app.request("/", { headers: NAV }, googleEnv(spyAssets(), { DEV_FAKE_EMAIL: "dev@example.com", ALLOW_DEV_AUTH: "true" }));
    expect(res.status).toBe(200);
  });
});

describe("static-site gate: the Worker's own routes are untouched", () => {
  it("answers /v1, /auth and the health probe as before, without touching the asset store", async () => {
    const assets = spyAssets();
    const e = googleEnv(assets);
    const api = await app.request("/v1/users/me", { headers: { "X-Requested-By": "hrms-spa" } }, e);
    expect(api.status).toBe(401);
    expect(api.headers.get("content-type")).toContain("application/problem+json");
    const login = await app.request("/auth/login", { headers: NAV }, e);
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get("location")!).origin).toBe("https://accounts.google.com");
    expect((await app.request("/healthz", {}, e)).status).toBe(200);
    // A miss under a worker-owned prefix is still a plain 404 - no sign-in redirect, no shell.
    const miss = await app.request("/found", { headers: NAV }, e);
    expect(miss.status).toBe(404);
    expect(assets.calls).toEqual([]);
  });
});

describe("isNavigation", () => {
  const req = (headers: Record<string, string>, method = "GET") => new Request("https://hrms.example.com/x", { method, headers });
  it("trusts Sec-Fetch-Mode where it is sent, and falls back to Accept where it is not", () => {
    expect(isNavigation(req({ "Sec-Fetch-Mode": "navigate" }))).toBe(true);
    expect(isNavigation(req({ "Sec-Fetch-Mode": "no-cors", Accept: "text/html" }))).toBe(false);
    expect(isNavigation(req({ "Sec-Fetch-Mode": "cors" }))).toBe(false);
    expect(isNavigation(req({ Accept: "text/html" }))).toBe(true);
    expect(isNavigation(req({ Accept: "text/html" }, "POST"))).toBe(false);
    expect(isNavigation(req({}))).toBe(false);
  });
});

describe("edge rule builder", () => {
  it("guards exactly the media paths, for these hosts, unless a listed key is present", () => {
    const expr = edgeRuleExpression(["hrms.example.com"], [EDGE_KEY]);
    expect(expr.startsWith('(http.host eq "hrms.example.com") and (')).toBe(true);
    for (const p of EDGE_PATHS) {
      if (p.includes("*")) expect(expr, p).toContain(`http.request.uri.path wildcard "${p}"`);
      else expect(expr, p).toMatch(new RegExp(`http\\.request\\.uri\\.path in \\{[^}]*"${p.replace(/[.]/g, "\\.")}"`));
    }
    expect(expr.endsWith(`and not (http.cookie contains "${EDGE_COOKIE}=${EDGE_KEY}")`)).toBe(true);
  });

  it("accepts every key of a rotation, and several hosts", () => {
    const expr = edgeRuleExpression(["hrms.example.com", "www.hrms.example.com"], [EDGE_KEY, "b".repeat(43)]);
    expect(expr).toContain('http.host in {"hrms.example.com" "www.hrms.example.com"}');
    expect(expr).toContain(`not (http.cookie contains "${EDGE_COOKIE}=${EDGE_KEY}" or http.cookie contains "${EDGE_COOKIE}=${"b".repeat(43)}")`);
  });

  it("fits the rule engine's ceiling with room to spare, even at the longest keys and several long hosts", () => {
    const longHost = `${"a".repeat(60)}.${"b".repeat(60)}.example.com`;
    const expr = edgeRuleExpression([longHost, `x.${longHost}`, `y.${longHost}`], ["k".repeat(128), "q".repeat(128)]);
    expect(expr.length).toBeLessThan(WAF_EXPRESSION_MAX);
  });

  it("refuses to build a rule that would not do what it says", () => {
    expect(() => edgeRuleExpression([], [EDGE_KEY])).toThrow();
    expect(() => edgeRuleExpression(["hrms.example.com"], [])).toThrow();
    for (const host of ["", "localhost", "HRMS.example.com", "hrms example.com", 'hrms.example.com" or true or "', "-bad.example.com"]) {
      expect(() => edgeRuleExpression([host], [EDGE_KEY]), host).toThrow();
    }
    for (const key of ["short", 'quote"quote"quote"quote"quote"quote"', "semi;colon;semi;colon;semi;colon;semi", "k".repeat(129)]) {
      expect(() => edgeRuleExpression(["hrms.example.com"], [key]), key).toThrow();
    }
  });

  it("recognises a well-formed key", () => {
    expect(isEdgeKey(EDGE_KEY)).toBe(true);
    expect(isEdgeKey("x".repeat(32))).toBe(true);
    expect(isEdgeKey("x".repeat(31))).toBe(false);
    expect(isEdgeKey(undefined)).toBe(false);
    expect(isEdgeKey("with space with space with space with")).toBe(false);
  });
});
