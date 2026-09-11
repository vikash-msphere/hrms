// Response security headers (docs/archive/plan.txt 11M). Applied to every /v1 response (incl. errors via finally).
// Referrer-Policy matters because resource ids live in URLs - keep them out of the Referer header sent
// to third parties. The API returns JSON only, so a locked-down CSP is safe here. (The SPA's own HTML
// CSP is configured at the static-asset layer, not the Worker.)
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next();
  } finally {
    const h = c.res?.headers;
    if (h) {
      h.set("Referrer-Policy", "no-referrer");
      h.set("X-Content-Type-Options", "nosniff");
      h.set("X-Frame-Options", "DENY");
      h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      // Every /v1 answer is written for ONE caller: a serialized row carries the per-object access hints and
      // the field redactions computed for whoever asked (http/accessHint.ts, http/fieldAccess.ts), so no two
      // people are entitled to the same bytes. There was no directive here at all, and absence is not "do not
      // cache": a 200 that carries a validator - which every collection list does, see http/listEtag.ts - is
      // HEURISTICALLY cacheable under RFC 9111 §4.2.2. Behind Cloudflare that is unlikely to bite; through the
      // MITM proxy a large employer runs on its own network it is one payslip list stored for the first reader
      // and served to the second. `private` is the half that says "one caller", `no-store` the half that says
      // "not even on disk", and neither costs anything the app wants: revalidation here is `If-None-Match`
      // against listEtag, which is a request that reaches the Worker rather than a cache hit that does not.
      h.set("Cache-Control", "private, no-store");
    }
  }
};
