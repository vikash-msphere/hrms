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
export const unimplemented = (d?: string) => new AppError(501, "/errors/unimplemented", "Not Implemented", d);

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
