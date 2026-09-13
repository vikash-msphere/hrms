import { and, or, eq, ne, lt, lte, gte, inArray, notInArray, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { orgToday, dayStartMs } from "./orgDay";

// Aggregated dashboard KPI counts: one request, one D1 batch, numbers only. Replaces the SPA fetching a whole
// collection page per KPI card just to count it client-side.
//
// NO ACCESS CONTROL HERE. The middleware already decided, per collection, whether the caller may list it and
// with what breadth, and handed the answers over `summaryScopes` (collection -> ListScope) - built by the
// exact decide()/scopeFor() pair a real `GET /v1/<collection>` gets, just like global search. A collection
// absent from the map contributes no aggregates, so a KPI the caller may not see is simply missing from the
// response (the SPA treats a missing key as "compute it yourself if you can read the rows").
//
// PARITY. Every aggregate's WHERE mirrors its collection's own list service binding - the same
// applyScope(code, owner) columns and the same soft-delete filter - plus the KPI's predicate, so the number
// here always equals what the SPA would have counted from the list response.
//
// "TODAY" IS THE ORG'S CALENDAR DAY, not the UTC one. Dates are still UTC midnights, because that is how
// date-only columns are anchored (domain/attendance.ts#utcDay) - what changed is WHICH day is chosen. The
// justification for reading the UTC clock here used to be that it matched the client, and it stopped being
// true when web/src/lib/orgDay.ts removed `new Date().toISOString().slice(0, 10)` from the SPA: "In IST the
// two disagree between midnight and 05:30 local". Roughly fourteen tiles key off `today` or a window derived
// from it - who is on leave today, joiners in the last 30 days, probations ending, compliance due or
// overdue, cards overdue, goals overdue - so for the first 5.5 hours of every working day in IST the
// dashboard was counting YESTERDAY, on the first screen of the morning. The server's other day-sensitive
// paths (payroll, leave, attendance, comp-off, the cron) all ask `orgToday(deps)`; this one did not.

export type SummaryEntry = { value: number; extra?: number };

type Ctx = {
  user: AppUser;
  now: Date; // request instant
  today: Date; // UTC midnight today
  tomorrow: Date; // UTC midnight tomorrow (exclusive end of "today")
  in7: Date; // UTC midnight 7 days out (inclusive window end)
  in30: Date; // UTC midnight 30 days out
  ago30: Date; // UTC midnight 30 days back (inclusive window start)
  weekStart: Date; // UTC midnight of the current week's Monday
};

// One aggregate: the KPI key it feeds, the collection whose LIST decision gates it, and the query builder.
// Builders select exactly { value, extra? } so the batch result maps 1:1 onto SummaryEntry.
type AggDef = {
  key: string;
  collection: string;
  build: (scope: ListScope, ctx: Ctx) => { sql: unknown };
};

const count = sql<number>`count(*)`;
const cond = (c: SQL) => sql<number>`coalesce(sum(case when ${c} then 1 else 0 end), 0)`;

const t = schema;

// The registry lives in registry() below: `value` is the card's number; `extra` is the one companion number
// its hint shows (documented per key). Every collection named here must appear in
// DASHBOARD_SUMMARY_COLLECTIONS (domain) for the middleware to scope it.
function def(key: string, collection: string, build: (scope: ListScope, ctx: Ctx) => unknown): AggDef {
  return { key, collection, build: (scope, ctx) => ({ sql: build(scope, ctx) }) };
}

function registry(deps: Deps): AggDef[] {
  const db = deps.db;
  return [
    // People currently employed within the caller's scope (not left, not soft-deleted); extra = everyone the
    // scope covers including leavers. The denominator any "N of M are away" line needs: a client counting the
    // employees it happens to have loaded is counting one 100-row page, not the org.
    def("headcount", "employees", (scope, c) =>
      db.select({
        value: cond(and(eq(t.employees.disabled, false), or(isNull(t.employees.endDate), gte(t.employees.endDate, c.today)))!),
        extra: count,
      }).from(t.employees).where(and(...[applyScope(scope, t.employees.code, t.employees.uuid), isNull(t.employees.deleteTime)].filter(Boolean) as SQL[]))),
    // People who started in the last 30 days. A count, so the dashboard's "new joiners" card no longer needs a
    // page of the directory to find them - and unlike that page, this one sees the whole org.
    def("joiners", "employees", (scope, c) =>
      db.select({ value: count }).from(t.employees).where(and(...[applyScope(scope, t.employees.code, t.employees.uuid), isNull(t.employees.deleteTime), isNotNull(t.employees.startDate), gte(t.employees.startDate, c.ago30), lte(t.employees.startDate, c.today)].filter(Boolean) as SQL[]))),
    // Probations ending in the next 30 days - the window HR watches for a confirm/extend decision.
    def("probation_ending", "employees", (scope, c) =>
      db.select({ value: count }).from(t.employees).where(and(...[applyScope(scope, t.employees.code, t.employees.uuid), isNull(t.employees.deleteTime), isNotNull(t.employees.probationEndDate), gte(t.employees.probationEndDate, c.today), lte(t.employees.probationEndDate, c.in30)].filter(Boolean) as SQL[]))),
    // Distinct people whose approved leave spans today (leave requests are hard-deleted, so no delete filter).
    def("on_leave", "leave-requests", (scope, c) =>
      db.select({ value: sql<number>`count(distinct ${t.leaveRequests.employeeId})` }).from(t.leaveRequests).where(and(...[applyScope(scope, t.leaveRequests.code, t.leaveRequests.employeeId), eq(t.leaveRequests.state, "APPROVED"), lte(t.leaveRequests.startDate, c.today), gte(t.leaveRequests.endDate, c.today)].filter(Boolean) as SQL[]))),
    // Open support tickets (state OPEN).
    def("open_tickets", "tickets", (scope) =>
      db.select({ value: count }).from(t.tickets).where(and(...[applyScope(scope, t.tickets.code, t.tickets.employeeId), isNull(t.tickets.deleteTime), eq(t.tickets.state, "OPEN")].filter(Boolean) as SQL[]))),
    // Expenses awaiting decision (state SUBMITTED); extra = their total amount.
    def("expenses_pending", "expenses", (scope) =>
      db.select({ value: count, extra: sql<number>`coalesce(sum(${t.expenses.amount}), 0)` }).from(t.expenses).where(and(...[applyScope(scope, t.expenses.code, t.expenses.employeeId), eq(t.expenses.state, "SUBMITTED")].filter(Boolean) as SQL[]))),
    // Recurring expenses whose next occurrence falls within the next 7 days.
    def("recurring_expenses_due", "expenses", (scope, c) =>
      db.select({ value: count }).from(t.expenses).where(and(...[applyScope(scope, t.expenses.code, t.expenses.employeeId), eq(t.expenses.isRecurring, true), isNotNull(t.expenses.nextOccurrenceOn), gte(t.expenses.nextOccurrenceOn, c.today), lte(t.expenses.nextOccurrenceOn, c.in7)].filter(Boolean) as SQL[]))),
    // Filings pending within 30 days; extra = how many of those are already past due.
    def("compliance_due", "compliance-events", (scope, c) =>
      db.select({ value: count, extra: cond(lt(t.complianceEvents.dueDate, c.today)) }).from(t.complianceEvents).where(and(...[applyScope(scope, t.complianceEvents.code, t.complianceEvents.code), isNull(t.complianceEvents.deleteTime), eq(t.complianceEvents.status, "pending"), lte(t.complianceEvents.dueDate, c.in30)].filter(Boolean) as SQL[]))),
    // Filings due within the next 7 days (not overdue yet).
    def("compliance_week", "compliance-events", (scope, c) =>
      db.select({ value: count }).from(t.complianceEvents).where(and(...[applyScope(scope, t.complianceEvents.code, t.complianceEvents.code), isNull(t.complianceEvents.deleteTime), eq(t.complianceEvents.status, "pending"), gte(t.complianceEvents.dueDate, c.today), lte(t.complianceEvents.dueDate, c.in7)].filter(Boolean) as SQL[]))),
    // Filings already past due and still pending.
    def("compliance_overdue", "compliance-events", (scope, c) =>
      db.select({ value: count }).from(t.complianceEvents).where(and(...[applyScope(scope, t.complianceEvents.code, t.complianceEvents.code), isNull(t.complianceEvents.deleteTime), eq(t.complianceEvents.status, "pending"), lt(t.complianceEvents.dueDate, c.today)].filter(Boolean) as SQL[]))),
    // Assets issued to people; extra = whole inventory size.
    def("assets_assigned", "assets", (scope) =>
      db.select({ value: cond(eq(t.assets.status, "assigned")), extra: count }).from(t.assets).where(and(...[applyScope(scope, t.assets.code, t.assets.assignedTo)].filter(Boolean) as SQL[]))),
    // Custody nobody has proved yet: awaiting a holder's confirmation, extra = awaiting a check-in scan. For an
    // employee the scope narrows this to their own assets, which is what the dashboard's "confirm it" tile reads
    // - so the ask costs no extra request beyond the summary the page already fetches.
    def("assets_pending_scan", "assets", (scope) =>
      db.select({ value: cond(eq(t.assets.status, "pending_ack")), extra: cond(eq(t.assets.status, "pending_verification")) }).from(t.assets).where(and(...[applyScope(scope, t.assets.code, t.assets.assignedTo)].filter(Boolean) as SQL[]))),
    // Goals in flight; extra = how many slipped past their due date.
    def("goals_active", "goals", (scope, c) =>
      db.select({ value: count, extra: cond(and(isNotNull(t.goals.dueDate), lt(t.goals.dueDate, c.today))!) }).from(t.goals).where(and(...[applyScope(scope, t.goals.code, t.goals.employeeId), isNull(t.goals.deleteTime), inArray(t.goals.status, ["not_started", "in_progress"])].filter(Boolean) as SQL[]))),
    // Disbursed loans with a balance owed; extra = total outstanding.
    def("loans_outstanding", "loans", (scope) =>
      db.select({ value: count, extra: sql<number>`coalesce(sum(${t.loans.principal} - ${t.loans.repaid}), 0)` }).from(t.loans).where(and(...[applyScope(scope, t.loans.code, t.loans.employeeId), isNull(t.loans.deleteTime), eq(t.loans.status, "DISBURSED"), sql`${t.loans.principal} - ${t.loans.repaid} > 0`].filter(Boolean) as SQL[]))),
    // Applications still moving through the funnel.
    def("candidates_pipeline", "applications", (scope) =>
      db.select({ value: count }).from(t.applications).where(and(...[applyScope(scope, t.applications.code, t.applications.code), isNull(t.applications.deleteTime), eq(t.applications.status, "active")].filter(Boolean) as SQL[]))),
    // Interviews scheduled from now on; extra = how many of those are today.
    def("interviews_upcoming", "interviews", (scope, c) =>
      db.select({ value: count, extra: cond(lt(t.interviews.scheduledStart, c.tomorrow)) }).from(t.interviews).where(and(...[applyScope(scope, t.interviews.code, t.interviews.code), isNull(t.interviews.deleteTime), eq(t.interviews.status, "scheduled"), gte(t.interviews.scheduledStart, c.now)].filter(Boolean) as SQL[]))),
    // Referrals still live.
    def("referrals_open", "referrals", (scope) =>
      db.select({ value: count }).from(t.referrals).where(and(...[applyScope(scope, t.referrals.code, t.referrals.referrerId), isNull(t.referrals.deleteTime), notInArray(t.referrals.status, ["joined", "rejected"])].filter(Boolean) as SQL[]))),
    // Reviews not yet acknowledged.
    def("reviews_open", "reviews", (scope) =>
      db.select({ value: count }).from(t.reviews).where(and(...[applyScope(scope, t.reviews.code, t.reviews.employeeId), ne(t.reviews.state, "ACKNOWLEDGED")].filter(Boolean) as SQL[]))),
    // Declarations awaiting proof verification.
    def("tax_verify", "tax-declarations", (scope) =>
      db.select({ value: count }).from(t.taxDeclarations).where(and(...[applyScope(scope, t.taxDeclarations.code, t.taxDeclarations.employeeId), isNull(t.taxDeclarations.deleteTime), eq(t.taxDeclarations.status, "DECLARED")].filter(Boolean) as SQL[]))),
    // Background checks still unresolved.
    def("bgchecks_open", "background-checks", (scope) =>
      db.select({ value: count }).from(t.backgroundChecks).where(and(...[applyScope(scope, t.backgroundChecks.code, t.backgroundChecks.employeeId), isNull(t.backgroundChecks.deleteTime), inArray(t.backgroundChecks.status, ["pending", "in_progress"])].filter(Boolean) as SQL[]))),
    // Suggestions without a response yet.
    def("suggestions_open", "suggestions", (scope) =>
      db.select({ value: count }).from(t.suggestions).where(and(...[applyScope(scope, t.suggestions.code, t.suggestions.submitterId), isNull(t.suggestions.deleteTime), inArray(t.suggestions.status, ["new", "under_review"])].filter(Boolean) as SQL[]))),
    // Active benefit enrollments.
    def("benefits_enrolled", "benefit-enrollments", (scope) =>
      db.select({ value: count }).from(t.benefitEnrollments).where(and(...[applyScope(scope, t.benefitEnrollments.code, t.benefitEnrollments.employeeId), isNull(t.benefitEnrollments.deleteTime), eq(t.benefitEnrollments.status, "enrolled")].filter(Boolean) as SQL[]))),
    // Open (undelivered) cards, blocked.
    def("cards_blocked", "cards", (scope) =>
      db.select({ value: count }).from(t.cards).where(and(...[applyScope(scope, t.cards.code, t.cards.employeeId), isNull(t.cards.deleteTime), isNull(t.cards.deliveredAt), eq(t.cards.blocked, true)].filter(Boolean) as SQL[]))),
    // Open cards past their due date.
    def("cards_overdue", "cards", (scope, c) =>
      db.select({ value: count }).from(t.cards).where(and(...[applyScope(scope, t.cards.code, t.cards.employeeId), isNull(t.cards.deleteTime), isNull(t.cards.deliveredAt), isNotNull(t.cards.dueDate), lt(t.cards.dueDate, c.today)].filter(Boolean) as SQL[]))),
    // Open cards due within the next 7 days.
    def("cards_due_week", "cards", (scope, c) =>
      db.select({ value: count }).from(t.cards).where(and(...[applyScope(scope, t.cards.code, t.cards.employeeId), isNull(t.cards.deleteTime), isNull(t.cards.deliveredAt), isNotNull(t.cards.dueDate), gte(t.cards.dueDate, c.today), lte(t.cards.dueDate, c.in7)].filter(Boolean) as SQL[]))),
    // Open cards assigned to the caller.
    def("my_open_cards", "cards", (scope, c) =>
      db.select({ value: count }).from(t.cards).where(and(...[applyScope(scope, t.cards.code, t.cards.employeeId), isNull(t.cards.deleteTime), isNull(t.cards.deliveredAt), eq(t.cards.assigneeId, c.user.employeeId ?? "")].filter(Boolean) as SQL[]))),
    // Employees serving notice.
    def("notice_serving", "notice-periods", (scope) =>
      db.select({ value: count }).from(t.noticePeriods).where(and(...[applyScope(scope, t.noticePeriods.code, t.noticePeriods.employeeId), isNull(t.noticePeriods.deleteTime), eq(t.noticePeriods.status, "serving")].filter(Boolean) as SQL[]))),
    // Distinct people on approved remote work spanning today.
    def("remote_today", "remote-work-requests", (scope, c) =>
      db.select({ value: sql<number>`count(distinct ${t.remoteWorkRequests.employeeId})` }).from(t.remoteWorkRequests).where(and(...[applyScope(scope, t.remoteWorkRequests.code, t.remoteWorkRequests.employeeId), eq(t.remoteWorkRequests.state, "APPROVED"), lte(t.remoteWorkRequests.startDate, c.today), gte(t.remoteWorkRequests.endDate, c.today)].filter(Boolean) as SQL[]))),
    // The caller's own draft time entries.
    def("timesheets_draft", "time-entries", (scope, c) =>
      db.select({ value: count }).from(t.timeEntries).where(and(...[applyScope(scope, t.timeEntries.code, t.timeEntries.employeeId), isNull(t.timeEntries.deleteTime), eq(t.timeEntries.status, "DRAFT"), eq(t.timeEntries.employeeId, c.user.employeeId ?? "")].filter(Boolean) as SQL[]))),
    // The caller's own hours this week (Mon-today), as a raw sum - the SPA rounds for display.
    def("timesheet_week", "time-entries", (scope, c) =>
      db.select({ value: sql<number>`coalesce(sum(${t.timeEntries.hours}), 0)` }).from(t.timeEntries).where(and(...[applyScope(scope, t.timeEntries.code, t.timeEntries.employeeId), isNull(t.timeEntries.deleteTime), eq(t.timeEntries.employeeId, c.user.employeeId ?? ""), gte(t.timeEntries.date, c.weekStart), lt(t.timeEntries.date, c.tomorrow)].filter(Boolean) as SQL[]))),
    // Hours this week across everyone the caller can see.
    def("team_hours_week", "time-entries", (scope, c) =>
      db.select({ value: sql<number>`coalesce(sum(${t.timeEntries.hours}), 0)` }).from(t.timeEntries).where(and(...[applyScope(scope, t.timeEntries.code, t.timeEntries.employeeId), isNull(t.timeEntries.deleteTime), gte(t.timeEntries.date, c.weekStart), lt(t.timeEntries.date, c.tomorrow)].filter(Boolean) as SQL[]))),
    // Active review cycles with a self/manager deadline inside the next 7 days.
    def("reviews_due_soon", "review-cycles", (scope, c) => {
      const inWin = (col: AnySQLiteColumn) => and(isNotNull(col), gte(col, c.today), lte(col, c.in7))!;
      return db.select({ value: count }).from(t.reviewCycles).where(and(...[applyScope(scope, t.reviewCycles.code, t.reviewCycles.code), isNull(t.reviewCycles.deleteTime), eq(t.reviewCycles.state, "ACTIVE"), sql`(${inWin(t.reviewCycles.selfDueDate)} or ${inWin(t.reviewCycles.managerDueDate)})`].filter(Boolean) as SQL[]));
    }),
    // Offers extended and awaiting a response.
    def("offers_pending", "offers", (scope) =>
      db.select({ value: count }).from(t.offers).where(and(...[applyScope(scope, t.offers.code, t.offers.code), isNull(t.offers.deleteTime), eq(t.offers.status, "extended")].filter(Boolean) as SQL[]))),
    // Live onboarding/offboarding runs; extra = how many are onboarding.
    def("transitions_active", "transitions", (scope) =>
      db.select({ value: count, extra: cond(eq(t.transitions.kind, "onboarding")) }).from(t.transitions).where(and(...[applyScope(scope, t.transitions.code, t.transitions.employeeId), isNull(t.transitions.deleteTime), eq(t.transitions.state, "ACTIVE")].filter(Boolean) as SQL[]))),
    // Outstanding checklist tasks across live transitions (task TODO, parent transition ACTIVE). Scope binds
    // on the PARENT transition's columns - the same rows a transitions list would return, drilled to tasks.
    def("onboarding_tasks_pending", "transitions", (scope) =>
      db.select({ value: count }).from(t.transitionTasks)
        .innerJoin(t.transitions, eq(t.transitionTasks.transitionId, t.transitions.uuid))
        .where(and(...[applyScope(scope, t.transitions.code, t.transitions.employeeId), isNull(t.transitions.deleteTime), eq(t.transitions.state, "ACTIVE"), eq(t.transitionTasks.status, "TODO")].filter(Boolean) as SQL[]))),
    // Open requisitions; extra = total seats across them.
    def("open_positions", "job-requisitions", (scope) =>
      db.select({ value: count, extra: sql<number>`coalesce(sum(${t.jobRequisitions.openings}), 0)` }).from(t.jobRequisitions).where(and(...[applyScope(scope, t.jobRequisitions.code, t.jobRequisitions.code), isNull(t.jobRequisitions.deleteTime), eq(t.jobRequisitions.status, "open")].filter(Boolean) as SQL[]))),
  ];
}


/** Compute the requested KPI aggregates the caller may see. `scopes` carries only the collections the
 *  middleware decided are listable; anything else is silently absent from the result. One D1 batch. */
export async function dashboardSummary(
  deps: Deps,
  user: AppUser,
  scopes: Map<string, ListScope>,
  keysCsv: string | undefined,
): Promise<Record<string, SummaryEntry>> {
  const requested = new Set((keysCsv ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  // `deps.clock`, not `new Date()`: every other time-sensitive service takes its instant from the injected
  // clock, and a service that reads the wall clock directly cannot be driven across a day boundary by a test
  // (the complaint services/leaveAccrual.ts makes about its own former self).
  const now = new Date(+deps.clock.now());
  const today = new Date(dayStartMs(await orgToday(deps)));
  const DAY = 86_400_000;
  const dow = (today.getUTCDay() + 6) % 7; // 0 = Monday
  const ctx: Ctx = {
    user,
    now,
    today,
    tomorrow: new Date(today.getTime() + DAY),
    in7: new Date(today.getTime() + 7 * DAY),
    in30: new Date(today.getTime() + 30 * DAY),
    ago30: new Date(today.getTime() - 30 * DAY),
    weekStart: new Date(today.getTime() - dow * DAY),
  };
  const defs = registry(deps).filter((d) => (requested.size === 0 || requested.has(d.key)) && scopes.has(d.collection));
  if (!defs.length) return {};
  const stmts = defs.map((d) => d.build(scopes.get(d.collection)!, ctx).sql);
  const results =
    stmts.length === 1
      ? [await (stmts[0] as PromiseLike<unknown>)]
      : ((await deps.db.batch(stmts as unknown as Parameters<typeof deps.db.batch>[0])) as unknown as unknown[]);
  const out: Record<string, SummaryEntry> = {};
  defs.forEach((d, i) => {
    const row = (results[i] as { value: number; extra?: number }[])[0];
    if (!row) return;
    const entry: SummaryEntry = { value: Number(row.value ?? 0) };
    if (row.extra !== undefined && row.extra !== null) entry.extra = Number(row.extra);
    out[d.key] = entry;
  });
  return out;
}
