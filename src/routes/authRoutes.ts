import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../env";
import { users } from "../db/schema";
import { makeDeps } from "../deps";
import { openSession, sealSession } from "../lib/session";
import { counter, keyedCounter } from "../lib/isolateRate";
import { syncGoogleProfile, type GoogleProfileClaims } from "../services/googleProfile";
import { EDGE_COOKIE } from "../http/assetPaths";
import { UNLOCK_COOKIE } from "../lib/appLock";

// Direct Google sign-in (OIDC authorization-code flow), the no-per-seat-cost alternative to fronting the
// app with Cloudflare Access. Selected by configuration: GOOGLE_CLIENT_ID set = Google mode; absent =
// Access mode, where these routes only bounce to the edge (Access re-challenges on its own).
//
// The flow is deliberately minimal - no library beyond `jose` (already used for the Access JWT):
//   /auth/login     -> 302 to Google's consent screen, with `state` (CSRF) + `nonce` (token replay) parked
//                      in short-lived HttpOnly cookies scoped to /auth, and `?next=` (the page to return to,
//                      same-origin only - see safeNext) parked beside them.
//   /auth/callback  -> state must round-trip, code is exchanged server-side (client_secret never leaves the
//                      Worker), the ID token is verified against Google's JWKS (issuer, audience=client_id,
//                      expiry, signature, nonce, email_verified), the email's domain is checked against
//                      ALLOWED_EMAIL_DOMAINS, a signed stateless session cookie is set (lib/session.ts), and
//                      the browser lands on the parked page, or `/`.
//
// The `profile` scope is asked for so the ID token carries `picture` and `given_name`/`family_name`, which
// services/googleProfile.ts writes onto the employee record as far as `settings/sign-in` allows - off the
// response path, never awaited. Access mode gets none of this: an Access JWT carries an email and nothing else,
// so there is nothing to sync.
//   /auth/logout    -> clears the session cookie, the media cookie and the HTTP cache (POST + the app's CSRF
//                      header, like every /v1 mutation).
//
// User provisioning does NOT happen here: the first authenticated /v1 request runs the same auto-provision
// path Access logins use (middleware/auth.ts), so the two modes create identical users.

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export const SESSION_COOKIE = "hrms_session";
// Short enough that a stolen cookie has a bounded life and a disabled Google account is fully out within a
// working day; long enough that nobody signs in twice in one. Google re-auth is silent (SSO), so expiry is
// a redirect round-trip, not a password prompt.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STATE_COOKIE = "hrms_oauth_state";
const NONCE_COOKIE = "hrms_oauth_nonce";
// Where to land after sign-in. Parked across the Google round trip like state and nonce, rather than carried in
// `state` (which Google echoes in a URL) or in the redirect_uri (which must match the registered one exactly).
const NEXT_COOKIE = "hrms_oauth_next";
const NEXT_MAX = 2048;

/**
 * The same-origin page a sign-in may return to, or null. Reached from a URL anyone can craft
 * (`/auth/login?next=...`), so the answer is only ever a path on THIS origin: an open redirect here would turn
 * the company's own sign-in page into a phishing hop. Refused: anything not starting with one `/`
 * (`//evil.example` and `/\evil.example` both resolve to another host), control characters (the URL parser
 * silently strips tabs and newlines, so what was checked would not be what was followed), anything the URL
 * parser resolves off-origin, and `/auth/` itself (a loop). Returns the normalised path + query, never a
 * fragment - the server never sees one.
 */
export function safeNext(raw: string | null | undefined, origin: string): string | null {
  if (typeof raw !== "string" || !raw || raw.length > NEXT_MAX) return null;
  if (raw[0] !== "/" || raw[1] === "/" || raw[1] === "\\") return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return null;
  return url.pathname + url.search;
}

let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

const randomToken = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

// The one cookie shape for the two OAuth round-trip cookies: HttpOnly (no script access), Secure, Lax (sent
// on the top-level redirect back from Google), scoped to /auth so they never ride ordinary API requests.
const OAUTH_COOKIE = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/auth", maxAge: 600 };

