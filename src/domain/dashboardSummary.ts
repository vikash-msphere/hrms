// The collections the dashboard-summary endpoint may aggregate over. Kept in domain (no db imports) so the
// authz middleware can build per-collection list scopes for the request without importing the service. The
// service's registry MUST stay within this list - every aggregate is gated by its collection's list decision,
// exactly like a real GET /v1/<collection>.
export const DASHBOARD_SUMMARY_COLLECTIONS = [
  "employees",
  "leave-requests",
  "tickets",
  "expenses",
  "compliance-events",
  "assets",
  "goals",
  "loans",
  "applications",
  "interviews",
  "referrals",
  "reviews",
  "tax-declarations",
  "background-checks",
  "suggestions",
  "benefit-enrollments",
  "cards",
  "notice-periods",
  "remote-work-requests",
  "time-entries",
  "review-cycles",
  "offers",
  "transitions",
  "job-requisitions",
] as const;

export type DashboardSummaryCollection = (typeof DASHBOARD_SUMMARY_COLLECTIONS)[number];

// Each KPI key the endpoint answers, and the collection whose LIST decision gates it. The service's `def`
// calls are typed against this map, so a key filed under a different collection there does not compile. The
// SPA reads it too: when the summary request fails, a card falls back to fetching rows, and it may only do
// that for a collection the caller can read - a failed summary is not a licence to try every list.
export const DASHBOARD_SUMMARY_KPIS = {
  headcount: "employees",
  joiners: "employees",
  probation_ending: "employees",
  on_leave: "leave-requests",
  open_tickets: "tickets",
  expenses_pending: "expenses",
  recurring_expenses_due: "expenses",
  compliance_due: "compliance-events",
  compliance_week: "compliance-events",
  compliance_overdue: "compliance-events",
  assets_assigned: "assets",
  assets_pending_scan: "assets",
  goals_active: "goals",
  loans_outstanding: "loans",
  candidates_pipeline: "applications",
  interviews_upcoming: "interviews",
  referrals_open: "referrals",
  reviews_open: "reviews",
  tax_verify: "tax-declarations",
  bgchecks_open: "background-checks",
  suggestions_open: "suggestions",
  benefits_enrolled: "benefit-enrollments",
  cards_blocked: "cards",
  cards_overdue: "cards",
  cards_due_week: "cards",
  my_open_cards: "cards",
  notice_serving: "notice-periods",
  remote_today: "remote-work-requests",
  timesheets_draft: "time-entries",
  timesheet_week: "time-entries",
  team_hours_week: "time-entries",
  reviews_due_soon: "review-cycles",
  offers_pending: "offers",
  transitions_active: "transitions",
  onboarding_tasks_pending: "transitions",
  open_positions: "job-requisitions",
} as const satisfies Record<string, DashboardSummaryCollection>;

export type DashboardSummaryKey = keyof typeof DASHBOARD_SUMMARY_KPIS;
