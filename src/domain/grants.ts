// Static role -> Grant table (docs/archive/plan.txt 1.3). Replaces the old CAP map (domain/rbac.ts), derived from
// today's `require_(...)` gates + the inline service checks so behavior is preserved (intended diffs are
// noted; the parity tests in 1.5 are the regression guard). Structured so it can later be loaded from
// Settings/DB behind the same interface (deferred TODO).
//
// Naming: levels patterns match the RESOURCE (no action); allow patterns match the full custom KEY
// (resource + verb); deny patterns match the full key (deny wins). `me`/`my-dept` are self-relative
// (resolved from the JWT). Read<write<admin ladder.
import type { Grant, Level } from "./permissions";

// Collections whose GET has no `require_` today -> readable by every authenticated user.
const COMMON_READ: Record<string, Level> = {
  "holidays.**": "read",
  "leave-types.**": "read",
  "departments.**": "read",
  "announcements.**": "read",
  "pay-periods.**": "read",
  "pay-components.**": "read",
  "reimbursement-categories.**": "read", // everyone reads categories to file a claim
  "expense-categories.**": "read", // everyone reads expense categories to file an expense
  "asset-categories.**": "read", // everyone reads asset categories to see what kind of thing they are holding
  "settings.**": "read", // org settings GET is open today (the SPA reads e.g. settings/holidays)
  "benefit-plans.**": "read", // everyone reads the plan catalog to enroll/waive
  "shifts.**": "read", // everyone reads the shift catalog (your roster assignment names one)
  "projects.**": "read", // everyone reads the project catalog to log time against
  "events.**": "read", // org calendar (conferences, off-sites); availability views read it
  // Everyone reads the review-cycle catalog: your own review names its cycle and carries that cycle's due
  // dates and period. Without it the reviews page can't title a card, date a stage, or scope "this cycle's"
  // goals/delivered work - HR was the only role that could read it.
  "review-cycles.**": "read",
  // Operations are employee-owned: collection read = "may list" (rows scoped to own by applyScope);
  // `operations.me.**` = your own items. super_admin sees all via `**`. Closes the org-wide-read BOLA.
  operations: "read",
  "operations.me.**": "read",
  // NOTE: the per-entity activity trail (`activity` capability) is PRIVATE-BY-DEFAULT — deliberately NOT here,
  // so no role holds it out of the box and only super (via `**`) can see activity. Admins grant it explicitly
  // per role/user/collection/scope via the ACL: `activity.**`, `activity.my-dept.**`, `activity.*.leave-requests`,
  // `activity.me.**`. It is an INDEPENDENT gate ANDed with READ on the target record (authz.ts), so it can only
  // narrow — you never see activity for a record you cannot read. Mirrors the org-wide `audit` cap.
};

// Own sensitive sub-resources (PII) - self-service for EVERY role (everyone is an employee with their own
// bank/identity/personal-info). Bound to `me`, so it reaches only the caller's own PII. OTHERS' PII is
// reachable only by a grant that names the sub-resource explicitly (by default: nobody but super via **).
// This is the field-precise opt-in: a broad employees grant (base record) does NOT reach these.
const OWN_PII: Record<string, Level> = {
  "employees.me.bank-account.**": "write",
  "employees.me.identity.**": "write",
  "employees.me.personal-info.**": "write",
  "employees.me.tax.**": "write", // own tax projection + prior-employer declarations (self-service)
  // Not PII, but the same "always self-service, own record only" tier: everyone manages their own in-app
  // notification mute prefs, like their own profile - never an org-toggled policy.
  "employees.me.notification-prefs.**": "write",
  // Public "about me" one-liner: self-expression, so always self-writable (HR can also tidy it via its
  // own employees.*.bio grant). Display rides the base employee record read.
  "employees.me.bio.**": "write",
  // Own probation end date: a redacted field (manifests.ts REDACTED_FIELDS) that no 2-token row grant reaches,
  // so without this line a role reading its own row through `employees.*` (payroll) lost it. Read only - HR
  // sets it. Powers the profile's "On probation · Nd left".
  "employees.me.probation_end_date.**": "read",
};

// Attendance self-service - EVERY role is an employee who clocks in/out and can file/cancel their own
// regularization requests. Bound to `me`, so it reaches only the caller's own records. Spread into each role
// (manager inherits employee's). Manager/HR get broader read + approve below.
const OWN_ATTENDANCE: Record<string, Level> = {
  attendance: "read", // list own sessions (rows scoped to own by applyScope)
  "attendance.me.**": "read", // own sessions (items)
  "attendance-regularizations": "write", // create + list own
  "attendance-regularizations.me.**": "write", // own requests
  // READ, never write: a day mark decides what one of your days is worth, so you are owed the sight of it -
  // and a self-write rule here would be a grant to re-value your own attendance.
  //
  // BOTH TOKENS, like `attendance` two lines up. The bare one is the LIST capability and the `.me.**` one is
  // the rows; the attendance grid reads marks as a list, so the row grant alone left every badge invisible to
  // the person whose pay the mark had changed - the half of this feature they are the audience for.
  "attendance-day-marks": "read", // list my own marks
  "attendance-day-marks.me.**": "read", // marks on my own days
};
const OWN_ATTENDANCE_ALLOW = ["attendance.me.clockIn", "attendance.me.clockOut", "attendance-regularizations.me.cancel"];

