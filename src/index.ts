import { Hono } from "hono";
import type { AppEnv } from "./env";
import { makeDeps } from "./deps";
import { dbContext } from "./middleware/dbContext";
import { csrf } from "./middleware/csrf";
import { auth } from "./middleware/auth";
import { authz } from "./middleware/authz";
import { rateLimit } from "./middleware/rateLimit";
import { idempotency } from "./middleware/idempotency";
import { encodeWireIdsMiddleware } from "./middleware/encodeWireIds";
import { decodeWireIdsRequest } from "./middleware/decodeWireIds";
import { codecFor } from "./lib/idCodec";
import { securityHeaders } from "./middleware/securityHeaders";
import { bodyLimit } from "./middleware/bodyLimit";
import { errorHandler } from "./middleware/errorHandler";
import { AppError } from "./lib/errors";
import { requestId } from "./middleware/requestId";
import * as Sentry from "@sentry/cloudflare";
import { runScheduled, NIGHTLY_CRON } from "./cron";

import { users } from "./routes/users";
import { apiKeys } from "./routes/apiKeys";
import { preferences } from "./routes/preferences";
import { settings } from "./routes/settings";
import { roles } from "./routes/roles";
import { policy } from "./routes/policy";
import { accessRules } from "./routes/accessRules";
import { accessPreviewRoute, accessRequestRoute, accessApproveRoute, accessRejectRoute, accessCloneRoute, accessReviewRoute, accessScopeCountsRoute } from "./routes/accessPreview";
import { employees } from "./routes/employees";
import { departments } from "./routes/departments";
import { leaveRequests } from "./routes/leaveRequests";
import { goals } from "./routes/goals";
import { goalTemplates } from "./routes/goalTemplates";
import { boards } from "./routes/boards";
import { cards } from "./routes/cards";
import { sprints } from "./routes/sprints";
import { activity } from "./routes/activity";
import { taxVerifications } from "./routes/taxVerifications";
import { moderationRoute, moderationDecide, moderationHide, moderationUnhide } from "./routes/moderation";
import { reviewCycles } from "./routes/reviewCycles";
import { reviews } from "./routes/reviews";
import { reviewFeedback } from "./routes/reviewFeedback";
import { transitions } from "./routes/transitions";
import { transitionTasks } from "./routes/transitionTasks";
import { checkIns } from "./routes/checkIns";
import { benefitPlans } from "./routes/benefitPlans";
import { dependents } from "./routes/dependents";
import { benefitEnrollments } from "./routes/benefitEnrollments";
import { shifts } from "./routes/shifts";
import { shiftAssignments } from "./routes/shiftAssignments";
import { projects } from "./routes/projects";
import { timeEntries } from "./routes/timeEntries";
import { loans } from "./routes/loans";
import { taxDeclarations } from "./routes/taxDeclarations";
import { leaveBalances } from "./routes/leaveBalances";
import { leaveAdjustments, leaveAdjustmentImport } from "./routes/leaveAdjustments";
import { payrollOpenings, payrollOpeningImport } from "./routes/payrollOpenings";
import { leaveHistoryImport } from "./routes/leaveHistoryImport";
import { payrollRuns } from "./routes/payrollRuns";
import { payrollBudgets } from "./routes/payrollBudgets";
import { operations } from "./routes/operations";
import { cronRuns } from "./routes/cronRuns";
import { cronTrigger } from "./routes/cronTrigger";
import { holidays } from "./routes/holidays";
import { holidaySelections } from "./routes/holidaySelections";
import { complianceEvents } from "./routes/complianceEvents";
import { complianceRules } from "./routes/complianceRules";
import { backgroundChecks } from "./routes/backgroundChecks";
import { announcements, announcementPost, announcementGiveKudos, announcementMarkAllRead } from "./routes/announcements";
import { letterTemplates } from "./routes/letterTemplatesRoutes";
import { leaveTypes } from "./routes/leaveTypes";
import { payComponents } from "./routes/payComponents";
import { payGrades } from "./routes/payGrades";
import { salaryStructures } from "./routes/salaryStructures";
import { payPeriods } from "./routes/payPeriods";
import { orgDocuments } from "./routes/orgDocuments";
import { documentAcknowledgements } from "./routes/documentAcknowledgements";
import { personalDocuments } from "./routes/personalDocuments";
import { letterGenerate } from "./routes/letterGenerate";
import { form16Generate } from "./routes/form16Generate";
import { form16Upload } from "./routes/form16Upload";
import { letterPreview } from "./routes/letterPreview";
import { payslipTemplatePreview } from "./routes/payslipTemplatePreview";
import { draftRoutes } from "./routes/aiDraft";
import { payslips } from "./routes/payslips";
import { reimbursements } from "./routes/reimbursements";
import { reimbursementCategories } from "./routes/reimbursementCategories";
import { expenses } from "./routes/expenses";
import { expenseCategories } from "./routes/expenseCategories";
import { vendors } from "./routes/vendors";
import { expenseBudgets } from "./routes/expenseBudgets";
import { referrals } from "./routes/referrals";
import { requisitions } from "./routes/requisitions";
import { candidates } from "./routes/candidates";
import { applications } from "./routes/applications";
import { interviews } from "./routes/interviews";
import { interviewFeedback } from "./routes/interviewFeedback";
import { offers } from "./routes/offers";
import { celebrations } from "./routes/celebrations";
import { employeeTrackedFrom } from "./routes/employeeTrackedFrom";
import { batch } from "./routes/batch";
import { search } from "./routes/search";
import { activityCountsRoute } from "./routes/activityCounts";
import { changes } from "./routes/changes";
import { dashboardSummaryRoute } from "./routes/dashboardSummary";
import { attentionRoute } from "./routes/attention";
import { peopleAnalyticsRoute, peopleAnalyticsNarrate } from "./routes/peopleAnalytics";
import { approvalsSummaryRoute } from "./routes/approvalsSummary";
import { expenseCloseRoute } from "./routes/expenseClose";
import { payrollForecastRoute } from "./routes/payrollForecast";
import { cardTransactions } from "./routes/cardTransactions";
import { bankFormats } from "./routes/bankFormats";
import { letterheads } from "./routes/letterheads";
import { payrollDebit } from "./routes/payrollDebit";
import { compensation } from "./routes/compensation";
import { compensationReapply } from "./routes/compensationReapply";
import { compensationPreview } from "./routes/compensationPreview";
import { compensationIncrement } from "./routes/compensationIncrement";
import { exportRecord } from "./routes/exportRecord";
import { esignCallback } from "./routes/esignCallback";
import { found } from "./routes/found";
import { diag } from "./routes/diag";
import { holidayFeed } from "./routes/holidayFeed";
import { positions } from "./routes/positions";
import { bonuses, bonusAward } from "./routes/bonuses";
import { assets, assetBatchCreate } from "./routes/assets";
import { assetCategories } from "./routes/assetCategories";
import { assetRequests } from "./routes/assetRequests";
import { stocktakes } from "./routes/stocktakes";
import { settlements } from "./routes/settlements";
import { leaveEncashments } from "./routes/leaveEncashments";
import { attendance } from "./routes/attendance";
import { attendanceRegularizations } from "./routes/attendanceRegularizations";
import { attendanceDayMarks } from "./routes/attendanceDayMarks";
import { overtimeRequests } from "./routes/overtimeRequests";
import { remoteWorkRequests } from "./routes/remoteWorkRequests";
import { lateEarlyRequests } from "./routes/lateEarlyRequests";
import { approvalDelegations } from "./routes/approvalDelegations";
import { noticePeriods } from "./routes/noticePeriods";
import { suggestions } from "./routes/suggestions";
import { notifications, notificationsMarkAll } from "./routes/notifications";
import { tickets } from "./routes/tickets";
import { ticketChecklists } from "./routes/ticketChecklists";
import { events } from "./routes/events";
import { automations } from "./routes/automations";
import { eventLog } from "./routes/eventLog";
import { automationRuns } from "./routes/automationRuns";
import { workflowInstances } from "./routes/workflowInstances";
import { workflowMeta } from "./routes/workflowMeta";
import { esignProviders } from "./routes/esignProviders";
import { tableViews } from "./routes/tableViews";
import { tableFields, tableDescribe } from "./routes/tableFields";
import { authRoutes } from "./routes/authRoutes";
import { WORKER_OWNED_PREFIXES } from "./http/assetPaths";
import { serveStaticSite } from "./http/staticSite";

