import type { Context } from "hono";
import { ZodError } from "zod";
import { AppError, aborted } from "../lib/errors";

// A concurrent create that lost the code-allocation race trips the UNIQUE index on `code` (codeAlloc is
// read-max-then-write; the index is the backstop that makes a collision fail SAFE instead of minting a
// duplicate code). Surface it as a retryable 409, not a raw 500 - the client just retries the create.
function isCodeCollision(err: Error): boolean {
  const msg = `${err?.message ?? ""} ${((err as { cause?: { message?: string } })?.cause?.message) ?? ""}`;
  return /UNIQUE constraint failed:[^:]*\.code\b/i.test(msg);
}

// Maps thrown errors to RFC 9457 problem+json. Never leaks stack traces or secrets.
export const errorHandler = (err: Error, c: Context) => {
  const isAppError = err instanceof AppError;
  const problem =
    isAppError
      ? err.toProblem(c.req.path)
      : err instanceof ZodError
        // A validation failure is a client error, not a 500. Body stays generic (no field paths/values leaked).
        ? { type: "/errors/invalid-argument", title: "Invalid argument", status: 400, instance: c.req.path }
        : isCodeCollision(err)
          ? aborted("resource id collision; please retry").toProblem(c.req.path)
          : { type: "/errors/internal", title: "Internal Server Error", status: 500 };
  // Log any unexpected (non-AppError, non-Zod) failure server-side. The client body stays generic, but with
  // [observability] on this is the only trace of a 500 - without it a production 500 is undebuggable.
  if (problem.status >= 500) console.error(`unhandled error [${c.get("requestId") ?? "-"}] ${c.req.method} ${c.req.path}:`, err);
  return c.body(JSON.stringify(problem), problem.status as 500, {
    "Content-Type": "application/problem+json",
  });
};
