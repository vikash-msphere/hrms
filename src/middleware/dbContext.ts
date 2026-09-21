import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { makeDeps } from "../deps";
import { makeRefCache } from "../lib/refData";

// Builds the per-request Deps and stashes it so later middleware/handlers can use it. A batch sub-request
// reuses the parent's Deps (env.__sharedCtx) instead of re-deriving the HKDF subkeys, so a fan-out of N reads
// pays the key derivation once, not N times.
export const dbContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.env.__sharedCtx?.deps ?? makeDeps(c.env);
  // Per-request memo for the reference catalogs (lib/refData.ts): one read each, however many times this
  // request consults them. A batch sub-request inherits the parent's Deps, so a fan-out shares one set.
  deps.refCache ??= makeRefCache();
  // Background work for this request (see Deps#defer). `??=` so a batch sub-request keeps the parent's,
  // which is the one with the real execution context. The try/catch is for runtimes that expose no context -
  // `app.request()` in a test - where `c.executionCtx` throws on access rather than returning undefined; the
  // callers then await their work instead, which is why every deferred task has to be correct either way.
  if (!deps.defer) {
    try {
      const ctx = c.executionCtx;
      deps.defer = (work) => ctx.waitUntil(work);
    } catch {
      /* no execution context on this runtime; callers await instead */
    }
  }
  c.set("deps", deps);
  await next();
};
