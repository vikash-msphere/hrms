// The day-one policy manifest a fresh database is seeded with (one `policy` row, key 'manifest'). SEED DATA
// ONLY: after that the row is the policy, edited through the policy API, and the running app never imports this
// file. The shape and the accessors that read a stored manifest are engine code, in src/domain/manifests.ts.
import type { AuditPolicy, OwnerRef, Policy, RefField, ScopeTier, StateRule } from "../../src/domain/manifests";

// Non-ownership body references the middleware validates ("may you reference this target?" = `level` on
// it). Ownership/principal refs (employee, manager, department, owner) are intentionally NOT here: they
// are path-derived or admin-only (re-parent), enforced structurally, so a body value can't smuggle one.
export const REFERENCES: Record<string, Record<string, RefField>> = {
  "leave-requests": { leave_type: { collection: "leave-types", level: "read" } },
  "holiday-selections": { holiday: { collection: "holidays", level: "read" } },
  "payroll-runs": { pay_period: { collection: "pay-periods", level: "read" } },
  reimbursements: { category: { collection: "reimbursement-categories", level: "read" } },
  // `stocktake` rides on :verify - filing a sighting against a count you cannot even read would be recording
  // into somebody else's report.
  assets: { category: { collection: "asset-categories", level: "read" }, stocktake: { collection: "stocktakes", level: "read" } },
  "asset-requests": { category: { collection: "asset-categories", level: "read" } },
  "benefit-enrollments": { plan: { collection: "benefit-plans", level: "read" } },
  "shift-assignments": { shift: { collection: "shifts", level: "read" } },
  "work-pattern-assignments": { pattern: { collection: "work-patterns", level: "read" } },
  "time-entries": { project: { collection: "projects", level: "read" } },
  referrals: { department: { collection: "departments", level: "read" }, hired_employee: { collection: "employees", level: "read" } },
  "job-requisitions": { department: { collection: "departments", level: "read" }, hiring_manager: { collection: "employees", level: "read" }, pay_grade: { collection: "pay-grades", level: "read" } },
  candidates: { referral: { collection: "referrals", level: "read" } },
  applications: { candidate: { collection: "candidates", level: "read" }, requisition: { collection: "job-requisitions", level: "read" }, referral: { collection: "referrals", level: "read" } },
  interviews: { application: { collection: "applications", level: "read" } },
  "interview-feedback": { interview: { collection: "interviews", level: "read" } },
  // A goal's ALIGNMENT and its BLOCKER name other goals, and nothing gated them: `resolveParentId` /
  // `resolveBlockedBy` (services/goals.ts) check that the target exists and that the chain does not loop, which
  // is integrity rather than access. So a caller could align their own goal under a goal they cannot read -
  // no disclosure (the serializer emits a bare `goals/<id>` ref, and opening it still 403s), but their row then
  // hangs in somebody else's alignment tree and counts toward that subtree's rollups. Declared here rather than
  // fixed in the service, because this is the one place a body reference is gated and the engine already does
  // it: `read` on the target, exactly as `cards.goal` below has always required.
  //
  // Costs no reachable flow: every parent the UI can offer comes from the goals list it already loaded, which
  // is scope-bound, and "none" is sent as "" (skipped here).
  goals: {
    parent: { collection: "goals", level: "read" },
    blocked_by: { collection: "goals", level: "read" },
    cycle: { collection: "review-cycles", level: "read" },
    department: { collection: "departments", level: "read" },
  },
  // A card lives on a board (need read on it) and may link to a goal (need read on it). `assignee` is a
  // principal ref (like manager), enforced structurally, so it is deliberately not gated here.
  cards: { board: { collection: "boards", level: "read" }, goal: { collection: "goals", level: "read" }, sprint: { collection: "sprints", level: "read" } },
  // A sprint is planned by whoever MANAGES its board (write on the board: its creator, its sharing list at
  // manage, its department's managers, the project manager) - not by everyone who can see it.
  sprints: { board: { collection: "boards", level: "write" } },
  offers: { application: { collection: "applications", level: "read" } },
};

