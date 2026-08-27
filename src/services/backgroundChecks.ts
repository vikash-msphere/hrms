// Background-verification tracking: flat company-wide CRUD + restore over `background_checks`. NO access
// control here - the middleware gates the collection by path + grants (private by default; this is sensitive,
// so super-only until HR is granted via the ACL). Mirrors the compliance-events service.
import { and, eq, isNull } from "drizzle-orm";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";
import { idFromPath } from "./documentsCommon";

const CHECK_TYPES = ["identity", "address", "education", "employment", "criminal", "reference", "credit", "other"] as const;
const STATUSES = ["pending", "in_progress", "clear", "discrepancy", "failed"] as const;
type CheckType = (typeof CHECK_TYPES)[number];
type Status = (typeof STATUSES)[number];

export type BackgroundCheckInput = {
  employee?: string;
  check_type?: CheckType;
  status?: Status;
  vendor?: string | null;
  reference_no?: string | null;
  initiated_date?: string | null;
  completed_date?: string | null;
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
export async function listBackgroundChecks(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const where = and(showDeleted ? undefined : isNull(schema.backgroundChecks.deleteTime), applyScope(scope, schema.backgroundChecks.code, schema.backgroundChecks.employeeId));
  return keysetPage(deps, schema.backgroundChecks, "background-checks", where, { max: maxPageSize, pageToken });
}

export const backgroundCheckSpec: CrudSpec<BackgroundCheckInput, typeof schema.backgroundChecks> = {
  table: schema.backgroundChecks,
  collection: "background-checks",
  auditName: "background-check",
  notFound: "background check not found",
  insert: (input) => {
    const employeeId = idFromPath(input.employee);
    if (!employeeId) throw invalidArgument("employee is required");
    validate(input);
    const status = input.status ?? "pending";
    return {
      employeeId,
      checkType: input.check_type ?? "identity",
      status,
      // Empty string clears, like an omitted field (see web/src/api.ts: nothing on the wire is ever null).
      vendor: input.vendor?.trim() || null,
      referenceNo: input.reference_no?.trim() || null,
      initiatedDate: input.initiated_date ? parseDate(input.initiated_date, "initiated_date") : new Date(),
      completedDate: input.completed_date ? parseDate(input.completed_date, "completed_date") : isFinal(status) ? new Date() : null,
      notes: input.notes?.trim() || null,
      documentId: idFromPath(input.document) ?? null,
    };
  },
  patch: (patch, row) => {
    validate(patch);
    const set: SetOf<typeof schema.backgroundChecks> = {};
    if (has(patch, "employee")) {
      const e = idFromPath(patch.employee);
      if (!e) throw invalidArgument("employee cannot be empty");
      set.employeeId = e;
    }
    if (has(patch, "check_type")) set.checkType = patch.check_type;
    if (has(patch, "vendor")) set.vendor = patch.vendor?.trim() || null;
    if (has(patch, "reference_no")) set.referenceNo = patch.reference_no?.trim() || null;
    if (has(patch, "initiated_date")) set.initiatedDate = patch.initiated_date ? parseDate(patch.initiated_date, "initiated_date") : null;
    if (has(patch, "completed_date")) set.completedDate = patch.completed_date ? parseDate(patch.completed_date, "completed_date") : null;
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    if (has(patch, "document")) set.documentId = idFromPath(patch.document) ?? null;
    if (has(patch, "status")) {
      set.status = patch.status;
      // Reaching a final status stamps completion (unless one was given); reopening clears it.
      if (patch.status && isFinal(patch.status) && !has(patch, "completed_date") && !row.completedDate) set.completedDate = new Date();
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
