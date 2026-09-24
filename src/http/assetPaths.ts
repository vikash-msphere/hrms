// Which static files skip the Worker, and the edge rule that guards them instead.
//
// A signed-out browser must not be able to download the app. The app is split into two tiers for that:
//
//   CODE  - the shell (every navigation), every JS/CSS chunk, and anything not listed below. These reach the
//           Worker first (`run_worker_first = ["/*", ...]`), and http/staticSite.ts refuses them unless the
//           caller holds a verified session - the same check /v1 uses. This is what reveals the application:
//           its routes, screens, API paths and field names.
//   MEDIA - the EDGE_PATHS below: fonts, images, icons, illustrations, stickers, pdf.js vendor data, the
//           manifest, the push service worker and the theme bootstrap. The asset layer serves these WITHOUT
//           invoking the Worker (each wrangler file lists them as `!` rules), so they cost nothing against the
//           free plan's daily request quota. A Cloudflare WAF custom rule guards them instead, by requiring the
//           `hrms_edge` cookie the Worker hands every signed-in browser.
//
// The media tier is weaker ON PURPOSE, and the trade is stated rather than implied: the free plan's rule
// language cannot verify a signature (no regex, no HMAC function, no cookie map - all Pro or above), so the
// edge can only compare one shared value, which every signed-in browser holds and a former holder keeps until
// it is rotated. That is acceptable for these files and only these: they carry nothing application-specific,
// and their hashed names are referenced only from gated code, so the key alone does not say what exists.
//
// No imports, so scripts/edgeRule.ts and the tests can load this without pulling in the app.

/** Path prefixes the Worker's own routes answer, where a miss is a real 404 rather than a client-side route, and
 *  where the static-site gate does not apply - each carries its own authentication (the /v1 chain, a provider
 *  signature, an HMAC token) or none by design (sign-in itself, the public lost-and-found page).
 *
 *  Every one must also be forwarded by the Vite dev proxy, or the route works in production and 404s on every
 *  developer's machine; test/spaFallback.test.ts pins that. (This list used to mirror `run_worker_first` too.
 *  It no longer has to: `/*` sends every path to the Worker except the media below.) */
export const WORKER_OWNED_PREFIXES = ["/v1", "/esign", "/auth", "/found", "/calendar", "/diag", "/__scheduled"];

/** Path patterns served by the asset layer without the Worker, in the platform's glob syntax: `*` matches any
 *  run of characters, `/` included. Each wrangler file lists every one as a `!` rule after `/*`, and
 *  test/spaFallback.test.ts pins both files to this list. NEVER add a pattern that matches app code (a `.js`,
 *  `.mjs` or `.css` Vite emits): that file would skip the session check. The two scripts named here are the
 *  deliberate exceptions - `push-sw.js` has to stay reachable for the browser's own update checks, and
 *  `theme-init.js` is theme bootstrap with nothing of the app in it. The same test fails a pattern that
 *  matches emitted code, and fails any code file under the two public directories. */
export const EDGE_PATHS = [
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/icon-*.png",
  "/manifest.webmanifest",
  "/push-sw.js",
  "/theme-init.js",
  "/assets/*.woff2",
  "/assets/*.svg",
  "/assets/*.png",
  "/assets/*.jpg",
  "/assets/*.webp",
  "/assets/illustrations/*",
  "/assets/kudos/*",
  "/assets/pdfjs/*",
] as const;

/** The cookie the WAF rule looks for. */
export const EDGE_COOKIE = "hrms_edge";

/** Longer than the 12h session on purpose. The value is shared and static, so how long a browser keeps it adds
 *  no exposure - anyone holding it could keep a copy anyway. What the longer life buys is that media a
 *  signed-in device has already been told about keeps loading across the session boundary: the notification
 *  icon a push shows overnight, the illustrations in a tab left open. Re-issued by the gate whenever a request
 *  carries a stale or missing copy, and deleted on sign-out. */
export const EDGE_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Cookie-safe, and safe to embed inside a WAF string literal (no quote, backslash, `;` or space). */
const EDGE_KEY_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
export const isEdgeKey = (key: string | undefined): key is string => typeof key === "string" && EDGE_KEY_SHAPE.test(key);

/** The platform's own reading of a `run_worker_first` rule (workers-shared rules-engine: split on `*`, escape
 *  the pieces, join with `.*`, anchor both ends), so a test can ask which paths a pattern covers. */
export function globMatches(pattern: string, path: string): boolean {
  const re = pattern
    .split("*")
    .map((part) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(path);
}

const HOST_SHAPE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** The rule engine's own ceiling on one expression. */
export const WAF_EXPRESSION_MAX = 4096;

/**
 * The Cloudflare WAF custom rule expression (action: Block) that guards the media tier for these hosts.
 *
 * Blocks a request when it is for one of this app's hostnames, for an EDGE_PATHS file, and carries none of the
 * accepted `hrms_edge` values. Every part of that is load-bearing:
 *   - the HOST condition: a custom rule applies to the whole zone, and a zone often serves other sites - an
 *     unscoped `/favicon.svg` rule would block the company website's icon too.
 *   - the PATH condition: only the media tier. The code tier must never be blocked here - a signed-out
 *     navigation has to reach the Worker to be redirected to sign-in, not stop at a Cloudflare block page.
 *   - more than one KEY during a rotation: the rule accepts the old and the new value while browsers pick up
 *     the new one (docs/deploy.md).
 *
 * Built only from operators and fields the free plan allows: `in`, `wildcard` (case-insensitive, `*` = any
 * run of characters, the same reading the routing rules use), `contains`, and the raw `http.cookie` header.
 * Throws rather than emitting a rule that would not do what it says.
 */
export function edgeRuleExpression(hosts: readonly string[], keys: readonly string[]): string {
  if (!hosts.length) throw new Error("at least one host is required");
  for (const h of hosts) if (!HOST_SHAPE.test(h)) throw new Error(`not a hostname: ${JSON.stringify(h)}`);
  if (!keys.length) throw new Error("at least one edge key is required");
  for (const k of keys) if (!isEdgeKey(k)) throw new Error("an edge key must be 32-128 characters of [A-Za-z0-9_-]");

  const quote = (s: string) => `"${s}"`;
  const exact = EDGE_PATHS.filter((p) => !p.includes("*"));
  const globs = EDGE_PATHS.filter((p) => p.includes("*"));
  const host = hosts.length === 1 ? `http.host eq ${quote(hosts[0]!)}` : `http.host in {${hosts.map(quote).join(" ")}}`;
  const paths = [
    `http.request.uri.path in {${exact.map(quote).join(" ")}}`,
    ...globs.map((g) => `http.request.uri.path wildcard ${quote(g)}`),
  ].join(" or ");
  const cookies = keys.map((k) => `http.cookie contains ${quote(`${EDGE_COOKIE}=${k}`)}`).join(" or ");
  const expression = `(${host}) and (${paths}) and not (${cookies})`;
  if (expression.length > WAF_EXPRESSION_MAX) {
    throw new Error(`the rule is ${expression.length} characters, over the ${WAF_EXPRESSION_MAX} the rule engine accepts`);
  }
  return expression;
}
