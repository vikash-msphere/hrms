// RFC 9457 problem details (AEP-193). One error shape, emitted as application/problem+json.

export type Problem = {
  type: string;       // URI reference identifying the problem class
  title: string;      // short, human-readable summary
  status: number;     // HTTP status code
  detail?: string;    // explanation specific to this occurrence
  instance?: string;  // URI reference identifying this occurrence (we use the request path)
};

export class AppError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly type: string,
    public readonly title: string,
    detail?: string,
  ) {
    super(detail ?? title);
  }
  toProblem(instance?: string): Problem {
    const detail = this.message && this.message !== this.title ? this.message : undefined;
    return { type: this.type, title: this.title, status: this.httpStatus, ...(detail ? { detail } : {}), ...(instance ? { instance } : {}) };
  }
}

// Canonical constructors (map to HTTP status). Use these everywhere.
export const invalidArgument = (d?: string) => new AppError(400, "/errors/invalid-argument", "Invalid Argument", d);
// Validate a wire value against the set a column actually accepts, NARROWING it as it goes: the runtime check
// and the type are one statement, so a value cannot be checked and then assigned as a bare `string`. `detail` is
// the 400's message, kept per call site because it is user-facing text.
export const oneOf = <T extends string>(v: unknown, allowed: readonly T[], detail: string): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw invalidArgument(detail);
  return v as T;
};

export const unauthenticated = (d?: string) => new AppError(401, "/errors/unauthenticated", "Unauthenticated", d);
export const forbidden = (d?: string) => new AppError(403, "/errors/permission-denied", "Permission Denied", d);
// A 403 with its own problem TYPE, because the client does more than print it: an off-network punch is the
// one denial with a way out (file a remote-work request), and the web clock offers that instead of a
// dead-end toast. Same status and title as `forbidden` - only `type` differs - so anything switching on
// those is unaffected, and the client never has to pattern-match the human sentence to know what happened.
export const clockNetworkFence = (d?: string) => new AppError(403, "/errors/clock-network-fence", "Permission Denied", d);
export const notFound = (d?: string) => new AppError(404, "/errors/not-found", "Not Found", d);
export const alreadyExists = (d?: string) => new AppError(409, "/errors/already-exists", "Already Exists", d);
export const failedPrecondition = (d?: string) => new AppError(409, "/errors/failed-precondition", "Failed Precondition", d);
export const aborted = (d?: string) => new AppError(409, "/errors/aborted", "Aborted", d);
// Too many requests. The caller is who they say they are and may do what they asked - there is just a budget
// on how often, and the honest answer names it (middleware/rateLimit.ts). 429 rather than 403 because a
// client should RETRY this one, and the `Retry-After` the middleware attaches tells it when.
export const resourceExhausted = (d?: string) => new AppError(429, "/errors/resource-exhausted", "Too Many Requests", d);
export const unimplemented = (d?: string) => new AppError(501, "/errors/unimplemented", "Not Implemented", d);
// A third party we call out to failed - the mail vendor, an e-sign provider. NOT a 500: nothing here
// malfunctioned, the hop did, and the two want different reactions (retry the send vs. read a stack trace).
// Emitting it as a 500 also buries a vendor outage under "unhandled error" in the log, which is where an
// afternoon goes.
export const upstreamFailed = (d?: string) => new AppError(502, "/errors/upstream-failed", "Upstream Failed", d);

/** Every message in an error's `cause` chain, joined - what to pattern-match a DRIVER error against.
 *
 *  Matching `String(err)` or `err.message` alone is a trap: drizzle wraps every failed statement in a
 *  DrizzleQueryError whose own message is just "Failed query: <sql>", and the real D1 text ("UNIQUE
 *  constraint failed: holidays.uuid") is only reachable through `cause`. A top-level match therefore keeps
 *  working right up until a drizzle upgrade adds a wrapper, at which point conflicts silently become 500s.
 *  The depth cap only guarantees termination if a chain ever cycles. */
export function errorChainText(err: unknown, depth = 8): string {
  const parts: string[] = [];
  for (let e: unknown = err; e && depth-- > 0; e = (e as { cause?: unknown }).cause) {
    const m = (e as { message?: unknown }).message;
    parts.push(typeof m === "string" ? m : String(e));
  }
  return parts.join(" ");
}

/** A create that lost the code-allocation race: the UNIQUE index on `code` rejected the loser.
 *
 *  Allocation is read-max-then-write (services/codeAlloc.ts), so two creates in the same scope at the same
 *  moment compose the SAME next code and the index is what stops the duplicate from being minted. The loser
 *  has nothing wrong with it - it only needs to look again - which is why services/crud.ts retries on this
 *  and middleware/errorHandler.ts reports what survives the retries as a retryable 409 rather than a 500. */
export function isCodeCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\.code\b/i.test(errorChainText(err));
}

/** The same lost race on a card's per-board number: allocated max+1, kept unique by card_board_seq_idx. */
export function isCardSeqCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bcards\.(board_id|seq)\b/i.test(errorChainText(err));
}

