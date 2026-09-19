// Bridges a live request path to the permission key the engine matches on (docs/archive/plan.txt Phase 2). The path's
// resource id is resolved to the internal `code`; `me`/`-` are left literal. Pure `buildCodedPath` (the
// id resolver is injected, so it is unit-testable) + a DB-backed uuid->code resolver with an in-isolate
// cache. NOTE: only the top resource id (segment after the collection) is resolved today; nested ids
// arrive with the 0.7/0.8 wire flip + parent-wildcard work.
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { byIdChunks } from "./dbBatch";

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
  "table-views": schema.tableViews,
  "letter-templates": schema.letterTemplates,
  letterheads: schema.letterheads,
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
  "goal-templates": schema.goalTemplates,
  "asset-requests": schema.assetRequests,
  stocktakes: schema.stocktakes, // inventory counts (walk-throughs); flat, HR/asset-admin managed
  settlements: schema.settlements,
  "leave-encashments": schema.leaveEncashments,
  attendance: schema.attendanceSessions,
  "attendance-regularizations": schema.attendanceRegularizations,
  "attendance-day-marks": schema.attendanceDayMarks,
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

/**
 * The OWNER column each collection's own list service binds as `applyScope`'s third argument - the column an
 * `own` breadth is matched against. Drizzle property names, resolved off the table by `listOwnerColumn`.
 *
 * WHY IT HAS TO BE WRITTEN DOWN. `applyScope` takes the column; every hand-written list passes the right one
 * inline, and until something else needed to scope the same table that was enough. The table builder does
 * (services/tableRun.ts, over ~50 bases and every link target it follows), and it guessed `table.employeeId`
 * for all of them - which is right for the thirty-odd employee-owned collections and wrong for every other
 * shape: `employees` is owned by `uuid`, `assets` by `assignedTo`, `referrals` by `referrerId`. A guess that
 * misses resolves to `undefined`, and `applyScope` fails CLOSED on a missing owner column, so an own-breadth
 * caller silently got an empty grid - and, through the link lane, a blank employee-name column on grids that
 * otherwise worked. Nothing leaked; the answer was just wrong in the direction nobody notices.
 *
 * A collection ABSENT from this map is one whose list binds no owner (the collection factory's generic list,
 * services/crud.ts - every flat catalogue). `undefined` is the honest answer for those and `applyScope`
 * already means the right thing by it, so absence is a value here rather than a hole.
 *
 * test/listOwnerColumns.test.ts reads the services back and fails when one of them binds a column this map
 * does not name - so the two cannot drift.
 */
export const LIST_OWNER_COLUMNS: Record<string, string> = {
  announcements: "authorEmployeeId",
  applications: "code",
  "approval-delegations": "delegatorId",
  "asset-requests": "employeeId",
  assets: "assignedTo",
  attendance: "employeeId",
  "attendance-regularizations": "employeeId",
  "attendance-day-marks": "employeeId",
  "background-checks": "employeeId",
  "benefit-enrollments": "employeeId",
  bonuses: "employeeId",
  candidates: "code",
  cards: "employeeId",
  "check-ins": "employeeId",
  compensation: "employeeId",
  "compliance-events": "code",
  departments: "code",
  dependents: "employeeId",
  "document-acknowledgements": "employeeId",
  employees: "uuid",
  events: "code",
  expenses: "employeeId",
  goals: "employeeId",
  "interview-feedback": "authorId",
  interviews: "code",
  "job-requisitions": "code",
  "leave-balances": "employeeId",
  "leave-encashments": "employeeId",
  "leave-requests": "employeeId",
  loans: "employeeId",
  "notice-periods": "employeeId",
  offers: "code",
  // The two document collections scope through one service (services/documentService.ts), which picks the
  // column from whether the collection is owned: personal documents by their employee, org documents by code.
  "org-documents": "code",
  "personal-documents": "employeeId",
  "overtime-requests": "employeeId",
  "payroll-runs": "code",
  payslips: "employeeId",
  positions: "employeeId",
  referrals: "referrerId",
  reimbursements: "employeeId",
  "remote-work-requests": "employeeId",
  "review-cycles": "code",
  "review-feedback": "authorId",
  reviews: "employeeId",
  settlements: "employeeId",
  "shift-assignments": "employeeId",
  stocktakes: "code",
  suggestions: "submitterId",
  "table-views": "ownerId",
  "tax-declarations": "employeeId",
  tickets: "employeeId",
  "time-entries": "employeeId",
  "transition-tasks": "assigneeId",
  transitions: "employeeId",
  users: "employeeId",
};

/**
 * Collections whose rows carry a FLAT code but a real employee OWNER column - the set the item lane needs an
 * OWNER KEY for (domain/permissions.ts Resolved#ownerResource).
 *
 * The membership rule is mechanical: a collection belongs here when `LIST_OWNER_COLUMNS` above binds it a real
 * owner column - not `code` or `uuid`, which are the "owned by its own identity" spellings a catalogue uses -
 * and it is NOT owned-coded (absent from `HIERARCHICAL_TABLES`, where the owner already sits inside the row's
 * own code and a second key could only add reach).
 *
 * WRITTEN OUT RATHER THAN COMPUTED, deliberately. Computing it needs `HIERARCHICAL_TABLES`, which lives in
 * `services/codeCascade.ts` because it pairs collections with drizzle tables - so a leaf module like this one
 * would have to import a service, as would `middleware/authz.ts` and `http/collectionRoute.ts`, which read the
 * set on the hot path. That is a layering inversion in a graph `madge` already reports ~157 cycles in, and it
 * buys nothing: `test/reparenting.test.ts` asserts this set is exactly the complement described above, so the
 * derivation is checked without the edge - the same registry-plus-tripwire shape `LIST_OWNER_COLUMNS` uses.
 *
 * Getting it wrong is asymmetric: a collection wrongly IN gets a widened item lane, one wrongly OUT keeps the
 * split-brain grant the owner key exists to close. The tripwire covers both directions.
 */