// Self-service custom methods on the caller's OWN employee record. `me`-bound, so each reaches exactly the
// caller's own row and nobody else's.
//
// `viewers` answers "who can see my record, and my bank/identity/tax details" - the effective-access question
// asked from the subject's side instead of an admin's. It is the report every other access surface already
// computes, pointed the other way; the service pins the target to the caller's own employee id, so the verb
// discloses nothing about anyone else even though it runs the same engine the admin preview does. Deliberately
// held by everyone: a person being able to find out who reads their bank details is the point.
const OWN_SELF_SERVICE_ALLOW = ["employees.me.viewers"];

// Shared work surface - EVERY role works the boards, delegates their own approvals and builds their own
// grids. Spread into each role, like OWN_ATTENDANCE.
//
// Boards, sprints and the cards on them are collaborative by nature, so the card grant is deliberately
// ALL-breadth rather than `me`: cards are owner-coded by assignee, and a column that shows only the cards
// assigned to the reader is a private to-do list, not a board. Board SHAPE (columns, WIP limits, swimlanes)
// stays out - `boards:configure` is the manager/HR verb below.
//
// `approval-delegations` and `table-views` are owner-coded (delegator / view owner) and their services pin
// the owner to the caller, so `me` reaches exactly the caller's own rows. `table-fields` is the builder's
// field catalogue - a virtual capability with no rows, read like any other catalogue.
const OWN_WORK: Record<string, Level> = {
  "boards.**": "read",
  "sprints.**": "read",
  "cards.**": "write",
  "approval-delegations.**": "read", // who is covering for whom is org-visible; writing is `me` below
  "approval-delegations.me.**": "write",
  "table-views": "write", // may call the list/create endpoints (rows scoped to own by applyScope)
  "table-views.me.**": "write",
  "table-fields.**": "read",
};
const OWN_WORK_ALLOW = [
  "cards.**", // every card verb (move/assign/block/comment/todos/watch) on the shared board surface
  "boards.*.metrics", // flow analytics for a board the caller can already read
  "table-views.me.run", // produce the rows for own saved grid (`:run` is the whole point of a view)
];

// Board social: every employee may give kudos (the open recognition wall) and react / reply / mark-read / vote
// on ANY board item (kudos are board posts now - kind="kudos"). `giveKudos` is a collection verb; the rest are
// all-scope (`*`) item verbs. Paired with `announcements.me.**` write (below) so an author can edit + soft-
// delete their OWN posts/kudos (owner-coded; HR still moderates all via `announcements.**`).
const BOARD_SOCIAL_ALLOW = [
  "announcements.giveKudos",
  "announcements.markAllRead", // clear own unread state across the board (collection verb, like giveKudos)
  "announcements.*.react",
  "announcements.*.reply",
  "announcements.*.markRead",
  "announcements.*.vote",
];

