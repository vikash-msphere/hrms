// Response security headers (docs/archive/plan.txt 11M). Applied to EVERY response (incl. errors via finally):
// registered once globally in src/index.ts, and again per-mount where a route wants it inside its own chain.
// Referrer-Policy matters because resource ids live in URLs - keep them out of the Referer header sent
// to third parties. The API returns JSON only, so a locked-down CSP is safe here. (The SPA's own HTML
// CSP is configured at the static-asset layer, not the Worker.)
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

// FILL IN, never overwrite. This is registered globally in src/index.ts as well as per-mount, so it can run
// OUTSIDE a route that deliberately set its own value - and the outer `finally` runs last, so "set" would win.
// Two routes depend on theirs: /found serves HTML with an inline <style> and needs a CSP that permits it
// (`default-src 'none'` renders the page unstyled), and /calendar/holidays sets the cache directives a calendar
// client polls against. Both are strictly more specific than the defaults below, which exist for the responses
// nobody wrote headers for - including the ones produced by middleware registered above a mount's own copy of
// this (a 413 from bodyLimit was the whole /v1 surface's one unhardened answer).
const fill = (h: Headers, name: string, value: string) => {
  if (!h.has(name)) h.set(name, value);
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next();
  } finally {
    const h = c.res?.headers;
    if (h) {
      fill(h, "Referrer-Policy", "no-referrer");
      fill(h, "X-Content-Type-Options", "nosniff");
      fill(h, "X-Frame-Options", "DENY");
      fill(h, "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      // Every /v1 answer is written for ONE caller: a serialized row carries the per-object access hints and
      // the field redactions computed for whoever asked (http/accessHint.ts, http/fieldAccess.ts), so no two
      // people are entitled to the same bytes. There was no directive here at all, and absence is not "do not
      // cache": a 200 that carries a validator - which every collection list does, see http/listEtag.ts - is
      // HEURISTICALLY cacheable under RFC 9111 §4.2.2. Behind Cloudflare that is unlikely to bite; through the
      // MITM proxy a large employer runs on its own network it is one payslip list stored for the first reader
      // and served to the second. `private` is the half that says "one caller", `no-store` the half that says
      // "not even on disk", and neither costs anything the app wants: revalidation here is `If-None-Match`
      // against listEtag, which is a request that reaches the Worker rather than a cache hit that does not.
      fill(h, "Cache-Control", "private, no-store");
    }
  }
};