// Re-exported for the tests that pin it (test/spaFallback.test.ts); the list itself lives with the other
// path rules in http/assetPaths.ts.
export { WORKER_OWNED_PREFIXES };

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.use("*", requestId); // correlation id on every request/response + in error logs
// Response security headers across every path the WORKER owns, ahead of the middleware that can answer before
// a mount is reached. Each mount below still declares the middleware inside its own chain, and this is
// idempotent with them - securityHeaders fills a header in rather than overwriting one, so a route that sets
// its own (the /found page's inline-style CSP, the calendar feed's cache directives) keeps it. What this adds
// is the responses produced ABOVE a mount, which that mount's copy can never reach: `bodyLimit` on the next
// line is the concrete case, and a 413 was the one /v1 answer in the app shipping with no `nosniff`, no
// `frame-ancestors` and no `Cache-Control`.
//
// DELIBERATELY NOT "*". The catch-all would also wrap the static site at the bottom of this file, whose
// headers come from the asset layer's `_headers` - and the API's CSP is `default-src 'none'`, which renders
// the app shell as a blank page if it ever landed on one. The prefixes are the same set the static site treats
// as worker-owned (http/assetPaths.ts).
for (const prefix of [...WORKER_OWNED_PREFIXES.flatMap((p) => [p, `${p}/*`]), "/healthz", "/readyz"]) {
  app.use(prefix, securityHeaders);
}
// Body ceiling on EVERY route, not just /v1: the e-sign webhook below also buffers a JSON body, and a cap that
// stops at /v1 is not a cap on the worker. Registered here because Hono applies middleware in registration
// order against the routes declared AFTER it - mounted lower down, it would miss /auth, /found and /esign.
app.use("*", bodyLimit); // refuse an oversized body from Content-Length, before any handler buffers it

