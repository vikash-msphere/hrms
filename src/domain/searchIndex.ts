// What global search (`GET /v1/search`) looks at, as DATA. One entry per collection: the table, how its list
// is scoped, which columns are matched, and which columns render the hit. No access decision lives here - the
// service pairs each entry with the caller's own `decide()` + `scopeFor()` verdict for that collection.
//
// `scoping` MIRRORS the collection's real list service, so a search hit is exactly a row the caller's list of
// that collection would have returned:
//   - "scoped" -> the service binds applyScope(scope, code, <owner>); `owner` is that same owner column.
//   - "flat"   -> an org-wide catalog whose list binds no scope (holidays, leave types, boards, ...): once the
//                 collection read grant passes, every row is listable, so search matches every row too.
//   - "self"   -> the service hard-pins the row to the caller regardless of grant (notifications).
// Getting `scoping` wrong is the one way this file can leak, so it is checked against the services by
// test/searchIndex.test.ts.
//
// Columns are named as Drizzle property names and resolved off the table at query time; the same test asserts
// every name exists, so a schema rename fails the suite instead of silently dropping a collection from search.
import * as schema from "../db/schema";

export type SearchScoping =
  | { kind: "scoped"; owner: string } // applyScope(scope, code, table[owner])
  | { kind: "flat" } // org-wide catalog: no row filter beyond the collection read grant
  | { kind: "self"; owner: string }; // always pinned to the caller's employee id

export type SearchEntry = {
  collection: string; // wire collection = the authz namespace decided against
  table: any;
  scoping: SearchScoping;
  match: string[]; // columns the query string is matched against (LIKE %q%)
  title?: string[]; // first non-empty renders the hit's title; joined with a space when `joinTitle`
  joinTitle?: boolean; // employees: "first last" rather than "first non-empty of"
  subtitle?: string[]; // first non-empty renders the muted second line
  // The semantic index only (services/searchEmbed.ts `embedText`); the keyword index ignores both.
  //   - `noun` says what the row IS, so "laptop" lands on `Asset: MacBook Pro` and not on whatever other
  //     two-word title happens to sit nearby. A bare title carries no kind at all.
  //   - `embedSubtitle: false` where the subtitle is only a status word (`fixed`, `kudos`). In a vector built
  //     from a handful of words, a status is a large share of the meaning, and it is the same few words across
  //     many rows, so it pulls them all toward each other and away from the query.
  // Set on every collection in domain/aiPolicy.ts INDEXABLE EXCEPT `TEXT_PINNED`, which test/searchIndex.test.ts
  // holds.
  noun?: string;
  embedSubtitle?: false;
};

const scoped = (owner: string): SearchScoping => ({ kind: "scoped", owner });
const flat: SearchScoping = { kind: "flat" };

