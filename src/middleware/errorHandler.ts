import type { Context } from "hono";
import { ZodError } from "zod";
import { AppError, aborted, alreadyExists, errorChainText, isCodeCollision, isShiftAssignmentDuplicate } from "../lib/errors";

// Which fields a validation failure was about, and what was wrong with each.
//
// The field NAMES are the request schema the client just wrote against - published in openapi.yaml, so naming
// them back reveals nothing. The submitted VALUES are a different matter (a salary, a PAN) and never appear
// here: only the path and Zod's own reason. With this the client can put the message on the field it belongs
// to instead of showing one sentence above a twelve-field form and leaving the reader to hunt.
// Zod's own message for a few issue kinds EMBEDS THE VALUE the caller sent - `invalid_enum_value` renders as
// "Invalid enum value. Expected 'a' | 'b', received 'x'", and `invalid_literal` and `unrecognized_keys` do the
// same with the key name. That is the one thing this function promises not to return, and on this app the
// values reaching a validator are salaries, PANs and bank accounts. So the message is taken from the ISSUE
// CODE, not from Zod, wherever Zod's would carry the input; the rest (a length rule, a regex, a required
// field) say nothing about the value and travel as written.
function safeMessage(issue: ZodError["issues"][number]): string {
  switch (issue.code) {
    case "invalid_enum_value":
      // The permitted set is the published schema, so naming it is free - and it is the half the client needs.
      return `must be one of: ${(issue as { options?: readonly unknown[] }).options?.join(", ") ?? "the permitted values"}`;
    case "invalid_literal":
      return "has a fixed permitted value";
    case "unrecognized_keys":
      return "contains a field this endpoint does not accept";
    case "invalid_union":
      // A union's message is a nest of sub-issues, each of which may carry its own received value.
      return "does not match any accepted shape";
    default:
      return issue.message;
  }
}

function zodFields(err: ZodError): { field: string; message: string }[] {
  const seen = new Set<string>();
  const out: { field: string; message: string }[] = [];
  for (const issue of err.issues) {
    // Body-validated routes nest under "json"/"body"; the leaf path is what the client called the field.
    const path = issue.path.filter((p) => typeof p === "string" && p !== "json" && p !== "body");
    const field = path.join(".");
    if (!field || seen.has(field)) continue;
    seen.add(field);
    out.push({ field, message: safeMessage(issue) });
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
        // A create that lost the code-allocation race trips the UNIQUE index on `code`. The create path
        // already re-allocates and tries again a few times (services/codeAlloc.ts withFreshCode), so a
        // collision reaching here means the scope stayed contended throughout - rare, and still the client's
        // to retry rather than a server fault, so it answers 409 and not a 500.
        : isCodeCollision(err)
          ? aborted("resource id collision; please retry").toProblem(c.req.path)
          // The roster's one-entry-per-person-per-day index. The service checks for the existing entry first
          // and says so in words; this catches the paths that cannot (a restore of a soft-deleted entry onto a
          // day since re-rostered) and the races that get past the check, so the invariant answers 409 rather
          // than surfacing SQLite's constraint text as a 500.
          : isShiftAssignmentDuplicate(err)
            ? alreadyExists("that employee is already rostered on that day").toProblem(c.req.path)
            : { type: "/errors/internal", title: "Internal Server Error", status: 500 };
  // Log any unexpected (non-AppError, non-Zod) failure server-side. The client body stays generic, but with
  // [observability] on this is the only trace of a 500 - without it a production 500 is undebuggable.
  //
  // A DELIBERATE 5xx (upstreamFailed: the mail vendor is down) is logged too, but not as "unhandled error"
  // with a stack: the stack points at our own fetch call and says nothing, while the detail carries the
  // vendor's own words. Filing a vendor outage under the same heading as a real crash is how a real crash
  // gets skimmed past.
  if (problem.status >= 500) {
    if (isAppError) console.error(`upstream failure [${c.get("requestId") ?? "-"}] ${c.req.method} ${c.req.path}: ${err.message}`);
    else console.error(`unhandled error [${c.get("requestId") ?? "-"}] ${c.req.method} ${c.req.path}:`, err);
  }
  return c.body(JSON.stringify(problem), problem.status as 500, {
    "Content-Type": "application/problem+json",
  });
};
