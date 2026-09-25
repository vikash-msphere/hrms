// RFC 9457 problem details (AEP-193). One error shape, emitted as application/problem+json.

export type Problem = {
  type: string;       // URI reference identifying the problem class
  title: string;      // short, human-readable summary
  status: number;     // HTTP status code
  detail?: string;    // explanation specific to this occurrence
  instance?: string;  // URI reference identifying this occurrence (the request path, id segments masked)
};

/** The internal-id shape: 8 random bytes in Crockford base32 (lib/idCodec.ts genId). */
const INTERNAL_ID = /^[0-9a-hj-km-np-tv-z]{13}$/;
/** What an id segment reads as once masked. Unreserved in a URI path, and no collection or verb is named `_`. */
const MASK = "_";

/**
 * A request path fit to publish in `problem.instance`.
 *
 * THE PATH AN ERROR HANDLER SEES IS THE DECODED ONE. `decodeWireIdsRequest` runs outside Hono (src/index.ts),
 * so by the time anything throws, `c.req.path` reads `/v1/employees/<13-char internal id>` - the primary key
 * the wire codec exists to keep off the wire (lib/idCodec.ts). And an error body never passes back through the
 * outbound edge: `encodeWireIdsMiddleware` only rewrites `application/json`, problem details are
 * `application/problem+json`, and a throw unwinds past its post-`next()` block regardless. So every 403, 404,
 * 409 and validation 400 on an item path published that id verbatim, under a field whose own comment called it
 * the request path.
 *
 * MASKED RATHER THAN RE-ENCODED, deliberately. Re-encoding is the prettier answer and cannot be relied on
 * here: `encode` is async and needs a codec, and the two places that build a problem outside a resolved
 * request (the body-cap refusal above Hono, and the static site's 404 - http/staticSite.ts) have neither - so it would be a second
 * code path for a field no client reads (`instance` is unused by web/src/lib/problemText.ts). Masking is one
 * pure function that cannot throw and cannot leak. The real path still reaches the server-side log, which is
 * where it is actually wanted.
 *
 * Only a segment that IS an internal id is masked, and a trailing `:verb` is kept (it names what was refused,
 * and carries no id). The Crockford alphabet omits i/l/o/u, so an ordinary 13-character key segment - a
 * settings key, a role name - does not match; a false positive would only over-mask, never under-mask.
 */
export function publicPath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      const colon = seg.indexOf(":");
      const head = colon >= 0 ? seg.slice(0, colon) : seg;
      if (!INTERNAL_ID.test(head)) return seg;
      return colon >= 0 ? MASK + seg.slice(colon) : MASK;
    })
    .join("/");
}

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
// A payroll build or a settlement that lost a payable to another writer between reading the payout queues and
// committing: its guarded paid-markers matched fewer rows than it priced, so the whole write was undone and
// nothing was paid. Its own TYPE because the client does more than print it. The answer is to run the same
// action again, which re-reads the queues without whatever the other writer took, and the payroll page does
// that itself. An etag `aborted` is different: it means a PERSON moved the record, and the reader has to look.
export const payablesRaced = (d?: string) => new AppError(409, "/errors/payables-raced", "Aborted", d);
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

/** A write whose PARENT ROW went while it was in flight: the row it points at was deleted between the read
 *  that found it and the insert that references it.
 *
 *  Not a validation failure and not a bug in the caller - both halves were true when they were read. It is the
 *  same shape of race as a code collision, one table up, and it is reachable by anything that records
 *  something ABOUT another row (a read receipt, a reaction, a sighting) while somebody else is deleting that
 *  row. The honest answer is that the thing is gone, which is a 404, not a 500. */
export function isMissingParentRow(err: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(errorChainText(err));
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

/** Two sign-ins of the same brand-new person both reached the auto-create in services/googleProfile.ts, or a
 *  create raced HR adding the same hire. `employees.work_email` being UNIQUE is what stops the second row, and
 *  the loser wants the row that now exists rather than a retry - there is only ever one person behind one work
 *  address. Note the index covers the RAW column, so it also fires on a SOFT-DELETED leaver still holding the
 *  address, which is deliberately not something an auto-create may step over. */
export function isEmployeeWorkEmailCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bemployees\.work_email\b/i.test(errorChainText(err));
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

/** This person has already acknowledged this version of this document (`dack_once_idx`).
 *
 *  Like the comp-off credit above, this is the EXPECTED answer rather than a race to retry: `:acknowledge`
 *  claims the ack row before it stamps a PDF, files the signed copy or calls the e-sign vendor, so the loser
 *  of a two-tab double-submit is supposed to collide here and be told "already acknowledged" instead of
 *  filing a second locked copy and buying a second Aadhaar transaction. The matcher is narrow for the same
 *  reason `isCompOffDuplicate` is: the same insert also allocates a `code`, and THAT collision must retry. */
export function isDocumentAckDuplicate(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bdocument_acknowledgements\.(document_id|employee_id|version)\b/i.test(errorChainText(err));
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

/** Two punches raced and both tried to leave the same person with an open attendance session
 *  (`att_open_emp_idx`, partial on `employee_id where clock_out is null and superseded_by is null`).
 *
 *  Same shape as the timeline indexes below and the same reason for existing: `clockIn` reads "is anything
 *  open" and then inserts, which is two statements, so a double-tapped clock button (or a phone and a laptop)
 *  could put TWO open rows on one employee. That is not a cosmetic duplicate - `openSessionFor` takes one of
 *  them arbitrarily, `clockOut` closes that one, and the other stays open forever: every later `clockIn`
 *  answers "already clocked in", the person can never punch again, and because loss of pay is derived from
 *  punches, every subsequent working day is docked as a full absence with nothing saying why.
 *
 *  The answer is the same one the pre-read gives in words, so it is a precondition and not a 500. */
export function isOpenAttendanceCollision(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\battendance_sessions\.(employee_id|clock_out|superseded_by)\b/i.test(errorChainText(err));
}

/** That person already has a review in that cycle (`review_cycle_emp_idx`).
 *
 *  `addReviewees` reads the cycle's existing reviews and inserts the ones that are missing, which is a
 *  check-then-write: two concurrent launches of one cycle both read an empty set and both insert. The index is
 *  what makes the duplicate unwritable - a second review row for one person in one cycle double-counts them in
 *  calibration, in the analytics and in their own list, and sends them two "your review is open" notices.
 *
 *  Launching is claimed exactly-once now (services/reviewCycles.ts), so the reachable racer is two mid-cycle
 *  `:addReviewees` calls; D1 rolls the whole insert batch back, so nothing half-lands and the caller re-reads. */
export function isReviewDuplicate(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\breviews\.(cycle_id|employee_id)\b/i.test(errorChainText(err));
}

/** That person already has pay before HRMS recorded for that financial year (`popen_emp_fy_idx`).
 *
 *  The services check for the live row first and say so in words (services/payrollOpenings.ts); this catches
 *  what gets past the check - two imports racing, or a restore of a deleted row onto a year that has been
 *  entered again since. Two live rows would count the same months' pay and tax twice in the year's TDS. */
export function isPayrollOpeningDuplicate(err: unknown): boolean {
  return /UNIQUE constraint failed:[^:]*\bpayroll_openings\.(employee_id|financial_year)\b/i.test(errorChainText(err));
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
