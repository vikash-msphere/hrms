import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../env";
import { users } from "../db/schema";
import { makeDeps } from "../deps";
import { openSession, sealSession } from "../lib/session";
import { counter } from "../lib/isolateRate";

// Direct Google sign-in (OIDC authorization-code flow), the no-per-seat-cost alternative to fronting the
// app with Cloudflare Access. Selected by configuration: GOOGLE_CLIENT_ID set = Google mode; absent =
// Access mode, where these routes only bounce to the edge (Access re-challenges on its own).
//
// The flow is deliberately minimal - no library beyond `jose` (already used for the Access JWT):
//   /auth/login     -> 302 to Google's consent screen, with `state` (CSRF) + `nonce` (token replay) parked
//                      in short-lived HttpOnly cookies scoped to /auth.
//   /auth/callback  -> state must round-trip, code is exchanged server-side (client_secret never leaves the
//                      Worker), the ID token is verified against Google's JWKS (issuer, audience=client_id,
//                      expiry, signature, nonce, email_verified), the email's domain is checked against
//                      ALLOWED_EMAIL_DOMAINS, and a signed stateless session cookie is set (lib/session.ts).
//   /auth/logout    -> clears the session cookie (POST + the app's CSRF header, like every /v1 mutation).
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

let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

const randomToken = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

// The one cookie shape for the two OAuth round-trip cookies: HttpOnly (no script access), Secure, Lax (sent
// on the top-level redirect back from Google), scoped to /auth so they never ride ordinary API requests.
const OAUTH_COOKIE = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/auth", maxAge: 600 };

// A FLOOR on the one unauthenticated lane a person actually walks (see lib/isolateRate.ts - the control is
// the WAF rule, and `npm run preflight` names this route as having had nothing at all). `/callback` is the
// expensive half: it exchanges a code with Google over a real outbound request and verifies an id token
// against a fetched JWKS, neither of which requires a credential of ours to provoke. Sized so a whole
// company arriving at nine in the morning never notices - sign-ins land on many isolates, and one isolate
// serving 300 of them a minute is already an unusual morning.
const signIns = counter(300);

export const authRoutes = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    if (signIns.throttled(Date.now())) {
      return c.text("too many sign-in attempts; try again in a minute", 429, { "Retry-After": String(signIns.retryAfterSeconds) });
    }
    await next();
  })
  .get("/login", (c) => {
    // Access mode: the edge already challenges every request - going home IS going to login.
    if (!c.env.GOOGLE_CLIENT_ID) return c.redirect("/");
    const state = randomToken();
    const nonce = randomToken();
    setCookie(c, STATE_COOKIE, state, OAUTH_COOKIE);
    setCookie(c, NONCE_COOKIE, nonce, OAUTH_COOKIE);
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${new URL(c.req.url).origin}/auth/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
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
    deleteCookie(c, STATE_COOKIE, { path: "/auth" });
    deleteCookie(c, NONCE_COOKIE, { path: "/auth" });
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
    return c.redirect("/");
  })
  .post("/logout", async (c) => {
    // Same CSRF posture as every /v1 mutation: a cross-site form can't log the user out.
    if (c.req.header("X-Requested-By") !== "hrms-spa") return c.text("missing X-Requested-By header", 403);
    const token = getCookie(c, SESSION_COOKIE);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });

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
