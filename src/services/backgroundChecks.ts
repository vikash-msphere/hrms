// Background-verification tracking: employee-OWNED CRUD + restore over `background_checks`. NO access
// control here - the middleware gates the collection by path + grants (private by default; this is sensitive,
// so super-only until HR is granted via the ACL).
//
// The row's code is allocated under its subject's employee code (`allocOwnedCode`), not flat. That is what makes
// the two lanes of one grant agree: the list binds `applyScope` to `employeeId` for an `own`/`dept` breadth, and
// the item lane matches `me` / `my-dept` against the row's CODE. With a flat code the second of those could never
// answer, so `GET /v1/background-checks/<id>` refused a row the list had just returned - which is why this
// collection was left without the `self`/`dept` tiers the rest of its kind carry.
import { and, eq } from "drizzle-orm";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";
import { CODE_WIDTH, allocOwnedCode } from "./codeAlloc";
import { idFromPath } from "./documentsCommon";
import { orgToday, dayStartMs } from "./orgDay";

const CHECK_TYPES = ["identity", "address", "education", "employment", "criminal", "reference", "credit", "other"] as const;
const STATUSES = ["pending", "in_progress", "clear", "discrepancy", "failed"] as const;
type CheckType = (typeof CHECK_TYPES)[number];
type Status = (typeof STATUSES)[number];

export type BackgroundCheckInput = {
  /** The subject. Required on create, and immutable afterwards - the row's code is allocated under them. */
  employee?: string;
  check_type?: CheckType;
  status?: Status;
  vendor?: string | null;
  reference_no?: string | null;
  initiated_date?: string | null;
  completed_date?: string | null;
  /** What the vendor charged. Null clears it; 0 is a real recorded figure and is kept. */
  cost?: number | null;
  notes?: string | null;
  /** `personal-documents/<id>`: the vendor's report, filed as the employee's own document. */
  document?: string | null;
};

const parseDate = (s: string, field: string): Date => {
  const ms = Date.parse(s.length <= 10 ? s + "T00:00:00Z" : s);
  if (Number.isNaN(ms)) throw invalidArgument(`${field} must be YYYY-MM-DD`);
  return new Date(ms);
};
// A finished status (clear/discrepancy/failed) stamps today's completion when none is given.
const isFinal = (s: Status) => s === "clear" || s === "discrepancy" || s === "failed";

function validate(input: BackgroundCheckInput) {
  if (input.check_type && !CHECK_TYPES.includes(input.check_type)) throw invalidArgument("invalid check_type");
  if (input.status && !STATUSES.includes(input.status)) throw invalidArgument("invalid status");
}

// A check belongs to an employee, so the list is row-filtered by the scope the middleware computed (own record
// / own department / all), in SQL - not by the generic whole-table read.
export async function listBackgroundChecks(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false, deletedOnly = false) {
  const where = and(deleteStateFilter(schema.backgroundChecks.deleteTime, showDeleted, deletedOnly), applyScope(scope, schema.backgroundChecks.code, schema.backgroundChecks.employeeId));
  return keysetPage(deps, schema.backgroundChecks, "background-checks", where, { max: maxPageSize, pageToken });
}

