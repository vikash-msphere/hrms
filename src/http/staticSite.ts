// The static site: every request the Worker's routes do not claim - the app shell, its JS/CSS chunks, and the
// client-side routes - answered here, and ONLY for a signed-in browser.
//
// WHY THE GATE. The asset layer used to serve all of web/dist to anyone, so a signed-out visitor downloaded
// the shell and the whole bundle - every route, screen, API path and field name - before the first /v1 call
// came back 401. A loader script cannot fix that (the chunks would still be public files, and one known name
// leads to the rest), so the refusal has to happen here, before the asset store is asked for anything:
//   - a signed-out NAVIGATION gets a bare 302 to sign-in. No HTML at all, so not even a script tag leaks.
//   - any other signed-out request gets a bare 401, the same answer whether the file exists or not, so the
//     gate is not an oracle for which chunk names are real.
// "Signed in" is `resolveBrowserIdentity` - the very check the /v1 auth middleware starts with - so the gate
// and the API can never disagree about the mode or the credential. It costs no D1 read (HMAC + expiry in
// Google mode). It does NOT consult the user's revocation stamp: that is a read per asset, and a revoked
// cookie reaching code for the rest of its 12h gets no data, because /v1 does check it.
//
// The media (http/assetPaths.ts EDGE_PATHS) never reaches this file: the asset layer serves it without the
// Worker, and a WAF rule guards it with the `hrms_edge` cookie this gate hands out.
//
// WHY THE WORKER OWNS THE SPA FALLBACK AT ALL. `not_found_handling` is "none" in both wrangler files, because the
// platform's own SPA fallback answers EVERY miss with index.html at 200, including a miss for /assets/<hash>.js.
// A browser asking for a script and receiving 200 text/html does not see "missing file"; it sees a script of
// the wrong type, caches that answer, and keeps failing from cache long after the file is back (`emptyOutDir`
// empties web/dist at the start of every build, so any fetch landing in that window got HTML). So: a request
// for a file that does not exist gets an honest 404, and only real app routes fall back to the shell.
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { resolveBrowserIdentity } from "../middleware/auth";
import { AppError, publicPath } from "../lib/errors";
import { EDGE_COOKIE, EDGE_COOKIE_MAX_AGE_S, WORKER_OWNED_PREFIXES, isEdgeKey } from "./assetPaths";

// A path whose last segment carries a file extension is asking for a FILE, not an app route. Deliberately
// narrow: SPA routes are slash-separated words, so requiring a dot in the final segment (and no trailing
// slash) never catches one.
export const LOOKS_LIKE_A_FILE = /\/[^/]+\.[a-z0-9]+$/i;

// A refusal says nothing, and nothing may keep it: not a shared cache, not the browser (the same URL answers
// 200 once the caller signs in), and not the Referer the sign-in hop would otherwise carry to Google.
const REFUSAL_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

/** A top-level page load, as opposed to a script, stylesheet or fetch. `Sec-Fetch-Mode` is authoritative where
 *  the browser sends it (all current ones do); without it, a GET that accepts HTML is the best available sign. */
export function isNavigation(req: Request): boolean {
  const mode = req.headers.get("Sec-Fetch-Mode");
  if (mode) return mode === "navigate";
  return (req.method === "GET" || req.method === "HEAD") && (req.headers.get("Accept") ?? "").includes("text/html");
}

function refuse(c: Context<AppEnv>): Response {
  // Only Google mode has a sign-in door of its own. In Access mode `/auth/login` bounces to `/`, so sending a
  // caller there from `/` would loop - and a request that reached the Worker without an Access token did not
  // come through Access, which only the edge can fix.
  if (c.env.GOOGLE_CLIENT_ID && isNavigation(c.req.raw)) {
    const url = new URL(c.req.url);
    const next = url.pathname + url.search;
    // The page they asked for rides along, so sign-in lands them back on it. /auth/login validates it
    // (routes/authRoutes.ts safeNext) - this only carries it.
    const location = next === "/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(next)}`;
    return new Response(null, { status: 302, headers: { ...REFUSAL_HEADERS, Location: location } });
  }
  return new Response(null, { status: 401, headers: REFUSAL_HEADERS });
}

