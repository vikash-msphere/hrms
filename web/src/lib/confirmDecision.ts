import type { ConfirmFn } from "@/components/common/confirm";

// One place for "are you sure?" on the decision verbs.
//
// A decision is not an edit: approving, rejecting or cancelling a request lands in somebody's notifications,
// moves money or time off, and cannot be taken back from the same button that made it. Those all deserve the
// same beat of friction, and they were spread across a dozen pages as bare one-click handlers - so the copy
// lives here and every page asks the same way.
//
// What does NOT belong here: edits behind a dialog with its own save button (the dialog IS the confirmation),
// reversible view state (pin, hide, mark read), and reads (preview, download, export). Friction on those is
// noise, and noise is what teaches people to click through the dialogs that matter.

export type Decision = "approve" | "reject" | "cancel" | "pay" | "disburse" | "submit" | "award" | "revoke" | "publish" | "unpublish" | "disable" | "hide" | "route" | "advance" | "decline" | "rescind" | "complete" | "reopen";

type Copy = { title: string; description: string; confirmLabel: string; destructive?: boolean };

// `subject` names the thing being decided ("Aarti's leave request", "INV-204") so the dialog can never be
// mistaken for the row above or below the one that was clicked.
const COPY: Record<Decision, (subject: string) => Copy> = {
  approve: (s) => ({ title: "Approve this request?", description: `${s} is approved and the requester is notified. Undoing it means cancelling the approved request.`, confirmLabel: "Approve" }),
  reject: (s) => ({ title: "Reject this request?", description: `${s} is rejected and the requester is notified. They would have to file again.`, confirmLabel: "Reject", destructive: true }),
  cancel: (s) => ({ title: "Cancel this request?", description: `${s} is withdrawn. Anything it reserved is released, and a new request has to be filed to try again.`, confirmLabel: "Cancel request", destructive: true }),
  pay: (s) => ({ title: "Mark this as paid?", description: `${s} is recorded as paid out. This is the money leaving - correct it afterwards only by editing the record.`, confirmLabel: "Mark paid" }),
  disburse: (s) => ({ title: "Disburse this loan?", description: `${s} is recorded as paid to the borrower, and repayment starts from the agreed date.`, confirmLabel: "Disburse" }),
  submit: (s) => ({ title: "Submit for approval?", description: `${s} goes to its approver and stops being editable by you.`, confirmLabel: "Submit" }),
  award: (s) => ({ title: "Award this?", description: `${s} is awarded and rides the next payroll run.`, confirmLabel: "Award" }),
  revoke: (s) => ({ title: "Revoke this?", description: `${s} stops working immediately, for everything using it.`, confirmLabel: "Revoke", destructive: true }),
  publish: (s) => ({ title: "Publish this?", description: `${s} becomes visible to its whole audience, and notifications go out.`, confirmLabel: "Publish" }),
  unpublish: (s) => ({ title: "Unpublish this?", description: `${s} disappears for everyone who could see it. Notifications already sent stay sent.`, confirmLabel: "Unpublish", destructive: true }),
  disable: (s) => ({ title: "Disable this?", description: `${s} stops running until somebody turns it back on.`, confirmLabel: "Disable", destructive: true }),
  // Distinct from `unpublish`, which is the author taking their own post down. This is somebody else taking
  // it down for them, so the copy has to say that the author is told - deciding to hide a colleague's post
  // without their knowing is a different act from the one the person clicking thinks they are performing.
  hide: (s) => ({ title: "Hide this post?", description: `${s} stops being visible on the wall and its author is told it was hidden. It is not deleted - it can be put back.`, confirmLabel: "Hide post", destructive: true }),
  route: (s) => ({ title: "Re-route this ticket?", description: `${s} moves to another team's queue and leaves yours.`, confirmLabel: "Re-route" }),
  advance: (s) => ({ title: "Move to the next stage?", description: `${s} advances in the pipeline, and the people on that stage are notified.`, confirmLabel: "Advance" }),
  decline: (s) => ({ title: "Decline this?", description: `${s} is declined and whoever asked is notified.`, confirmLabel: "Decline", destructive: true }),
  rescind: (s) => ({ title: "Rescind this offer?", description: `${s} is withdrawn from the candidate. This is visible to them and cannot be undone.`, confirmLabel: "Rescind", destructive: true }),
  complete: (s) => ({ title: "Mark this complete?", description: `${s} is closed out, and anything waiting on it moves on.`, confirmLabel: "Complete" }),
  reopen: (s) => ({ title: "Reopen this?", description: `${s} goes back to being open, and the people responsible for it are notified again.`, confirmLabel: "Reopen" }),
};

/** Ask before a decision verb. Returns false when the person backs out - callers just `return`. */
export function confirmDecision(confirm: ConfirmFn, verb: Decision, subject: string): Promise<boolean> {
  return confirm(COPY[verb](subject));
}