// Plain employee: self-service only (today canSeeEmployee -> self; sub-resources via the *.me singletons).
const employee: Grant = {
  levels: {
    ...COMMON_READ,
    "users.me.**": "read", // own user record (users/me)
    "preferences.**": "write", // own UI preferences (service scopes by user)
    // Collection-level read = "may call the list endpoint"; rows are scoped in the service. A 1-token
    // pattern matches only the collection, so item-GET of someone else stays denied (preserves behavior).
    employees: "read",
    "leave-balances": "read",
    payslips: "read",
    "employees.me": "read", // own directory record (item)
    // Own presence pill. A sub-resource, so the base `employees.me` read does NOT reach it (a 2-token pattern
    // never matches a 3-token key) - without this line the caller's own profile header 403s.
    "employees.me.presence.**": "read",
    ...OWN_PII, // own bank/identity/personal-info (self-service)
    "leave-requests": "write", // create + list (rows scoped in service)
    "leave-requests.me.**": "write", // own leave-requests (owner code embedded in the id)
    "leave-balances.me.**": "read", // own balances (item)
    "reimbursements": "write", // create + list own claims (rows scoped in service)
    "reimbursements.me.**": "write", // own reimbursement claims (owner code embedded in the id)
    "expenses": "write", // create + list own operational expenses (rows scoped in service)
    "expenses.me.**": "write", // own expenses (owner code embedded in the id)
    "holiday-selections": "write", // create/select + list
    "holiday-selections.me.**": "write", // own selections (item)
    "payslips.me.**": "read", // own payslips (item)
    // Documents are path-gated by the middleware, private by default. An employee reads ONLY their own
    // personal documents; they have NO org-documents access by default (a grant opens it - the user's call).
    "personal-documents": "read", // may call the list endpoint (rows scoped to own by applyScope)
    "personal-documents.me.**": "read", // own personal documents (items)
    "announcements.me.**": "write", // edit + soft-delete own board posts / kudos (owner-coded; HR moderates all)
    ...OWN_ATTENDANCE, // clock in/out + own attendance + file own regularizations
    ...OWN_WORK, // boards/cards/sprints, own approval delegation, own saved grids
    // Self-service request workflows (same shape as leave-requests: collection write = create + list own,
    // `.me.**` = own rows; the create gate pins the owner ref to self, so none of these reach anyone else).
    "overtime-requests": "write",
    "overtime-requests.me.**": "write",
    "remote-work-requests": "write",
    "remote-work-requests.me.**": "write",
    "asset-requests": "write", // ask for kit (a laptop, a monitor); the category catalog is readable above
    "asset-requests.me.**": "write",
    "time-entries": "write", // log own timesheet rows against the project catalog
    "time-entries.me.**": "write",
    "goals": "write", // own performance goals (manager sets/edits team goals via my-dept)
    "goals.me.**": "write",
    "check-ins": "write", // own 1:1 notes + action items (counterpart defaults to the manager)
    "check-ins.me.**": "write",
    "dependents": "write", // own dependents (feed benefit enrollments)
    "dependents.me.**": "write",
    "benefit-enrollments": "write", // enroll in / waive plans for self
    "benefit-enrollments.me.**": "write",
    "loans": "write", // request a loan / salary advance (decisions are payroll's verbs)
    "loans.me.**": "write",
    "tax-declarations": "write", // declare investments + attach proofs (verification is payroll's verb)
    "tax-declarations.me.**": "write",
    "tickets": "write", // raise support tickets (on-behalf creation needs write on the target's namespace)
    "tickets.me.**": "write",
    "notice-periods": "write", // self-service resignation
    "notice-periods.me.**": "write",
    "interview-feedback": "write", // interviewers author their own scorecards
    "interview-feedback.me.**": "write",
    // Read-only self views of records others drive for you.
    "transitions": "read", // own onboarding/offboarding checklist
    "transitions.me.**": "read",
    "transition-tasks": "read",
    "transition-tasks.me.**": "read",
    "reviews": "read", // own reviews (stage verbs below; manager assessment redacted until shared)
    "reviews.me.**": "read",
    "review-feedback": "read", // 360 requests where you are the nominated author
    "review-feedback.me.**": "read",
    "shift-assignments": "read", // own roster
    "shift-assignments.me.**": "read",
    "leave-encashments": "read", // own encashments (HR creates/decides them)
    "leave-encashments.me.**": "read",
  },
  allow: [
    ...OWN_ATTENDANCE_ALLOW,
    ...OWN_SELF_SERVICE_ALLOW,
    ...BOARD_SOCIAL_ALLOW,
    ...OWN_WORK_ALLOW,
    "overtime-requests.me.cancel",
    "remote-work-requests.me.cancel",
    "asset-requests.me.cancel",
    "time-entries.me.submit",
    "goals.me.updateProgress",
    // The owner's forward-looking call ("on track / at risk / off track"), which is the half of goal health
    // nobody can derive: pace comes off the dates, this comes off the person doing the work. Its own narrow
    // verb so it can be held without edit rights - and, like the watch eye below, a level grant carries no
    // custom methods, so the picker on your OWN goal reached nobody but super_admin until this line.
    "goals.me.setConfidence",
    "goals.me.comment", // answer the coaching on own goal - a thread only one side may write to is not one
    // Hand your own draft goal to the manager to agree - the owner's half of the goal-setting handshake
    // (services/goals.ts#proposeGoal). The manager's half is `goals.my-dept.approve` / `.requestChanges`.
    // Same trap as setConfidence and watch above: a level grant carries no custom methods, so without this
    // line the Submit button on your OWN goal reached nobody but super_admin and the handshake the propose /
    // approve / requestChanges verbs exist for was unreachable for every role that ships.
    "goals.me.propose",
    // Follow a goal. A level grant carries no custom methods, so a verb has to be named even where the caller
    // already writes the row - which is why the watch eye reached nobody but super_admin until this line.
    // Scoped to own goals; following somebody ELSE's goal is a per-object ACL grant (`goals.<code>.watch`),
    // deliberately, because the notifications carry that goal's title to whoever is following it.
    "goals.me.watch",
    "goals.me.unwatch",
    // Goals that are the same work in other words, and the goal yours could roll up under. A read of OTHER
    // goals, re-decided against this caller's own goal list scope, so it can name nothing they could not
    // already list.
    "goals.me.similar",
    // Ask for a unit, a starting value and a target for your own goal. One generation on a press, and the
    // three values land in the form for the owner to accept or discard.
    "goals.me.suggestMeasure",
    "reviews.me.suggestFeedback", // name the people who saw your work; nominating from it stays the manager's
    // What the app recorded about YOUR cycle - tasks you delivered, kudos you were written, goals you were
    // credited a share of, your own 1:1 notes - beside the box you write your self-assessment in. Each
    // section is separately decided by the list verdict its own collection gives this caller, so the verb is
    // the affordance and not the access: somebody who cannot list 1:1s gets that section empty.
    "reviews.me.evidence",
    // Who worked with you this cycle, which is what makes `suggestFeedback` above answerable: the list it
    // leads with is the people who actually saw the work rather than the whole directory.
    "reviews.me.collaborators",
    "tax-declarations.me.upload", // attach/download own investment proofs
    "tax-declarations.me.download",
    "tickets.me.**", // every ticket verb on OWN tickets (comment/cancel/todos/...); others' via category shares
    "transition-tasks.me.complete", // tick + document own onboarding tasks
    "transition-tasks.me.upload",
    "reviews.me.submitSelf",
    "reviews.me.acknowledge",
    "reviews.me.pdf", // record copy of own finished review
    "review-feedback.me.submitFeedback", // answer (or decline) a 360 nomination
    "review-feedback.me.decline",
    "employees.me.getPhoto",
    "employees.me.uploadPhoto",
    "employees.me.clearPhoto",
    "employees.me.getSignature", // read own e-signature (service hard-enforces owner-only)
    "employees.me.uploadSignature",
    "employees.me.clearSignature",
    "employees.me.uploadIdentityDoc", // attach a supporting doc to own identity field
    "employees.me.downloadIdentityDoc",
    "employees.me.clearIdentityDoc",
    "leave-requests.me.cancel",
    "leave-requests.me.upload", // attach a supporting document (sick note) to own request
    "leave-requests.me.download", // read back own request's document
    "reimbursements.me.cancel",
    "reimbursements.me.upload", // attach a receipt to own claim
    "reimbursements.me.download", // download own claim's receipt
    "expenses.me.submit", // submit own expense for approval
    "expenses.me.cancel",
    "expenses.me.upload", // attach an invoice to own expense
    "expenses.me.download", // download own expense's invoice
    // Both halves of looking at your own payslip. `:preview` renders it inline and `:download` hands over a
    // copy to keep - separate verbs so they can be granted apart (see routes/payslips.ts), and only
    // `download` was ever seeded. That left the Payslips page showing its download buttons with the view
    // buttons beside them hidden, which is the permission the wrong way round: keeping a permanent copy is
    // the stronger act, and it was the one allowed.
    "payslips.me.preview",
    "payslips.me.download",
    "personal-documents.me.download",
    "employees.upcomingCelebrations", // company-wide birthdays + work anniversaries feed (day+month only)
    "employees.batchGetPhotos", // batched photo fetch (transport only; the service re-applies per-id employee scope)
    "batch.run", // multi-read batch transport (each sub-request is independently gated)
  ],
};

