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

export type Decision = "approve" | "reject" | "cancel" | "pay" | "disburse" | "submit" | "award" | "revoke" | "publish" | "unpublish" | "disable" | "hide" | "release" | "unhide" | "unhidePublish" | "handBack" | "removeSuggestion" | "pin" | "pinReplacing" | "route" | "advance" | "decline" | "rescind" | "complete" | "reopen" | "setTrackedFrom" | "applyOpenings" | "applyPayOpenings" | "applyLeaveHistory";

type Copy = { title: string; description: string; confirmLabel: string; destructive?: boolean };

// `subject` names the thing being decided ("Aarti's leave request", "INV-204") so the dialog can never be
// mistaken for the row above or below the one that was clicked.
//
// `other` is the SECOND thing a decision displaces, for the handful that push something else aside - today
// pinning, which unpins whatever is currently at the top. A decision that quietly undoes another one has to
// name the one it is undoing, or the person agreeing to it is agreeing to something they were not shown.
const COPY: Record<Decision, (subject: string, other?: string) => Copy> = {
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
  // A SOFT delete, and the copy says so rather than borrowing the finality of `Delete permanently`. It is
  // here because of where the button sits, not because deleting is irreversible: on the board a post's bin
  // is inches from a moderator's Hide, and one of the two asking while the other fires on the click reads
  // as the silent one being the safer of the two. It is not - hiding tells the author and can be undone
  // from the queue, while this takes the post out of the feed for everybody.
  // Pinning, which is the loudest thing anybody can do to the board short of posting: it puts one post
  // above everything else for the whole company until somebody takes it down.
  //
  // TWO COPIES, because pinning when something is ALREADY pinned is a different act - it displaces that
  // post, and the person doing it may well not know which one that is (the pinned post is at the top of a
  // board they may have scrolled past). Naming it is the whole point of asking: "Pin this?" answered yes
  // means something different from "Unpin the all-hands notice and pin this instead?".
  pin: (s) => ({ title: "Pin this post?", description: `${s} goes to the top of the board for everyone and stays there until somebody unpins it.`, confirmLabel: "Pin it" }),
  pinReplacing: (s, other) => ({
    title: "Replace the pinned post?",
    description: `${other ?? "The pinned post"} is at the top of the board now. Pinning ${s} unpins it - one post leads the board at a time. The post that comes down is not otherwise changed.`,
    confirmLabel: "Unpin that, pin this",
  }),
  // The suggestion box's twin, and the copy has to keep it apart from Hide beside it: removing takes the
  // votes with it, hiding does not. Somebody reaching for the wrong one of two adjacent buttons should
  // learn which they picked from the dialog, not from the result.
  removeSuggestion: (s) => ({ title: "Remove this suggestion?", description: `${s} and its votes come off the box. Hiding it instead keeps the votes and tells the submitter, and can be undone from Flagged posts.`, confirmLabel: "Remove", destructive: true }),
  // Reversing a takedown, which is why the copy names whose decision is being reversed rather than reading
  // as an ordinary restore. WHERE IT LANDS DEPENDS ON THE HOST and the copy says both, because this dialog
  // is shared by all three: an announcement comes back as a draft and its flag closes (a draft is on no
  // wall, so there is nothing left to decide), while a reply or a suggestion has no draft state and is back
  // in front of readers the moment this is pressed.
  unhide: (s) => ({ title: "Put this post back?", description: `${s} comes back: an announcement returns to its author as a draft, and a reply or suggestion goes straight back on the wall. This reverses a moderator's decision, and the author is told.`, confirmLabel: "Put it back" }),
  // The same reversal carried all the way through, and a separate dialog because the outcome is the one
  // thing `unhide` promises will NOT happen: the post is in front of readers on this click, not sitting in
  // its author's drafts waiting for them. Somebody reaching for the nearer of two adjacent buttons should
  // learn which they picked here rather than from the wall.
  unhidePublish: (s) => ({ title: "Put this post back on the wall?", description: `${s} is visible to its audience again from now, reversing a moderator's decision to take it down. Its author is told. A post that was never published is announced as it goes up.`, confirmLabel: "Put it on the wall" }),
  // The third answer to a held post, beside releasing it and keeping it down: give it back. Nothing becomes
  // visible, so the copy leads with what the author gets rather than with a warning.
  handBack: (s) => ({ title: "Send this back to its author?", description: `${s} goes back to whoever wrote it as a draft, and it leaves your queue. Nobody has seen it and nobody will until they publish it again - which sends it through the safety check afresh.`, confirmLabel: "Send it back" }),
  // The moderation gate's opposite of `hide`, and NOT the same act as `publish`: the person releasing it is
  // not the author, and what they are overruling is a safety check that objected. The copy has to say that
  // this is the moment the post becomes visible, because until now nobody has seen it at all.
  release: (s) => ({ title: "Release this post?", description: `${s} goes on the wall now and its audience is notified, overriding the check that held it back. Nobody has seen it up to this point.`, confirmLabel: "Release post" }),
  route: (s) => ({ title: "Re-route this ticket?", description: `${s} moves to another team's queue and leaves yours.`, confirmLabel: "Re-route" }),
  advance: (s) => ({ title: "Move to the next stage?", description: `${s} advances in the pipeline, and the people on that stage are notified.`, confirmLabel: "Advance" }),
  decline: (s) => ({ title: "Decline this?", description: `${s} is declined and whoever asked is notified.`, confirmLabel: "Decline", destructive: true }),
  rescind: (s) => ({ title: "Rescind this offer?", description: `${s} is withdrawn from the candidate. This is visible to them and cannot be undone.`, confirmLabel: "Rescind", destructive: true }),
  complete: (s) => ({ title: "Mark this complete?", description: `${s} is closed out, and anything waiting on it moves on.`, confirmLabel: "Complete" }),
  reopen: (s) => ({ title: "Reopen this?", description: `${s} goes back to being open, and the people responsible for it are notified again.`, confirmLabel: "Reopen" }),
  // One act over the whole workforce, and it moves pay: from the next build, a working day before the date
  // with nothing recorded stops being docked. Nothing on the page undoes it in bulk, so it asks.
  setTrackedFrom: (s) => ({
    title: "Set when HRMS records start?",
    description: `${s}. From then on a working day before their date with no punches, mark or leave is not an absence and is never docked as loss of pay. Anyone who already has a date keeps it.`,
    confirmLabel: "Set the date",
  }),
  // Moves many encashable balances at once, and tells each person. A re-import only moves the difference, so
  // it is repeatable, but nothing on the page takes it back in one go.
  applyOpenings: (s) => ({
    title: "Apply these opening balances?",
    description: `${s}. Each balance moves by the change shown, and each person is told their balances were brought over from before HRMS.`,
    confirmLabel: "Apply",
  }),
  // Approved leave written past the request flow for many people at once. Each row can be removed again from
  // the leave History tab, but nothing on the page takes the batch back in one go.
  applyLeaveHistory: (s) => ({
    title: "Bring in this leave?",
    description: `${s}. Each lands as approved leave and notifies nobody. History (before the records start) counts toward quotas and limits and changes no balance; booked leave takes its days off the balance.`,
    confirmLabel: "Bring it in",
  }),
  // Moves the year's income tax for everybody in the file from the next payroll build. Re-applying replaces
  // the figures, so it is repeatable, but a draft run built before it has to be rebuilt.
  applyPayOpenings: (s) => ({
    title: "Apply this pay and tax?",
    description: `${s}. The next payroll works out the year's TDS, professional tax cap and ESI with these figures included. A draft run built before now will ask to be rebuilt.`,
    confirmLabel: "Apply",
  }),
};

/** Ask before a decision verb. Returns false when the person backs out - callers just `return`.
 *  `other` names the thing this decision displaces, where there is one (see COPY). */
export function confirmDecision(confirm: ConfirmFn, verb: Decision, subject: string, other?: string): Promise<boolean> {
  return confirm(COPY[verb](subject, other));
}
