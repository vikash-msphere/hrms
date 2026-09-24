/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { sealSession, openSession } from "../src/lib/session";
import { app } from "../src/index";
import { makeDeps } from "../src/deps";
import * as schema from "../src/db/schema";
import { genId } from "../src/lib/idCodec";
import type { Bindings } from "../src/env";
import { safeNext } from "../src/routes/authRoutes";
import { syncGoogleProfile } from "../src/services/googleProfile";
import { orgToday } from "../src/services/orgDay";

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
    // `profile` is what puts `picture` on the ID token - see the photo-import suite at the foot of this file.
    expect(to.searchParams.get("scope")).toBe("openid email profile");
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

// WHAT A SIGN-IN WRITES ONTO THE EMPLOYEE RECORD, and the two different promises the two halves make.
//
// THE PHOTO IS A ONE-TIME FILL. The `picture` claim is free (the `profile` scope), and a new employee otherwise
// has no face in the app until somebody uploads a JPEG by hand. What this suite holds down is everything that
// makes "once" true: the claim on the employee row is the lock AND the memory, so a second sign-in imports
// nothing, a photo somebody deliberately cleared is never restored, and a failed fetch gives the slot back
// instead of spending the one chance that person gets. Plus the two refusals that keep an outbound fetch
// honest - a host that is not Google's, and a body that is not the JPEG everything downstream serves it as.
//
// THE NAME IS A MIRROR, and off by default: `first_name`/`last_name` are NOT NULL and HR types them at hire, so
// there is no empty slot and the only thing a sync can do is overwrite. The cases below are the guards that
// make that safe to switch on - no write when nothing changed, no half-name, and an audit entry on every real
// change so a name that moved can be traced to this and not to a person.
describe("Google mode: syncing the profile", () => {
  const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const b = env as unknown as Bindings;
  const KEY32 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const EMAIL = "avatar@example.com";
  const AVATAR = "https://lh3.googleusercontent.com/a/ACg8ocKtest=s96-c";
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);

  /** Somebody with a Google account and no employee record - what the auto-create is for. */
  const NEW_EMAIL = "newjoiner@example.com";

  const deps = () => makeDeps({ ...googleEnv() } as unknown as Bindings);
  const employee = async () => (await deps().db.select().from(schema.employees).where(eq(schema.employees.workEmail, EMAIL)).limit(1))[0]!;

  let calls: string[] = [];
  const realFetch = globalThis.fetch;
  /** Stand in for Google's avatar CDN, recording what was asked for. */
  const serve = (body: BodyInit | null, init?: ResponseInit) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(body, init ?? { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
  };

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
    const d = deps();
    await d.db.delete(schema.employees).where(eq(schema.employees.workEmail, EMAIL));
    await d.db.delete(schema.employees).where(eq(schema.employees.workEmail, NEW_EMAIL));
    await d.db.delete(schema.users).where(eq(schema.users.email, EMAIL));
    await d.db.delete(schema.users).where(eq(schema.users.email, NEW_EMAIL));
    await d.db.delete(schema.settings).where(eq(schema.settings.key, "sign-in"));
    await d.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }]).onConflictDoNothing();
    await d.db.insert(schema.employees).values({
      uuid: genId(),
      code: `e-${genId().slice(0, 5)}`,
      firstName: "Ada",
      lastName: "Avatar",
      workEmail: EMAIL,
    });
    calls = [];
    serve(JPEG);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("imports the photo once, at a usable size, and does nothing on the next sign-in", async () => {
    await syncGoogleProfile(deps(), EMAIL, { picture: AVATAR });
    const after = await employee();
    expect(after.photoKey).toBe(`photos/${after.uuid}`);
    expect(after.photoAt).not.toBeNull();
    // Google renders whatever the size directive asks for, and the one on the claim is `s96`.
    expect(calls).toEqual([AVATAR.replace("=s96-c", "=s400-c")]);
    // The bytes are in the (encrypted) store and come back out as they went in.
    expect(new Uint8Array((await deps().docs.get(after.photoKey!))!)).toEqual(JPEG);

    // Second sign-in: the row already carries a photo, so the claim matches nothing and Google is never asked.
    await syncGoogleProfile(deps(), EMAIL, { picture: AVATAR });
    expect(calls).toHaveLength(1);
  });

  it("never replaces a photo that is already there, and never restores one that was cleared", async () => {
    // Uploaded here, by hand - the app's own photo always wins.
    await deps().db.update(schema.employees).set({ photoKey: "photos/mine", photoAt: new Date() }).where(eq(schema.employees.workEmail, EMAIL));
    await syncGoogleProfile(deps(), EMAIL, { picture: AVATAR });
    expect((await employee()).photoKey).toBe("photos/mine");
    expect(calls).toHaveLength(0);

    // Cleared: `clearPhoto` nulls the key and STAMPS the time, which is how "I removed it on purpose" is told
    // apart from "never had one". Handing Google's back here is the one outcome that would be unfixable.
    await deps().db.update(schema.employees).set({ photoKey: null, photoAt: new Date() }).where(eq(schema.employees.workEmail, EMAIL));
    await syncGoogleProfile(deps(), EMAIL, { picture: AVATAR });
    expect((await employee()).photoKey).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("does nothing at all when the org has switched it off", async () => {
    await deps().db.insert(schema.settings).values({ key: "sign-in", value: JSON.stringify({ google_photo: false }) });
    await syncGoogleProfile(deps(), EMAIL, { picture: AVATAR });
    const after = await employee();
    expect(calls).toHaveLength(0);
    // The slot is untouched, not merely unfilled: stamping it would spend the person's one import silently,
    // so turning the switch back on would do nothing for anybody who signed in while it was off.
    expect(after.photoKey).toBeNull();
    expect(after.photoAt).toBeNull();
  });

  it("refuses a URL that is not a Google avatar, without making the request", async () => {
    for (const bad of [
      "https://evil.example/a/photo=s96-c",
      "http://lh3.googleusercontent.com/a/photo=s96-c", // not https
      "https://lh3.googleusercontent.com.evil.example/a/photo", // suffix, not the domain
      "https://lh3.googleusercontent.com/a/default-user=s96-c", // Google's generated initial, not a photograph
      "not a url",
    ]) {
      await syncGoogleProfile(deps(), EMAIL, { picture: bad });
    }
    expect(calls).toHaveLength(0);
    expect((await employee()).photoAt).toBeNull();
  });

  it("refuses a body that is not a JPEG, and gives the slot back so the next sign-in can retry", async () => {
    serve(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    await syncGoogleProfile(deps(), EMAIL, { picture: AVATAR });
    let after = await employee();
    expect(after.photoKey).toBeNull();
    // The claim is RELEASED. Left stamped, one bad response would cost this person the import permanently.
    expect(after.photoAt).toBeNull();

    serve(JPEG);
    await syncGoogleProfile(deps(), EMAIL, { picture: AVATAR });
    after = await employee();
    expect(after.photoKey).toBe(`photos/${after.uuid}`);
  });

  // ---- the name, and its three modes ---------------------------------------------------------------------

  const NAMES = { givenName: "Grace", familyName: "Hopper" };
  const nameMode = (mode: unknown) => deps().db.insert(schema.settings).values({ key: "sign-in", value: JSON.stringify({ google_name: mode }) });
  const nameAudits = async (uuid: string) =>
    (await deps().db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "employee.name.update"))).filter((a) => a.entityId === uuid);
  /** An account that has USED the app - what `once` reads to tell a new joiner from everybody else. */
  const seen = (at: Date | null) =>
    deps().db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 5)}`, email: EMAIL, role: "employee", status: "active", lastSeenAt: at });

  it("takes the name at a first sign-in, by default, and records the change", async () => {
    await seen(null); // the account exists (hiring creates it) but nobody has used it
    const before = await employee();
    await syncGoogleProfile(deps(), EMAIL, NAMES);
    const after = await employee();
    expect([after.firstName, after.lastName]).toEqual(["Grace", "Hopper"]);
    // A real content change, so the row's version MOVES - an open profile form should conflict, unlike the
    // photo claim, which deliberately holds `updated_at` still.
    expect(+new Date(after.updatedAt)).toBeGreaterThanOrEqual(+new Date(before.updatedAt));

    const entries = await nameAudits(after.uuid);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.meta!)).toMatchObject({
      diff: { first_name: { from: "Ada", to: "Grace" }, last_name: { from: "Avatar", to: "Hopper" } },
    });
  });

  it("stops arguing once the person has used the app - a correction made here survives every later sign-in", async () => {
    await seen(new Date());
    await syncGoogleProfile(deps(), EMAIL, NAMES);
    const after = await employee();
    expect([after.firstName, after.lastName]).toEqual(["Ada", "Avatar"]);
    expect(await nameAudits(after.uuid)).toHaveLength(0);
  });

  it("never touches the name when the org says never", async () => {
    await nameMode("never");
    await seen(null);
    await syncGoogleProfile(deps(), EMAIL, NAMES);
    expect([(await employee()).firstName, (await employee()).lastName]).toEqual(["Ada", "Avatar"]);
  });

  it("mirrors on every sign-in when the org says always, however long they have been here", async () => {
    await nameMode("always");
    await seen(new Date());
    await syncGoogleProfile(deps(), EMAIL, NAMES);
    expect([(await employee()).firstName, (await employee()).lastName]).toEqual(["Grace", "Hopper"]);
  });

  it("reads a value it does not recognise as `never`, and the old boolean as what it used to mean", async () => {
    await nameMode("alwyas"); // a typo must sync LESS than intended, never more
    await seen(new Date());
    await syncGoogleProfile(deps(), EMAIL, NAMES);
    expect((await employee()).firstName).toBe("Ada");

    // This setting shipped as a boolean before it grew a middle option; `true` meant today's "always".
    await deps().db.update(schema.settings).set({ value: JSON.stringify({ google_name: true }) }).where(eq(schema.settings.key, "sign-in"));
    await syncGoogleProfile(deps(), EMAIL, NAMES);
    expect((await employee()).firstName).toBe("Grace");
  });

  it("writes nothing at all when the name already matches", async () => {
    await nameMode("always");
    await seen(new Date());
    await syncGoogleProfile(deps(), EMAIL, { givenName: "Ada", familyName: "Avatar" });
    // Every sign-in runs this. A rewrite-anyway would move the ETag on every one of them and 409 anybody with
    // the profile open, and would fill the trail with entries that record no change.
    expect(await nameAudits((await employee()).uuid)).toHaveLength(0);
  });

  it("refuses a half name, rather than blanking the other part", async () => {
    await nameMode("always");
    await seen(new Date());
    for (const half of [{ givenName: "Grace" }, { familyName: "Hopper" }, { givenName: "  ", familyName: "Hopper" }]) {
      await syncGoogleProfile(deps(), EMAIL, half);
    }
    const after = await employee();
    expect([after.firstName, after.lastName]).toEqual(["Ada", "Avatar"]);
  });

  // ---- making the employee record -------------------------------------------------------------------------
  //
  // The one switch here that creates a PERSON rather than filling a field on one, which is why it is off by
  // default and why "once" is structural: an employee holding the work address is the memory, and a leaver's
  // soft-deleted row counts - coming back must be a rehire somebody decides, not a side effect of signing in.

  const newcomer = async () =>
    (await deps().db.select().from(schema.employees).where(eq(schema.employees.workEmail, NEW_EMAIL)))[0];
  const createOn = (extra: Record<string, unknown> = {}) =>
    deps().db.insert(schema.settings).values({ key: "sign-in", value: JSON.stringify({ google_employee: true, ...extra }) });

  it("creates nobody unless the org asked for it", async () => {
    await syncGoogleProfile(deps(), NEW_EMAIL, NAMES);
    expect(await newcomer()).toBeUndefined();
  });

  it("creates the record from what the sign-in carries, and links the sign-in account to it", async () => {
    await createOn();
    await syncGoogleProfile(deps(), NEW_EMAIL, NAMES);
    const emp = (await newcomer())!;
    expect([emp.firstName, emp.lastName, emp.workEmail]).toEqual(["Grace", "Hopper", NEW_EMAIL]);
    // The org's own calendar day, not the Worker's UTC one.
    expect(emp.startDate && new Date(emp.startDate).toISOString().slice(0, 10)).toBe(await orgToday(deps()));
    // It is a full `createEmployee`, so the person has a code, a human ID and an account - without the account
    // link every `me`-scoped grant misses and they sign in to an empty app, which is the whole point of this.
    expect(emp.code).toBeTruthy();
    expect(emp.employeeNumber).toBeTruthy();
    const account = (await deps().db.select().from(schema.users).where(eq(schema.users.email, NEW_EMAIL)))[0];
    expect(account?.employeeId).toBe(emp.uuid);
  });

  it("adopts an account that signed in before there was a record to link it to", async () => {
    // The ordinary order of events: the auth middleware minted this row on an earlier sign-in, unlinked,
    // because no employee held the address yet.
    await deps().db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 5)}`, email: NEW_EMAIL, role: "employee", status: "active" });
    await createOn();
    await syncGoogleProfile(deps(), NEW_EMAIL, NAMES);
    const rows = await deps().db.select().from(schema.users).where(eq(schema.users.email, NEW_EMAIL));
    // Linked, not duplicated: a second account at the default role would hold none of the first one's grants.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employeeId).toBe((await newcomer())!.uuid);
  });

  it("creates at most one, however many times they sign in", async () => {
    await createOn();
    await syncGoogleProfile(deps(), NEW_EMAIL, NAMES);
    const first = (await newcomer())!;
    await syncGoogleProfile(deps(), NEW_EMAIL, { givenName: "Someone", familyName: "Else" });
    const rows = await deps().db.select().from(schema.employees).where(eq(schema.employees.workEmail, NEW_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uuid).toBe(first.uuid);
  });

  it("does not resurrect a leaver whose record was deleted", async () => {
    await deps().db.insert(schema.employees).values({
      uuid: genId(),
      code: `e-${genId().slice(0, 5)}`,
      firstName: "Gone",
      lastName: "Away",
      workEmail: NEW_EMAIL,
      deleteTime: new Date(),
    });
    await createOn();
    await syncGoogleProfile(deps(), NEW_EMAIL, NAMES);
    const rows = await deps().db.select().from(schema.employees).where(eq(schema.employees.workEmail, NEW_EMAIL));
    // One row, still the deleted one. Coming back is a rehire a person decides, not a sign-in side effect.
    expect(rows).toHaveLength(1);
    expect([rows[0]!.firstName, rows[0]!.deleteTime]).toEqual(["Gone", rows[0]!.deleteTime]);
    expect(rows[0]!.deleteTime).not.toBeNull();
  });

  it("will not make a record it can only name after an email address", async () => {
    await createOn();
    await syncGoogleProfile(deps(), NEW_EMAIL, { givenName: "Grace" });
    expect(await newcomer()).toBeUndefined();
  });

  it("gives the person it just created their Google photo in the same pass", async () => {
    await createOn();
    await syncGoogleProfile(deps(), NEW_EMAIL, { ...NAMES, picture: AVATAR });
    const emp = (await newcomer())!;
    expect(emp.photoKey).toBe(`photos/${emp.uuid}`);
  });

  it("survives Google failing outright (a sign-in must never fail on a missing face)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(syncGoogleProfile(deps(), EMAIL, { picture: AVATAR })).resolves.toBeUndefined();
    expect((await employee()).photoAt).toBeNull();
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
