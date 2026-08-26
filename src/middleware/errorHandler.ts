import type { Context } from "hono";
import { ZodError } from "zod";
import { AppError, aborted, errorChainText } from "../lib/errors";

// A concurrent create that lost the code-allocation race trips the UNIQUE index on `code` (codeAlloc is
// read-max-then-write; the index is the backstop that makes a collision fail SAFE instead of minting a
// duplicate code). Surface it as a retryable 409, not a raw 500 - the client just retries the create.
//
// The driver's message lives down the `cause` chain rather than on the error itself - see errorChainText.
function isCodeCollision(err: Error): boolean {
  return /UNIQUE constraint failed:[^:]*\.code\b/i.test(errorChainText(err));
}

// Which fields a validation failure was about, and what was wrong with each.
//
// The field NAMES are the request schema the client just wrote against - published in openapi.yaml, so naming
// them back reveals nothing. The submitted VALUES are a different matter (a salary, a PAN) and never appear
// here: only the path and Zod's own reason. With this the client can put the message on the field it belongs
// to instead of showing one sentence above a twelve-field form and leaving the reader to hunt.
function zodFields(err: ZodError): { field: string; message: string }[] {
  const seen = new Set<string>();
  const out: { field: string; message: string }[] = [];
  for (const issue of err.issues) {
    // Body-validated routes nest under "json"/"body"; the leaf path is what the client called the field.
    const path = issue.path.filter((p) => typeof p === "string" && p !== "json" && p !== "body");
    const field = path.join(".");
    if (!field || seen.has(field)) continue;
    seen.add(field);
    out.push({ field, message: issue.message });
    if (out.length === 12) break; // a body this wrong is a bug, not a form somebody is filling in
  }
  return out;
}

// Maps thrown errors to RFC 9457 problem+json. Never leaks stack traces or secrets.
export const errorHandler = (err: Error, c: Context) => {
  const isAppError = err instanceof AppError;
  const problem =
    isAppError
      ? err.toProblem(c.req.path)
      : err instanceof ZodError
        // A validation failure is a client error, not a 500. Field paths and Zod's reasons travel; the values
        // the caller sent do not.
        ? { type: "/errors/invalid-argument", title: "Invalid argument", status: 400, instance: c.req.path, fields: zodFields(err) }
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
