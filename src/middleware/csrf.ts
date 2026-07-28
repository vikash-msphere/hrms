import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { forbidden } from "../lib/errors";

// The Access cookie is sent automatically; require a custom header on mutations to block cross-site writes.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (MUTATING.has(c.req.method) && c.req.header("X-Requested-By") !== "hrms-spa") {
    throw forbidden("missing X-Requested-By header");
  }
  await next();
};