// Unauthenticated health checks for uptime monitors / load balancers (everything under /v1 needs an Access
// JWT, so there must be something to probe without one). /healthz is pure liveness; /readyz also pings D1.
//
// They carry the security headers too, from the registration above - which is why they are named in it: they
// sit outside every worker-owned prefix, so nothing else would cover them. Nothing here is sensitive; the
// point is that "which responses are hardened" should not be a list somebody has to keep in their head, and
// an unauthenticated endpoint is the wrong one to leave off it. It also stops an intermediary caching a stale
// `ready` past the isolate window the block below is careful to bound.
app.get("/healthz", (c) => c.json({ status: "ok" }));

// A READY answer is cached in the isolate for a few seconds. /readyz is unauthenticated and touches D1, so
// without this every caller - an uptime monitor on a tight interval, or anyone who finds the path - spends a
// D1 read per request, and on the free plan's 100k/day allowance that is a cheap way to exhaust the quota
// the app itself needs. A few seconds is well inside any monitor's tolerance for detecting an outage, and
// only the positive answer is cached: a FAILING probe re-checks every time, so recovery is reported at once
// and a stale "ready" can never outlive the database being down by more than the window.
const READY_TTL_MS = 5_000;
let readyUntil = 0;
app.get("/readyz", async (c) => {
  if (Date.now() < readyUntil) return c.json({ status: "ready" });
  try {
    await c.env.DB.prepare("SELECT 1").first();
    readyUntil = Date.now() + READY_TTL_MS;
    return c.json({ status: "ready" });
  } catch {
    readyUntil = 0;
    return c.json({ status: "unavailable" }, 503);
  }
});

// Direct Google sign-in (mode-selected by GOOGLE_CLIENT_ID - see routes/authRoutes.ts). Outside /v1: login
// and callback are by nature unauthenticated, and they touch no DB (provisioning happens on the first /v1
// request through the auth middleware). Security headers still apply.
app.use("/auth/*", securityHeaders);
app.route("/auth", authRoutes);

// Public lost-and-found page for printed asset tags (opt-in via settings/asset-tags found_page; the QR on a
// sticker can encode /found/<wire-id>). OUTSIDE /v1: no session - a stranger returning hardware has none. The
// wire-id token is HMAC-authenticated (unguessable) and the route serves only org name/tag/contact. It sets
// its own security headers (needs inline-style CSP for the HTML). Needs only Deps for the two reads.
app.use("/found/*", dbContext);
app.route("/found", found);

// Subscribable holiday calendar (opt-in via settings/holidays feed_enabled). OUTSIDE /v1: a calendar client
// has no session. The token is an authenticated wire id under its own "holiday-feed" domain, and the response
// carries only that employee's days off. Sets its own content/cache headers.
app.use("/calendar/*", dbContext);
app.route("/calendar", holidayFeed);

