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
};

const scoped = (owner: string): SearchScoping => ({ kind: "scoped", owner });
const flat: SearchScoping = { kind: "flat" };

export const SEARCH_INDEX: SearchEntry[] = [
  // ---- People + org ---------------------------------------------------------------------------------------
  { collection: "employees", table: schema.employees, scoping: scoped("uuid"),
    match: ["firstName", "lastName", "legalName", "workEmail", "jobTitle", "employeeNumber"],
    title: ["firstName", "lastName"], joinTitle: true, subtitle: ["jobTitle", "workEmail"] },
  { collection: "departments", table: schema.departments, scoping: scoped("code"), match: ["name"], title: ["name"] },
  { collection: "positions", table: schema.positions, scoping: scoped("employeeId"),
    match: ["jobTitle", "location", "note"], title: ["jobTitle"], subtitle: ["location", "note"] },

  // ---- Leave + time ---------------------------------------------------------------------------------------
  { collection: "leave-requests", table: schema.leaveRequests, scoping: scoped("employeeId"),
    match: ["reason", "state"], title: ["reason"], subtitle: ["state"] },
  { collection: "leave-encashments", table: schema.leaveEncashments, scoping: scoped("employeeId"),
    match: ["state"], subtitle: ["state"] },
  { collection: "leave-types", table: schema.leaveTypes, scoping: flat, match: ["name"], title: ["name"] },
  { collection: "holidays", table: schema.holidays, scoping: flat, match: ["name", "kind"], title: ["name"], subtitle: ["kind"] },
  { collection: "attendance", table: schema.attendanceSessions, scoping: scoped("employeeId"),
    match: ["note", "source"], title: ["note"], subtitle: ["source"] },
  { collection: "attendance-regularizations", table: schema.attendanceRegularizations, scoping: scoped("employeeId"),
    match: ["reason", "state"], title: ["reason"], subtitle: ["state"] },
  { collection: "overtime-requests", table: schema.overtimeRequests, scoping: scoped("employeeId"),
    match: ["reason", "state", "decisionNote"], title: ["reason"], subtitle: ["state"] },
  { collection: "remote-work-requests", table: schema.remoteWorkRequests, scoping: scoped("employeeId"),
    match: ["location", "reason", "state"], title: ["reason", "location"], subtitle: ["location", "state"] },
  { collection: "approval-delegations", table: schema.approvalDelegations, scoping: scoped("delegatorId"),
    match: ["reason"], title: ["reason"] },
  { collection: "shifts", table: schema.shifts, scoping: flat, match: ["name"], title: ["name"] },
  { collection: "shift-assignments", table: schema.shiftAssignments, scoping: scoped("employeeId"), match: ["note"], title: ["note"] },
  { collection: "projects", table: schema.projects, scoping: flat,
    match: ["name", "client", "projectCode"], title: ["name"], subtitle: ["client", "projectCode"] },
  { collection: "time-entries", table: schema.timeEntries, scoping: scoped("employeeId"),
    match: ["description", "status"], title: ["description"], subtitle: ["status"] },

  // ---- Work: goals, boards, reviews ----------------------------------------------------------------------
  { collection: "goals", table: schema.goals, scoping: scoped("employeeId"),
    match: ["title", "description", "status"], title: ["title"], subtitle: ["status"] },
  { collection: "boards", table: schema.boards, scoping: flat,
    match: ["name", "description", "taskPrefix"], title: ["name"], subtitle: ["description"] },
  { collection: "sprints", table: schema.sprints, scoping: flat,
    match: ["name", "goal", "state"], title: ["name"], subtitle: ["goal", "state"] },
  { collection: "cards", table: schema.cards, scoping: scoped("employeeId"),
    match: ["title", "description", "keyPrefix", "columnKey", "priority"], title: ["title"], subtitle: ["columnKey"] },
  { collection: "review-cycles", table: schema.reviewCycles, scoping: flat, match: ["name", "state"], title: ["name"], subtitle: ["state"] },
  { collection: "reviews", table: schema.reviews, scoping: scoped("employeeId"),
    match: ["selfComment", "managerComment", "state"], title: ["selfComment", "managerComment"], subtitle: ["state"] },
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
    match: ["title", "fileName", "documentType"], title: ["title", "fileName"], subtitle: ["documentType"] },
  { collection: "personal-documents", table: schema.personalDocuments, scoping: scoped("employeeId"),
    match: ["title", "fileName", "documentType", "financialYear"], title: ["title", "fileName"], subtitle: ["documentType"] },
  { collection: "letter-templates", table: schema.letterTemplates, scoping: flat,
    match: ["label", "category", "filename"], title: ["label"], subtitle: ["category"] },
  { collection: "announcements", table: schema.announcements, scoping: flat,
    match: ["title", "bodyText", "category", "kind"], title: ["title"], subtitle: ["kind"] },
  { collection: "events", table: schema.events, scoping: scoped("code"),
    match: ["title", "description"], title: ["title"], subtitle: ["description"] },

  // ---- Money: pay, claims, expenses ------------------------------------------------------------------------
  { collection: "reimbursements", table: schema.reimbursements, scoping: scoped("employeeId"),
    match: ["description", "state"], title: ["description"], subtitle: ["state"] },
  { collection: "reimbursement-categories", table: schema.reimbursementCategories, scoping: flat, match: ["name"], title: ["name"] },
  { collection: "expenses", table: schema.expenses, scoping: scoped("employeeId"),
    match: ["description", "invoiceNumber", "paymentRef", "state"], title: ["description", "invoiceNumber"], subtitle: ["state"] },
  { collection: "expense-categories", table: schema.expenseCategories, scoping: flat, match: ["name", "glCode"], title: ["name"], subtitle: ["glCode"] },
  { collection: "expense-budgets", table: schema.expenseBudgets, scoping: flat, match: ["periodKey", "periodType"], title: ["periodKey"], subtitle: ["periodType"] },
  { collection: "vendors", table: schema.vendors, scoping: flat,
    match: ["name", "contactEmail", "taxId", "notes"], title: ["name"], subtitle: ["contactEmail"] },
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
    match: ["name", "category", "description", "provider"], title: ["name"], subtitle: ["provider", "category"] },
  { collection: "dependents", table: schema.dependents, scoping: scoped("employeeId"),
    match: ["name", "relationship"], title: ["name"], subtitle: ["relationship"] },
  { collection: "benefit-enrollments", table: schema.benefitEnrollments, scoping: scoped("employeeId"),
    match: ["status"], subtitle: ["status"] },

  // ---- Recruiting ---------------------------------------------------------------------------------------------
  { collection: "job-requisitions", table: schema.jobRequisitions, scoping: scoped("code"),
    match: ["title", "description", "location", "employmentType", "status"], title: ["title"], subtitle: ["location", "status"] },
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
  { collection: "ticket-checklists", table: schema.ticketChecklists, scoping: flat, match: ["name"], title: ["name"] },
  { collection: "suggestions", table: schema.suggestions, scoping: scoped("submitterId"),
    match: ["title", "body", "category", "response", "status"], title: ["title"], subtitle: ["category", "status"] },
  { collection: "assets", table: schema.assets, scoping: scoped("assignedTo"),
    match: ["name", "assetTag", "serialNumber", "category", "notes", "status"], title: ["name"], subtitle: ["assetTag", "status"] },
  { collection: "notifications", table: schema.notifications, scoping: { kind: "self", owner: "recipientId" },
    match: ["title", "body", "type"], title: ["title"], subtitle: ["body"] },

  // ---- Admin ----------------------------------------------------------------------------------------------------
  { collection: "automations", table: schema.automations, scoping: flat,
    match: ["name", "description", "triggerType"], title: ["name"], subtitle: ["description"] },
];

export const SEARCHABLE_COLLECTIONS = SEARCH_INDEX.map((e) => e.collection);