export const backgroundCheckSpec: CrudSpec<BackgroundCheckInput, typeof schema.backgroundChecks> = {
  table: schema.backgroundChecks,
  collection: "background-checks",
  auditName: "background-check",
  notFound: "background check not found",
  // Owner-coded under the SUBJECT of the check, which is what a `background-checks.me.**` rule reaches and what
  // lets a manager's `my-dept` rule cover their reports. The owner is fixed at create (see `patch` below).
  allocCode: (deps, table, values, attempt) =>
    allocOwnedCode(deps, table, schema.backgroundChecks.employeeId, values.employeeId as string, CODE_WIDTH.owned, attempt > 1),
  insert: async (input, deps) => {
    const employeeId = idFromPath(input.employee);
    if (!employeeId) throw invalidArgument("employee is required");
    validate(input);
    const status = input.status ?? "pending";
    // `initiated_date` / `completed_date` are DAY columns - a caller's value is parsed to UTC midnight and the
    // serializer reads them back with `.slice(0, 10)` - so a stamped default has to be the ORG's day, not the
    // instant the request arrived. In IST a check completed at 00:30 local was filed as completed yesterday.
    const today = new Date(dayStartMs(await orgToday(deps)));
    return {
      employeeId,
      checkType: input.check_type ?? "identity",
      status,
      // Empty string clears, like an omitted field (see web/src/api.ts: nothing on the wire is ever null).
      vendor: input.vendor?.trim() || null,
      referenceNo: input.reference_no?.trim() || null,
      initiatedDate: input.initiated_date ? parseDate(input.initiated_date, "initiated_date") : today,
      completedDate: input.completed_date ? parseDate(input.completed_date, "completed_date") : isFinal(status) ? today : null,
      // `?? null`, not `|| null`: a check that cost nothing is a recorded 0, which is a different fact from an
      // invoice nobody has entered yet.
      cost: input.cost ?? null,
      notes: input.notes?.trim() || null,
      documentId: idFromPath(input.document) ?? null,
    };
  },
  patch: async (patch, row, deps) => {
    validate(patch);
    const set: SetOf<typeof schema.backgroundChecks> = {};
    // The SUBJECT is immutable. The row's code is allocated under their employee code and a code never changes:
    // nothing in this codebase re-codes a row when its owner column moves (codeCascade rewrites prefixes when an
    // EMPLOYEE moves department, which is a different operation). So a re-point would leave the code under the
    // previous subject - the row would keep answering their `me` rule and their manager's `my-dept` one, and stop
    // answering the new subject's, silently and permanently. Re-filing is the honest way to correct a mis-filed
    // check, and it leaves an audit trail of both acts.
    if (has(patch, "employee")) throw invalidArgument("employee cannot be changed; delete this check and file it against the right employee");
    if (has(patch, "check_type")) set.checkType = patch.check_type;
    if (has(patch, "vendor")) set.vendor = patch.vendor?.trim() || null;
    if (has(patch, "reference_no")) set.referenceNo = patch.reference_no?.trim() || null;
    if (has(patch, "initiated_date")) set.initiatedDate = patch.initiated_date ? parseDate(patch.initiated_date, "initiated_date") : null;
    if (has(patch, "completed_date")) set.completedDate = patch.completed_date ? parseDate(patch.completed_date, "completed_date") : null;
    if (has(patch, "cost")) set.cost = patch.cost ?? null;
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    if (has(patch, "document")) set.documentId = idFromPath(patch.document) ?? null;
    if (has(patch, "status")) {
      set.status = patch.status;
      // Reaching a final status stamps completion (unless one was given); reopening clears it. The org's
      // calendar day, for the reason the insert states.
      if (patch.status && isFinal(patch.status) && !has(patch, "completed_date") && !row.completedDate) set.completedDate = new Date(dayStartMs(await orgToday(deps)));
      if (patch.status && !isFinal(patch.status) && !has(patch, "completed_date")) set.completedDate = null;
    }
    return set;
  },
  // Keep a linked onboarding task in sync: a final outcome (clear/discrepancy/failed) completes it; reopening
  // the check reopens the task. The task carries no sensitive status, so this is safe for the subject view.
  afterUpdate: async (deps, _actor, row, _before, patch) => {
    if (!has(patch, "status") || !patch.status) return;
    const done = isFinal(patch.status);
    await deps.db.update(schema.transitionTasks)
      .set({ status: done ? "DONE" : "TODO", completedAt: done ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.transitionTasks.backgroundCheckId, row.uuid));
  },
};

const svc = crudService(backgroundCheckSpec);
export const {
  get: getBackgroundCheck,
  create: createBackgroundCheck,
  update: updateBackgroundCheck,
  remove: deleteBackgroundCheck,
  restore: restoreBackgroundCheck,
  purge: purgeBackgroundCheck,
} = svc;