export const SEARCH_INDEX: SearchEntry[] = [
  // ---- People + org ---------------------------------------------------------------------------------------
  // NOT `legalName`. It is a redacted field (bootstrap/authz/policy.ts REDACTED_FIELDS): someone's legal name can
  // differ from the one they go by, and saying so is theirs to do. Matching on it would let anybody who reads
  // the directory confirm a guess - "whose legal name is X?" - through search, although the field itself is never
  // shown to them. Migration 0014 dropped it from the live index and re-indexed the rows already in it.
  { collection: "employees", table: schema.employees, scoping: scoped("uuid"),
    match: ["firstName", "lastName", "workEmail", "jobTitle", "employeeNumber"],
    title: ["firstName", "lastName"], joinTitle: true, subtitle: ["jobTitle", "workEmail"], noun: "Person" },
  { collection: "departments", table: schema.departments, scoping: scoped("code"), match: ["name"], title: ["name"], noun: "Department" },
  { collection: "positions", table: schema.positions, scoping: scoped("employeeId"),
    match: ["jobTitle", "location", "note"], title: ["jobTitle"], subtitle: ["location", "note"] },

  // ---- Leave + time ---------------------------------------------------------------------------------------
  { collection: "leave-requests", table: schema.leaveRequests, scoping: scoped("employeeId"),
    match: ["reason", "state"], title: ["reason"], subtitle: ["state"] },
  { collection: "leave-encashments", table: schema.leaveEncashments, scoping: scoped("employeeId"),
    match: ["state"], subtitle: ["state"] },
  { collection: "leave-types", table: schema.leaveTypes, scoping: flat, match: ["name"], title: ["name"], noun: "Leave type" },
  { collection: "holidays", table: schema.holidays, scoping: flat, match: ["name", "kind"], title: ["name"], subtitle: ["kind"],
    noun: "Holiday", embedSubtitle: false },
  { collection: "attendance", table: schema.attendanceSessions, scoping: scoped("employeeId"),
    match: ["note", "source"], title: ["note"], subtitle: ["source"] },
  { collection: "attendance-regularizations", table: schema.attendanceRegularizations, scoping: scoped("employeeId"),
    match: ["reason", "state"], title: ["reason"], subtitle: ["state"] },
  { collection: "overtime-requests", table: schema.overtimeRequests, scoping: scoped("employeeId"),
    match: ["reason", "state", "decisionNote"], title: ["reason"], subtitle: ["state"] },
  { collection: "remote-work-requests", table: schema.remoteWorkRequests, scoping: scoped("employeeId"),
    match: ["location", "reason", "state"], title: ["reason", "location"], subtitle: ["location", "state"] },
  { collection: "asset-requests", table: schema.assetRequests, scoping: scoped("employeeId"),
    match: ["justification", "state"], title: ["justification"], subtitle: ["state"] },
  { collection: "approval-delegations", table: schema.approvalDelegations, scoping: scoped("delegatorId"),
    match: ["reason"], title: ["reason"] },
  { collection: "shifts", table: schema.shifts, scoping: flat, match: ["name"], title: ["name"], noun: "Shift" },
  { collection: "shift-assignments", table: schema.shiftAssignments, scoping: scoped("employeeId"), match: ["note"], title: ["note"] },
  { collection: "work-patterns", table: schema.workPatterns, scoping: flat, match: ["name"], title: ["name"], noun: "Schedule" },
  { collection: "work-pattern-assignments", table: schema.workPatternAssignments, scoping: scoped("employeeId"), match: ["note"], title: ["note"] },
  { collection: "projects", table: schema.projects, scoping: flat,
    match: ["name", "client", "projectCode"], title: ["name"], subtitle: ["client", "projectCode"], noun: "Project" },
  { collection: "time-entries", table: schema.timeEntries, scoping: scoped("employeeId"),
    match: ["description", "status"], title: ["description"], subtitle: ["status"] },

  // ---- Work: goals, boards, reviews ----------------------------------------------------------------------
  { collection: "goals", table: schema.goals, scoping: scoped("employeeId"),
    match: ["title", "description", "status"], title: ["title"], subtitle: ["status"] },
  { collection: "boards", table: schema.boards, scoping: flat,
    match: ["name", "description", "taskPrefix"], title: ["name"], subtitle: ["description"], noun: "Board" },
  { collection: "sprints", table: schema.sprints, scoping: flat,
    match: ["name", "goal", "state"], title: ["name"], subtitle: ["goal", "state"], noun: "Sprint" },
  { collection: "cards", table: schema.cards, scoping: scoped("employeeId"),
    match: ["title", "description", "keyPrefix", "columnKey", "priority"], title: ["title"], subtitle: ["columnKey"] },
  { collection: "review-cycles", table: schema.reviewCycles, scoping: flat, match: ["name", "state"], title: ["name"], subtitle: ["state"] },
  // `managerComment` IS DELIBERATELY NOT INDEXED, and neither may the rest of the manager's assessment be.
  //
  // http/serialize.ts withholds it from the owner-employee until the review is SHARED (`_managerVisible`,
  // set by routes/reviews.ts), and the employee grant says so in its own comment. Indexing it went around
  // that gate completely: search never passes through a serializer - it reads `search_docs.title`, written by
  // a trigger - so the reviewee could match on their manager's unshared words, and because `title` is
  // "first non-empty" a review with no self-assessment yet rendered the manager's comment VERBATIM as the
  // ⌘K hit. `state_visibility` could not have saved it either: that gate is row-level and applies to every
  // item method, so marking an unshared review restricted would also block the employee's own read and their
  // `:submitSelf`. The field simply does not belong in an index.
  //
  // The self-assessment stays: it is the employee's own words, and it is served to them and to editors
  // unconditionally. `state` keeps a review findable when no self-assessment has been written yet.
  { collection: "reviews", table: schema.reviews, scoping: scoped("employeeId"),
    match: ["selfComment", "state"], title: ["selfComment"], subtitle: ["state"] },
  { collection: "review-feedback", table: schema.reviewFeedback, scoping: scoped("authorId"),
    match: ["comment", "state"], title: ["comment"], subtitle: ["state"] },
  { collection: "check-ins", table: schema.checkIns, scoping: scoped("employeeId"), match: ["notes"], title: ["notes"] },

  // ---- Lifecycle: onboarding / offboarding / compliance ---------------------------------------------------
  { collection: "transitions", table: schema.transitions, scoping: scoped("employeeId"),
    match: ["name", "kind", "state"], title: ["name"], subtitle: ["kind", "state"] },
  { collection: "transition-tasks", table: schema.transitionTasks, scoping: scoped("assigneeId"),
    match: ["title", "description", "note", "status"], title: ["title"], subtitle: ["status"] },
  { collection: "notice-periods", table: schema.noticePeriods, scoping: scoped("employeeId"),
    match: ["type", "reason", "notes", "status"], title: ["reason", "type"], subtitle: ["status"] },
  { collection: "background-checks", table: schema.backgroundChecks, scoping: scoped("employeeId"),
    match: ["checkType", "vendor", "referenceNo", "notes", "status"], title: ["checkType"], subtitle: ["vendor", "status"] },
  { collection: "compliance-events", table: schema.complianceEvents, scoping: scoped("code"),
    match: ["title", "category", "periodLabel", "reference", "notes", "status"], title: ["title"], subtitle: ["category", "periodLabel"] },
  { collection: "compliance-rules", table: schema.complianceRules, scoping: flat,
    match: ["title", "category", "notes"], title: ["title"], subtitle: ["category"] },

  // ---- Documents + announcements --------------------------------------------------------------------------
  { collection: "org-documents", table: schema.orgDocuments, scoping: scoped("code"),
    match: ["title", "fileName", "documentType"], title: ["title", "fileName"], subtitle: ["documentType"], noun: "Company document" },
  { collection: "personal-documents", table: schema.personalDocuments, scoping: scoped("employeeId"),
    match: ["title", "fileName", "documentType", "financialYear"], title: ["title", "fileName"], subtitle: ["documentType"] },
  { collection: "letter-templates", table: schema.letterTemplates, scoping: flat,
    match: ["label", "category", "filename"], title: ["label"], subtitle: ["category"], noun: "Letter template" },
  // SCOPED BY AUTHOR, matching `services/announcements.ts#visibleWhere`, which binds the author column. Held
  // as `flat` this was the one entry that disagreed with its own list service: an `own`-breadth caller's board
  // shows only the posts they wrote, while search applied no row filter at all - so ⌘K would return the title
  // and subtitle of every post in the org to somebody whose board shows none of them. Inert on the seeded
  // policy (every role holds `announcements.**`, so both sides answer "all"), and live the moment an admin
  // narrows announcements through the ACL, which is the entire purpose of the ACL.
  { collection: "announcements", table: schema.announcements, scoping: scoped("authorEmployeeId"),
    match: ["title", "bodyText", "category", "kind"], title: ["title"], subtitle: ["kind"], noun: "Announcement", embedSubtitle: false },
  { collection: "events", table: schema.events, scoping: scoped("code"),
    match: ["title", "description"], title: ["title"], subtitle: ["description"], noun: "Event" },

  // ---- Money: pay, claims, expenses ------------------------------------------------------------------------
  { collection: "reimbursements", table: schema.reimbursements, scoping: scoped("employeeId"),
    match: ["description", "state"], title: ["description"], subtitle: ["state"] },
  { collection: "reimbursement-categories", table: schema.reimbursementCategories, scoping: flat, match: ["name"], title: ["name"],
    noun: "Reimbursement category" },
  { collection: "expenses", table: schema.expenses, scoping: scoped("employeeId"),
    match: ["description", "invoiceNumber", "paymentRef", "state"], title: ["description", "invoiceNumber"], subtitle: ["state"] },
  { collection: "expense-categories", table: schema.expenseCategories, scoping: flat, match: ["name", "glCode"], title: ["name"], subtitle: ["glCode"],
    noun: "Expense category" },
  { collection: "expense-budgets", table: schema.expenseBudgets, scoping: flat, match: ["periodKey", "periodType"], title: ["periodKey"], subtitle: ["periodType"] },
  { collection: "payroll-budgets", table: schema.payrollBudgets, scoping: flat, match: ["periodKey", "periodType"], title: ["periodKey"], subtitle: ["periodType"] },
  { collection: "vendors", table: schema.vendors, scoping: flat,
    match: ["name", "contactEmail", "taxId", "notes"], title: ["name"], subtitle: ["contactEmail"], noun: "Vendor" },
  { collection: "loans", table: schema.loans, scoping: scoped("employeeId"),
    match: ["kind", "reason", "status"], title: ["reason", "kind"], subtitle: ["status"] },
  { collection: "bonuses", table: schema.bonuses, scoping: scoped("employeeId"),
    match: ["kind", "reason"], title: ["reason", "kind"], subtitle: ["kind"] },
  { collection: "tax-declarations", table: schema.taxDeclarations, scoping: scoped("employeeId"),
    match: ["label", "section", "note", "financialYear"], title: ["label"], subtitle: ["section", "financialYear"] },
  { collection: "pay-components", table: schema.payComponents, scoping: flat,
    match: ["name", "kind", "method"], title: ["name"], subtitle: ["kind"] },
  { collection: "pay-grades", table: schema.payGrades, scoping: flat,
    match: ["name", "level", "description"], title: ["name"], subtitle: ["level"] },
  { collection: "salary-structures", table: schema.salaryStructures, scoping: flat,
    match: ["name", "description"], title: ["name"], subtitle: ["description"] },
  { collection: "pay-periods", table: schema.payPeriods, scoping: flat, match: ["label"], title: ["label"] },

  // ---- Benefits ---------------------------------------------------------------------------------------------
  { collection: "benefit-plans", table: schema.benefitPlans, scoping: flat,
    match: ["name", "category", "description", "provider"], title: ["name"], subtitle: ["provider", "category"], noun: "Benefit plan" },
  { collection: "dependents", table: schema.dependents, scoping: scoped("employeeId"),
    match: ["name", "relationship"], title: ["name"], subtitle: ["relationship"] },
  { collection: "benefit-enrollments", table: schema.benefitEnrollments, scoping: scoped("employeeId"),
    match: ["status"], subtitle: ["status"] },

  // ---- Recruiting ---------------------------------------------------------------------------------------------
  { collection: "job-requisitions", table: schema.jobRequisitions, scoping: scoped("code"),
    match: ["title", "description", "location", "employmentType", "status"], title: ["title"], subtitle: ["location", "status"],
    noun: "Job opening" },
  { collection: "candidates", table: schema.candidates, scoping: scoped("code"),
    match: ["name", "email", "phone", "source", "tags", "notes"], title: ["name"], subtitle: ["email", "source"] },
  { collection: "applications", table: schema.applications, scoping: scoped("code"),
    match: ["stage", "status", "rejectionReason", "source"], title: ["stage"], subtitle: ["status"] },
  { collection: "interviews", table: schema.interviews, scoping: scoped("code"),
    match: ["title", "mode", "location", "status"], title: ["title"], subtitle: ["mode", "status"] },
  { collection: "interview-feedback", table: schema.interviewFeedback, scoping: scoped("authorId"),
    match: ["comment", "recommendation"], title: ["comment"], subtitle: ["recommendation"] },
  { collection: "offers", table: schema.offers, scoping: scoped("code"),
    match: ["status", "notes"], title: ["notes"], subtitle: ["status"] },
  { collection: "referrals", table: schema.referrals, scoping: scoped("referrerId"),
    match: ["candidateName", "candidateEmail", "positionTitle", "notes", "status"], title: ["candidateName"], subtitle: ["positionTitle", "status"] },

  // ---- Support + engagement ------------------------------------------------------------------------------------
  { collection: "tickets", table: schema.tickets, scoping: scoped("employeeId"),
    match: ["subject", "description", "category", "state", "priority"], title: ["subject"], subtitle: ["category", "state"] },
  { collection: "ticket-checklists", table: schema.ticketChecklists, scoping: flat, match: ["name"], title: ["name"], noun: "Ticket checklist" },
  { collection: "suggestions", table: schema.suggestions, scoping: scoped("submitterId"),
    match: ["title", "body", "category", "response", "status"], title: ["title"], subtitle: ["category", "status"] },
  { collection: "assets", table: schema.assets, scoping: scoped("assignedTo"),
    match: ["name", "assetTag", "serialNumber", "notes", "status"], title: ["name"], subtitle: ["assetTag", "status"], noun: "Asset" },
  { collection: "asset-categories", table: schema.assetCategories, scoping: flat, match: ["name", "tagCode"], title: ["name"], subtitle: ["tagCode"],
    noun: "Asset category" },
  // Inventory counts: "Q3 count" is a thing people go looking for months later, and the label is the only
  // handle they remember.
  { collection: "stocktakes", table: schema.stocktakes, scoping: flat, match: ["label", "notes", "status"], title: ["label"], subtitle: ["status"] },
  { collection: "notifications", table: schema.notifications, scoping: { kind: "self", owner: "recipientId" },
    match: ["title", "body", "type"], title: ["title"], subtitle: ["body"] },

  // ---- Admin ----------------------------------------------------------------------------------------------------
  { collection: "automations", table: schema.automations, scoping: flat,
    match: ["name", "description", "triggerType"], title: ["name"], subtitle: ["description"] },
  // A saved grid is a thing people go back to by NAME ("the salary sheet"), months later, from anywhere.
  { collection: "table-views", table: schema.tableViews, scoping: scoped("ownerId"),
    match: ["name", "description", "base"], title: ["name"], subtitle: ["description", "base"] },
];