/** And on the tag printed on an asset: also allocated max+1 within its category, also unique. */
export function isAssetTagCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bassets\.asset_tag\b/i.test(errorChainText(err));
}

/** Two first requests of the same person's first login both reached the auto-provision insert.
 *
 *  Unlike the allocation races above this is not a composed value losing a draw - it is the SAME user being
 *  minted twice, and `users.email` being UNIQUE is what stops the second row existing. The loser does not
 *  need a fresh anything; it needs the row the winner just wrote (middleware/auth.ts). Distinct from
 *  `isCodeCollision`, which the same insert can also raise on its allocated `code` and which is retried by
 *  re-allocating instead. */
export function isUserEmailCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\busers\.email\b/i.test(errorChainText(err));
}

/** Two sign-in accounts pointed at one employee (`users_employee_idx`). Not a race and not retryable: it is
 *  an admin re-pointing an account at a person who already has one, and the answer is to say so. */
export function isUserEmployeeCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\busers\.employee_id\b/i.test(errorChainText(err));
}

/** And on a person's human ID (EMP-0042), allocated max+1 from the org's format and unique. */
export function isEmployeeNumberCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bemployees\.employee_number\b/i.test(errorChainText(err));
}

/** Two overlapping `:awardVariablePay` runs both read "this cycle has paid nobody yet" and both tried to write
 *  the same person's payout; `bonus_cycle_emp_idx` rejected the loser.
 *
 *  Unlike the races above, the loser here must NOT retry: the row that now exists IS this award, written by
 *  the other run. services/variablePay.ts counts it as skipped, which is the same answer the pre-read gives
 *  when a payout already exists. */
export function isVariablePayCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bbonuses\.(cycle_id|employee_id)\b/i.test(errorChainText(err));
}

/** Two callers both found no `settings` row for a key and both tried to create it; the primary key on
 *  `settings.key` rejected the loser.
 *
 *  Same shape as the code races above and the same answer: nothing is wrong with the losing request, it only
 *  needs to read the row that now exists and apply itself to that. services/settings.ts turns this into the
 *  retryable 409 rather than the 500 an unhandled constraint failure would be. */
export function isSettingKeyCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bsettings\.key\b/i.test(errorChainText(err));
}

/** The comp-off credit for one employee on one worked day already exists (`compoff_emp_date_idx`).
 *
 *  This one is the EXPECTED answer, not a race to retry: the credit row is what makes the nightly tick
 *  idempotent, so a second run over the same holiday is supposed to collide and skip. It has a matcher of its
 *  own because the alternative - catching everything the insert can throw - also swallowed the code race
 *  (which must retry, since the tick only ever credits yesterday and there is no third chance) and any
 *  transient D1 failure, silently, with no log. */
export function isCompOffDuplicate(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bcomp_off_credits\.(employee_id|worked_date)\b/i.test(errorChainText(err));
}

/** That person is already rostered on that day (`sa_emp_day_idx`, partial on the live rows).
 *
 *  The service checks for an existing entry before it writes, so reaching here means two rostering calls for
 *  the same cell raced - or one caller worked from a roster view that did not hold the entry (a truncated
 *  page). Either way it is the caller's to resolve by looking again, not a 500: the index is what keeps the
 *  invariant every roster reader assumes, and the check above it is what usually explains it in words. */
export function isShiftAssignmentDuplicate(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bshift_assignments\.(employee_id|date)\b/i.test(errorChainText(err));
}

/** Two concurrent writes to one employee's effective-dated timeline both tried to leave it with an open row.
 *
 *  `comp_open_idx` / `pos_open_idx` are partial unique indexes on `employee_id where effective_to is null`, so
 *  they are what stops a salary or a role history from ending up with two "current" rows when two revisions
 *  race (services/compensation.ts, services/positions.ts). Both writers guard their close on the row still
 *  being open and both run close+insert as one atomic batch, so the loser normally stops on the short count -
 *  this matcher is for the ordering where it does not: the loser's close matched nothing AND its insert then
 *  collided, which D1 raises as a constraint failure that rolls the whole batch back. Either way the answer
 *  is the same and it is not a 500: read the timeline again and re-apply. */
export function isOpenTimelineCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\b(compensation|positions)\.employee_id\b/i.test(errorChainText(err));
}

/** A DELETE that SQLite refused because another table still points at the row.
 *
 *  A hard purge tears down what a row OWNS first (services/softDelete.ts `cascade`), so reaching this means
 *  something the row does not own still references it - a person who still has payslips, a goal somebody
 *  aligned a child to. That is a precondition the caller can act on ("detach it first"), not a bug in the
 *  request, so it belongs in the 409 lane rather than as the unhandled 500 it used to be. Read through the
 *  drizzle wrapper for the same reason every other matcher here does. */
export function isForeignKeyViolation(err: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(errorChainText(err));
}
