import { idOf } from "./utils";

// Collections whose page deep-opens a SPECIFIC record via the hash route `#/<page>/<id>` (the page reads the
// id and opens that record). Only these truly "open the resource"; everything else lands on the list page.
const DEEP_OPEN: Record<string, string> = {
  employees: "employees", // EmployeeProfile
  candidates: "candidates", // CandidateProfile
  // Pages that open the record's dialog from a route id (via useDeepOpen). Value = the nav page key.
  goals: "goals", assets: "assets", tickets: "tickets",
  offers: "offers", "job-requisitions": "job-requisitions", interviews: "interviews",
  referrals: "referrals", suggestions: "suggestions",
  "compliance-events": "compliance", "background-checks": "background-checks",
  "notice-periods": "notice-periods", announcements: "announcements", events: "events",
  "tax-declarations": "tax-declarations", holidays: "holidays",
  cards: "boards", // a kanban card → the Boards page selects its board + opens the task dialog
};

// Collection -> the nav page that shows it (record not auto-opened). Covers the navigable collections; the
// caller falls back (e.g. to the in-place activity drill) when a collection is absent here.
const PAGE_OF: Record<string, string> = {
  departments: "departments", positions: "employees",
  "leave-requests": "leave-requests", "leave-encashments": "leave-requests",
  reimbursements: "reimbursements",
  expenses: "expenses", vendors: "vendors", "expense-budgets": "expense-budgets",
  "approval-delegations": "delegations", "review-cycles": "reviews", "interview-feedback": "interviews",
  "pay-periods": "pay-periods", bonuses: "payroll-runs", notifications: "notifications",
  "overtime-requests": "overtime",
  "remote-work-requests": "remote-work",
  "attendance-regularizations": "attendance", attendance: "attendance",
  loans: "loans", "time-entries": "timesheets", projects: "timesheets",
  "tax-declarations": "tax-declarations",
  goals: "goals", boards: "boards", cards: "boards", sprints: "boards",
  reviews: "reviews", "review-feedback": "reviews", "check-ins": "check-ins",
  announcements: "announcements", suggestions: "suggestions", events: "events",
  assets: "assets", tickets: "tickets",
  "compliance-events": "compliance", "compliance-rules": "compliance",
  "background-checks": "background-checks",
  transitions: "transitions", "transition-tasks": "transitions", "notice-periods": "notice-periods",
  "job-requisitions": "job-requisitions", offers: "offers", interviews: "interviews",
  applications: "pipeline", referrals: "referrals",
  "benefit-plans": "benefits", "benefit-enrollments": "benefits", dependents: "benefits",
  "payroll-runs": "payroll-runs", payslips: "payslips",
  "shift-assignments": "schedule", shifts: "schedule",
  "org-documents": "documents", "personal-documents": "documents",
  holidays: "holidays", automations: "workflows",
};

// Admin catalogs live inside Settings panels; a record deep-links to `#/settings/<panel>/<id>` (3rd route
// segment), where the panel opens its editor for that row. Value = the Settings panel key.
const SETTINGS_PANEL: Record<string, string> = {
  "leave-types": "leave-types", shifts: "shifts",
  "pay-components": "pay-components", "pay-grades": "pay-grades", "salary-structures": "salary-structures",
  projects: "projects", "benefit-plans": "benefit-plans", "reimbursement-categories": "reimbursements",
  "letter-templates": "letters", "expense-categories": "expenses", "ticket-checklists": "ticket-checklists",
};

// The hash route to reach a record from the activity feed / approvals inbox: the record inside its Settings
// panel, else a deep record page, else the collection's list page, else null (no destination).
export function resourceRoute(collection: string, ref?: string): string | null {
  if (ref && collection in SETTINGS_PANEL) return `settings/${SETTINGS_PANEL[collection]}/${idOf(ref)}`;
  if (ref && collection in DEEP_OPEN) return `${DEEP_OPEN[collection]}/${idOf(ref)}`;
  if (PAGE_OF[collection]) return PAGE_OF[collection];
  if (collection in SETTINGS_PANEL) return `settings/${SETTINGS_PANEL[collection]}`;
  return null;
}

// Whether clicking navigates to the exact record (vs. just the list page) — for tooltip wording.
export function opensExactRecord(collection: string): boolean {
  return collection in DEEP_OPEN;
}

// The nav page key a collection lives on (no record id), or null when it only lives inside a Settings panel.
// Lets a caller borrow that page's nav icon instead of maintaining a second collection→icon table.
export function pageKeyForCollection(collection: string): string | null {
  return PAGE_OF[collection] ?? DEEP_OPEN[collection] ?? null;
}

// The Settings panel key that manages a collection, or null. Same purpose: reuse the panel's registered icon.
export function settingsPanelForCollection(collection: string): string | null {
  return SETTINGS_PANEL[collection] ?? null;
}
