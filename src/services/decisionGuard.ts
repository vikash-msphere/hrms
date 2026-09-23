// Maker-checker for every decision that moves money or excuses time, as ONE implementation.
//
// The verb's grant (middleware) says who may approve a CLASS of rows, and the seeded grants are written in
// relative scopes: a manager approves `*.my-dept.approve`, and the manager's own rows sit under their own
// department. So the grant alone let a manager approve their own overtime, a payroll admin approve and disburse
// their own loan, and HR approve their own claims. The grant cannot say "but not your own" - scope tokens name
// where a row lives, not who it is about - so the rule lives here, as a workflow precondition the deciders
// share, next to the state checks they already make (the same shape as attendanceDayMarks.ts's subject rule).
//
// Only the decisions in the subject's FAVOUR are guarded: approve, pay, disburse, record a repayment, issue.
// Rejecting or cancelling your own request moves nothing your way, so it stays open.
//
// A one-person team has nobody else to ask, and a control it cannot satisfy is one it routes around - so the
// org can lift the rule (`settings/approvals.allow_self_approval`). Off by default.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { failedPrecondition } from "../lib/errors";
import { getSettingValue } from "./settings";
import { checkEtag, type VersionedRow } from "./versionGuard";

export type ApprovalsConfig = { allow_self_approval?: boolean };
export const DEFAULT_APPROVALS: ApprovalsConfig = { allow_self_approval: false };

/** Is the caller the person this row is about, with the org not having opted out of the rule? */
export async function isBlockedSelfDecision(deps: Deps, actor: Pick<AppUser, "employeeId">, subjectEmployeeId: string | null | undefined): Promise<boolean> {
  // A caller with no employee record (a service account, an unlinked admin) cannot be the subject of anything.
  if (!actor.employeeId || !subjectEmployeeId || actor.employeeId !== subjectEmployeeId) return false;
  const cfg = await getSettingValue<ApprovalsConfig>(deps, "approvals", DEFAULT_APPROVALS);
  return cfg.allow_self_approval !== true;
}

/**
 * Refuse the subject deciding their own request in their favour. `action` reads as a verb phrase in the
 * message: "approve", "pay out", "disburse".
 */
export async function assertNotSubject(deps: Deps, actor: Pick<AppUser, "employeeId">, subjectEmployeeId: string | null | undefined, action: string, noun: string): Promise<void> {
  if (await isBlockedSelfDecision(deps, actor, subjectEmployeeId)) {
    throw failedPrecondition(`you cannot ${action} your own ${noun}; somebody else has to decide it`);
  }
}

/**
 * The version half of a decision. The approver read a row; when the client says which version (If-Match), the
 * decision is refused if the row has moved since - a borrower raising a loan's principal after the approver
 * opened it must not have the new figure approved on the strength of the old one. Every decider calls this,
 * favourable or not, so a stale reject is refused the same way.
 */
export function assertReviewedVersion(row: VersionedRow, ifMatch?: string): void {
  checkEtag(row, ifMatch);
}
