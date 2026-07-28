import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

// Mint a per-request correlation id (honouring an upstream x-request-id if present), stash it on the context
// for the error handler, and echo it as a response header. With [observability] on, this ties a user-reported
// 500 to its log line.
export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.header("x-request-id") || crypto.randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};