// Security headers on the public webhook responses too (the /v1 middleware below doesn't cover /esign).
app.use("/esign/*", securityHeaders);
// Public e-sign provider webhook, OUTSIDE /v1 so the session auth/authz/csrf middleware below does not apply -
// it is authenticated by the provider's HMAC signature inside the driver. Mounted before the /v1 middleware.
app.route("/esign", esignCallback);

// Diagnostics relay for the SPA's error tracker. OUTSIDE /v1: the SDK sends no session and no CSRF header,
// and a report from a signed-out or half-broken page is the one most worth having. It forwards to exactly one
// configured project and refuses everything else - see routes/diag.ts for why it is shaped that way, and why
// the path says nothing about the vendor.
app.use("/diag", securityHeaders);
app.route("/diag", diag);

app.use("/v1/*", securityHeaders); // set response security headers on every /v1 response (incl. errors)
app.use("/v1/*", dbContext);
app.use("/v1/*", encodeWireIdsMiddleware); // outbound edge: internal ids -> opaque wire tokens
app.use("/v1/*", csrf);
app.use("/v1/*", auth);
// Per-caller request budgets. Deliberately between auth (which supplies the principal to key on) and authz
// (so a refused request costs none of the gate's per-object reads). A FLOOR, not the rate limit - the WAF
// rule is - and the counterpart inside /v1 to the one lib/isolateRate.ts puts under the public lanes.
app.use("/v1/*", rateLimit);
app.use("/v1/*", authz); // ENFORCE: path-based authz is the sole gate; fail-closed (null/error/unmatched -> deny)
app.use("/v1/*", idempotency); // a write re-sent with the same Idempotency-Key is answered from the first copy

app.route("/v1/users", users);
app.route("/v1/api-keys", apiKeys); // machine credentials: a key acts as its owner, narrowed by its scope