// Manager = employee + reads own dept subtree (manager = dept head, so the dept subtree IS their team):
// employees, leave-requests and leave-balances of their department. Decides leave for the dept.
const manager: Grant = {
  levels: {
    ...employee.levels,
    // Base directory record of each dept member (2-token item) - NOT their sub-resources. `employees.my-dept`
    // matches `employees.<member>` but not `employees.<member>.bank-account`, so a manager sees the team
    // roster without their PII (PII stays super-only by default). Own PII still via OWN_PII.
    "employees.my-dept": "read",
    // The team's probation end dates: the manager is who the nightly reminder asks to confirm or extend.
    "employees.my-dept.probation_end_date.**": "read",
    // Presence of each dept member - the same reading of leave + attendance the manager already holds
    // through `attendance.my-dept.**`, surfaced as the profile header's pill.
    "employees.my-dept.presence.**": "read",
    "leave-requests.my-dept.**": "read", // dept's leave-requests (to review/approve) - no PII sub-resources
    "leave-balances.my-dept.**": "read", // dept's leave balances
    "attendance.my-dept.**": "read", // dept's attendance (sessions + presence)
    "attendance-regularizations.my-dept.**": "read", // dept's regularization requests (to review)
    // READ only. A manager sees why a report's short day was counted the way it was; re-valuing it is a pay
    // decision, and the seeded default leaves that with HR. An org that wants its managers doing it grants
    // write through the ACL, which is what that UI is for.
    "attendance-day-marks.my-dept.**": "read", // marks on the dept's days
    "overtime-requests.my-dept.**": "read", // dept's overtime requests (to review)
    "remote-work-requests.my-dept.**": "read", // dept's remote-work requests (to review)
    "asset-requests.my-dept.**": "read", // dept's asset requests (to review; handing the kit over is HR/IT's step)
    "time-entries.my-dept.**": "read", // dept's timesheets (to review)
    "goals.my-dept.**": "write", // set + edit the team's goals
    "check-ins.my-dept.**": "write", // run 1:1s with the team
    "reviews.my-dept.**": "read", // the team's reviews (manager stage verbs below)
    "transitions.my-dept.**": "read", // the team's onboarding/offboarding progress
    "transition-tasks.my-dept.**": "read",
    "shift-assignments": "write", // roster the team (create gate pins the owner to the dept scope below)
    "shift-assignments.my-dept.**": "write",
    "expenses.my-dept.**": "read", // dept's operational expenses (to review/approve)
    "vendors.**": "read", // resolve vendor names on the team's expenses
    // Own the team's work surface: create/rename/archive boards and run their sprints (the shape verbs are
    // below). Everyone else reads the boards and works the cards (OWN_WORK).
    "boards.**": "write",
    "sprints.**": "write",
    "goal-templates.**": "read", // apply a blueprint to the team; authoring the catalogue is HR's
  },
  // Approve/reject scoped to the manager's own dept subtree (matches the my-dept read scope above).
  // `*` here would let a manager decide ANY dept's request (cross-dept BOLA); `my-dept` keeps it owned.
  allow: [
    ...employee.allow,
    "leave-requests.my-dept.approve",
    "leave-requests.my-dept.reject",
    "leave-requests.my-dept.download", // read the sick note behind a team member's request before deciding
    "attendance-regularizations.my-dept.approve",
    "attendance-regularizations.my-dept.reject",
    "overtime-requests.my-dept.approve",
    "overtime-requests.my-dept.reject",
    "remote-work-requests.my-dept.approve",
    "remote-work-requests.my-dept.reject",
    "asset-requests.my-dept.approve",
    "asset-requests.my-dept.reject",
    "time-entries.my-dept.approve",
    "time-entries.my-dept.reject",
    "reviews.my-dept.submitManager", // manager assessment + 360 nominations for the team's reviews
    "reviews.my-dept.nominate",
    "reviews.my-dept.nudge", // remind the current stage's owner on a stalled team review
    // Writing about somebody is the case the evidence pack was built for: what they delivered, what was said
    // about them and what they contributed to, gathered under the cycle's window instead of across four tabs.
    "reviews.my-dept.evidence",
    // Who saw the work, so the 360 picker leads with them rather than with the whole directory.
    "reviews.my-dept.collaborators",
    "reviews.my-dept.pdf", // record copy of a report's finished review
    "goals.my-dept.setConfidence", // the same call on a goal the manager set for the team
    "goals.my-dept.comment", // coach on the team's goals - the thread under a goal is where that happens
    "goals.my-dept.watch", // follow the team's goals
    "goals.my-dept.unwatch",
    // Credit a share of a team goal to whoever delivered it. The manager's call and not the owner's: a share
    // scores in the CONTRIBUTOR's review, so it is a statement about somebody else's performance.
    "goals.my-dept.setContributors",
    "goals.my-dept.similar", // duplicated effort across the team, and what a report's goal should align to
    "goals.my-dept.suggestMeasure", // a measure for a report's goal that has none, offered while agreeing it
    "boards.**", // configure the board's shape (columns, WIP limits, swimlanes, labels) + restore
    "sprints.**", // activate/complete the team's sprints + restore
    "goal-templates.*.apply", // stamp a blueprint onto a report or the whole team
    // The manager's half of the goal-setting handshake: agree the goal a report submitted, or send it back
    // with the reason (services/goals.ts#approveGoal / #requestGoalChanges). `my-dept` like every other
    // decision verb here - `*` would let a manager agree any department's goals. A goal the manager SETS for
    // a report lands AGREED at creation, so these are only ever the report-proposed path.
    "goals.my-dept.approve",
    "goals.my-dept.requestChanges",
    "expenses.my-dept.approve", // decide the dept's operational expenses (my-dept keeps it owned, not cross-dept)
    "expenses.my-dept.reject",
  ],
};

