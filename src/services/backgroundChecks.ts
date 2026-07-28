// Background-verification tracking: flat company-wide CRUD + restore over `background_checks`. NO access
// control here - the middleware gates the collection by path + grants (private by default; this is sensitive,
// so super-only until HR is granted via the ACL). Mirrors the compliance-events service.
import { and, eq, isNull } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";
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
};

const parseDate = (s: string, field: string): Date => {
  const ms = Date.parse(s.length <= 10 ? s + "T00:00:00Z" : s);
  if (Number.isNaN(ms)) throw invalidArgument(`${field} must be YYYY-MM-DD`);
  return new Date(ms);
};
// A finished status (clear/discrepancy/failed) stamps today's completion when none is given.
const isFinal = (s: Status) => s === "clear" || s === "discrepancy" || s === "failed";

export async function listBackgroundChecks(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const where = and(showDeleted ? undefined : isNull(schema.backgroundChecks.deleteTime), applyScope(scope, schema.backgroundChecks.code, schema.backgroundChecks.employeeId));
  return keysetPage(deps, schema.backgroundChecks, "background-checks", where, { dir: "asc", max: maxPageSize, pageToken });
}

export async function getBackgroundCheck(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.backgroundChecks).where(eq(schema.backgroundChecks.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("background check not found");
  return row;
}

function validate(input: BackgroundCheckInput) {
  if (input.check_type && !CHECK_TYPES.includes(input.check_type)) throw invalidArgument("invalid check_type");
  if (input.status && !STATUSES.includes(input.status)) throw invalidArgument("invalid status");
}

export async function createBackgroundCheck(deps: Deps, actor: AppUser, input: BackgroundCheckInput, id?: string) {
  const employeeId = idFromPath(input.employee);
  if (!employeeId) throw invalidArgument("employee is required");
  validate(input);
  const status = input.status ?? "pending";
  const row = (await deps.db
    .insert(schema.backgroundChecks)
    .values({
      code: await allocFlatCode(deps, schema.backgroundChecks),
      ...(id ? { uuid: id } : {}),
      employeeId,
      checkType: input.check_type ?? "identity",
      status,
      vendor: input.vendor ?? null,
      referenceNo: input.reference_no ?? null,
      initiatedDate: input.initiated_date ? parseDate(input.initiated_date, "initiated_date") : new Date(),
      completedDate: input.completed_date ? parseDate(input.completed_date, "completed_date") : isFinal(status) ? new Date() : null,
      notes: input.notes ?? null,
    })
    .returning())[0]!;
  await audit(deps, actor, "background-check.create", "background-checks", row.uuid, undefined, row);
  return row;
}

export async function updateBackgroundCheck(deps: Deps, actor: AppUser, id: string, patch: BackgroundCheckInput, ifMatch?: string) {
  const row = await getBackgroundCheck(deps, id);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  validate(patch);
  const has = (k: keyof BackgroundCheckInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (has("employee")) { const e = idFromPath(patch.employee); if (!e) throw invalidArgument("employee cannot be empty"); set.employeeId = e; }
  if (has("check_type")) set.checkType = patch.check_type;
  if (has("vendor")) set.vendor = patch.vendor ?? null;
  if (has("reference_no")) set.referenceNo = patch.reference_no ?? null;
  if (has("initiated_date")) set.initiatedDate = patch.initiated_date ? parseDate(patch.initiated_date, "initiated_date") : null;
  if (has("completed_date")) set.completedDate = patch.completed_date ? parseDate(patch.completed_date, "completed_date") : null;
  if (has("notes")) set.notes = patch.notes ?? null;
  if (has("status")) {
    set.status = patch.status;
    // Reaching a final status stamps completion (unless one was given); reopening clears it.
    if (patch.status && isFinal(patch.status) && !has("completed_date") && !row.completedDate) set.completedDate = new Date();
    if (patch.status && !isFinal(patch.status) && !has("completed_date")) set.completedDate = null;
  }
  const updated = (await deps.db.update(schema.backgroundChecks).set(set).where(eq(schema.backgroundChecks.uuid, id)).returning())[0]!;
  // Keep a linked onboarding task in sync: a final outcome (clear/discrepancy/failed) completes it; reopening
  // the check reopens the task. The task carries no sensitive status, so this is safe for the subject view.
  if (has("status") && patch.status) {
    const done = isFinal(patch.status);
    await deps.db.update(schema.transitionTasks)
      .set({ status: done ? "DONE" : "TODO", completedAt: done ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.transitionTasks.backgroundCheckId, id));
  }
  await audit(deps, actor, "background-check.update", "background-checks", id, diffMeta(row, updated, set), updated);
  return updated;
}

export const deleteBackgroundCheck = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) =>
  softDeleteRow(deps, actor, schema.backgroundChecks, "background check", "background-checks", id, ifMatch);
export const restoreBackgroundCheck = (deps: Deps, actor: AppUser, id: string) =>
  restoreRow(deps, actor, schema.backgroundChecks, "background check", "background-checks", id);
export const purgeBackgroundCheck = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) =>
  purgeRow(deps, actor, schema.backgroundChecks, "background check", "background-checks", id, ifMatch);
