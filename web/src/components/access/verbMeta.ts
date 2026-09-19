// Human labels + one-line descriptions for custom methods (AEP verbs) - the companion to collectionMeta.
// Raw camelCase tokens ("submitManager") are precise but answer nothing at grant time; a chip that reads
// "Submit manager review - share the written review with the employee" does. Generic verbs cover the many
// collections sharing approve/reject/upload/…; per-collection overrides refine where the same token means
// something specific. Fallback: camelCase -> spaced words, no description.
// `caution` is for the rare verb whose grant is WIDER than its name suggests - where the honest description of
// what you are handing over does not fit in the one-liner, and a reader picking it out of a list of twenty
// otherwise-ordinary methods would have no way to know. It is surfaced next to the verb rather than buried in a
// tooltip, because the whole point is that it should be read before the grant is made.
type VerbInfo = { label: string; description?: string; caution?: string };

const GENERIC: Record<string, VerbInfo> = {
  approve: { label: "Approve", description: "Move a pending request to approved." },
  reject: { label: "Reject", description: "Turn down a pending request." },
  cancel: { label: "Cancel", description: "Withdraw a request before it is settled." },
  submit: { label: "Submit", description: "Send a draft in for approval." },
  upload: { label: "Upload attachment", description: "Attach or replace the supporting file." },
  download: { label: "Download attachment", description: "Open or keep a copy of the attached file." },
  pay: { label: "Mark paid", description: "Record the payout as settled." },
  complete: { label: "Complete", description: "Mark it done." },
  reopen: { label: "Reopen", description: "Bring a closed item back to active." },
  restore: { label: "Restore", description: "Un-delete a soft-deleted row." },
  "*": { label: "All methods", description: "Every custom method of this collection in one rule." },
};

