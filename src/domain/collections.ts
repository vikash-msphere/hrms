// The authoritative set of collection names that may appear as the first token of a grant pattern. The
// grant validator rejects any pattern naming a collection not in here, so a typo or a stale collection can
// never compile into authority. `**` (the super cross-collection pattern) is allowed separately - it is not
// a collection. Held against the ROUTE MOUNTS by test/collections.test.ts (drift gate), so a mounted
// collection cannot be missing from here and be silently unnameable.
export const COLLECTIONS: ReadonlySet<string> = new Set([
  // code-bearing resources (mirror authzResolve TABLES) + the config collections
  "letter-templates",
  // the stationery documents are ISSUED on (one per legal entity/brand), page design and all, distinct from
  // the app's own branding logo
  "letterheads",
  // machine credentials (super-only by default): an API key acts as its owner, narrowed by its scope
  "api-keys",
  "employees", "departments", "leave-requests", "leave-types", "leave-balances", "holidays",
  "holiday-selections", "org-documents", "personal-documents", "announcements", "pay-components", "pay-grades", "salary-structures",
  "pay-periods", "payroll-runs", "payslips", "operations", "users", "compensation", "positions", "bonuses", "assets", "asset-categories", "asset-requests", "stocktakes", "settlements", "goal-templates",
  "leave-encashments", "reimbursements", "reimbursement-categories",
  // operational/company expenses: employee-owned expense (submitter-scoped) + flat vendor/category masters + finance budgets
  "expenses", "expense-categories", "vendors", "expense-budgets",
  "attendance", "attendance-regularizations", "overtime-requests", "remote-work-requests", "approval-delegations", "notice-periods", "suggestions", "notifications",
  // compliance: per-employee acknowledgement (e-signature) of an org-document version; employee-owned, private-by-default
  "document-acknowledgements",
  // statutory compliance calendar (PF/ESI/TDS/GST/PT/returns); flat company-wide, HR-managed
  "compliance-events", "compliance-rules",
  // background-verification tracking; flat company-wide, HR-managed (sensitive)
  "background-checks",
  // performance goals; employee-owned + code-scoped (self write, manager dept-write, HR read)
  "goals",
  // agile kanban: team/HR-managed boards (flat) + employee-owned cards (code-scoped own/dept/all) + scrum sprints (flat)
  "boards", "cards", "sprints",
  // performance reviews: HR-managed cycles (flat) + per-employee reviews (employee-owned, code-scoped)
  "review-cycles", "reviews",
  // 360 peer feedback on a review; owned by the nominated author (code-scoped)
  "review-feedback",
  // onboarding/offboarding: subject-owned transitions + tasks (subject completes own; HR drives all)
  "transitions", "transition-tasks",
  // 1:1 check-ins between a report and their manager; report-owned (pair-private - no HR grant)
  "check-ins",
  // benefits: HR-authored plan catalog + employee-owned dependents & enrollments
  "benefit-plans", "dependents", "benefit-enrollments",
  // shift scheduling: HR shift catalog + employee-owned roster assignments (manager rosters the dept)
  "shifts", "shift-assignments",
  // timesheets: project catalog + employee-owned time entries (manager approves the dept's)
  "projects", "time-entries",
  // loans / salary advances; employee-owned request, payroll decides/disburses
  "loans",
  // investment/tax declarations; employee-owned declaration, payroll verifies
  "tax-declarations",
  // employee referrals; referrer-owned (code-scoped), private-by-default (grant employee/HR via the ACL)
  "referrals",
  // ATS: job requisitions + candidates (talent pool) + applications (pipeline); flat company-level, HR-run
  "job-requisitions", "candidates", "applications",
  // ATS: interviews (flat, HR-run) + interview-feedback (scorecards; interviewer-owned)
  "interviews", "interview-feedback",
  // ATS: offers (flat, HR-run; accept converts the candidate to an employee + opens onboarding)
  "offers",
  // support tickets; requester-owned self-service (HR runs the desk; cross-visibility via category shares)
  "tickets",
  // predefined ticket checklists; HR-authored templates
  "ticket-checklists",
  // org calendar events (conferences, off-sites) marking attendees unavailable; readable by all, HR-written
  "events",
  // recorded cron ticks; private-by-default (no grant names it, so super-only via **) but still a real
  // code-bearing resource, so it must be registered here.
  "cron-runs",
  // workflow & automation engine: rules (HR-authored) + the event log + run observability. Authoring is the
  // privileged act (actions run with system authority), so writes are HR/super only; event-log/automation-runs
  // are read-only admin observability.
  "automations", "event-log", "automation-runs", "workflow-instances",
  // Virtual capability (no table, no route id): builder metadata for the Workflows UI. `workflow-meta.read`
  // gates GET /v1/workflow-meta; assembled from EVENT_TYPES + ACCESS_VERBS (no data of its own).
  "workflow-meta",
  // Virtual capability (no table): non-secret e-sign driver catalog for the Settings E-signature tab.
  // `esign-providers.read` gates GET /v1/esign-providers (from the driver registry; no data of its own).
  "esign-providers",
  "settings", "preferences",
  // bank bulk-payment formats (mappings + template), and the employer debit accounts the files are drawn on.
  // `payroll-debit-accounts` is PRIVATE-BY-DEFAULT: no seeded grant names it, so only super_admin reaches it
  // out of the box. It is listed here because listing is what makes a namespace NAMEABLE at all - leaving it
  // out enforced something stronger and unstated, that no grant could ever name it, so a `payroll_admin` could
  // not be given the debit-account editor even deliberately and the ACL rejected the rule as naming an unknown
  // collection with no hint why. Every other private-by-default namespace in the app (`referrals`, `boards`,
  // `api-keys`, `timeline`, `export`, `audit`) is listed and ungranted; this one now says the same thing in
  // the code that its comment always said in prose.
  "bank-formats", "payroll-debit-accounts",
  // policy-management collections (governed by their own keys, super-only by default)
  "roles", "policy", "access-rules",
  // Virtual UI capability (no table, no route): gates visibility of the Dashboard team timeline. The data it
  // shows is still enforced per underlying collection; `timeline.read` only decides who sees the widget, and
  // is configurable via the ACL like any other resource. Private-by-default (only super via ** until granted).
  "timeline",
  // Virtual capability (no table, no route): gates the cross-module CSV/Excel export affordance in the web.
  // `export.read` decides who may export; the data exported is still each list endpoint's access-filtered,
  // row-scoped result (you can only export what you can already read). Configurable via the ACL like any resource.
  "export",
  // Virtual transport capability (no table): `batch.run` lets a caller use the /v1/batch:run multi-read
  // endpoint. It grants NO data access of its own - every sub-request inside a batch is independently gated by
  // the full middleware chain. Held by everyone (it only collapses requests the caller could already make).
  "batch",
  // Virtual capability (no table): the per-entity activity trail (GET /v1/activity?resource=<col>/<id>). Gated
  // as `activity.<recordCode>.<collection>` read, ANDed in the middleware with READ on that record (never leak
  // activity for a record you can't read). PRIVATE-BY-DEFAULT — not in COMMON_READ, so only super (via `**`)
  // sees activity until an admin grants it per role/user/collection/scope via the ACL (like the `audit` cap).
  "activity",
  // Virtual capability (no table, no data of its own): `tax-verifications.read` gates GET /v1/tax-verifications,
  // the HR/payroll queue of prior-employer tax declarations awaiting verification (assembled by scanning the
  // encrypted per-employee tax blob). Sensitive (exposes declared prior salary), so private-by-default: super
  // via `**`, widened to hr/payroll via the ACL. The verify/reject action rides the existing employees.tax write.
  "tax-verifications",
  // Custom cross-collection grids: the saved DEFINITION of one (base + columns + filters), owner-coded and
  // shared through the ordinary object ACL. Running one reads every source under the runner's own scopes, so a
  // shared view never carries the author's access with it.
  "table-views",
  // Virtual capability (no table, no rows): the builder's field catalogue, `GET /v1/table-fields`. Assembled
  // from the schema + the org's own config (identity fields, pay components, leave types) and filtered to the
  // collections the caller may list, exactly like `workflow-meta`.
  "table-fields",
  // Virtual capability (no table, no route of its own): `unmask.read` decides whether a custom grid serves the
  // REAL value of a masked field (a full PAN, a full account number) rather than the masked form the profile
  // shows. It grants no data access on its own - the per-field read on `employees.<code>.identity.<key>` still
  // has to allow - it only decides whether what you may already read arrives masked. Grantable per FIELD as
  // well as wholesale (`unmask.*.bank-account.account_number.**`), so reading account numbers for a bank file
  // need not also mean reading everyone's statutory ids. Private by default (super-only via `**` until an
  // admin grants it), like `export` and `timeline`, and every unmasked run writes its own audit row NAMING
  // the fields it revealed.
  "unmask",
  // Virtual capability (no table): `audit.read` gates the ORG-WIDE activity feed (GET /v1/activity with no
  // ?resource) — every audit row across all collections, including sensitive-read + denial rows. Sensitive
  // (all people, all actions), so private-by-default: NOT in COMMON_READ, super-only via `**`, admins widen
  // via the ACL (mirrors `timeline`/`export`). The per-entity feed stays the everyone-held `activity` cap.
  "audit",
]);

// Is `token` a valid collection for a grant pattern? `**` is the super wildcard (every collection), allowed.
export function isGrantCollection(token: string): boolean {
  return token === "**" || COLLECTIONS.has(token);
}