// A FLOOR on the one unauthenticated lane a person actually walks (see lib/isolateRate.ts - the control is
// the WAF rule, and `npm run preflight` names this route as having had nothing at all). `/callback` is the
// expensive half: it exchanges a code with Google over a real outbound request and verifies an id token
// against a fetched JWKS, neither of which requires a credential of ours to provoke.
//
// TWO BUDGETS, because they bound different things and neither implies the other.
//
// `perIp` is the one that was missing. A single shared counter is what `/found` and `/diag` were both moved
// off, for a reason that applies here with more force than it does to either of them: one noisy client spends
// the isolate's entire allowance, and the cost of that is not a refused attacker, it is that NOBODY ELSE ON
// THAT ISOLATE CAN SIGN IN. Sign-in is the door - a floor whose failure mode is locking the workforce out of
// the app is worse than the flood it was put there to bound. The key is the address Cloudflare observed
// (`cf-connecting-ip`), which a client cannot set because the edge overwrites it - the same reason the audit
// trail keys on it and nothing else.
//
// `total` keeps the absolute ceiling the shared counter used to be, because per-IP alone bounds nothing
// against a spread-out flood: a thousand addresses each politely inside their own budget is still a thousand
// OAuth round trips this isolate pays for. Sized so a whole company arriving at nine in the morning never
// notices - sign-ins land on many isolates, and one isolate serving 300 a minute is already an unusual
// morning - while one address walking through 30 of them in a minute is already a client in a loop.
const perIp = keyedCounter(30);
const total = counter(300);
// One bucket for requests arriving with no observed address (not behind the edge - local dev, a direct origin
// hit). They share a budget rather than each getting the full one, which is the conservative way round:
// unattributable traffic must not be the way to get an unbounded allowance. Same shape as routes/found.ts.
const NO_IP = "-";

// On the three sign-in routes BY NAME, not on "*": this app is mounted at /auth, and "*" would reach every
// other /auth path too - the app lock's (routes/appLockRoutes.ts), whose keepalives from an office behind one
// address would then spend that address's sign-in budget.
const signInFloor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const now = Date.now();
  // Per-IP FIRST, so its `retryAfterSeconds` is the one reported when it is the budget that refused - the
  // two counters keep separate windows, and reading the wrong one parks a client for a window that had
  // nothing to do with them.
  if (perIp.throttled(c.req.header("cf-connecting-ip") ?? NO_IP, now)) {
    return c.text("too many sign-in attempts; try again in a minute", 429, { "Retry-After": String(perIp.retryAfterSeconds) });
  }
  if (total.throttled(now)) {
    return c.text("too many sign-in attempts; try again in a minute", 429, { "Retry-After": String(total.retryAfterSeconds) });
  }
  await next();
};

