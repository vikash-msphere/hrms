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
  c.set("deps", deps);
  await next();
};
