/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { sealSession, openSession } from "../src/lib/session";
import { app } from "../src/index";
import { makeDeps } from "../src/deps";
import type { Bindings } from "../src/env";

// Direct Google sign-in mode: the stateless session codec, and the /auth routes' behavior in both auth
// modes. The Google token exchange itself is not driven here (it needs Google); what IS pinned down is
// everything an attacker can reach without Google - the cookie's integrity, the state gate, the CSRF
// posture, and that the middleware rejects absent/forged sessions.

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const OTHER_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

const googleEnv = (): Record<string, unknown> => ({
  ...(env as unknown as Bindings),
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-secret",
  AUTH_SESSION_KEY: KEY,
  DEV_FAKE_EMAIL: undefined,
  ALLOW_DEV_AUTH: undefined,
});

describe("session codec", () => {
  it("round-trips a valid session", async () => {
    const now = Date.now();
    const token = await sealSession({ email: "ada@example.com", iat: now, exp: now + 60_000 }, KEY);
    const opened = await openSession(token, KEY, now);
    expect(opened?.email).toBe("ada@example.com");
  });

  it("rejects an expired session", async () => {
    const now = Date.now();
    const token = await sealSession({ email: "ada@example.com", iat: now - 120_000, exp: now - 60_000 }, KEY);
    expect(await openSession(token, KEY, now)).toBeNull();
  });

  it("rejects a tampered payload and a wrong key", async () => {
    const now = Date.now();
    const token = await sealSession({ email: "ada@example.com", iat: now, exp: now + 60_000 }, KEY);
    // Forge the payload but keep the signature.
    const forgedPayload = Buffer.from(JSON.stringify({ email: "root@evil.example", iat: now, exp: now + 60_000 })).toString("base64url");
    const forged = `${forgedPayload}.${token.split(".")[1]}`;
    expect(await openSession(forged, KEY, now)).toBeNull();
    // Same payload signed under a different key.
    const otherKeyToken = await sealSession({ email: "ada@example.com", iat: now, exp: now + 60_000 }, OTHER_KEY);
    expect(await openSession(otherKeyToken, KEY, now)).toBeNull();
    // Garbage.
    expect(await openSession("not-a-token", KEY, now)).toBeNull();
    expect(await openSession("", KEY, now)).toBeNull();
  });
});

describe("/auth routes (Google mode)", () => {
  it("login redirects to Google with state+nonce cookies and the right params", async () => {
    const res = await app.request("/auth/login", {}, googleEnv());
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://accounts.google.com");
    expect(to.searchParams.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("scope")).toBe("openid email");
    const cookies = res.headers.getSetCookie().join(";");
    expect(cookies).toContain("hrms_oauth_state=");
    expect(cookies).toContain("hrms_oauth_nonce=");
    expect(cookies).toContain("HttpOnly");
    // The state in the URL must be the state in the cookie.
    const state = to.searchParams.get("state")!;
    expect(cookies).toContain(`hrms_oauth_state=${state}`);
  });

  it("callback refuses a state mismatch without exchanging the code", async () => {
    const res = await app.request(
      "/auth/callback?code=fake&state=attacker",
      { headers: { cookie: "hrms_oauth_state=different; hrms_oauth_nonce=n" } },
      googleEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("logout requires the CSRF header, then clears the session cookie", async () => {
    const noHeader = await app.request("/auth/logout", { method: "POST" }, googleEnv());
    expect(noHeader.status).toBe(403);
    const res = await app.request("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa" } }, googleEnv());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signin_url: string }).signin_url).toBe("/auth/login");
    expect(res.headers.getSetCookie().join(";")).toContain("hrms_session=;");
  });

  it("a /v1 request without a session is 401; a forged session cookie is 401", async () => {
    const e = googleEnv();
    const none = await app.request("/v1/users/me", { headers: { "X-Requested-By": "hrms-spa" } }, e);
    expect(none.status).toBe(401);
    const now = Date.now();
    const forged = await sealSession({ email: "root@example.com", iat: now, exp: now + 60_000 }, OTHER_KEY);
    const bad = await app.request("/v1/users/me", { headers: { "X-Requested-By": "hrms-spa", cookie: `hrms_session=${forged}` } }, e);
    expect(bad.status).toBe(401);
  });
});

describe("Google mode: the domain allow-list is the perimeter, so an empty one is refused", () => {
  // In Access mode Cloudflare is the perimeter and an unset list means "no extra restriction". In Google
  // mode there is nothing in front of the Worker: an unset list would admit ANY Google account on the
  // internet and auto-provision it as an `employee`. Both the startup check and the callback fail closed.
  it("makeDeps refuses to boot Google mode without ALLOWED_EMAIL_DOMAINS", () => {
    const noDomains = { ...googleEnv(), ALLOWED_EMAIL_DOMAINS: undefined } as unknown as Bindings;
    expect(() => makeDeps(noDomains)).toThrow(/ALLOWED_EMAIL_DOMAINS/);
    // A list of only separators/blanks is the same thing as unset.
    expect(() => makeDeps({ ...noDomains, ALLOWED_EMAIL_DOMAINS: " , " })).toThrow(/ALLOWED_EMAIL_DOMAINS/);
    // Configured -> boots.
    expect(() => makeDeps({ ...noDomains, ALLOWED_EMAIL_DOMAINS: "example.com" })).not.toThrow();
  });
});

describe("/auth routes (Access mode)", () => {
  it("login bounces home (the edge is the login) and logout points at the Access logout", async () => {
    const e: Record<string, unknown> = { ...(env as unknown as Bindings), DEV_FAKE_EMAIL: undefined, ALLOW_DEV_AUTH: undefined };
    const login = await app.request("/auth/login", {}, e);
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/");
    const logout = await app.request("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa" } }, e);
    expect(((await logout.json()) as { signin_url: string }).signin_url).toBe("/cdn-cgi/access/logout");
  });
});
