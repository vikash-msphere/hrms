// Bridges a live request path to the permission key the engine matches on (docs/archive/plan.txt Phase 2). The path's
// resource id is resolved to the internal `code`; `me`/`-` are left literal. Pure `buildCodedPath` (the
// id resolver is injected, so it is unit-testable) + a DB-backed uuid->code resolver with an in-isolate
// cache. NOTE: only the top resource id (segment after the collection) is resolved today; nested ids
// arrive with the 0.7/0.8 wire flip + parent-wildcard work.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";

// Collection name -> table, for resources that carry an authz-relevant `code`.
// The registry is exported (as COLLECTION_TABLES) because it is the one place that knows, for every wire
// collection, which table backs it - so the change-stamp triggers are generated from it and cannot miss a
// collection that authz already knows about.
export const TABLES: Record<string, any> = {
  "api-keys": schema.apiKeys,
  employees: schema.employees,
  departments: schema.departments,
  "leave-requests": schema.leaveRequests,
  goals: schema.goals,
  boards: schema.boards,
  cards: schema.cards,
  sprints: schema.sprints,
  "review-cycles": schema.reviewCycles,
  reviews: schema.reviews,
  "review-feedback": schema.reviewFeedback,
  transitions: schema.transitions,
  "transition-tasks": schema.transitionTasks,
  "check-ins": schema.checkIns,
  "benefit-plans": schema.benefitPlans,
  dependents: schema.dependents,
  "benefit-enrollments": schema.benefitEnrollments,
  shifts: schema.shifts,
  "shift-assignments": schema.shiftAssignments,
  projects: schema.projects,
  "time-entries": schema.timeEntries,
  loans: schema.loans,
  "tax-declarations": schema.taxDeclarations,
  referrals: schema.referrals,
  "job-requisitions": schema.jobRequisitions,
  candidates: schema.candidates,
  applications: schema.applications,
  interviews: schema.interviews,
  "interview-feedback": schema.interviewFeedback,
  offers: schema.offers,
  "leave-types": schema.leaveTypes,
  "letter-templates": schema.letterTemplates,
  "letterhead-logos": schema.letterheadLogos,
  "leave-balances": schema.leaveBalances,
  holidays: schema.holidays,
  "holiday-selections": schema.holidaySelections,
  "compliance-events": schema.complianceEvents,
  "compliance-rules": schema.complianceRules,
  "background-checks": schema.backgroundChecks,
  "overtime-requests": schema.overtimeRequests,
  "remote-work-requests": schema.remoteWorkRequests,
  "approval-delegations": schema.approvalDelegations,
  "notice-periods": schema.noticePeriods,
  suggestions: schema.suggestions,
  notifications: schema.notifications,
  "org-documents": schema.orgDocuments,
  "personal-documents": schema.personalDocuments,
  "document-acknowledgements": schema.documentAcknowledgements,
  announcements: schema.announcements,
  "pay-components": schema.payComponents,
  "pay-grades": schema.payGrades,
  "salary-structures": schema.salaryStructures,
  "pay-periods": schema.payPeriods,
  "payroll-runs": schema.payrollRuns,
  payslips: schema.payslips,
  reimbursements: schema.reimbursements,
  "reimbursement-categories": schema.reimbursementCategories,
  expenses: schema.expenses,
  "expense-categories": schema.expenseCategories,
  vendors: schema.vendors,
  "expense-budgets": schema.expenseBudgets,
  "ticket-checklists": schema.ticketChecklists,
  operations: schema.jobs, // the jobs table is surfaced as the `operations` collection (employee-owned)
  "cron-runs": schema.cronRuns, // recorded cron ticks; private-by-default (super-only via **)
  automations: schema.automations, // workflow rules (HR-authored)
  "event-log": schema.eventLog, // domain event log (admin observability)
  "automation-runs": schema.automationRuns, // automation firing log (admin observability)
  "workflow-instances": schema.workflowInstances, // suspended/finished durable workflows (admin observability)
  compensation: schema.compensation,
  positions: schema.positions,
  bonuses: schema.bonuses,
  assets: schema.assets,
  "asset-categories": schema.assetCategories,
  "asset-requests": schema.assetRequests,
  stocktakes: schema.stocktakes, // inventory counts (walk-throughs); flat, HR/asset-admin managed
  settlements: schema.settlements,
  "leave-encashments": schema.leaveEncashments,
  attendance: schema.attendanceSessions,
  "attendance-regularizations": schema.attendanceRegularizations,
  tickets: schema.tickets,
  events: schema.events,
  users: schema.users,
};