// Fields that need write authorization beyond the plain resource-write grant. For each such field PRESENT
// in the body (CREATE or UPDATE), the middleware additionally checks write on `<collection>.<id>.<field>`
// - so the level matcher gates it (e.g. employees.** write covers employees.x.department.write for HR,
// but a plain employee, lacking record write, cannot set department/manager on themselves; compensation
// amounts stay payroll-only; users role/status/employee-relink stay super-only). This blocks
// mass-assignment / self-escalation and is the hook for finer per-field control later.
export const PROTECTED_FIELDS: Record<string, string[]> = {
  // role/status escalation; employee relink = identity change. `roles` is the secondary set (db/schema.ts
  // `user_roles`) and is listed for exactly the reason `role` is: it grants authority, so it must not ride in on
  // a plain `users` write. Omitting it would have left the same escalation available under a different key.
  users: ["role", "roles", "status", "employee"],
  employees: ["department", "manager", "epf_enrolled", "eps_excluded", "employee_number"], // re-parent (re-scoping) + EPF/EPS membership + human ID — payroll/HR only, never self-writable
  compensation: ["annual_ctc", "variable_pay_target", "currency_code", "pay_grade", "salary_structure"], // pay amounts (annual_ctc drives the whole split; variable_pay_target is the bonus they play for) — payroll only, never self
};

/**
 * Base-record fields whose READ is decided per field: `<collection>.<code>.<field>` at level `read`,
 * checked as the resource is serialized (`http/accessHint.ts` `withAccess`). The token is the WIRE name, so
 * the rule an admin authors and the key that disappears from the payload are spelled the same.
 *
 * Field access used to reach three collections and four PII sub-resources, because the only mechanism was
 * PROTECTED_FIELDS (a WRITE gate) and the sub-resource redactors. Everything else was all-or-nothing at the
 * row: a recruiter coordinating interviews read the offer's money, the hiring panel read the candidate's
 * personal phone number, and a leave approver read the sick note's stated reason - none of which the row
 * grant was ever meant to say yes to.
 *
 * ADDITIVE FOR `**` GRANTS. A pattern's `**` matches trailing tokens, so a grant like `offers.**`,
 * `leave-requests.my-dept.**` or `candidates.me.**` already satisfies `<collection>.<code>.<field>.read`, and
 * its holder loses nothing by the field being listed. What the entry BUYS is the ability to take one away: a
 * deny on `offers.*.base_comp` removes exactly that field from exactly those callers, deny-wins and scoped
 * like any other pattern, instead of forcing the choice between the whole record and nothing. Same shape as
 * the delete axis (permissions.ts `denyingPattern`). A 2-token row grant (`employees.*`) has no `**` tail and
 * does NOT reach the field - see the `employees` entry below before listing a field on such a collection.
 *
 * Kept to fields that are genuinely a different sensitivity from the row they sit on - money, personal
 * contact details, free text about a person - rather than every column: each one is an in-memory decide()
 * per row of a list response.
 */