app.route("/v1/preferences", preferences);
app.route("/v1/settings", settings);
app.route("/v1/roles", roles);
app.route("/v1/policy", policy);
app.route("/v1/access-rules:preview", accessPreviewRoute); // effective-access preview (collection verb, before the collection mount)
app.route("/v1/access-rules:requestAccess", accessRequestRoute); // ask access admins for a missing grant
app.route("/v1/access-rules:approve", accessApproveRoute); // four-eyes: apply a pending permission change
app.route("/v1/access-rules:reject", accessRejectRoute); // four-eyes: turn down a pending permission change
app.route("/v1/access-rules:clone", accessCloneRoute); // copy one subject's rules onto another as one traceable act
app.route("/v1/access-rules:review", accessReviewRoute); // unused + over-broad rule report, off the rule_usage counter
app.route("/v1/access-rules:scopeCounts", accessScopeCountsRoute); // how many RECORDS a scope chip reaches (bounded count)
app.route("/v1/access-rules", accessRules);
app.route("/v1/batch:run", batch); // multi-read batch: re-dispatches GET sub-requests through the full chain
app.route("/v1/search", search); // cross-collection search: per-collection list decision + scope inside the service
app.route("/v1/dashboard-summary", dashboardSummaryRoute); // aggregated KPI counts: same per-collection gating as search
app.route("/v1/attention", attentionRoute); // "what needs me": derived trouble across goals/cards/reviews, same gating
app.route("/v1/people-analytics:narrate", peopleAnalyticsNarrate); // narrated period-on-period change, before the collection mount
app.route("/v1/people-analytics", peopleAnalyticsRoute); // per-person report across the modules: same per-collection gating as search
app.route("/v1/approvals-summary", approvalsSummaryRoute); // approval queue counts: per-queue `approve` gating, no rows
app.route("/v1/payroll-forecast", payrollForecastRoute); // committed salary cost, 12 months, no rows
app.route("/v1/expense-close", expenseCloseRoute); // month-end close checklist: per-collection list gating, no rows
app.route("/v1/card-transactions", cardTransactions); // corporate card charges, imported and matched to claims
app.route("/v1/activity-counts", activityCountsRoute); // "new since I last looked" counts: same gating as search, no rows
app.route("/v1/changes", changes); // which collections were written to since a moment: lets a client trust its stored copies
app.route("/v1/employees:upcomingCelebrations", celebrations); // collection custom method, before the employees mount
app.route("/v1/employees:setTrackedFrom", employeeTrackedFrom); // the day HRMS records start, for everyone who joined before it
app.route("/v1/employees", employees);
app.route("/v1/departments", departments);
app.route("/v1/leave-requests:importHistory", leaveHistoryImport); // leave taken before HRMS, before the collection mount
app.route("/v1/leave-requests", leaveRequests);
app.route("/v1/goals", goals);
app.route("/v1/goal-templates", goalTemplates); // goal blueprints HR curates; :apply stamps them onto people
app.route("/v1/boards", boards);
app.route("/v1/cards", cards);
app.route("/v1/sprints", sprints);
app.route("/v1/activity", activity);
app.route("/v1/tax-verifications", taxVerifications);
app.route("/v1/moderation:decide", moderationDecide); // uphold or dismiss a flag, before the collection mount
app.route("/v1/moderation:hide", moderationHide); // take a post down by hand, no model flag involved
app.route("/v1/moderation:unhide", moderationUnhide); // put a hidden post back as a draft, reopening its flag
app.route("/v1/moderation", moderationRoute); // public posts a guard model objected to
app.route("/v1/review-cycles", reviewCycles);
app.route("/v1/reviews", reviews);
app.route("/v1/review-feedback", reviewFeedback);
app.route("/v1/transitions", transitions);
app.route("/v1/transition-tasks", transitionTasks);
app.route("/v1/check-ins", checkIns);
app.route("/v1/benefit-plans", benefitPlans);
app.route("/v1/dependents", dependents);
app.route("/v1/benefit-enrollments", benefitEnrollments);
app.route("/v1/shifts", shifts);
app.route("/v1/shift-assignments", shiftAssignments);
app.route("/v1/projects", projects);
app.route("/v1/time-entries", timeEntries);
app.route("/v1/loans", loans);
app.route("/v1/tax-declarations", taxDeclarations);
app.route("/v1/leave-balances", leaveBalances);
app.route("/v1/leave-adjustments:importOpenings", leaveAdjustmentImport); // opening balances from before HRMS, before the collection mount
app.route("/v1/leave-adjustments", leaveAdjustments);
app.route("/v1/payroll-openings:importOpenings", payrollOpeningImport); // pay and tax from before HRMS, before the collection mount
app.route("/v1/payroll-openings", payrollOpenings);
app.route("/v1/payroll-runs", payrollRuns);
app.route("/v1/payroll-budgets", payrollBudgets);
app.route("/v1/operations", operations);
app.route("/v1/cron-runs:run", cronTrigger); // collection custom method, before the cron-runs mount
app.route("/v1/cron-runs", cronRuns);
app.route("/v1/holidays", holidays);
app.route("/v1/holiday-selections", holidaySelections);
app.route("/v1/compliance-events", complianceEvents);
app.route("/v1/compliance-rules", complianceRules);
app.route("/v1/background-checks", backgroundChecks);
app.route("/v1/announcements:post", announcementPost); // collection custom method, before the announcements mount
app.route("/v1/announcements:giveKudos", announcementGiveKudos); // open recognition wall (kind="kudos")
app.route("/v1/announcements:markAllRead", announcementMarkAllRead); // clear the board's unread state in one call
// `<collection>:draft` for every collection that has a draft kind. Mounted from the registry rather than
// listed here, so adding a kind in domain/aiDraft.ts cannot leave its route unmounted. Each must come BEFORE
// its collection's own mount, for the same reason `payslips:previewTemplate` does: the collection route would
// otherwise match the path first and read `:draft` as an item id.
for (const { path, app: draftApp } of draftRoutes) app.route(path, draftApp);