export const OWNER_COLUMN_COLLECTIONS: ReadonlySet<string> = new Set(["assets", "users"]);

/**
 * The owner column to hand `applyScope` for `collection`, off the table backing it.
 *
 * Undefined when the collection binds no owner, when the map names a column the table does not carry, and
 * when the collection is unknown - all three are the fail-closed answer `applyScope` already understands, so
 * a caller never has to distinguish them.
 */
export function listOwnerColumn(collection: string, table?: any): any | undefined {
  const t = table ?? TABLES[collection];
  const prop = LIST_OWNER_COLUMNS[collection];
  return t && prop ? t[prop] : undefined;
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

// Resolve an item's `code` AND whatever else the decision needs off the same row, in ONE read (uncached - the
// extra columns are mutable, unlike code). Lets the middleware gate item reads on row state (e.g.
// "unpublished") and match an owner column without a second read, so the budget stays "the one id->code
// resolve". `cols` are drizzle property names; `ownerProp` is the owner column (LIST_OWNER_COLUMNS) when the
// collection needs one, and comes back separately because it is an OWNER id, not row state.
//
// The owner id still has to become an owner CODE, but that hop is `uuidToCode(deps, "employees", ownerId)` -
// the cached resolver above - so warm it costs no read at all.
export async function resolveItemState(
  deps: Deps,
  collection: string,
  id: string,
  cols: string[],
  ownerProp?: string,
): Promise<{ code: string | null; state: Record<string, unknown>; ownerId: string | null } | null> {
  const t = TABLES[collection];
  if (!t) return null;
  const sel: Record<string, any> = { code: t.code };
  for (const col of cols) if (t[col]) sel[col] = t[col];
  // Selected under a reserved key so a state column of the same name cannot shadow it, and so the owner never
  // lands in `state` (which is matched against the collection's public_when rule).
  if (ownerProp && t[ownerProp]) sel.__owner = t[ownerProp];
  const row = (await deps.db.select(sel).from(t).where(eq(t.uuid, id)).limit(1))[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const { code, __owner, ...state } = row;
  return { code: (code as string | null) ?? null, state, ownerId: (__owner as string | null) ?? null };
}

/**
 * The owner employee CODE for each row of a page, keyed by the row's own code - what the access hint needs for a
 * flat-coded owner-column collection (http/accessHint.ts computeCan).
 *
 * ONE read for the whole page, not one per row. The item lane can lean on the per-isolate uuid->code cache
 * because it resolves a single owner; a hundred-row asset list cold would be a hundred indexed lookups, which is
 * the eager read the D1 budget forbids. So the distinct owners are fetched in a single `IN` (chunked by the
 * usual parameter cap) and mapped back.
 *
 * `ownerProp` is the drizzle property naming the owner column (LIST_OWNER_COLUMNS). Rows with no owner - an
 * asset in stock, a service account with no employee - contribute no entry, and the hint then decides them on
 * the row's own code exactly as it does today.
 */
export async function pageOwnerCodes(deps: Deps, rows: any[], ownerProp: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const owners = [...new Set(rows.map((r) => r?.[ownerProp]).filter((v): v is string => typeof v === "string" && v.length > 0))];
  if (!owners.length) return out;
  const codeOf = new Map<string, string>();
  for (const group of await byIdChunks(owners, (ids) =>
    deps.db.select({ uuid: schema.employees.uuid, code: schema.employees.code }).from(schema.employees).where(inArray(schema.employees.uuid, ids)),
  )) {
    if (group.code) codeOf.set(group.uuid, group.code);
  }
  for (const r of rows) {
    const code = r?.code as string | undefined;
    const owner = r?.[ownerProp] as string | undefined;
    if (code && owner) {
      const oc = codeOf.get(owner);
      if (oc) out.set(code, oc);
    }
  }
  return out;
}

export type IdResolver = (collection: string, id: string) => Promise<string | null>;

// Substitute the top resource id with its code; keep `me`, `-` (AEP parent wildcard), and the trailing :verb.
//
// AN ID THAT DOES NOT RESOLVE IS LEFT AS THE RAW UUID, and what that means for the decision depends on the
// caller's grant - it is not, as this said for a long time, simply "fail closed". A scoped pattern (`me`,
// `my-dept`, `<prefix>-*`) cannot match a uuid, so those do deny. A WILDCARD one matches it like anything
// else: `employees.*` and `employees.**` both match `employees.<uuid>`, so a broadly-granted caller is allowed
// through to a handler that then answers 404 for the row that is not there.
//
// Nothing is reachable through the difference - a caller that `*` allows on an unresolvable id is a caller `*`
// would have allowed on the real code too, so no authority is gained - and it is the right shape for the audit
// row either way. Stated accurately because "fails closed" is the kind of claim that stops the next reader
// checking: if a scope is ever added here that is meant to bound a wildcard holder, THIS is the line it has to
// be checked against.
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