export const REDACTED_FIELDS: Record<string, string[]> = {
  // An offer's money. Running the pipeline - schedule, advance, interview - is a different job from setting
  // or seeing the number. `currency_code` is deliberately NOT here: it is meaningless on its own, and a
  // reader who cannot see the amount has no use for its unit.
  offers: ["base_comp"],
  // An external person's own contact details, and the panel's free-text notes about them.
  candidates: ["email", "phone", "notes"],
  // The stated reason for leave is routinely medical, and is not the same thing as the dates a roster needs.
  "leave-requests": ["reason"],
  // A ticket raised about a person can carry anything; a queue only needs its subject and state.
  tickets: ["description"],
  // What the company paid for a thing, and what it is worth now. An asset row is readable by the person
  // HOLDING it (assets.me), and "your laptop cost 1.8 lakh" is a different sensitivity from "you have a
  // laptop" - the same split `offers.base_comp` draws between running a process and seeing its number.
  // `book_value` is listed beside its input because hiding only the cost would leave the figure it is
  // computed from on the wire, which is not a redaction.
  assets: ["purchase_cost", "book_value"],
  // Vendor pricing on a check about one person, on a row that person's own `me` rule can reach. Choosing an
  // agency is an HR decision; the subject of the check has no part in it and no business seeing the invoice.
  "background-checks": ["cost"],
  // When somebody's probation ends is a confirm-or-extend decision owed by their management line and HR, not
  // directory information - and the directory is readable far more widely than that. UNLIKE the entries above,
  // listing this one takes the field away from 2-token grants (`employees.*`, `employees.me`,
  // `employees.my-dept`): a pattern with no `**` tail stops at the row and never reaches
  // `employees.<code>.probation_end_date`. Every holder that should keep it therefore carries an explicit
  // `employees.<scope>.probation_end_date.**` read rule beside its row grant - seeded in bootstrap/authz/roles/,
  // and backfilled onto live roles by migration 0001.
  //
  // The rest are HR and payroll details that ride the same base record every employee now reads for the
  // directory: the LEGAL name (which can differ from the name a person goes by, and saying so is theirs to do),
  // the employee number, the EPF/EPS membership flags (which hint at pay) and the records-start date. Each
  // holder that needs one - the person themselves, HR, payroll, a manager for the team's employee numbers -
  // carries the explicit field rule, the same as the probation date.
  employees: ["probation_end_date", "legal_name", "employee_number", "epf_enrolled", "eps_excluded", "tracked_from"],
  // NOT `reviews`: its manager comments and ratings are already withheld by the review's own state machine
  // (`_managerVisible`, http/serialize.ts), and a second mechanism over the same field would be two places
  // deciding one question.
};