// HR admin: employee.write + config.write + announcement.write. Write (not admin) -> can soft-delete but
// force-purge stays super_admin-only. allow "<collection>.**" = every custom method (lifecycle/restore)
// on the resources config.write controls.
const hr_admin: Grant = {
  levels: {
    ...COMMON_READ,
    "users.me.**": "read",
    "preferences.**": "write",
    ...OWN_PII, // HR sees only their OWN PII (self-service); others' PII stays super-only by default
    // Field-precise employee write: collection (create/list) + base record + the two non-PII protected
    // fields (department/manager). Deliberately omits bank-account/identity/personal-info, so HR no longer
    // reaches anyone else's PII through a broad grant. (Re-parent via department is still 501-guarded.)
    employees: "write",
    "employees.*": "write",
    "employees.*.probation_end_date.**": "read", // redacted field the row grant above does not reach
    "employees.*.department.**": "write",
    "employees.*.manager.**": "write",
    "employees.*.bio.**": "write", // moderate/tidy anyone's public about-me (not PII)
    "employees.*.presence.**": "read", // anyone's status pill (derived from leave + attendance, which HR reads in full)
    "employees.*.tax.**": "write", // income-tax (TDS) projection for everyone - HR/payroll manage it (unlike bank/identity PII)
    "departments.**": "write",
    "positions.**": "write", // HR records promotions/transfers (effective-dated role history)
    "bonuses.**": "write", // HR records one-off awards (bonus/incentive)
    "settlements.**": "write", // HR computes full-and-final settlements at exit
    "holidays.**": "write",
    "leave-types.**": "write",
    "letter-templates.**": "write", // HR authors letter types (read = who may generate is per-template ACL)
    "announcements.**": "write",
    "org-documents.**": "write",
    "personal-documents.**": "write",
    // Who has signed the current version of a policy, and who is still pending: the Documents page's
    // AckProgressDialog reads this roster, and HR is the only role that opens it. Nothing had granted the
    // collection at any level, so the panel silently showed an empty signed list next to a chase list holding
    // the whole company - the same "route shipped, grant did not" shape as the presence pill.
    "document-acknowledgements.**": "read",
    "pay-periods.**": "write",
    "pay-components.**": "write",
    "reimbursement-categories.**": "write", // HR configures reimbursement categories
    "expense-categories.**": "write", // HR (finance) configures operational-expense categories
    "vendors.**": "write", // HR (finance) maintains the vendor master
    "expense-budgets.**": "write", // HR (finance) sets + reviews budgets (spend derived from expenses)
    "bank-formats.**": "write", // HR defines per-bank bulk-payment Excel formats (mappings + template)
    "settings.**": "write",
    "leave-requests.**": "read", // HR can view all leave-requests
    "leave-balances.**": "read", // HR can view everyone's leave balances (encashment page needs the real number)
    "reimbursements.**": "read", // HR can view + decide all reimbursement claims
    expenses: "write", // HR (finance) RECORDS company spend (a vendor invoice arrives at finance, not at the employee who ordered it)
    "expenses.**": "read", // HR (finance) views + decides all operational expenses org-wide
    // Workflow engine: HR authors the automation rules (authoring is the privileged act - actions run with
    // system authority) and reads the event + run logs. Not granted to employee/manager (private-by-default).
    "automations.**": "write",
    "event-log.**": "read",
    "automation-runs.**": "read",
    "workflow-instances.**": "read",
    "workflow-meta.**": "read", // builder metadata endpoint (virtual)
    "esign-providers.**": "read", // e-sign driver catalog for the Settings E-signature tab (virtual)
    ...OWN_ATTENDANCE, // HR clocks in/out + files own regularizations like any employee
    ...OWN_WORK, // boards/cards/sprints, own approval delegation, own saved grids
    "boards.**": "write", // HR administers the boards org-wide (create/rename/archive; shape verbs below)
    "sprints.**": "write",
    "goal-templates.**": "write", // HR curates the goal blueprint catalogue (a Settings entry)
    "attendance.**": "read", // HR sees all attendance (presence, history)
    "attendance-regularizations.**": "read", // HR reviews all regularization requests
    "attendance-day-marks.**": "write", // HR decides what a day counts as, org-wide (and withdraws its own marks)
    "overtime-requests.**": "read", // HR reviews + decides these org-wide (verbs below)
    "remote-work-requests.**": "read",
    "asset-requests.**": "read", // HR decides these org-wide and hands the kit over (verbs below)
    "time-entries.**": "read", // org-wide timesheet visibility (approval stays the manager's)
    // Recruiting (ATS): HR runs the whole pipeline.
    "job-requisitions.**": "write",
    "candidates.**": "write",
    "applications.**": "write",
    "interviews.**": "write",
    "interview-feedback.**": "write",
    "offers.**": "write",
    "background-checks.**": "write", // HR runs background verification
    // Lifecycle: HR opens/drives onboarding + offboarding and records notice periods.
    "transitions.**": "write",
    "transition-tasks.**": "read", // task mutation is verb-only (complete/reopen/upload, allowed below)
    "notice-periods.**": "write",
    // Benefits: HR authors the plan catalog and manages anyone's dependents/enrollments.
    "benefit-plans.**": "write",
    "dependents.**": "write",
    "benefit-enrollments.**": "write",
    // Compliance calendar: HR files statutory events + maintains the recurrence rules.
    "compliance-events.**": "write",
    "compliance-rules.**": "write",
    // Performance: HR administers cycles; reads (not edits) goals/reviews/feedback. 1:1 check-in notes stay
    // private to the pair (no HR grant).
    "review-cycles.**": "write",
    "reviews.**": "read",
    "review-feedback.**": "read",
    "goals.**": "read",
    // Scheduling + workplace: shift catalog/roster, project catalog, help desk, checklists, asset register.
    "shifts.**": "write",
    "shift-assignments.**": "write",
    "projects.**": "write",
    "tickets.**": "write",
    "ticket-checklists.**": "write",
    "assets.**": "write",
    "asset-categories.**": "write", // HR maintains the kinds of asset, and the tag code each one prints
    // Inventory counts. A stocktake is the asset register being walked, by the same administrator who
    // maintains the register - but nothing was seeded for it at ANY level, so the whole page was reachable
    // only by super_admin while `assets` and `asset-categories` beside it were HR's. Not a withheld verb: a
    // withheld collection, which is how the earlier role-grants gap looked too.
    "stocktakes.**": "write",
    "events.**": "write", // org calendar
    "leave-encashments.**": "write", // HR records + decides encashments
    "loans.**": "read", // visibility only; decisions are payroll's verbs
    "tax-declarations.**": "read",
    "suggestions.**": "read", // triage visibility (the box itself opens via the `everyone` ACL)
    "pay-grades.**": "read", // comp catalogs are payroll-authored; HR reads for letters/requisitions
    "salary-structures.**": "read",
  },
  allow: [
    ...OWN_ATTENDANCE_ALLOW,
    ...OWN_SELF_SERVICE_ALLOW,
    ...OWN_WORK_ALLOW,
    "boards.**", // configure any board's shape + restore
    "sprints.**",
    "goal-templates.**", // :apply + lifecycle/restore on the blueprint catalogue
    "attendance-regularizations.*.approve", // HR decides regularizations org-wide
    "attendance-regularizations.*.reject",
    "leave-requests.*.approve", // leave.decide includes hr_admin (not just managers)
    "leave-requests.*.reject",
    "leave-requests.*.download", // any request's supporting document
    "overtime-requests.*.approve", // HR decides overtime + remote-work org-wide (like regularizations)
    "overtime-requests.*.reject",
    "remote-work-requests.*.approve",
    "remote-work-requests.*.reject",
    "asset-requests.*.approve",
    "asset-requests.*.reject",
    "asset-requests.*.issue", // hand over the actual asset, which is what closes the request
    "job-requisitions.**", // every ATS custom method (advance/reject, complete/cancel, offer workflow, uploads)
    "candidates.**",
    "applications.**",
    "interviews.**",
    "interview-feedback.**",
    "offers.**",
    "background-checks.**",
    "transitions.**", // complete/cancel/reopen/appendTask + restore
    "transition-tasks.**", // complete/reopen/upload on anyone's tasks
    "notice-periods.**",
    "benefit-plans.**",
    "dependents.**",
    "benefit-enrollments.**",
    "compliance-events.**",
    "compliance-rules.**",
    "review-cycles.**", // launch/enroll/close/reopen
    "reviews.*.skipStage", // unblock a stuck review (stage owners keep their own verbs)
    "reviews.*.nudge", // remind the current stage's owner on any stalled review
    "reviews.*.pdf", // record copy of any finished review
    // Hand one review to a different writer (a transfer mid-cycle, a manager on leave). HR's rather than the
    // manager's: it reassigns who is accountable for the write-up, which is the cycle administrator's call.
    "reviews.*.assignReviewer",
    "reviews.*.evidence", // the same pack on any review HR reads - the cycle's own record, not an assessment
    "reviews.*.collaborators", // and the 360 picker's list of who actually worked with them
    "shifts.**",
    "shift-assignments.**",
    "projects.**",
    "tickets.**", // run the help desk (assign/start/resolve/close/comment/todos)
    "ticket-checklists.**",
    "assets.**",
    "asset-categories.**",
    "stocktakes.**", // open a count, record what was found on the walk, close it (and restore one deleted)
    "events.**",
    "leave-encashments.**", // approve/reject/cancel
    "suggestions.*.respond", // HR triage (status + response) on any suggestion
    "reimbursements.*.approve", // HR decides reimbursement claims (no manager involvement)
    "reimbursements.*.reject",
    "reimbursements.*.pay", // separate-mode payout (mark approved claims paid out-of-band)
    "reimbursements.*.upload", // attach/replace any claim's receipt
    "reimbursements.*.download", // view any claim's receipt
    "reimbursement-categories.**",
    "expenses.*.submit", // finance can submit on behalf (e.g. a vendor invoice)
    "expenses.*.approve", // finance decides expenses org-wide
    "expenses.*.reject",
    "expenses.*.pay", // record out-of-band vendor payment
    "expenses.*.upload", // attach/replace any expense's invoice
    "expenses.*.download",
    // Read a DRAFT claim's PDF invoice into suggested fields. Granted to whoever already records the claim,
    // because it fills a form they are filling anyway - a level grant carries no custom methods, so writing
    // the row is not enough on its own. Doubly gated beyond this: the org must switch the feature on AND
    // choose which fields a model may propose, so the grant alone sends nothing anywhere.
    "expenses.*.extractReceipt",
    "expense-categories.**",
    "vendors.**",
    "expense-budgets.**",
    "employees.**",
    "departments.**",
    "holidays.**",
    "leave-types.**",
    "letter-templates.**",
    "announcements.**",
    "org-documents.**",
    "personal-documents.**",
    "pay-periods.**",
    "pay-components.**",
    "bank-formats.**", // manage bank bulk-payment formats (mappings + template upload). Debit account is super-only.
    "automations.**", // author rules + the enable/disable/test custom verbs
    "batch.run", // multi-read batch transport (each sub-request is independently gated)
  ],
};

