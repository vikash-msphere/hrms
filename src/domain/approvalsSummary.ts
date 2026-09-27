// The queues the approvals badge counts. Kept in domain (no db imports) so the authz middleware can resolve
// each collection's APPROVE scope for the request without importing the service, exactly as
// DASHBOARD_SUMMARY_COLLECTIONS does for the KPI aggregates. The service's own registry must stay within this
// list - every count is gated by its collection's approve decision, the same one a real
// `POST /v1/<collection>/<id>:approve` would get.
//
// `awaiting` is the state value that means "waiting for a decision" in that collection's own vocabulary: most
// call it PENDING on `state`, timesheets call it SUBMITTED on `status`, and expenses split DRAFT (not yet
// submitted) from SUBMITTED. The service binds it; naming it here keeps the queue definition in one place.
export const APPROVAL_QUEUES = [
  { collection: "leave-requests", awaiting: "PENDING" },
  { collection: "reimbursements", awaiting: "PENDING" },
  { collection: "overtime-requests", awaiting: "PENDING" },
  { collection: "remote-work-requests", awaiting: "PENDING" },
  { collection: "late-early-requests", awaiting: "PENDING" },
  { collection: "attendance-regularizations", awaiting: "PENDING" },
  { collection: "leave-encashments", awaiting: "PENDING" },
  { collection: "loans", awaiting: "PENDING" },
  { collection: "time-entries", awaiting: "SUBMITTED" },
  { collection: "expenses", awaiting: "SUBMITTED" },
  { collection: "asset-requests", awaiting: "PENDING" },
] as const;

export const APPROVAL_SUMMARY_COLLECTIONS = APPROVAL_QUEUES.map((q) => q.collection);

// The prior-employer tax declarations awaiting verification ride the same envelope: they are a queue in the
// same inbox and the same badge, but not a collection - the figures live in each employee's encrypted tax
// blob, with the awaiting state mirrored onto `employees.tax_verification_status` so the badge can COUNT them
// without decrypting anything. Gated by `tax-verifications.read` - the same gate its rows endpoint gets.
export const TAX_VERIFICATION_QUEUE = "tax-verifications";