// Owner refs: body fields that set who a NEW resource is owned by (on create there is no path id, so the
// body owner is an unverified object reference - the BOLA gap). For each, the middleware requires the
// caller may create under that owner: the ref resolves to an employee code and the caller has write on
// `<collection>.<ownerCode>` (own via `me`, or an admin who may write that owner's namespace). `collection`
// is the ref TARGET (always employees here). holiday-selections and loans are omitted: their services force
// self, so there is no body owner to gate (a loan/advance is requested for the caller and no one else).
export const OWNER_REFS: Record<string, Record<string, OwnerRef>> = {
  "leave-requests": { employee: { collection: "employees" } },
  "personal-documents": { employee: { collection: "employees" } },
  "attendance-regularizations": { employee: { collection: "employees" } },
  "attendance-day-marks": { employee: { collection: "employees" } },
  "overtime-requests": { employee: { collection: "employees" } },
  "remote-work-requests": { employee: { collection: "employees" } },
  // Carried onto the live manifest by migration 0002, because production reads this from the `policy` row.
  "late-early-requests": { employee: { collection: "employees" } },
  "asset-requests": { employee: { collection: "employees" } },
  "notice-periods": { employee: { collection: "employees" } },
  // The board author owns their row: kudos are author(giver)-owned, and a generic post's author owns it too, so
  // an author can self-scope edit/soft-delete their own item (kudos folded into announcements as kind="kudos").
  announcements: { author: { collection: "employees" } },
  suggestions: { submitter: { collection: "employees" } },
  reimbursements: { employee: { collection: "employees" } },
  // A company expense is owned by the employee who incurred it, and `employee` is settable on create
  // (services/expenses.ts). The seeded `expenses: write` collection grant is what makes self-service filing
  // work, so it decides nothing about WHOSE expense is being filed - exactly the trap `leave-requests`
  // documents below. Undeclared, any employee could file an expense owned by a colleague: code-allocated
  // under their code, so it lands in their list and their manager's queue, and `:submit` notifies THEIR
  // manager and drives automations against them. With this entry the middleware requires write on
  // `expenses.<ownerCode>`, which `expenses.me.**` satisfies for self and nothing else satisfies for anyone
  // else. The service carries the second half of the same defence.
  expenses: { employee: { collection: "employees" } },
  goals: { employee: { collection: "employees" } },
  // A card is coded under its BOARD (domain/boardAccess.ts), so the board is what a create files it under: write
  // on `cards.<boardCode>` - whoever may work the board's tasks. The 1-token `cards` create grant cannot see which
  // board, which is exactly the question this answers. `employee` (the task's owner, default the caller) is
  // gated too: naming somebody else takes write on `cards.<their code>`, which no board rule reaches, so only an
  // org-wide card grant files a task in another person's name.
  cards: { board: { collection: "boards" }, employee: { collection: "employees" } },
  transitions: { employee: { collection: "employees" } },
  "check-ins": { employee: { collection: "employees" } },
  dependents: { employee: { collection: "employees" } },
  "benefit-enrollments": { employee: { collection: "employees" } },
  "shift-assignments": { employee: { collection: "employees" } },
  "work-pattern-assignments": { employee: { collection: "employees" } },
  "time-entries": { employee: { collection: "employees" } },
  "tax-declarations": { employee: { collection: "employees" } },
  // A ticket is owned by its requester employee. Absent = the caller (self-service). Present = raise it ON
  // BEHALF OF that employee - the middleware gates it (needs write on tickets.<ownerCode>), so an ordinary
  // employee can only set it to themselves, while HR/super/system automations may raise one for anyone.
  tickets: { employee: { collection: "employees" } },
  referrals: { referrer: { collection: "employees" } },
  "interview-feedback": { author: { collection: "employees" } },
  // Admin-created comp records. Default holders (hr_admin/payroll_admin) have `**` write so the owner check is
  // a no-op for them; the point is defense-in-depth: if any of these is ever granted at a narrow (self/dept)
  // scope via the ACL, create-on-behalf-of-another is blocked (must hold write on the target's namespace),
  // closing a BOLA-write gap. The bonuses `:award` BULK path is a separate admin op (gated by the award verb),
  // not owner-scoped by design.
  compensation: { employee: { collection: "employees" } },
  positions: { employee: { collection: "employees" } },
  bonuses: { employee: { collection: "employees" } },
  settlements: { employee: { collection: "employees" } },
  "leave-encashments": { employee: { collection: "employees" } },
  // A ledger row moves the balance of the employee it names, so naming somebody is exactly the thing a narrow
  // grant must not reach past. Carried onto the live manifest by migration 0002.
  "leave-adjustments": { employee: { collection: "employees" } },
  // Pay and tax paid before HRMS, about the employee it names. Carried onto the live manifest by migration 0002.
  "payroll-openings": { employee: { collection: "employees" } },
  // A delegation says whose approvals somebody else is covering, and `delegator` is the owner: the row is
  // scoped by `delegator_id` (lib/authzResolve.ts) and `activeDelegatesFor` reads it to decide who gets a copy
  // of that person's approval nudges (services/notifications.ts). Undeclared, the field was accepted as given -
  // so a holder of `approval-delegations.write` at ANY scope, including the `me` scope this self-service
  // feature invites, could name somebody else as the delegator and themselves as the delegate, and every
  // approval notification addressed to that person was copied to them. Not an escalation (a delegate still
  // needs their own grant to decide anything) - an unconsented subscription to another manager's queue, and one
  // the delegator is never told about.
  "approval-delegations": { delegator: { collection: "employees" } },
  // A background check belongs to the person it is about, and `employee` is settable on create - so without this
  // a narrowly-granted holder could file a check under somebody else, putting a vendor report in another person's
  // file. The patch half of that gap is closed differently: the subject is now immutable, because the row's code
  // is allocated under it (services/backgroundChecks.ts) and a code never moves.
  "background-checks": { employee: { collection: "employees" } },
};

