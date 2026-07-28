import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { makeDeps } from "../deps";

// Builds the per-request Deps and stashes it so later middleware/handlers can use it. A batch sub-request
// reuses the parent's Deps (env.__sharedCtx) instead of re-deriving the HKDF subkeys, so a fan-out of N reads
// pays the key derivation once, not N times.
export const dbContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("deps", c.env.__sharedCtx?.deps ?? makeDeps(c.env));
  await next();
};