// Resource collections that carry an authz `code` (the source of truth for "this is a real resource").
// The wire-id codec set (ENCODABLE in encodeWireIds) must cover all of these - guarded by a test - so
// no collection ever serializes a raw internal id.
export const RESOURCE_COLLECTIONS = Object.keys(TABLES);

// The Drizzle table backing a wire collection, or undefined for a virtual/unknown one. Used by audit() to
// snapshot a record's label when the caller passed no row (one indexed uuid lookup).
export function tableFor(collection: string): any | undefined {
  return TABLES[collection];
}

// id is the wire identifier in the path (currently the uuid; later the random wire id). Resolve -> code.
// uuid->code is normally immutable, so this per-isolate cache is fast; it is bounded (FIFO eviction) so a
// long-lived isolate seeing many distinct ids can't grow it without limit. Re-parenting (moveDepartment /
// moveEmployee in codeCascade.ts) is the ONE operation that rewrites a code: the acting isolate calls
// `invalidateCodeCache()` immediately, and a short TTL bounds how long OTHER isolates can serve a stale code
// (so a just-moved employee is correctly re-scoped everywhere within the TTL). The TTL costs at most one
// re-resolve per distinct id per window on the authz path (a single indexed lookup) - negligible.
const codeCache = new Map<string, { code: string; exp: number }>(); // `${collection}:${id}` -> {code, expiry ms}
const CODE_CACHE_MAX = 10_000;
const CODE_CACHE_TTL_MS = 10 * 60 * 1000;

// Drop the whole per-isolate uuid->code cache. Called after a re-parent rewrites codes (codeCascade.ts) so the
// acting isolate never serves a stale code; other isolates self-heal via the TTL.
export function invalidateCodeCache(): void {
  codeCache.clear();
}

export async function uuidToCode(deps: Deps, collection: string, id: string): Promise<string | null> {
  const t = TABLES[collection];
  if (!t) return null;
  const key = `${collection}:${id}`;
  const hit = codeCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.code;
  const row = (await deps.db.select({ code: t.code }).from(t).where(eq(t.uuid, id)).limit(1))[0] as { code: string | null } | undefined;
  if (row?.code) {
    if (codeCache.size >= CODE_CACHE_MAX) codeCache.delete(codeCache.keys().next().value!);
    codeCache.set(key, { code: row.code, exp: Date.now() + CODE_CACHE_TTL_MS });
    return row.code;
  }
  return null;
}

// Reverse of uuidToCode: the internal uuid for a (collection, code). Codes are unique within a collection
// (the scope key), so this is a single indexed-ish lookup. Used to render a grant-exception's object back
// as a `<collection>/<uuid>` ref (the outbound edge then encodes it to a wire token); never on a hot path.
export async function codeToUuid(deps: Deps, collection: string, code: string): Promise<string | null> {
  const t = TABLES[collection];
  if (!t) return null;
  const row = (await deps.db.select({ uuid: t.uuid }).from(t).where(eq(t.code, code)).limit(1))[0] as { uuid: string } | undefined;
  return row?.uuid ?? null;
}

// Resolve a state-gated item: its `code` AND the requested state columns, in ONE read (uncached - state is
// mutable, unlike code). Lets the middleware gate item reads on row state (e.g. "unpublished") without a
// second read, so the budget stays "the one id->code resolve". `cols` are drizzle property names.
export async function resolveItemState(
  deps: Deps,
  collection: string,
  id: string,
  cols: string[],
): Promise<{ code: string | null; state: Record<string, unknown> } | null> {
  const t = TABLES[collection];
  if (!t) return null;
  const sel: Record<string, any> = { code: t.code };
  for (const col of cols) if (t[col]) sel[col] = t[col];
  const row = (await deps.db.select(sel).from(t).where(eq(t.uuid, id)).limit(1))[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const { code, ...state } = row;
  return { code: (code as string | null) ?? null, state };
}

export type IdResolver = (collection: string, id: string) => Promise<string | null>;

// Substitute the top resource id with its code; keep `me`, `-` (AEP parent wildcard), and the trailing
// :verb. If the id does not resolve, leave it as-is (the decision will fail closed - fine for audit).
export async function buildCodedPath(pathname: string, resolveId: IdResolver): Promise<string> {
  const m = /^\/v1\/(.+)$/.exec(pathname);
  const rest0 = m?.[1];
  if (!rest0) return pathname;
  let rest = rest0;
  let verb = "";
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    verb = rest.slice(colon); // includes the leading ':'
    rest = rest.slice(0, colon);
  }
  const segs = rest.split("/");
  const collection = segs[0];
  const id = segs[1];
  if (collection && id && id !== "me" && id !== "-") {
    const code = await resolveId(collection, id);
    if (code) segs[1] = code;
  }
  return `/v1/${segs.join("/")}${verb}`;
}