// Which SUBJECT-RELATIVE scope tiers are meaningful when granting access on a collection - see `ScopeTier` in
// src/domain/manifests.ts for what each tier means and why `named-dept` is derived rather than declared.
// Narrowest-first, so the ACL UI's default selection is the tightest. Over-inclusion is SAFE - a tier the
// engine can't honor for a collection just yields an inert rule (never a security hole) - so this errs toward
// offering a scope. Anything unlisted is "all" only.
export const SUPPORTED_SCOPES: Record<string, ScopeTier[]> = {
  // Employee-coded collections: target the subject's own rows, their department, or everyone.
  employees: ["self", "reports", "org", "dept", "all"],
  "leave-requests": ["self", "reports", "org", "dept", "all"],
  goals: ["self", "reports", "org", "dept", "all"],
  reviews: ["self", "reports", "org", "dept", "all"],
  "review-feedback": ["self", "reports", "org", "dept", "all"],
  transitions: ["self", "reports", "org", "dept", "all"],
  "transition-tasks": ["self", "reports", "org", "dept", "all"],
  "check-ins": ["self", "reports", "org", "dept", "all"],
  dependents: ["self", "reports", "org", "dept", "all"],
  "benefit-enrollments": ["self", "reports", "org", "dept", "all"],
  "shift-assignments": ["self", "reports", "org", "dept", "all"],
  "work-pattern-assignments": ["self", "reports", "org", "dept", "all"],
  "time-entries": ["self", "reports", "org", "dept", "all"],
  loans: ["self", "reports", "org", "dept", "all"],
  "tax-declarations": ["self", "reports", "org", "dept", "all"],
  referrals: ["self", "reports", "org", "dept", "all"],
  "interview-feedback": ["self", "reports", "org", "dept", "all"],
  // Owner-coded under the SUBJECT of the check (services/backgroundChecks.ts allocOwnedCode), so `me` reaches the
  // employee's own verification record and `my-dept` a manager's reports. The tiers are the point of the code
  // change: the collection stays super/HR-only by default and the ACL can now author the narrow forms, instead of
  // org-wide access to everyone's background checks being the only grant on offer for a sensitive collection.
  "background-checks": ["self", "reports", "org", "dept", "all"],
  // FLAT-coded with an owner column (`assigned_to`), not owner-coded: custody moves over an asset's life and a
  // code is immutable, so an owned code would lie after the first hand-over. The item lane reaches these rows
  // through the OWNER KEY instead (domain/permissions.ts Resolved#ownerResource), which is what makes `me` mean
  // "the kit I am holding" and `my-dept` "my team's kit" - and what makes the tiers safe to offer at all.
  assets: ["self", "reports", "org", "dept", "all"],
  "leave-balances": ["self", "reports", "org", "dept", "all"],
  "leave-encashments": ["self", "reports", "org", "dept", "all"],
  // "self" for READING, like the day marks below: an adjustment explains your own balance, so an org may let
  // you see it. A self-WRITE rule would be a grant to move your own balance.
  "leave-adjustments": ["self", "reports", "org", "dept", "all"],
  "payroll-openings": ["self", "reports", "org", "dept", "all"],
  attendance: ["self", "reports", "org", "dept", "all"],
  "attendance-regularizations": ["self", "reports", "org", "dept", "all"],
  // "self" is here for READING: a mark decides what one of your days is worth, so you are owed the sight of
  // it on your own attendance. It is a scope tier, not a level - whether a self rule is read or write is the
  // policy's call, and a self-WRITE rule would be a grant to re-value your own attendance.
  "attendance-day-marks": ["self", "reports", "org", "dept", "all"],
  "overtime-requests": ["self", "reports", "org", "dept", "all"],
  "remote-work-requests": ["self", "reports", "org", "dept", "all"],
  "late-early-requests": ["self", "reports", "org", "dept", "all"],
  "asset-requests": ["self", "reports", "org", "dept", "all"],
  "notice-periods": ["self", "reports", "org", "dept", "all"],
  announcements: ["self", "reports", "org", "dept", "all"], // author-owned (giver for kudos); self = own posts/kudos
  suggestions: ["self", "reports", "org", "dept", "all"],
  "document-acknowledgements": ["self", "reports", "org", "dept", "all"],
  "personal-documents": ["self", "all"],
  payslips: ["self", "reports", "org", "dept", "all"],
  reimbursements: ["self", "reports", "org", "dept", "all"],
  compensation: ["self", "reports", "org", "dept", "all"],
  positions: ["self", "reports", "org", "dept", "all"],
  bonuses: ["self", "reports", "org", "dept", "all"],
  settlements: ["self", "reports", "org", "dept", "all"],
  operations: ["self", "all"], // employee-owned jobs
  tickets: ["self", "all"], // owner-coded; visibility beyond own is category-based, not a grant scope
  // Owner-coded under the author (services/tableViews.ts allocOwnedCode), so `me` reaches the grids somebody
  // saved. No dept tier: a saved grid is a personal artifact and sharing one is an object share on its code (the
  // ACL), not a breadth - which is the same reasoning tickets carries above.
  "table-views": ["self", "all"],
  // Company expenses are owner-coded under the employee who incurred them (services/expenses.ts
  // allocOwnedCode), so `me` / `my-dept` reach exactly the filer's own rows and a manager's team. The seed
  // already grants `expenses.me.**` and `expenses.my-dept.**`; these tiers are what let the ACL author the
  // same thing for any other role or person, instead of offering org-wide finance access as the only choice.
  expenses: ["self", "reports", "org", "dept", "all"],
  // Owner-coded under the DELEGATOR (services/approvalDelegations.ts allocCode), which is what the seed's
  // `approval-delegations.me.**` write reaches. No dept tier: covering for somebody is a personal
  // arrangement, and a dept-wide grant over other people's delegations has no reading that is not `all`.
  "approval-delegations": ["self", "all"],
  // A user ACCOUNT, not an employee record. `self` here means the caller's own account: matched by the literal
  // `me` token on `/v1/users/me` (the path the SPA uses), by the owner column on the list, and - since the item
  // lane gained the OWNER KEY (domain/permissions.ts Resolved#ownerResource) - by `employee_id` on an item read
  // addressed by id. Users carry a FLAT code, so before that key the three lanes of one rule disagreed.
  //
  // It does not become a way to edit your own role: `role` and `status` are PROTECTED_FIELDS, and the field gate
  // deliberately decides WITHOUT the owner key (middleware/authz.ts), so a self-scoped holder still needs an
  // explicit `users.*` grant to touch them.
  users: ["self", "all"],
  // Departments form the code hierarchy, so `subtree` (this dept + its sub-depts) is the meaningful narrowing.
  departments: ["subtree", "all"],
  // Per-entity activity trail gate (ANDed with the record read). Scope narrows WHICH records' activity you may
  // see: own / your dept / all. The target collection rides the field slot (`activity.<scope>.<collection>`),
  // authored in the ACL editor's per-collection picker — so activity is scopeable AND collection-filterable.
  activity: ["self", "reports", "org", "dept", "all"],
};