const PER_COLLECTION: Record<string, Record<string, VerbInfo>> = {
  attendance: {
    clockIn: { label: "Clock in", description: "Start the working session." },
    clockOut: { label: "Clock out", description: "End the working session." },
  },
  goals: { updateProgress: { label: "Update progress", description: "Move the goal's progress percentage." } },
  reviews: {
    submitSelf: { label: "Submit self-assessment", description: "Send the reviewee's own write-up onward." },
    submitManager: { label: "Submit manager review", description: "Share ratings + feedback with the employee." },
    acknowledge: { label: "Acknowledge", description: "Confirm the shared review has been read." },
    skipStage: { label: "Skip stage", description: "Advance without this stage's input." },
    nominate: { label: "Request 360 feedback", description: "Invite peers to give feedback." },
    nudge: { label: "Nudge", description: "Remind whoever owns the current stage." },
    pdf: { label: "Export PDF", description: "Download the finished review as a PDF." },
  },
  "review-feedback": {
    submitFeedback: { label: "Submit feedback", description: "Answer a 360 feedback request." },
    decline: { label: "Decline", description: "Pass on a 360 feedback request." },
  },
  "review-cycles": {
    launch: { label: "Launch", description: "Start the cycle and create its reviews." },
    enroll: { label: "Add people", description: "Enroll more reviewees into a running cycle." },
    close: { label: "Close", description: "End the cycle." },
  },
  loans: {
    disburse: { label: "Disburse", description: "Mark the principal as paid out; EMIs start next payroll." },
    recordRepayment: { label: "Record repayment", description: "Log a repayment against the outstanding amount." },
  },
  "payroll-runs": {
    build: { label: "Build", description: "Compute the run's payslip items from current inputs." },
    publish: { label: "Publish", description: "Release payslips to employees." },
    bankFile: { label: "Bank file", description: "Download the bank transfer file." },
    statutoryReport: { label: "Statutory report", description: "Download PF/ESI/PT statements." },
    previewPayslip: { label: "Preview payslip", description: "Open one employee's slip before publishing." },
  },
  payslips: {
    preview: { label: "Preview", description: "Open the payslip in the app." },
    download: { label: "Download", description: "Keep a PDF copy." },
  },
  employees: {
    enrollDefaultBenefits: { label: "Enrol default benefits", description: "Put a new hire into the default benefit plans." },
    uploadPhoto: { label: "Set profile photo", description: "Upload or replace the photo on somebody's record. Everyone holds it for their own; granting it here means doing it for other people." },
    clearPhoto: { label: "Remove profile photo", description: "Take the photo off somebody's record. Paired with setting one - a moderation action when granted beyond your own." },
  },
  announcements: {
    post: { label: "Post", description: "Publish a new board post." },
    giveKudos: { label: "Give kudos", description: "Post praise about a teammate." },
    markRead: { label: "Mark read", description: "Record a read receipt." },
    react: { label: "React", description: "Add an emoji reaction." },
    reply: { label: "Reply", description: "Comment under a post." },
    vote: { label: "Vote", description: "Answer a poll." },
    publish: { label: "Publish" }, unpublish: { label: "Unpublish" },
    disable: { label: "Disable comments" }, enable: { label: "Enable comments" },
    lock: { label: "Lock" }, unlock: { label: "Unlock" },
  },
  cards: {
    move: { label: "Move", description: "Drag a task between columns." },
    block: { label: "Block" }, unblock: { label: "Unblock" },
    assign: { label: "Assign", description: "Set who works the task." },
    prioritize: { label: "Prioritise" },
    comment: { label: "Comment" },
    addTodos: { label: "Add checklist items" }, toggleTodo: { label: "Tick checklist items" }, removeTodo: { label: "Remove checklist items" },
  },
  boards: { configure: { label: "Configure board", description: "Edit columns, WIP limits, swimlanes, policies." }, metrics: { label: "View metrics", description: "Open the board's flow analytics." } },
  sprints: { activate: { label: "Activate" }, complete: { label: "Complete" } },
  suggestions: {
    respond: { label: "Respond", description: "Set the status and write the public reply." },
    upvote: { label: "Upvote" }, downvote: { label: "Remove upvote" },
  },
  referrals: { award: { label: "Award bonus", description: "Create the referral bonus for the next payroll." } },
  assets: {
    verify: { label: "Check into stock", description: "Scan an asset's tag to count it in - what makes \"in stock\" a fact rather than a claim." },
    acknowledge: { label: "Confirm receipt", description: "The holder scanning the tag on the thing they were handed (their own assets only)." },
    printTag: { label: "Print tags", description: "Print stickers - and see the tag secret printed inside the QR." },
    reissueTag: { label: "Reissue tag", description: "Kill a lost or defaced sticker and queue a new one." },
    batchCreate: { label: "Add many at once", description: "Add a whole delivery: a quantity of identical things, or a list of serial numbers." },
  },
  "tax-declarations": { verify: { label: "Verify", description: "Accept the declared investment with its proof." } },
  "bank-formats": { uploadTemplate: { label: "Upload template", description: "Replace the bank file template." } },
  letterheads: {
    uploadImage: { label: "Upload artwork", description: "Add or replace one of the letterhead's images." },
    image: { label: "View artwork", description: "See the images themselves, not just their names." },
    deleteImage: { label: "Remove artwork", description: "Delete one of the letterhead's images." },
    preview: { label: "Preview page", description: "Render a sample document on this letterhead." },
    duplicate: { label: "Duplicate", description: "Copy this letterhead, artwork and all, as a new one." },
  },
  operations: { run: { label: "Run", description: "Execute the maintenance job." } },
  "cron-runs": { run: { label: "Run now", description: "Fire a scheduled tick on demand." } },
  automations: {
    enable: { label: "Enable rule" }, disable: { label: "Disable rule" },
    test: { label: "Test rule", description: "Dry-run against a sample event; nothing executes." },
  },
  "org-documents": { acknowledge: { label: "Acknowledge", description: "Sign off on the policy version." }, download: { label: "Download" } },
  "personal-documents": {
    sign: { label: "E-sign", description: "Sign the letter in place (owner only)." },
    refreshEsign: { label: "Refresh e-sign status" },
    download: { label: "Download" },
    print: { label: "Print copy", description: "Re-render the letter on its letterhead's print page." },
  },
  offers: {
    extend: { label: "Extend", description: "Send the approved offer to the candidate." },
    accept: { label: "Accept", description: "Record acceptance and enable employee conversion." },
    decline: { label: "Mark declined" },
    rescind: { label: "Rescind", description: "Withdraw the offer." },
  },
  applications: { advance: { label: "Advance stage", description: "Move the application to the next pipeline stage." } },
  interviews: { complete: { label: "Mark done" }, cancel: { label: "Cancel interview" } },
  transitions: { appendTask: { label: "Add task", description: "Append a checklist task to the running process." } },
  "transition-tasks": { upload: { label: "Upload document", description: "Attach the document a task asks for." } },
  "access-rules": {
    preview: {
      label: "Preview access",
      description: "Ask the engine what a person can do (view-as).",
      // "View as" swaps the whole PRINCIPAL, so the holder reads the app with the subject's grant, list scopes
      // and field redaction - that is what makes the simulation honest, and it is also what makes this verb far
      // wider than "preview". The server refuses a super subject to a non-super holder (lib/viewAs.ts rail 2),
      // but full containment is not computable over pattern grants, so any OTHER role is reachable: hold this
      // and you can read payroll through a payroll admin. Keep it with the people who already see everything.
      caution: "Grants read access to anything any non-super role can see, by simulating that person. Treat it as an access-admin capability, not an ordinary method.",
    },
    requestAccess: { label: "Request access", description: "Let people ask access admins for a missing grant (grant to Everyone to enable the flow)." },
    review: {
      label: "Run the access review",
      description: "List rules nobody has used in 90 days, and org-wide rules whose recorded use never left the holder's own team. Reads usage counts only - it changes no access.",
    },
    scopeCounts: {
      label: "See how many records a scope reaches",
      description: "Show record counts next to the scope choices when granting ('All 214 · One department 12'), so the narrower option is visible before it is skipped.",
    },
    approve: { label: "Approve permission changes", description: "Apply a pending grant or removal queued by four-eyes approval. Nobody can approve their own request." },
    reject: { label: "Reject permission changes", description: "Turn down a pending grant or removal queued by four-eyes approval." },
    clone: {
      label: "Copy permissions",
      description: "Copy every rule one role or person holds onto another, in one traceable operation. Additive - nothing is removed.",
      // Each copied rule is still authored through the normal create path, so nothing here escapes validation
      // or the four-eyes queue. The width is in the REACH: one click can hand a role forty grants, including
      // whatever the source holds over payroll or personal data.
      caution: "One click can hand a subject every grant another one holds. Give it to the people you trust with the whole access model, not to everyone who may edit a single rule.",
    },
  },
};

const fallbackLabel = (verb: string) => (verb === "*" ? "All methods" : verb.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));

export function verbInfo(collection: string, verb: string): VerbInfo {
  return PER_COLLECTION[collection]?.[verb] ?? GENERIC[verb] ?? { label: fallbackLabel(verb) };
}
