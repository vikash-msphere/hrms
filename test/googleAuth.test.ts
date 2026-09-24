/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { sealSession, openSession } from "../src/lib/session";
import { app } from "../src/index";
import { makeDeps } from "../src/deps";
import * as schema from "../src/db/schema";
import { genId } from "../src/lib/idCodec";
import type { Bindings } from "../src/env";
import { safeNext } from "../src/routes/authRoutes";

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

  // `iat` decides REVOCATION - the auth middleware compares it against the user's `sessions_valid_from` stamp,
  // which is what "sign out everywhere" and "I lost my phone" mean. A payload without one used to open fine,
  // leaving `sessionIat` undefined: the middleware's `!== null` guard passed it, `undefined < stamp` compared
  // false, and the revoked cookie was honoured. It is validated as strictly as `exp` for that reason.
  it("rejects a session whose iat is missing or not a number", async () => {
    const now = Date.now();
    // Signed with the REAL key, so only the field check can reject these - not the MAC.
    const sign = (payload: object) => sealSession(payload as never, KEY);
    expect(await openSession(await sign({ email: "ada@example.com", exp: now + 60_000 }), KEY, now)).toBeNull();
    expect(await openSession(await sign({ email: "ada@example.com", iat: null, exp: now + 60_000 }), KEY, now)).toBeNull();
    expect(await openSession(await sign({ email: "ada@example.com", iat: "yesterday", exp: now + 60_000 }), KEY, now)).toBeNull();
    // ...and one without a usable `exp` likewise, which was already true and stays true.
    expect(await openSession(await sign({ email: "ada@example.com", iat: now }), KEY, now)).toBeNull();
    // The well-formed one still opens.
    expect((await openSession(await sign({ email: "ada@example.com", iat: now, exp: now + 60_000 }), KEY, now))?.iat).toBe(now);
  });

  // The same field, bounded rather than merely numeric - both shapes below defeat the revocation decision the
  // middleware makes from `iat` while passing every other check.
  it("rejects an iat in the future or a sitting wider than the lane's ceiling", async () => {
    const now = Date.now();
    const sign = (payload: object) => sealSession(payload as never, KEY);
    // A future `iat` outlives any `sessions_valid_from` stamp set from the present clock, so "sign out
    // everywhere" would never reach it.
    expect(await openSession(await sign({ email: "ada@example.com", iat: now + 600_000, exp: now + 900_000 }), KEY, now)).toBeNull();
    // A small skew is tolerated: both clocks are this Worker's, and sealing then reading takes milliseconds.
    expect(await openSession(await sign({ email: "ada@example.com", iat: now + 5_000, exp: now + 60_000 }), KEY, now)).not.toBeNull();
    // A cookie claiming a year-long sitting is not one this lane issues (12h), and the revocation story here
    // is "short TTL plus a cut-off stamp".
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(await openSession(await sign({ email: "ada@example.com", iat: now - year, exp: now + 60_000 }), KEY, now)).toBeNull();
    // The issued shape is well inside the ceiling and unaffected.
    const twelveHours = 12 * 60 * 60 * 1000;
    expect(await openSession(await sign({ email: "ada@example.com", iat: now, exp: now + twelveHours }), KEY, now)).not.toBeNull();
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

  // What the browser keeps after signing out: not the media key, and not the year-long cached bundle.
  it("logout also drops the media cookie and the HTTP cache", async () => {
    const res = await app.request("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa" } }, googleEnv());
    expect(res.headers.getSetCookie().join(";")).toContain("hrms_edge=;");
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
  });

  // The page to come back to rides the round trip beside state and nonce - but only a page on this origin.
  it("login parks a same-origin `next`, and clears any stale one when the request has none", async () => {
    const parked = await app.request(`/auth/login?next=${encodeURIComponent("/leave/123?tab=history")}`, {}, googleEnv());
    expect(parked.status).toBe(302);
    const cookie = parked.headers.getSetCookie().find((c) => c.startsWith("hrms_oauth_next="));
    expect(cookie).toBeDefined();
    expect(decodeURIComponent(cookie!.split(";")[0]!.slice("hrms_oauth_next=".length))).toBe("/leave/123?tab=history");
    expect(cookie).toContain("Path=/auth");
    expect(cookie).toContain("HttpOnly");

    for (const next of ["//evil.example/x", "https://evil.example/", "/auth/login"]) {
      const res = await app.request(`/auth/login?next=${encodeURIComponent(next)}`, {}, googleEnv());
      const set = res.headers.getSetCookie().find((c) => c.startsWith("hrms_oauth_next="));
      // Refused values are not parked; the cookie is cleared instead (an empty value).
      expect(set, next).toMatch(/^hrms_oauth_next=;/);
    }
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

describe("safeNext: sign-in only ever returns to a page on this origin", () => {
  const origin = "https://hrms.example.com";
  it("keeps a same-origin path and its query, normalised", () => {
    expect(safeNext("/leave/123", origin)).toBe("/leave/123");
    expect(safeNext("/leave?tab=history&x=1", origin)).toBe("/leave?tab=history&x=1");
    expect(safeNext("/a/../payroll", origin)).toBe("/payroll");
    // Encoded slashes stay a path on this origin - the browser requests them literally.
    expect(safeNext("/%2F%2Fevil.example", origin)).toBe("/%2F%2Fevil.example");
  });

  it("refuses anything that could leave the origin, loop, or be read differently than it was checked", () => {
    const refused = [
      undefined,
      null,
      "",
      "leave",
      "//evil.example/path",
      "/\\evil.example/path",
      "https://evil.example/",
      "javascript:alert(1)",
      "/auth/login",
      "/auth/callback?code=x",
      "/auth",
      "/leave\tx",
      "/leave\nx",
      `/${"a".repeat(2048)}`,
    ];
    for (const raw of refused) expect(safeNext(raw, origin), JSON.stringify(raw)).toBeNull();
  });
});

// A stateless cookie is verified by signature alone, so deleting the browser's copy does not stop the token:
// one lifted off a lost laptop stayed good for the rest of its 12 hours, and the only server-side answers were
// disabling the person or rotating AUTH_SESSION_KEY (which signs out the whole company).
//
// `users.sessions_valid_from` is the cut-off that fixes it, checked in the auth middleware against the `iat`
// the cookie carries - on the user row auth ALREADY reads every request to check `status`, so it costs nothing.
describe("Google mode: signing out actually revokes the session", () => {
  const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const b = env as unknown as Bindings;
  const KEY32 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const EMAIL = "revoke@example.com";

  beforeAll(async () => {
    (b as unknown as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY32;
    (b as unknown as Record<string, unknown>).WIRE_ID_KEY = KEY32;
    const sql = Object.keys(migrations).sort().map((k) => migrations[k]).join("\n");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await b.DB.prepare(s).run().catch(() => {}); // tables may already exist from another suite
    }
  });

  beforeEach(async () => {
    const deps = makeDeps({ ...googleEnv() } as unknown as Bindings);
    await deps.db.delete(schema.users).where(eq(schema.users.email, EMAIL));
    await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }]).onConflictDoNothing();
    await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 5)}`, email: EMAIL, role: "employee", status: "active" });
  });

  const asUser = (token: string) =>
    app.request("/v1/users/me", { headers: { "X-Requested-By": "hrms-spa", cookie: `hrms_session=${token}` } }, googleEnv());

  // The assertion is deliberately "401 or not 401", not a 200: this user holds no grants, so authz answers 403.
  // That is exactly what isolates the session check - a 403 proves the cookie was ACCEPTED and the request got
  // past authentication, which is the only thing under test here.
  it("accepts a live session, then refuses that same cookie once the user signs out", async () => {
    const now = Date.now();
    const token = await sealSession({ email: EMAIL, iat: now, exp: now + 60_000 }, KEY);
    expect((await asUser(token)).status).not.toBe(401);

    const out = await app.request(
      "/auth/logout",
      { method: "POST", headers: { "X-Requested-By": "hrms-spa", cookie: `hrms_session=${token}` } },
      googleEnv(),
    );
    expect(out.status).toBe(200);

    // Same unexpired, correctly-signed cookie. Signature-only verification would still admit it.
    expect((await asUser(token)).status).toBe(401);
  });

  it("lets the user straight back in: a session minted after the cut-off is fine", async () => {
    const now = Date.now();
    const old = await sealSession({ email: EMAIL, iat: now - 10_000, exp: now + 60_000 }, KEY);
    await app.request("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa", cookie: `hrms_session=${old}` } }, googleEnv());
    expect((await asUser(old)).status).toBe(401);

    // Signing in again issues a fresh `iat`, which is at or after the stamp.
    const fresh = await sealSession({ email: EMAIL, iat: Date.now() + 1000, exp: Date.now() + 60_000 }, KEY);
    expect((await asUser(fresh)).status).not.toBe(401);
  });

  it("revokes every device, which is what a token with no per-device identity can honestly promise", async () => {
    const now = Date.now();
    const laptop = await sealSession({ email: EMAIL, iat: now - 5_000, exp: now + 60_000 }, KEY);
    const phone = await sealSession({ email: EMAIL, iat: now - 4_000, exp: now + 60_000 }, KEY);
    await app.request("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa", cookie: `hrms_session=${phone}` } }, googleEnv());
    expect((await asUser(laptop)).status).toBe(401);
    expect((await asUser(phone)).status).toBe(401);
  });

  it("leaves a logout with no session cookie as a pure cookie-clear (no write, nobody revoked)", async () => {
    const now = Date.now();
    const token = await sealSession({ email: EMAIL, iat: now, exp: now + 60_000 }, KEY);
    const out = await app.request("/auth/logout", { method: "POST", headers: { "X-Requested-By": "hrms-spa" } }, googleEnv());
    expect(out.status).toBe(200);
    // Nothing was stamped, so an unrelated live session is untouched.
    expect((await asUser(token)).status).not.toBe(401);
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

// THE SIGN-IN FLOOR IS PER CALLER, and that is the property worth pinning rather than the number.
//
// `/auth/*` carried a single shared `counter()` for the whole route while `/found` and `/diag` had both been
// moved to `keyedCounter`. The failure mode of a shared budget here is not a refused attacker: it is that one
// client in a loop spends the isolate's whole allowance and NOBODY ELSE ON THAT ISOLATE CAN SIGN IN. Sign-in
// is the door, so a floor whose failure mode is locking the workforce out is worse than the flood it bounds.
//
// The route-wide ceiling is kept alongside it (a thousand addresses each inside their own budget is still a
// thousand OAuth round trips), which is why this asserts both halves: one address is cut off, and a second
// address is unaffected by the first one's spending.
describe("/auth is floored per caller, not per isolate", () => {
  // Comfortably past the per-IP budget (30/min) and far under the route-wide one (300/min), so the second
  // address below is answering on its own budget rather than on what is left of a shared one.
  const BURST = 34;
  const login = (ip: string) => app.request("/auth/login", { headers: { "cf-connecting-ip": ip } }, googleEnv());

  it("throttles the address that is hammering it, and only that address", async () => {
    let refused = 0;
    for (let i = 0; i < BURST; i++) {
      const res = await login("203.0.113.9");
      if (res.status === 429) refused++;
    }
    expect(refused, "one address must run out of its own budget").toBeGreaterThan(0);

    // The whole point: a different caller arrives after that burst and still gets in.
    const other = await login("198.51.100.4");
    expect(other.status, "a second address must not pay for the first one's burst").toBe(302);
    expect(other.headers.get("location")).toContain("accounts.google.com");
  });

  it("advertises what is left of the window, never zero", async () => {
    let retryAfter: string | null = null;
    for (let i = 0; i < BURST && retryAfter === null; i++) {
      const res = await login("203.0.113.77");
      if (res.status === 429) retryAfter = res.headers.get("Retry-After");
    }
    expect(retryAfter, "a refusal must say when to come back").not.toBeNull();
    const seconds = Number(retryAfter);
    expect(Number.isInteger(seconds)).toBe(true);
    // At least 1 (a `Retry-After: 0` invites the retry the same window refuses) and never more than the
    // window it is the remainder of.
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
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