export const authRoutes = new Hono<AppEnv>()
  .use("/login", signInFloor)
  .use("/callback", signInFloor)
  .use("/logout", signInFloor)
  .get("/login", (c) => {
    // Access mode: the edge already challenges every request - going home IS going to login.
    if (!c.env.GOOGLE_CLIENT_ID) return c.redirect("/");
    const state = randomToken();
    const nonce = randomToken();
    setCookie(c, STATE_COOKIE, state, OAUTH_COOKIE);
    setCookie(c, NONCE_COOKIE, nonce, OAUTH_COOKIE);
    // The page the caller was sent here from (the static-site gate and the SPA both pass it). A sign-in started
    // without one must not inherit a stale value from an abandoned attempt, so it is cleared rather than kept.
    const next = safeNext(c.req.query("next"), new URL(c.req.url).origin);
    if (next) setCookie(c, NEXT_COOKIE, next, OAUTH_COOKIE);
    else deleteCookie(c, NEXT_COOKIE, { path: "/auth" });
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${new URL(c.req.url).origin}/auth/callback`);
    url.searchParams.set("response_type", "code");
    // `profile` is what puts `picture` on the ID token (see the header note). Asked for whether or not the
    // import is switched on: consent is granted once, at the account chooser, and making the scope depend on a
    // settings row would re-prompt everybody the first time somebody flipped it.
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    // Always show the account chooser: on a shared machine "sign in" must never silently resume whichever
    // Google account happens to be live in the browser.
    url.searchParams.set("prompt", "select_account");
    return c.redirect(url.toString());
  })
  .get("/callback", async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID) return c.redirect("/");
    const code = c.req.query("code");
    const state = c.req.query("state");
    const cookieState = getCookie(c, STATE_COOKIE);
    const cookieNonce = getCookie(c, NONCE_COOKIE);
    const cookieNext = getCookie(c, NEXT_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/auth" });
    deleteCookie(c, NONCE_COOKIE, { path: "/auth" });
    deleteCookie(c, NEXT_COOKIE, { path: "/auth" });
    // A missing/mismatched state is a forged or stale callback - never exchange its code.
    if (!code || !state || !cookieState || state !== cookieState) return c.text("sign-in failed: state mismatch (try again)", 400);

    // Exchange the code server-side. Bounded: a hung Google endpoint must not hold the request open.
    let idToken: string | undefined;
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: c.env.GOOGLE_CLIENT_ID,
          client_secret: c.env.GOOGLE_CLIENT_SECRET ?? "",
          redirect_uri: `${new URL(c.req.url).origin}/auth/callback`,
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) idToken = ((await res.json()) as { id_token?: string }).id_token;
    } catch {
      /* fall through to the failure response */
    }
    if (!idToken) return c.text("sign-in failed: could not verify with Google (try again)", 502);

    // Verify the ID token cryptographically - the exchange being server-side is not, on its own, proof of
    // anything about the token's contents.
    let email: string;
    // What this sign-in offers about the person, read off the VERIFIED payload and never off the token
    // endpoint's raw JSON. What is done with it - and whether anything is - is settings/sign-in's decision.
    const claims: GoogleProfileClaims = {};
    try {
      googleJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
      const { payload } = await jwtVerify(idToken, googleJwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: c.env.GOOGLE_CLIENT_ID,
      });
      // The nonce ties this token to the login THIS browser started; a replayed token fails here.
      if (!cookieNonce || payload.nonce !== cookieNonce) return c.text("sign-in failed: nonce mismatch (try again)", 400);
      if (payload.email_verified !== true || typeof payload.email !== "string" || !payload.email) {
        return c.text("sign-in failed: Google did not attest a verified email", 403);
      }
      email = payload.email.toLowerCase();
      if (typeof payload.picture === "string") claims.picture = payload.picture;
      if (typeof payload.given_name === "string") claims.givenName = payload.given_name;
      if (typeof payload.family_name === "string") claims.familyName = payload.family_name;
    } catch {
      return c.text("sign-in failed: invalid token (try again)", 400);
    }

    // With no Access policy in front, the domain allow-list IS the org perimeter for who may sign in at
    // all (auth.ts applies it again at first-login provisioning; here it stops outsiders pre-session).
    // FAIL-CLOSED on an empty list: this route only runs in Google mode, where "no list" would mean "any
    // Google account on the internet", not "no restriction". makeDeps refuses to boot that config too.
    const allowed = (c.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length) return c.text("sign-in is not configured (ALLOWED_EMAIL_DOMAINS is unset)", 500);
    if (!allowed.includes(email.split("@")[1] ?? "")) return c.text("this Google account's domain is not permitted", 403);

    const now = Date.now();
    setCookie(c, SESSION_COOKIE, await sealSession({ email, iat: now, exp: now + SESSION_TTL_MS }, c.env.AUTH_SESSION_KEY!), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    // Write what the org has asked for onto the employee record (services/googleProfile.ts). Entirely off the
    // response path and never awaited: it makes an outbound request and a write, and a sign-in must not wait on
    // either or fail with either. Deps are built inside the branch that needs them, the way /logout below does
    // it and for the same reason - /login and /callback must keep working in Access mode, where there may be no
    // app-side session config to build a Deps from at all.
    if (claims.picture || claims.givenName || claims.familyName) {
      const work = syncGoogleProfile(makeDeps(c.env), email, claims);
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        /* no execution context (tests, in-process dispatch): `importGooglePhoto` never rejects, so dropping the
           promise is safe, and awaiting it here would put a Google round trip in front of the redirect. */
        void work;
      }
    }
    // Validated again on the way out, not only when it was parked: the cookie is ours, but this is the line
    // that decides where a freshly signed-in browser goes, and it should not depend on the cookie being so.
    return c.redirect(safeNext(cookieNext, new URL(c.req.url).origin) ?? "/");
  })
  .post("/logout", async (c) => {
    // Same CSRF posture as every /v1 mutation: a cross-site form can't log the user out.
    if (c.req.header("X-Requested-By") !== "hrms-spa") return c.text("missing X-Requested-By header", 403);
    const token = getCookie(c, SESSION_COOKIE);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    // What this browser keeps of the app after signing out. The media key goes (http/assetPaths.ts), and so
    // does the HTTP cache: the bundle sits there pinned for a year (`immutable`), and on a shared machine the
    // next person should not be able to dig it out. Local storage is already purged by the client before it
    // calls this (lib/clientStore.ts purgeAll), and every /v1 answer is `no-store`. NOT "storage": that would
    // also unregister the push service worker. The cost is a fresh download of the bundle on this device's
    // next sign-in - only after an explicit sign-out, never on an expiry.
    deleteCookie(c, EDGE_COOKIE, { path: "/" });
    // And the app lock's proof: the next sign-in is a new session, which a proof is bound to anyway, so this is
    // hygiene rather than the guarantee.
    deleteCookie(c, UNLOCK_COOKIE, { path: "/" });
    c.header("Clear-Site-Data", '"cache"');

    // Deleting the cookie only takes this browser's copy away; the TOKEN stays valid until it expires, because
    // it is verified by signature alone and nothing server-side is consulted. So signing out also stamps the
    // user's session cut-off, which the auth middleware checks on the read it already does per request. That
    // is what makes "sign out" survive a lost or cloned cookie.
    //
    // It signs out EVERY device, which is the honest behaviour for a token with no per-device identity to
    // revoke, and the one that answers "I left my laptop on a train". Cheap: only reached when a real session
    // cookie was presented, so a bare logout call costs no write.
    //
    // Deps are built HERE rather than by a `/auth/*` middleware, the same way the e-sign webhook does it
    // (routes/esignCallback.ts). Login and callback touch no DB and must keep working in Access mode, where
    // there may be no app-side session config to build a Deps from at all - so the one route that writes owns
    // its own, inside the branch that writes.
    if (c.env.GOOGLE_CLIENT_ID && token) {
      // Best-effort throughout: a failed stamp must not leave the caller stuck on a page they have already
      // left. The cookie is gone from this browser regardless, and the session still expires on its own.
      try {
        const session = await openSession(token, c.env.AUTH_SESSION_KEY!, Date.now());
        if (session) {
          // MATCHED THE WAY AUTH MATCHES: `lower(email)`, not `=`. The column is plain TEXT with no NOCASE
          // collation, so `=` is case-sensitive - while middleware/auth.ts deliberately falls back to this same
          // `lower()` lookup because a row stored with different case is a case it expects to meet. On such a
          // row the exact match here found nothing, so the cut-off was never stamped: the cookie left this
          // browser and a lifted copy stayed good for the rest of its twelve hours. That is precisely the
          // outcome this stamp exists to prevent, failing silently, on the one action a person takes when they
          // believe they have a reason to. The two lookups must agree, so they now use the same predicate.
          await makeDeps(c.env)
            .db.update(users)
            .set({ sessionsValidFrom: new Date(), updatedAt: new Date() })
            .where(sql`lower(${users.email}) = ${session.email.toLowerCase()}`);
        }
      } catch (e) {
        console.error("[auth] logout: session cut-off stamp failed (non-fatal)", e);
      }
    }
    // Access mode has no app-side session; the edge session is ended at Cloudflare's own logout path.
    return c.json({ signin_url: c.env.GOOGLE_CLIENT_ID ? "/auth/login" : "/cdn-cgi/access/logout" });
  });
