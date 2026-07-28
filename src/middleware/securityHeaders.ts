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
    }
  }
};