export const SEARCHABLE_COLLECTIONS = SEARCH_INDEX.map((e) => e.collection);

/** The entry's state/status property, which `status:` narrows by. Every entry that has one lists it among its
 *  `match` columns, so it is found there rather than declared twice. */
export const statusPropOf = (entry: SearchEntry): string | undefined => entry.match.find((p) => p === "state" || p === "status");

/**
 * What ⌘K can suggest after `in:` and `status:`: each searchable collection in `listable`, with the values its
 * state/status column can hold, lower-cased the way `status:` compares them. Read off the schema's enums, so it
 * costs no database read and cannot drift from what the column accepts. A collection whose status column is
 * free text, or that has none, answers no statuses.
 *
 * `reference` marks the kinds that are not somebody's records: the org-wide catalogs (`flat` - leave types,
 * holidays, automations, ...) and the caller's own inbox (`self` - notifications). They are large and rarely what
 * a search is narrowed to, so the palette offers them after the record kinds (paletteQuery.ts rankKindOffers).
 */
export function searchVocabulary(listable: ReadonlySet<string>): { collection: string; statuses: string[]; reference?: true }[] {
  return SEARCH_INDEX.filter((e) => listable.has(e.collection)).map((e) => ({
    collection: e.collection,
    statuses: statusValuesOf(e),
    ...(e.scoping.kind === "scoped" ? {} : { reference: true as const }),
  }));
}

/** The values the entry's status column can hold, lower-cased; empty when it has none or it is free text. */
export function statusValuesOf(entry: SearchEntry): string[] {
  const prop = statusPropOf(entry);
  const values = prop ? ((entry.table as Record<string, { enumValues?: readonly string[] }>)[prop]?.enumValues ?? []) : [];
  return [...new Set(values.map((v) => v.toLowerCase()))];
}

/**
 * Indexable collections whose embed text must stay `<title> - <subtitle>`, with no `noun` and every subtitle.
 *
 * Their stored vectors are compared to EACH OTHER, not only to a query: ticket triage, card triage and the
 * duplicate sweep, goal similarity and suggestion similarity all fetch a record's own vector and ask the index
 * for its neighbours, against cosine thresholds (0.78-0.88) tuned on exactly this text. A shared prefix like
 * `Helpdesk ticket: ` on both sides of every pair raises every pair's similarity, so the thresholds would start
 * calling unrelated work a duplicate. Search measured no worse without it on these four (2026-09-26,
 * scripts/searchBench.ts), so they keep the text the thresholds were set on.
 */
export const TEXT_PINNED: ReadonlySet<string> = new Set(["tickets", "cards", "goals", "suggestions"]);