let warnedBadEdgeKey = false;

/** Hand a signed-in browser the media cookie, when its copy is missing or stale. On any response this gate
 *  lets through - the shell, or a chunk a long-open tab fetches - so a key rotation or a tab opened before the
 *  cookie existed picks it up at the next thing it loads rather than only on a full reload. */
function withEdgeCookie(c: Context<AppEnv>, res: Response): Response {
  const key = c.env.EDGE_KEY;
  if (!key || res.status >= 400) return res;
  if (!isEdgeKey(key)) {
    // Never issue a value the WAF rule could not have been built from (scripts/edgeRule.ts refuses it too).
    // Loud once per isolate, not per request.
    if (!warnedBadEdgeKey) console.error("[staticSite] EDGE_KEY is set but malformed (32-128 chars of [A-Za-z0-9_-]); no edge cookie issued");
    warnedBadEdgeKey = true;
    return res;
  }
  if (getCookie(c, EDGE_COOKIE) === key) return res;
  res.headers.append("Set-Cookie", `${EDGE_COOKIE}=${key}; Max-Age=${EDGE_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return res;
}

function notFound(c: Context<AppEnv>, path: string): Response {
  // `publicPath`, like every other problem body: a 404 under /v1 is reached with the path already decoded to
  // internal ids, and this response never passes back through the outbound wire edge. See lib/errors.ts.
  return c.body(JSON.stringify({ type: "/errors/not-found", title: "Not Found", status: 404, instance: publicPath(path) }), 404, {
    "Content-Type": "application/problem+json",
  });
}

/** Everything the routes did not claim, for every method. Wired as `app.notFound` in src/index.ts. */
export async function serveStaticSite(c: Context<AppEnv>): Promise<Response> {
  const path = c.req.path;
  // A miss under a WORKER-OWNED prefix is a genuine 404 - the API, the e-sign callbacks, the unauthenticated
  // public pages. These are emphatically not SPA routes, and answering them with the shell would turn "this
  // holiday feed is disabled" or "that token is forged" into a 200 page. No gate: these prefixes carry their
  // own authentication, or none by design, and a 404 among them reveals nothing about the app.
  if (WORKER_OWNED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return notFound(c, path);

  try {
    await resolveBrowserIdentity(c);
  } catch (e) {
    // A thrown CONFIG error (Access mode with its variables missing) refuses too - failing closed - and says so,
    // because /v1 would be answering 500 for the same cause and the two should be easy to connect.
    if (!(e instanceof AppError)) console.error("[staticSite] identity check failed", e);
    return refuse(c);
  }

  // The site is read-only. This used to answer any method with the shell at 200.
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  // The request itself, not a rebuilt one: its conditional and range headers reach the asset layer, so a
  // revalidation of the shell comes back 304 and a partial fetch stays partial. Re-wrapped because the
  // binding's headers are immutable and the edge cookie may be added to them.
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) return withEdgeCookie(c, new Response(asset.body, asset));

  if (LOOKS_LIKE_A_FILE.test(path)) return notFound(c, path);

  // A client-side route: serve the shell and let the SPA router take it from here. Fetched through the ASSETS
  // binding so index.html still carries the headers _headers assigns it (CSP, no-cache). The shell's OWN
  // status, not a hardcoded 200: if index.html is missing or the asset layer is unwell, answering 200 around
  // whatever came back would read as a healthy app route to every monitor, crawler and browser cache.
  const shell = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
  if (!shell.ok) return new Response(shell.body, { status: shell.status, headers: shell.headers });
  return withEdgeCookie(c, new Response(shell.body, { status: 200, headers: shell.headers }));
}
