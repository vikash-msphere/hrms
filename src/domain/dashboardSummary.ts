// The collections the dashboard-summary endpoint may aggregate over. Kept in domain (no db imports) so the
// authz middleware can build per-collection list scopes for the request without importing the service. The
// service's registry MUST stay within this list - every aggregate is gated by its collection's list decision,
// exactly like a real GET /v1/<collection>.
export const DASHBOARD_SUMMARY_COLLECTIONS = [
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