// Payroll admin: employee.read.all + comp.read/write + payroll run transitions (submit/publish).
// Approving a run is super_admin-only (separation of duties) - encoded as a deny here so the MIDDLEWARE
// enforces it, not an inline role check.
const payroll_admin: Grant = {
  levels: {
    ...COMMON_READ,
    "users.me.**": "read",
    "preferences.**": "write",
    ...OWN_PII, // own PII only; payroll no longer reaches others' bank/identity via a broad employees read
    employees: "read", // list the directory
    "employees.*": "read", // base records (for payroll) - NOT the PII sub-resources, NOT probation_end_date (redacted)
    "employees.*.tax.**": "write", // income-tax (TDS) projection for everyone (payroll runs it)
    "compensation.**": "write",
    "payroll-runs.**": "write",
    "payslips.**": "read",
    "reimbursements.**": "read", // payroll views + decides + pays out reimbursement claims
    expenses: "write", // payroll (finance) records company spend as well as paying it
    "expenses.**": "read", // payroll (finance) views + decides + pays operational expenses org-wide
    "vendors.**": "write", // finance maintains the vendor master
    "expense-budgets.**": "write", // finance sets + reviews budgets
    // Comp catalogs: payroll authors the grade bands + salary structures compensation rows reference.
    "pay-grades.**": "write",
    "salary-structures.**": "write",
    // Loans + tax declarations are payroll's workflows (EMIs deduct in the run; declarations feed TDS review).
    "loans.**": "write",
    "tax-declarations.**": "write",
    "leave-encashments.**": "read", // encashments pay out through the run (HR creates/decides them)
    "bonuses.**": "read", // bonuses pay out through the run (HR awards them)
    "overtime-requests.**": "read", // approved overtime pays out through the run
    "personal-documents": "read", // may list (rows scoped to own)
    "personal-documents.me.**": "read", // own personal docs (self-service, like every employee)
    "announcements.me.**": "write", // edit + soft-delete own board posts / kudos (like every employee)
    ...OWN_ATTENDANCE, // payroll clocks in/out + files own regularizations like any employee
    ...OWN_WORK, // boards/cards/sprints, own approval delegation, own saved grids
  },
  // Payroll runs the workflow but NOT approve (separation of duties), NOT bankFile, and NOT paymentResult -
  // the bank file exposes the employer debit account + every employee's account number, so it is
  // super_admin-only, and recording what the bank DID with that file follows the file rather than the run:
  // granting it here while withholding `bankFile` would let the run operator assert that money arrived for a
  // payment they were never able to send.
  // These two verbs are deliberately NOT granted (private-by-default) rather than granted-then-denied, so
  // no future broad grant can ever re-expose them: only super_admin's `**` reaches them.
  allow: [
    "payroll-runs.*.submit",
    "payroll-runs.*.build",
    "payroll-runs.*.publish",
    // The PDF of a payslip payroll already reads: the level grant above answers the resource, and the bytes
    // are behind these two verbs, which nothing had granted. Both are audited as sensitive reads. This is the
    // run operator reading what the run produced - unlike the bank file and the statutory report below, which
    // are withheld because of what ELSE they expose (the employer debit account, every account number).
    "payslips.*.preview",
    "payslips.*.download",
    "reimbursements.*.approve",
    "reimbursements.*.reject",
    "reimbursements.*.pay",
    "reimbursements.*.download",
    "expenses.*.submit", // finance can submit a vendor invoice on behalf
    "expenses.*.approve",
    "expenses.*.reject",
    "expenses.*.pay", // record out-of-band vendor payment
    "expenses.*.upload",
    "expenses.*.download",
    "expenses.*.extractReceipt", // same reason as hr_admin above: payroll also records vendor invoices
    "vendors.**",
    "expense-budgets.**",
    "compensation.reapplySplit", // re-derive every current row's basic/special under the live ctc config (CTC held fixed)
    "compensation.preview", // price a PROPOSED revision without writing it - the conversation before the raise
    "compensation.increment", // an increment ROUND: price a team's raises, or apply them one at a time
    "pay-grades.**", // lifecycle/restore on the comp catalogs
    "salary-structures.**",
    "loans.**", // approve/reject/disburse/recordRepayment
    "tax-declarations.**", // verify/reject + proof upload/download
    "personal-documents.me.download",
    "employees.upcomingCelebrations",
    "employees.batchGetPhotos",
    "batch.run",
    ...OWN_ATTENDANCE_ALLOW,
    ...OWN_SELF_SERVICE_ALLOW,
    ...BOARD_SOCIAL_ALLOW,
    ...OWN_WORK_ALLOW,
  ],
};