// State-gated visibility: a row that is NOT in its `public_when` state is visible only to callers who hold
// `requires` on the collection (the editors). See `StateRule` in src/domain/manifests.ts.
export const STATE_VISIBILITY: Record<string, StateRule> = {
  announcements: { requires: "write", public_when: { published: true, disabled: false } },
};

// Audit policy: which reads are SENSITIVE enough to record. The middleware audits every authz DENIAL (the
// abuse/enumeration signal) plus an allowed read that touches one of these - a sensitive PII sub-resource, a
// sensitive whole-item collection, or a sensitive custom verb (downloads). Ordinary reads are NOT audited
// (volume). meta records field keys, never values - the middleware never sees the values.
export const AUDIT: AuditPolicy = {
  // Field-bearing PII sub-resources whose read IS an accountability event: bank details (payout fraud),
  // statutory ids (PAN/Aadhaar/UAN), tax declarations. `personal-info` is deliberately NOT here: it is the
  // personal / contact / emergency cards on the profile's default tab, loaded on every open of a record the
  // caller can already read, so auditing it logs routine lookups by the hundred and buries the real signal. Its
  // per-field access control is unchanged (still read-redacted + write-gated); only the read row is dropped.
  sensitive_subresources: ["bank-account", "identity", "tax"],
  // Whole-item-sensitive collections: reading one row exposes salary / PII / medical, so an item GET is
  // audited (a `<col>.read.sensitive` row anchored on the record) even when the caller is allowed. Kept
  // deliberately narrow — a collection belongs here only if the ROW ITSELF carries money or personal data:
  // an org-level catalog (salary-structures = reusable component templates), a membership row (benefit-
  // enrollments = which plan), or a document's metadata (personal-documents = name/type/status; its BYTES
  // are audited via `personal-documents:download`) is not that, and auditing it is pure volume.
  sensitive_collections: ["compensation", "payslips", "settlements", "background-checks", "offers", "payroll-openings"],
  // Custom methods that stream sensitive bytes, keyed `<collection>:<verb>` — a bare verb name is ambiguous
  // (`payslips:download` is a person's pay, `org-documents:download` is the handbook everyone may read).
  // Only reads belong here. A write is already logged as a write (`personal-documents:generateForm16` files a
  // document), and these three reads are left silent on purpose: `payslips:previewTemplate` renders fabricated
  // sample figures, `payroll-runs:previewPayslip` re-renders numbers the run's review table already shows to
  // the same caller, `org-documents:download` / `expenses:download` are shared org content, not personal data.
  sensitive_verbs: [
    "employees:downloadIdentityDoc",
    "payslips:preview", "payslips:download",
    "payroll-runs:bankFile", "payroll-runs:statutoryReport", // bulk exports: every employee's account no. / statutory ids
    "personal-documents:download", "personal-documents:previewLetter", // previewLetter renders a NAMED employee's real letter (CTC)
    "candidates:download", "referrals:download", // an external person's resume
    "tax-declarations:download", // rent receipts / PAN / investment proofs
    // THE MEDICAL ONE, and it was the omission that stood out: `leave-requests:download` streams the
    // supporting document behind a request - the sick note the seeded grants describe in as many words
    // ("read the sick note behind a team member's request before deciding", bootstrap/authz/grants.ts). The
    // request's own one-line `reason` is already classified "routinely medical" in REDACTED_FIELDS, so the app
    // redacted the summary at field level and handed over the doctor's letter it summarises with no read row at
    // all.
    "leave-requests:download",
    // A ticket attachment is whatever a stranger uploaded (routes/tickets.ts says so beside the handler), and
    // `tickets.description` is redacted for exactly that reason - "a ticket raised about a person can carry
    // anything". Its bytes get the same accountability row its text already gets.
    "tickets:attachment",
    // Decided explicitly rather than left to whoever types next: a claim receipt is the same kind of personal
    // financial document as the rent receipts beside it in `tax-declarations:download`, and nothing but an
    // omission separated them.
    "reimbursements:download",
    // Renders a NAMED candidate's offer letter, salary included - the same content, and the same reason, as
    // `personal-documents:previewLetter` two lines up, and `offers` is already a sensitive_collection.
    "offers:letter",
  ],
};

// Seed lookups for the tests that pin the seeded manifest. The running app reads these through the stored
// manifest (`user.policy.references[...]`), never here.
export function referencesOf(collection: string): Record<string, RefField> {
  return REFERENCES[collection] ?? {};
}
export function protectedFieldsOf(collection: string): string[] {
  return PROTECTED_FIELDS[collection] ?? [];
}

// The whole manifest, as the `policy` row stores it.
export const DEFAULT_POLICY: Policy = { protected_fields: PROTECTED_FIELDS, references: REFERENCES, owner_refs: OWNER_REFS, state_visibility: STATE_VISIBILITY, audit: AUDIT, supported_scopes: SUPPORTED_SCOPES, redacted_fields: REDACTED_FIELDS };
