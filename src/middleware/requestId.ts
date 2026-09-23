import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

// Mint a per-request correlation id (honouring an upstream x-request-id if present), stash it on the context
// for the error handler, and echo it as a response header. With [observability] on, this ties a user-reported
// 500 to its log line.
//
// An upstream id is honoured only when it LOOKS like one. It is echoed into a response header, written into log
// lines and carried on error bodies, so an arbitrary caller-chosen string - kilobytes long, or shaped to read as
// another log record - was a way to forge or flood the one field meant to be trustworthy. Anything else is
// replaced with a fresh id, which is also what a caller sending none gets.
const UPSTREAM_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const upstream = c.req.header("x-request-id");
  const id = upstream && UPSTREAM_ID.test(upstream) ? upstream : crypto.randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};