const super_admin: Grant ={ levels: { "**": "admin" }, allow: ["**"] };

// The seed grant set (typed default). NOT the runtime source of truth once P0b lands - the DB `grants`
// table is, loaded onto the user context. `satisfies` keeps the precise literal keys (so `GRANTS.employee`
// stays a `Grant`) while documenting the shape. Roles are data, so dynamic lookups go through `grantFor`.
export const GRANTS = { employee, manager, hr_admin, payroll_admin, super_admin } satisfies Record<string, Grant>;

// Deny-all grant: the fail-closed default for a role with no policy (unknown / unconfigured role).
export const EMPTY_GRANT: Grant = { levels: {}, allow: [] };

// Reserved pseudo-role: a rule subject that applies to EVERY authenticated caller (the "allow everyone"
// primitive). It is a real `roles` row so the ACL UI can target it, but it is never assignable to a user
// (users.ts rejects it) - a user still holds exactly one real role. Its rules are unioned into each caller's
// authority at decide time (auth.ts / authz.ts), EXCEPT for super_admin (anyone holding the `**` wildcard),
// who is exempt so an `everyone` deny can never lock out the break-glass identity.
export const EVERYONE_ROLE = "everyone";

// Whether a grant confers the unrestricted super wildcard. Such a caller is exempt from `everyone` rules.
export function isSuperGrant(g: Grant): boolean {
  return g.levels["**"] != null || g.allow.includes("**");
}