app.route("/v1/announcements", announcements);
app.route("/v1/letter-templates", letterTemplates);
app.route("/v1/leave-types", leaveTypes);
app.route("/v1/pay-components", payComponents);
app.route("/v1/pay-grades", payGrades);
app.route("/v1/salary-structures", salaryStructures);
app.route("/v1/pay-periods", payPeriods);
app.route("/v1/org-documents", orgDocuments);
app.route("/v1/document-acknowledgements", documentAcknowledgements);
app.route("/v1/personal-documents:generateLetter", letterGenerate); // collection custom method, before the personal-documents mount
app.route("/v1/personal-documents:generateForm16", form16Generate); // Form 16 (Part B) generator, same pattern/gate
app.route("/v1/personal-documents:uploadForm16", form16Upload); // official TRACES Form 16 upload, same pattern/gate
app.route("/v1/personal-documents:previewLetter", letterPreview); // draft-template preview (no persist), before the personal-documents mount
app.route("/v1/personal-documents", personalDocuments);
app.route("/v1/payslips:previewTemplate", payslipTemplatePreview); // payslip-design preview on sample data, before the payslips mount
app.route("/v1/payslips", payslips);
app.route("/v1/reimbursements", reimbursements);
app.route("/v1/referrals", referrals);
app.route("/v1/job-requisitions", requisitions);
app.route("/v1/candidates", candidates);
app.route("/v1/applications", applications);
app.route("/v1/interviews", interviews);
app.route("/v1/interview-feedback", interviewFeedback);
app.route("/v1/offers", offers);
app.route("/v1/reimbursement-categories", reimbursementCategories);
app.route("/v1/expenses", expenses);
app.route("/v1/expense-categories", expenseCategories);
app.route("/v1/vendors", vendors);
app.route("/v1/expense-budgets", expenseBudgets);
app.route("/v1/bank-formats", bankFormats);
app.route("/v1/letterheads", letterheads);
app.route("/v1/payroll-debit-accounts", payrollDebit);
app.route("/v1/compensation:reapplySplit", compensationReapply); // collection custom method, before the compensation mount
app.route("/v1/compensation:preview", compensationPreview); // prices a proposed revision, writes nothing
app.route("/v1/compensation:increment", compensationIncrement); // a whole increment round: price it, or apply it
app.route("/v1/export:record", exportRecord); // the audit entry for a browser-side bulk export
app.route("/v1/compensation", compensation);
app.route("/v1/positions", positions);
app.route("/v1/bonuses:award", bonusAward); // collection custom method, before the bonuses mount
app.route("/v1/bonuses", bonuses);
app.route("/v1/assets:batchCreate", assetBatchCreate); // collection custom method, before the assets mount
app.route("/v1/assets", assets);
app.route("/v1/asset-categories", assetCategories);
app.route("/v1/asset-requests", assetRequests);
app.route("/v1/stocktakes", stocktakes);
app.route("/v1/settlements", settlements);
app.route("/v1/leave-encashments", leaveEncashments);
app.route("/v1/attendance-regularizations", attendanceRegularizations);
app.route("/v1/attendance-day-marks", attendanceDayMarks);
app.route("/v1/overtime-requests", overtimeRequests);
app.route("/v1/remote-work-requests", remoteWorkRequests);
app.route("/v1/late-early-requests", lateEarlyRequests);
app.route("/v1/approval-delegations", approvalDelegations);
app.route("/v1/notice-periods", noticePeriods);
app.route("/v1/suggestions", suggestions);
app.route("/v1/notifications:markAllRead", notificationsMarkAll); // collection custom method, before the notifications mount
app.route("/v1/notifications", notifications);
app.route("/v1/attendance", attendance);
app.route("/v1/ticket-checklists", ticketChecklists);
app.route("/v1/tickets", tickets);
app.route("/v1/events", events);
app.route("/v1/automations", automations);
app.route("/v1/event-log", eventLog);
app.route("/v1/automation-runs", automationRuns);
app.route("/v1/workflow-instances", workflowInstances);
app.route("/v1/workflow-meta", workflowMeta);
app.route("/v1/esign-providers", esignProviders); // virtual: non-secret e-sign driver catalog for Settings
app.route("/v1/table-fields:describe", tableDescribe); // NL -> grid spec, before the table-fields mount
app.route("/v1/table-fields", tableFields); // virtual: the custom-grid field catalogue (no table, no rows)
app.route("/v1/table-views", tableViews); // saved custom grids (the definition; `:run` produces the rows)

// Everything no route above claims: the app shell, its JS/CSS chunks and the client-side routes, served only to
// a signed-in browser, with the SPA fallback decided here rather than by the platform. `run_worker_first` sends
// every path except the media to the Worker, so this is where the app's code is answered. See
// http/staticSite.ts.
app.notFound(serveStaticSite);

