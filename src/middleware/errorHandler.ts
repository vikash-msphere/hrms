import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import {
  AppError, aborted, alreadyExists, errorChainText, forbidden, invalidArgument, isAssetTagCollision,
  isCardSeqCollision, isCodeCollision, isEmployeeNumberCollision, isPayrollOpeningDuplicate, isReviewDuplicate, isShiftAssignmentDuplicate,
  notFound, publicPath, resourceExhausted, unauthenticated,
} from "../lib/errors";

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

// The app's own error of a given status, for carrying a framework failure across into this vocabulary.
// Nothing in src/ throws an HTTPException, so this only ever translates Hono's own - see below.
const AS_APP_ERROR: Record<number, (detail?: string) => AppError> = {
  400: invalidArgument,
  401: unauthenticated,
  403: forbidden,
  404: notFound,
  409: alreadyExists,
  429: resourceExhausted,
};

/**
 * Hono's own `HTTPException`, rendered as one of ours.
 *
 * WHY THIS IS NEEDED AT ALL. The framework throws this for the failures it handles before a route sees them,
 * and one of those is on EVERY validated write in the app: `zValidator` refuses a body that will not parse
 * with `new HTTPException(400, { message: "Malformed JSON in request body" })`. Unmapped, it matched none of
 * the branches below and fell to the catch-all `{ status: 500 }` - so a caller who sent a trailing comma was
 * told the server had crashed, with no indication that the body was theirs to fix. Worse at our end than at
 * theirs: `problem.status >= 500` then logged it as `unhandled error` with a stack, and with [observability]
 * on, every malformed request anyone sent raised an alert about a fault that did not exist.
 *
 * Translated rather than passed through, so the body is indistinguishable from the same status raised
 * anywhere else in the app and no client has to learn a second problem vocabulary. `err.message` is one of
 * Hono's own fixed strings - it carries none of the request, which is the rule `safeMessage` above follows
 * for the same reason.
 *
 * A 5xx HTTPException is deliberately NOT translated: that is a server fault, and it belongs in the log at
 * the foot of this file with everything else that crashed.
 */
function fromHttpException(err: HTTPException, path: string) {
  const asAppError = AS_APP_ERROR[err.status];
  if (asAppError) return asAppError(err.message).toProblem(path);
  // A 4xx the app has no word of its own for (413 from a framework body cap, say). The STATUS is the part a
  // client acts on, so it is carried verbatim rather than flattened into a 400 that misreports the reason.
  return { type: "/errors/invalid-argument", title: "Invalid argument", status: err.status, instance: path, detail: err.message };
}

// Maps thrown errors to RFC 9457 problem+json. Never leaks stack traces or secrets.
export const errorHandler = (err: Error, c: Context) => {
  const isAppError = err instanceof AppError;
  // THE PATH THAT GOES IN THE BODY IS MASKED; the raw one is only logged. See lib/errors.ts#publicPath - by
  // the time anything throws, `c.req.path` carries the decoded INTERNAL id, and a problem body is the one
  // response shape the outbound wire edge never rewrites.
  const instance = publicPath(c.req.path);
  const problem =
    isAppError
      ? err.toProblem(instance)
      : err instanceof ZodError
        // A validation failure is a client error, not a 500. Field paths and Zod's reasons travel; the values
        // the caller sent do not.
        ? { type: "/errors/invalid-argument", title: "Invalid argument", status: 400, instance, fields: zodFields(err) }
      // The framework's own client errors, which are client errors just as much as Zod's - see fromHttpException.
      : err instanceof HTTPException && err.status < 500
        ? fromHttpException(err, instance)
        // A create that lost an ALLOCATION race trips the UNIQUE index on whichever number it composed. The
        // create paths already re-allocate and try again a few times (services/codeAlloc.ts withFreshCode),
        // so a collision reaching here means the scope stayed contended throughout - rare, and still the
        // client's to retry rather than a server fault, so it answers 409 and not a 500.
        //
        // ALL FOUR OF THEM, not just `code`. Every one of these is the same shape - a number read as max+1
        // from what is stored, kept honest by a UNIQUE index, retried by the same helper - but only `code`
        // was listed, so the other three fell to the catch-all below and were reported as "Internal Server
        // Error" with a stack and an `unhandled error` log line. Which one a create happens to lose on is not
        // a property a client should be able to observe, and it is certainly not the difference between "try
        // again" and "the server is broken".
        : isCodeCollision(err) || isAssetTagCollision(err) || isCardSeqCollision(err) || isEmployeeNumberCollision(err)
          ? aborted("resource id collision; please retry").toProblem(instance)
          // The roster's one-entry-per-person-per-day index. The service checks for the existing entry first
          // and says so in words; this catches the paths that cannot (a restore of a soft-deleted entry onto a
          // day since re-rostered) and the races that get past the check, so the invariant answers 409 rather
          // than surfacing SQLite's constraint text as a 500.
          : isShiftAssignmentDuplicate(err)
            ? alreadyExists("that employee is already rostered on that day").toProblem(instance)
          // One review per person per cycle (`review_cycle_emp_idx`). `addReviewees` checks first and says so
          // in words; this catches the race that gets past the check - two `:addReviewees` calls on one
          // active cycle - so the invariant answers 409 rather than SQLite's constraint text as a 500.
          : isReviewDuplicate(err)
            ? alreadyExists("someone in that list already has a review in this cycle; re-read the cycle and try again").toProblem(instance)
          // One live row of pay before HRMS per person per financial year (`popen_emp_fy_idx`): a restore onto
          // a year entered again since, or two imports racing past the service's own check.
          : isPayrollOpeningDuplicate(err)
            ? alreadyExists("that employee already has pay before HRMS for that financial year; edit that entry instead").toProblem(instance)
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