/**
 * The role SUBJECTS a per-object rule lookup must fan out over for this caller: every role they hold, plus the
 * `everyone` pseudo-role.
 *
 * ONE DEFINITION, because there are eight call sites and they are the kind that drift. The expression was
 * written out at each of them, so adding secondary roles (db/schema.ts `user_roles`) meant changing all eight or
 * silently having per-object role rules stop applying to somebody's second role at whichever one was missed -
 * a fail-closed bug, but an invisible one: the share simply does not appear.
 *
 * `everyone` applies to every caller EXCEPT super (the `**` holder), who must stay unrestrictable - an
 * `everyone` DENY that could bind super would be a lockout of the break-glass identity.
 */
export function roleSubjectsOf(principal: { role: string; roles?: readonly string[] }, grant: Grant): string[] {
  // The PRIMARY role is the floor. Taking the array alone would mean a principal assembled without one - a test
  // fixture, a future code path that forgets - silently contributed NO role subjects, so every per-object role
  // rule stopped applying to them. That fails closed, which is the right direction and the wrong failure: the
  // share simply does not appear, with nothing to notice. The primary always belongs in the set anyway.
  const held = principal.roles?.length ? [...new Set(principal.roles)] : [principal.role];
  return isSuperGrant(grant) ? held : [...held, EVERYONE_ROLE];
}

// Fail-closed accessor for a dynamic (string) role. The single seam P0b repoints from this seed map to the
// grant loaded off the auth read. An unknown role yields EMPTY_GRANT (deny-all), never throws.
export function grantFor(role: string): Grant {
  return (GRANTS as Record<string, Grant>)[role] ?? EMPTY_GRANT;
}
