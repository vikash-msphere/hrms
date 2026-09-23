import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { forbidden } from "../lib/errors";
import { hasApiKeyBearer } from "../lib/apiKeyToken";

// The Access cookie is sent automatically; require a custom header on mutations to block cross-site writes.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  // API-key callers are exempt. CSRF defends against AMBIENT credentials - a cookie the browser attaches on
  // its own. An Authorization header is never ambient: a cross-site page cannot make the browser send one
  // (adding it forces a preflight no CORS policy here answers), so there is nothing to forge.
  //
  // This runs BEFORE auth, so it cannot know whether the key is valid - it skips on the mere PRESENCE of an
  // `hrms_`-shaped bearer. That is safe ONLY because of the no-fallback rule in middleware/auth.ts: such a
  // request is resolved as that key or fails 401, never as the session cookie. If auth ever fell back, an
  // attacker could attach a junk bearer purely to suppress this check and then ride the victim's session.
  // The two rules are one mechanism; do not change either alone.
  if (hasApiKeyBearer(c.req.header("Authorization"))) {
    await next();
    return;
  }
  if (MUTATING.has(c.req.method) && c.req.header("X-Requested-By") !== "hrms-spa") {
    throw forbidden("missing X-Requested-By header");
  }
  await next();
};