// One codec per isolate so the HKDF subkeys are derived once, not per request. The memo lives in
// lib/idCodec.ts (keyed on the key material) rather than here, because `makeDeps` needs the same instance and
// cannot import from this module - so the inbound edge, the batch re-dispatch and every `deps.idCodec` now
// share one set of derived subkeys instead of the edge having its own and each request minting another.
export function getCodec(env: AppEnv["Bindings"]) {
  return codecFor(env.WIRE_ID_KEY);
}
// Exported so /v1/batch:run can re-dispatch sub-requests through the full middleware chain via app.fetch.
// Only referenced inside the batch handler (runtime), so the index<->batch import cycle is safe.
export { app };

// Slug for the nightly job's Sentry cron monitor. Named, not derived from the expression, because the monitor
// has to survive a schedule change: renaming it would orphan the history and silence the alert.
const NIGHTLY_MONITOR = "hrms-nightly";

const handler = {
  // Inbound edge: decode wire tokens -> internal ids BEFORE Hono routes, so params/services/authz are
  // id-native. Outbound encoding is the encodeWireIds middleware. Non-/v1 paths pass through unchanged.
  async fetch(request: Request, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    let decoded: Request;
    try {
      decoded = await decodeWireIdsRequest(request, getCodec(env));
    } catch (e) {
      // This edge runs OUTSIDE Hono, so `app.onError` never sees what it throws - and it throws for exactly
      // one reason: a JSON body that read past the size cap (middleware/decodeWireIds.ts readCapped). Rendered
      // here in the same problem+json shape middleware/errorHandler gives the declared-length refusal, so a
      // client cannot tell which half of the cap stopped it. Anything else is a real fault and is re-thrown to
      // `withSentry` below rather than dressed up as a client error.
      if (!(e instanceof AppError)) throw e;
      const problem = e.toProblem(new URL(request.url).pathname);
      return new Response(JSON.stringify(problem), {
        status: e.httpStatus,
        headers: { "Content-Type": "application/problem+json" },
      });
    }
    return app.fetch(decoded, env, ctx);
  },
  // Everything outside the Worker's own routes - the shell, its chunks, the client-side routes - arrives here
  // too and is answered by the static-site gate (app.notFound -> http/staticSite.ts). Only the media skips the
  // Worker (http/assetPaths.ts EDGE_PATHS).
  async scheduled(event: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    // The 5-minute drain is chatty and self-correcting - a missed one is made up by the next. The NIGHTLY run
    // is the one worth a check-in: it does leave accrual, reminders and digests, and if it silently stops
    // nobody finds out until a leave balance is wrong weeks later. `withMonitor` opens a check-in before the
    // run and closes it with ok/error, so Sentry alerts on a run that fails AND on one that never arrives -
    // the second being the failure that has no error to catch.
    const run = () => runScheduled(event.cron, makeDeps(env));
    ctx.waitUntil(
      event.cron === NIGHTLY_CRON
        ? Sentry.withMonitor(NIGHTLY_MONITOR, run, {
            schedule: { type: "crontab", value: NIGHTLY_CRON },
            checkinMargin: 10, // minutes late before it counts as missed
            maxRuntime: 30, // minutes running before it counts as stuck
            timezone: "Etc/UTC", // the cron expression is UTC; saying so keeps the monitor's clock honest
          })
        : run(),
    );
  },
};

// Wrapped LAST, around the finished handler: `withSentry` initializes the SDK per request and instruments
// both `fetch` and `scheduled`, so an unhandled throw anywhere in the Worker becomes an issue instead of a
// bare 500 nobody sees. It also continues the trace the SPA started - the browser sends `sentry-trace` on
// every /v1 call (tracePropagationTargets in web/src/instrument.ts) - so one trace spans the click, the API
// call and the D1 work behind it.
//
// Returns undefined when SENTRY_DSN is unset, which is `withSentry`'s documented way of staying inert: no
// client, no overhead, and local development is unchanged.
export default Sentry.withSentry(
  (env: AppEnv["Bindings"]) =>
    env.SENTRY_DSN
      ? {
          dsn: env.SENTRY_DSN,
          release: env.SENTRY_RELEASE,
          environment: env.SENTRY_ENVIRONMENT ?? "production",
          // Matches the SPA's rate so a distributed trace is not sampled in on one side and out on the other.
          tracesSampleRate: 0.2,
          // The server half of the same rule the browser follows: this is an HR system, and request bodies
          // are payroll and personal data. Nothing here needs them to report an error.
          sendDefaultPii: false,
        }
      : undefined,
  handler,
);
