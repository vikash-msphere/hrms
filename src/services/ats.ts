// ATS service: flat company-wide CRUD for job requisitions, candidates, and applications, plus the pipeline
// custom methods (`:advance`, `:reject`). NO access control here - the middleware gates each collection by
// path + grants (private by default; recruiter/HR granted via the ACL). Mirrors the flat-collection pattern
// of services/backgroundChecks.ts; the pipeline stage rules live in domain/ats.ts (pure + tested).
import { eq, and, isNull, sql } from "drizzle-orm";
import { allocFlatCode, allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { keysetPage } from "./keysetPage";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted, failedPrecondition, oneOf } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { idFromPath } from "./documentsCommon";
import { getSettingValue } from "./settings";
import {
  DEFAULT_ATS_CONFIG, type AtsConfig, isStage, nextStage, statusForStage,
  REQUISITION_STATUSES, type RequisitionStatus, canOfferTransition, type OfferStatus,
} from "../domain/ats";
import { createEmployee } from "./employees";
import { reviseCompensation } from "./compensation";
import { emitEvent } from "./eventBus";
import { notify } from "./notifications";

const cfgOf = (deps: Deps) => getSettingValue<AtsConfig>(deps, "ats", DEFAULT_ATS_CONFIG);
const parseDate = (s: string, field: string): Date => {
  const ms = Date.parse(s.length <= 10 ? s + "T00:00:00Z" : s);
  if (Number.isNaN(ms)) throw invalidArgument(`${field} must be YYYY-MM-DD`);
  return new Date(ms);
};

// ---- Job requisitions ----------------------------------------------------------------------------------------

const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "intern", "temporary"] as const;
export type RequisitionInput = {
  title?: string | null;
  department?: string | null;
  hiring_manager?: string | null;
  location?: string | null;
  employment_type?: string | null;
  openings?: number | null;
  description?: string | null;
  status?: string | null;
  opened_date?: string | null;
  closed_date?: string | null;
};

export async function listRequisitions(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, statusFilter?: string, showDeleted = false) {
  const conds = [];
  if (statusFilter) conds.push(eq(schema.jobRequisitions.status, statusFilter as RequisitionStatus));
  if (!showDeleted) conds.push(isNull(schema.jobRequisitions.deleteTime));
  const scoped = applyScope(scope, schema.jobRequisitions.code, schema.jobRequisitions.code);
  if (scoped) conds.push(scoped);
  return keysetPage(deps, schema.jobRequisitions, "job-requisitions", conds.length ? and(...conds) : undefined, { dir: "asc", max: maxPageSize, pageToken });
}

// Active-application counts keyed by requisition uuid, for the Jobs list badge (one grouped query).
export async function applicantCountsByRequisition(deps: Deps): Promise<Map<string, number>> {
  const rows = await deps.db
    .select({ requisitionId: schema.applications.requisitionId, n: sql<number>`count(*)` })
    .from(schema.applications)
    .where(isNull(schema.applications.deleteTime))
    .groupBy(schema.applications.requisitionId);
  return new Map(rows.map((r) => [r.requisitionId, Number(r.n)]));
}

async function getRequisition(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, id)).limit(1))[0];
  if (!row) throw notFound("requisition not found");
  return row;
}

export async function createRequisition(deps: Deps, actor: AppUser, input: RequisitionInput, id?: string) {
  const title = (input.title ?? "").trim();
  if (!title) throw invalidArgument("title is required");
  if (input.employment_type && !EMPLOYMENT_TYPES.includes(input.employment_type as any)) throw invalidArgument("invalid employment_type");
  const status = (input.status ?? "draft") as RequisitionStatus;
  if (!REQUISITION_STATUSES.includes(status)) throw invalidArgument("invalid status");
  const row = (await deps.db
    .insert(schema.jobRequisitions)
    .values({
      code: await allocFlatCode(deps, schema.jobRequisitions),
      ...(id ? { uuid: id } : {}),
      title,
      departmentId: input.department ? idFromPath(input.department) : null,
      hiringManagerId: input.hiring_manager ? idFromPath(input.hiring_manager) : null,
      location: input.location?.trim() || null,
      employmentType: (input.employment_type as any) || null,
      openings: input.openings ?? 1,
      description: input.description?.trim() || null,
      status,
      openedDate: input.opened_date ? parseDate(input.opened_date, "opened_date") : status === "open" ? new Date() : null,
      closedDate: input.closed_date ? parseDate(input.closed_date, "closed_date") : null,
    })
    .returning())[0]!;
  await audit(deps, actor, "requisition.create", "job-requisitions", row.uuid, undefined, row);
  return row;
}

export async function updateRequisition(deps: Deps, actor: AppUser, id: string, patch: RequisitionInput, ifMatch?: string) {
  const row = await getRequisition(deps, id);
  if (row.deleteTime) throw notFound("requisition not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.jobRequisitions> = { updatedAt: new Date() };
  if (patch.title !== undefined) { const t = (patch.title ?? "").trim(); if (!t) throw invalidArgument("title cannot be blank"); set.title = t; }
  if (patch.department !== undefined) set.departmentId = patch.department ? idFromPath(patch.department) : null;
  if (patch.hiring_manager !== undefined) set.hiringManagerId = patch.hiring_manager ? idFromPath(patch.hiring_manager) : null;
  if (patch.location !== undefined) set.location = patch.location?.trim() || null;
  if (patch.employment_type !== undefined) set.employmentType = patch.employment_type ? oneOf(patch.employment_type, EMPLOYMENT_TYPES, "invalid employment_type") : null;
  if (patch.openings !== undefined && patch.openings != null) { if (!(patch.openings > 0)) throw invalidArgument("openings must be greater than 0"); set.openings = patch.openings; }
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.opened_date !== undefined) set.openedDate = patch.opened_date ? parseDate(patch.opened_date, "opened_date") : null;
  if (patch.closed_date !== undefined) set.closedDate = patch.closed_date ? parseDate(patch.closed_date, "closed_date") : null;
  if (patch.status !== undefined) {
    const s = patch.status as RequisitionStatus;
    if (!REQUISITION_STATUSES.includes(s)) throw invalidArgument("invalid status");
    set.status = s;
    // Stamp lifecycle dates on first open / on close, without clobbering an explicit patch value.
    if (s === "open" && !row.openedDate && patch.opened_date === undefined) set.openedDate = new Date();
    if ((s === "closed" || s === "filled") && !row.closedDate && patch.closed_date === undefined) set.closedDate = new Date();
  }
  const updated = (await deps.db.update(schema.jobRequisitions).set(set).where(eq(schema.jobRequisitions.uuid, id)).returning())[0]!;
  await audit(deps, actor, "requisition.update", "job-requisitions", id, diffMeta(row, updated, set), updated);
  return updated;
}


// ---- Candidates ----------------------------------------------------------------------------------------------

export type CandidateInput = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  source_detail?: string | null;
  referral?: string | null;
  tags?: string | null;
  notes?: string | null;
};

export async function listCandidates(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const where = and(showDeleted ? undefined : isNull(schema.candidates.deleteTime), applyScope(scope, schema.candidates.code, schema.candidates.code));
  return keysetPage(deps, schema.candidates, "candidates", where, { dir: "asc", max: maxPageSize, pageToken });
}

export async function getCandidate(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.candidates).where(eq(schema.candidates.uuid, id)).limit(1))[0];
  if (!row) throw notFound("candidate not found");
  return row;
}

export async function createCandidate(deps: Deps, actor: AppUser, input: CandidateInput, id?: string) {
  const name = (input.name ?? "").trim();
  if (!name) throw invalidArgument("name is required");
  const row = (await deps.db
    .insert(schema.candidates)
    .values({
      code: await allocFlatCode(deps, schema.candidates),
      ...(id ? { uuid: id } : {}),
      name,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      source: input.source?.trim() || null,
      sourceDetail: input.source_detail?.trim() || null,
      referralId: input.referral ? idFromPath(input.referral) : null,
      tags: input.tags?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .returning())[0]!;
  await audit(deps, actor, "candidate.create", "candidates", row.uuid, undefined, row);
  return row;
}

export async function updateCandidate(deps: Deps, actor: AppUser, id: string, patch: CandidateInput, ifMatch?: string) {
  const row = await getCandidate(deps, id);
  if (row.deleteTime) throw notFound("candidate not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.candidates> = { updatedAt: new Date() };
  if (patch.name !== undefined) { const n = (patch.name ?? "").trim(); if (!n) throw invalidArgument("name cannot be blank"); set.name = n; }
  if (patch.email !== undefined) set.email = patch.email?.trim() || null;
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.source !== undefined) set.source = patch.source?.trim() || null;
  if (patch.source_detail !== undefined) set.sourceDetail = patch.source_detail?.trim() || null;
  if (patch.referral !== undefined) set.referralId = patch.referral ? idFromPath(patch.referral) : null;
  if (patch.tags !== undefined) set.tags = patch.tags?.trim() || null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  const updated = (await deps.db.update(schema.candidates).set(set).where(eq(schema.candidates.uuid, id)).returning())[0]!;
  await audit(deps, actor, "candidate.update", "candidates", id, diffMeta(row, updated, set), updated);
  return updated;
}


// ---- Applications --------------------------------------------------------------------------------------------

export type ApplicationInput = {
  candidate?: string | null;
  requisition?: string | null;
  stage?: string | null;
  source?: string | null;
  referral?: string | null;
  applied_date?: string | null;
};

export async function listApplications(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, opts: { requisition?: string; candidate?: string; stage?: string; status?: string; showDeleted?: boolean } = {}) {
  const conds = [];
  if (opts.requisition) conds.push(eq(schema.applications.requisitionId, idFromPath(opts.requisition)!));
  if (opts.candidate) conds.push(eq(schema.applications.candidateId, idFromPath(opts.candidate)!));
  if (opts.stage) conds.push(eq(schema.applications.stage, opts.stage));
  if (opts.status) conds.push(eq(schema.applications.status, opts.status as any));
  if (!opts.showDeleted) conds.push(isNull(schema.applications.deleteTime));
  const scoped = applyScope(scope, schema.applications.code, schema.applications.code);
  if (scoped) conds.push(scoped);
  return keysetPage(deps, schema.applications, "applications", conds.length ? and(...conds) : undefined, { dir: "asc", max: maxPageSize, pageToken });
}

async function getApplication(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.applications).where(eq(schema.applications.uuid, id)).limit(1))[0];
  if (!row) throw notFound("application not found");
  return row;
}

export async function createApplication(deps: Deps, actor: AppUser, input: ApplicationInput, id?: string) {
  const candidateId = input.candidate ? idFromPath(input.candidate) : null;
  const requisitionId = input.requisition ? idFromPath(input.requisition) : null;
  if (!candidateId) throw invalidArgument("candidate is required");
  if (!requisitionId) throw invalidArgument("requisition is required");
  const cfg = await cfgOf(deps);
  const stage = input.stage ?? cfg.stages[0]?.key ?? "applied";
  if (!isStage(cfg, stage)) throw invalidArgument("invalid stage");
  // A candidate defaults their source onto a new application when none is given.
  const cand = (await deps.db.select({ source: schema.candidates.source, referralId: schema.candidates.referralId }).from(schema.candidates).where(eq(schema.candidates.uuid, candidateId)).limit(1))[0];
  const row = (await deps.db
    .insert(schema.applications)
    .values({
      code: await allocFlatCode(deps, schema.applications),
      ...(id ? { uuid: id } : {}),
      candidateId,
      requisitionId,
      stage,
      status: statusForStage(cfg, stage),
      source: input.source?.trim() || cand?.source || null,
      referralId: input.referral ? idFromPath(input.referral) : cand?.referralId ?? null,
      appliedDate: input.applied_date ? parseDate(input.applied_date, "applied_date") : new Date(),
      stageChangedDate: new Date(),
    })
    .returning())[0]!;
  await audit(deps, actor, "application.create", "applications", row.uuid, undefined, row);
  return row;
}

// Set the pipeline stage directly (HR edit) or via `:advance`. Landing on a hired-kind stage flips status to
// "hired"; moving back to an active stage from a terminal outcome re-activates it.
async function setStage(deps: Deps, actor: AppUser, id: string, stage: string): Promise<typeof schema.applications.$inferSelect> {
  const row = await getApplication(deps, id);
  if (row.deleteTime) throw notFound("application not found");
  const cfg = await cfgOf(deps);
  if (!isStage(cfg, stage)) throw invalidArgument("invalid stage");
  const [updated] = await deps.db
    .update(schema.applications)
    .set({ stage, status: statusForStage(cfg, stage), rejectionReason: null, stageChangedDate: new Date(), updatedAt: new Date() })
    .where(eq(schema.applications.uuid, id))
    .returning();
  await audit(deps, actor, "application.stage", "applications", id, { stage });
  await emitEvent(deps, actor, "application.stageChanged", { subject: `applications/${id}`, payload: { stage, status: updated!.status } });
  return updated!;
}

export async function updateApplication(deps: Deps, actor: AppUser, id: string, patch: ApplicationInput & { status?: string | null }, ifMatch?: string) {
  const row = await getApplication(deps, id);
  if (row.deleteTime) throw notFound("application not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  if (patch.stage !== undefined && patch.stage) return setStage(deps, actor, id, patch.stage);
  const set: SetOf<typeof schema.applications> = { updatedAt: new Date() };
  if (patch.source !== undefined) set.source = patch.source?.trim() || null;
  if (patch.referral !== undefined) set.referralId = patch.referral ? idFromPath(patch.referral) : null;
  if (patch.applied_date !== undefined) set.appliedDate = patch.applied_date ? parseDate(patch.applied_date, "applied_date") : null;
  if (patch.status !== undefined && patch.status === "withdrawn") set.status = "withdrawn";
  const updated = (await deps.db.update(schema.applications).set(set).where(eq(schema.applications.uuid, id)).returning())[0]!;
  await audit(deps, actor, "application.update", "applications", id, diffMeta(row, updated, set), updated);
  return updated;
}

// `:advance` - move one stage forward in the configured pipeline (or to an explicit target stage).
export async function advanceApplication(deps: Deps, actor: AppUser, id: string, targetStage?: string) {
  const row = await getApplication(deps, id);
  if (row.deleteTime) throw notFound("application not found");
  if (row.status !== "active") throw failedPrecondition("application is not active");
  const cfg = await cfgOf(deps);
  const next = targetStage ?? nextStage(cfg, row.stage);
  if (!next) throw failedPrecondition("already at the final stage");
  return setStage(deps, actor, id, next);
}

// `:reject` - end the application with a coarse "rejected" status + a reason.
export async function rejectApplication(deps: Deps, actor: AppUser, id: string, reason?: string) {
  const row = await getApplication(deps, id);
  if (row.deleteTime) throw notFound("application not found");
  const [updated] = await deps.db
    .update(schema.applications)
    .set({ status: "rejected", rejectionReason: reason?.trim() || null, stageChangedDate: new Date(), updatedAt: new Date() })
    .where(eq(schema.applications.uuid, id))
    .returning();
  await audit(deps, actor, "application.reject", "applications", id, { reason });
  return updated!;
}


// ---- Interviews ----------------------------------------------------------------------------------------------

const INTERVIEW_MODES = ["onsite", "video", "phone"] as const;
export type InterviewInput = {
  application?: string | null;
  title?: string | null;
  mode?: string | null;
  scheduled_start_time?: string | null;
  scheduled_end_time?: string | null;
  interviewers?: string[] | null;
  location?: string | null;
  status?: string | null;
};
// Normalise an interviewers array (employee paths/ids, already edge-decoded to ids) to a de-duped JSON array.
const interviewersJson = (v?: string[] | null) => JSON.stringify(Array.from(new Set((v ?? []).map((a) => idFromPath(a)).filter((x): x is string => !!x))));
const parseTs = (s: string, field: string): Date => { const ms = Date.parse(s); if (Number.isNaN(ms)) throw invalidArgument(`${field} is not a valid time`); return new Date(ms); };

export async function listInterviews(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, opts: { application?: string; status?: string; showDeleted?: boolean } = {}) {
  const conds = [];
  if (opts.application) conds.push(eq(schema.interviews.applicationId, idFromPath(opts.application)!));
  if (opts.status) conds.push(eq(schema.interviews.status, opts.status as any));
  if (!opts.showDeleted) conds.push(isNull(schema.interviews.deleteTime));
  const scoped = applyScope(scope, schema.interviews.code, schema.interviews.code);
  if (scoped) conds.push(scoped);
  return keysetPage(deps, schema.interviews, "interviews", conds.length ? and(...conds) : undefined, { dir: "asc", max: maxPageSize, pageToken });
}

async function getInterview(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.interviews).where(eq(schema.interviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("interview not found");
  return row;
}

// Candidate display name behind an application (for interview notification bodies). "the candidate" on miss.
async function candidateNameForApplication(deps: Deps, applicationId: string): Promise<string> {
  const app = (await deps.db.select({ c: schema.applications.candidateId }).from(schema.applications).where(eq(schema.applications.uuid, applicationId)).limit(1))[0];
  if (!app?.c) return "the candidate";
  const cand = (await deps.db.select({ n: schema.candidates.name }).from(schema.candidates).where(eq(schema.candidates.uuid, app.c)).limit(1))[0];
  return cand?.n?.trim() || "the candidate";
}
const parseIdList = (json: string | null): string[] => { try { return (JSON.parse(json ?? "[]") as string[]).filter((x) => typeof x === "string"); } catch { return []; } };

export async function createInterview(deps: Deps, actor: AppUser, input: InterviewInput, id?: string) {
  const applicationId = input.application ? idFromPath(input.application) : null;
  if (!applicationId) throw invalidArgument("application is required");
  const title = (input.title ?? "").trim();
  if (!title) throw invalidArgument("title is required");
  if (input.mode && !INTERVIEW_MODES.includes(input.mode as any)) throw invalidArgument("invalid mode");
  const row = (await deps.db
    .insert(schema.interviews)
    .values({
      code: await allocFlatCode(deps, schema.interviews),
      ...(id ? { uuid: id } : {}),
      applicationId,
      title,
      mode: (input.mode as any) || "video",
      scheduledStart: input.scheduled_start_time ? parseTs(input.scheduled_start_time, "scheduled_start_time") : null,
      scheduledEnd: input.scheduled_end_time ? parseTs(input.scheduled_end_time, "scheduled_end_time") : null,
      interviewerIds: interviewersJson(input.interviewers),
      location: input.location?.trim() || null,
    })
    .returning())[0]!;
  await audit(deps, actor, "interview.create", "interviews", row.uuid, undefined, row);
  // Notify each interviewer they're scheduled (with the candidate + time).
  const candName = await candidateNameForApplication(deps, applicationId);
  const when = row.scheduledStart ? ` on ${new Date(row.scheduledStart).toLocaleString()}` : "";
  for (const iv of parseIdList(row.interviewerIds).filter((x) => x !== actor.employeeId))
    await notify(deps, { recipient: iv, type: "recruiting.interview_scheduled", title: "Interview scheduled", body: `${title} with ${candName}${when}.`, link: "interviews", subject: `interviews/${row.uuid}`, action: "respond", actorId: actor.employeeId });
  return row;
}

export async function updateInterview(deps: Deps, actor: AppUser, id: string, patch: InterviewInput, ifMatch?: string) {
  const row = await getInterview(deps, id);
  if (row.deleteTime) throw notFound("interview not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.interviews> = { updatedAt: new Date() };
  if (patch.title !== undefined) { const t = (patch.title ?? "").trim(); if (!t) throw invalidArgument("title cannot be blank"); set.title = t; }
  if (patch.mode !== undefined) set.mode = patch.mode ? oneOf(patch.mode, INTERVIEW_MODES, "invalid mode") : "video";
  if (patch.scheduled_start_time !== undefined) set.scheduledStart = patch.scheduled_start_time ? parseTs(patch.scheduled_start_time, "scheduled_start_time") : null;
  if (patch.scheduled_end_time !== undefined) set.scheduledEnd = patch.scheduled_end_time ? parseTs(patch.scheduled_end_time, "scheduled_end_time") : null;
  if (patch.interviewers !== undefined) set.interviewerIds = interviewersJson(patch.interviewers);
  if (patch.location !== undefined) set.location = patch.location?.trim() || null;
  const updated = (await deps.db.update(schema.interviews).set(set).where(eq(schema.interviews.uuid, id)).returning())[0]!;
  await audit(deps, actor, "interview.update", "interviews", id, diffMeta(row, updated, set), updated);
  // A reschedule notifies every interviewer; a changed panel notifies only the newly-added interviewers.
  const timeChanged = set.scheduledStart !== undefined && +new Date(row.scheduledStart ?? 0) !== +new Date(updated.scheduledStart ?? 0);
  const current = parseIdList(updated.interviewerIds);
  const added = current.filter((x) => !parseIdList(row.interviewerIds).includes(x));
  const targets = new Set([...(timeChanged ? current : []), ...added].filter((x) => x !== actor.employeeId));
  if (targets.size && updated.applicationId) {
    const candName = await candidateNameForApplication(deps, updated.applicationId);
    const when = updated.scheduledStart ? ` on ${new Date(updated.scheduledStart).toLocaleString()}` : "";
    for (const iv of targets)
      await notify(deps, { recipient: iv, type: "recruiting.interview_scheduled", title: timeChanged ? "Interview rescheduled" : "Added to an interview", body: `${updated.title} with ${candName}${when}.`, link: "interviews", subject: `interviews/${id}`, action: "respond", actorId: actor.employeeId });
  }
  return updated;
}

async function setInterviewStatus(deps: Deps, actor: AppUser, id: string, status: "done" | "cancelled") {
  const row = await getInterview(deps, id);
  if (row.deleteTime) throw notFound("interview not found");
  const [updated] = await deps.db.update(schema.interviews).set({ status, updatedAt: new Date() }).where(eq(schema.interviews.uuid, id)).returning();
  await audit(deps, actor, `interview.${status === "done" ? "complete" : "cancel"}`, "interviews", id);
  return updated!;
}
export const completeInterview = (deps: Deps, actor: AppUser, id: string) => setInterviewStatus(deps, actor, id, "done");
export const cancelInterview = (deps: Deps, actor: AppUser, id: string) => setInterviewStatus(deps, actor, id, "cancelled");


// ---- Interview feedback (scorecards) -------------------------------------------------------------------------

const RECOMMENDATIONS = ["strong_yes", "yes", "no", "strong_no"] as const;
export type FeedbackInput = {
  interview?: string | null;
  author?: string | null;
  ratings?: Record<string, number> | null;
  overall_rating?: number | null;
  recommendation?: string | null;
  comment?: string | null;
};

export async function listInterviewFeedback(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, opts: { interview?: string; showDeleted?: boolean } = {}) {
  const conds = [applyScope(scope, schema.interviewFeedback.code, schema.interviewFeedback.authorId)];
  if (opts.interview) conds.push(eq(schema.interviewFeedback.interviewId, idFromPath(opts.interview)!));
  if (!opts.showDeleted) conds.push(isNull(schema.interviewFeedback.deleteTime));
  return keysetPage(deps, schema.interviewFeedback, "interview-feedback", and(...conds.filter(Boolean)), { dir: "asc", max: maxPageSize, pageToken });
}

async function getInterviewFeedback(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.interviewFeedback).where(eq(schema.interviewFeedback.uuid, id)).limit(1))[0];
  if (!row) throw notFound("scorecard not found");
  return row;
}

export async function createInterviewFeedback(deps: Deps, actor: AppUser, input: FeedbackInput, id?: string) {
  const interviewId = input.interview ? idFromPath(input.interview) : null;
  if (!interviewId) throw invalidArgument("interview is required");
  const authorId = (input.author ? idFromPath(input.author) : undefined) ?? actor.employeeId;
  if (!authorId) throw invalidArgument("author is required");
  if (input.recommendation && !RECOMMENDATIONS.includes(input.recommendation as any)) throw invalidArgument("invalid recommendation");
  const row = (await deps.db
    .insert(schema.interviewFeedback)
    .values({
      code: await allocOwnedCode(deps, schema.interviewFeedback, schema.interviewFeedback.authorId, authorId),
      ...(id ? { uuid: id } : {}),
      interviewId,
      authorId,
      ratingsJson: input.ratings ? JSON.stringify(input.ratings) : null,
      overallRating: input.overall_rating ?? null,
      recommendation: (input.recommendation as any) || null,
      comment: input.comment?.trim() || null,
    })
    .returning())[0]!;
  await audit(deps, actor, "interview-feedback.create", "interview-feedback", row.uuid, undefined, row);
  return row;
}

export async function updateInterviewFeedback(deps: Deps, actor: AppUser, id: string, patch: FeedbackInput, ifMatch?: string) {
  const row = await getInterviewFeedback(deps, id);
  if (row.deleteTime) throw notFound("scorecard not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.interviewFeedback> = { updatedAt: new Date() };
  if (patch.ratings !== undefined) set.ratingsJson = patch.ratings ? JSON.stringify(patch.ratings) : null;
  if (patch.overall_rating !== undefined) set.overallRating = patch.overall_rating ?? null;
  if (patch.recommendation !== undefined) set.recommendation = patch.recommendation ? oneOf(patch.recommendation, RECOMMENDATIONS, "invalid recommendation") : null;
  if (patch.comment !== undefined) set.comment = patch.comment?.trim() || null;
  const updated = (await deps.db.update(schema.interviewFeedback).set(set).where(eq(schema.interviewFeedback.uuid, id)).returning())[0]!;
  await audit(deps, actor, "interview-feedback.update", "interview-feedback", id, diffMeta(row, updated, set), updated);
  return updated;
}


// ---- Offers --------------------------------------------------------------------------------------------------

const ymd = (d: Date | number) => new Date(d).toISOString().slice(0, 10);
export type OfferInput = {
  application?: string | null;
  base_comp?: number | null;
  currency_code?: string | null;
  offer_date?: string | null;
  join_date?: string | null;
  expiry_date?: string | null;
  notes?: string | null;
};

export async function listOffers(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, opts: { application?: string; status?: string; showDeleted?: boolean } = {}) {
  const conds = [];
  if (opts.application) conds.push(eq(schema.offers.applicationId, idFromPath(opts.application)!));
  if (opts.status) conds.push(eq(schema.offers.status, opts.status as any));
  if (!opts.showDeleted) conds.push(isNull(schema.offers.deleteTime));
  const scoped = applyScope(scope, schema.offers.code, schema.offers.code);
  if (scoped) conds.push(scoped);
  return keysetPage(deps, schema.offers, "offers", conds.length ? and(...conds) : undefined, { dir: "asc", max: maxPageSize, pageToken });
}

async function getOffer(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.offers).where(eq(schema.offers.uuid, id)).limit(1))[0];
  if (!row) throw notFound("offer not found");
  return row;
}

export async function createOffer(deps: Deps, actor: AppUser, input: OfferInput, id?: string) {
  const applicationId = input.application ? idFromPath(input.application) : null;
  if (!applicationId) throw invalidArgument("application is required");
  const row = (await deps.db
    .insert(schema.offers)
    .values({
      code: await allocFlatCode(deps, schema.offers),
      ...(id ? { uuid: id } : {}),
      applicationId,
      baseComp: input.base_comp ?? null,
      currency: input.currency_code?.trim() || "INR",
      offerDate: input.offer_date ? parseDate(input.offer_date, "offer_date") : null,
      joinDate: input.join_date ? parseDate(input.join_date, "join_date") : null,
      expiryDate: input.expiry_date ? parseDate(input.expiry_date, "expiry_date") : null,
      notes: input.notes?.trim() || null,
    })
    .returning())[0]!;
  await audit(deps, actor, "offer.create", "offers", row.uuid, undefined, row);
  return row;
}

export async function updateOffer(deps: Deps, actor: AppUser, id: string, patch: OfferInput, ifMatch?: string) {
  const row = await getOffer(deps, id);
  if (row.deleteTime) throw notFound("offer not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  if (row.status !== "draft") throw failedPrecondition("only a draft offer can be edited");
  const set: SetOf<typeof schema.offers> = { updatedAt: new Date() };
  if (patch.base_comp !== undefined) set.baseComp = patch.base_comp ?? null;
  if (patch.currency_code !== undefined) set.currency = patch.currency_code?.trim() || "INR";
  if (patch.offer_date !== undefined) set.offerDate = patch.offer_date ? parseDate(patch.offer_date, "offer_date") : null;
  if (patch.join_date !== undefined) set.joinDate = patch.join_date ? parseDate(patch.join_date, "join_date") : null;
  if (patch.expiry_date !== undefined) set.expiryDate = patch.expiry_date ? parseDate(patch.expiry_date, "expiry_date") : null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  const updated = (await deps.db.update(schema.offers).set(set).where(eq(schema.offers.uuid, id)).returning())[0]!;
  await audit(deps, actor, "offer.update", "offers", id, diffMeta(row, updated, set), updated);
  return updated;
}

// Move an offer's status through the workflow (guarded by the pure transition map). `approve` also stamps the
// approver. Accept triggers the candidate->employee conversion separately (acceptOffer).
async function transitionOffer(deps: Deps, actor: AppUser, id: string, to: OfferStatus, extra: Record<string, unknown> = {}) {
  const row = await getOffer(deps, id);
  if (row.deleteTime) throw notFound("offer not found");
  if (!canOfferTransition(row.status, to)) throw failedPrecondition(`cannot move an offer from ${row.status} to ${to}`);
  // Guard the flip on the read status so the transition is EXACTLY-ONCE (0 rows = a concurrent call moved it).
  const [updated] = await deps.db.update(schema.offers).set({ status: to, updatedAt: new Date(), ...extra }).where(and(eq(schema.offers.uuid, id), eq(schema.offers.status, row.status))).returning();
  if (!updated) throw failedPrecondition(`cannot move an offer from ${row.status} to ${to}`);
  await audit(deps, actor, `offer.${to}`, "offers", id);
  return updated;
}
export const approveOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "approved", { approverId: actor.employeeId ?? null });
export const extendOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "extended", { offerDate: undefined });
export const declineOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "declined");
export const rescindOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "rescinded");

// Accept an extended offer: convert the candidate to an employee and open an onboarding transition, then mark
// the application hired. Idempotent-ish: guarded by the workflow (only `extended` -> `accepted` is legal).
export async function acceptOffer(deps: Deps, actor: AppUser, id: string) {
  const offer = await getOffer(deps, id);
  if (offer.deleteTime) throw notFound("offer not found");
  if (!canOfferTransition(offer.status, "accepted")) throw failedPrecondition(`cannot accept an offer in ${offer.status}`);

  const app = (await deps.db.select().from(schema.applications).where(eq(schema.applications.uuid, offer.applicationId)).limit(1))[0];
  if (!app) throw failedPrecondition("application not found");
  const cand = (await deps.db.select().from(schema.candidates).where(eq(schema.candidates.uuid, app.candidateId)).limit(1))[0];
  if (!cand) throw failedPrecondition("candidate not found");
  if (!cand.email) throw failedPrecondition("candidate needs an email before they can be converted to an employee");
  const req = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, app.requisitionId)).limit(1))[0];

  // Split the candidate's display name into first / last (last defaults to "." so the employee validator passes).
  const parts = cand.name.trim().split(/\s+/);
  const firstName = parts[0] || cand.name.trim();
  const lastName = parts.slice(1).join(" ") || ".";
  const startDate = offer.joinDate ? ymd(offer.joinDate) : undefined;

  // Claim the offer FIRST, after the (read-only) validation above: flip extended->accepted with a conditional
  // update guarded on the current status. Two concurrent accepts both pass the read-time canOfferTransition
  // check, but only one wins this update - the loser gets 0 rows and aborts, so the candidate is never
  // converted to an employee twice. createdEmployeeId is stamped after createEmployee below; a crash between
  // leaves an accepted offer with a null createdEmployeeId (visible, recoverable) rather than a duplicate hire.
  const claim = await deps.db
    .update(schema.offers)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(and(eq(schema.offers.uuid, id), eq(schema.offers.status, "extended")))
    .returning();
  if (!claim.length) throw aborted("this offer has already been accepted");

  const employee = await createEmployee(deps, actor, {
    first_name: firstName,
    last_name: lastName,
    work_email: cand.email,
    job_title: req?.title ?? null,
    department: req?.departmentId ? `departments/${req.departmentId}` : null,
    start_date: startDate ?? null,
  });

  // Seed the hire's compensation from the (already-approved) offered CTC, so the offered figure is authoritative
  // and HR doesn't re-key it (risking drift). Goes through reviseCompensation - not a raw insert - so the CTC
  // split, structure application and CTC-line derivation match every other surface. Best-effort: if the figure
  // can't be split under the current config (e.g. too low for the basic %), fall back to manual comp entry
  // rather than failing the whole hire (the employee already exists at this point).
  if (offer.baseComp && offer.baseComp > 0) {
    try {
      await reviseCompensation(deps, actor, {
        employee: `employees/${employee.uuid}`,
        annual_ctc: offer.baseComp,
        currency_code: offer.currency,
        effective_from: startDate ?? ymd(deps.clock.now()),
      });
    } catch { /* best-effort: leave comp for manual entry if the offered CTC can't be split under current config */ }
  }

  // Onboarding is no longer opened inline here: creating the employee emits `employee.created`, and the seeded
  // "Onboard a new hire" automation opens the onboarding transition (+ enrols benefits, etc.). This makes the
  // hire->onboarding hand-off DATA (editable in the Workflows builder), not hardcoded. Disable that rule and no
  // transition opens - the point of a workflow engine.
  const cfg = await cfgOf(deps);
  const hiredStage = cfg.stages.find((s) => s.kind === "hired")?.key ?? app.stage;
  await deps.db.update(schema.applications).set({ status: "hired", stage: hiredStage, stageChangedDate: new Date(), updatedAt: new Date() }).where(eq(schema.applications.uuid, app.uuid));

  // Referral seam: if this hire came from a referral, link the new employee as the referral's milestone anchor
  // so the existing referral-bonus cron awards the referrer. Prefer the application's referral, else the
  // candidate's. Only sets the anchor when the referral hasn't already been linked.
  const referralId = app.referralId ?? cand.referralId ?? null;
  if (referralId) {
    await deps.db
      .update(schema.referrals)
      .set({ hiredEmployeeId: employee.uuid, status: "joined", updatedAt: new Date() })
      .where(and(eq(schema.referrals.uuid, referralId), isNull(schema.referrals.hiredEmployeeId)));
  }

  // Status was already flipped to "accepted" by the claim above; here we only link the created employee.
  const [updated] = await deps.db
    .update(schema.offers)
    .set({ createdEmployeeId: employee.uuid, updatedAt: new Date() })
    .where(eq(schema.offers.uuid, id))
    .returning();
  await audit(deps, actor, "offer.accepted", "offers", id, { employee: `employees/${employee.uuid}` });
  // Tell the hiring manager their candidate accepted (the req is on its way to filled).
  if (req?.hiringManagerId && req.hiringManagerId !== actor.employeeId)
    await notify(deps, { recipient: req.hiringManagerId, type: "recruiting.offer_accepted", title: "Offer accepted", body: `${cand.name} accepted the offer for ${req.title}.`, link: "job-requisitions", subject: `job-requisitions/${req.uuid}`, priority: "high", actorId: actor.employeeId });
  // Announce the hire so automations run the "next logical steps" (open onboarding, enrol benefits, mark the
  // requisition filled, ...). subject = the offer; employee = the hire. requisitionId/openings let a rule close
  // the req when it's the last opening.
  await emitEvent(deps, actor, "offer.accepted", {
    subject: `offers/${id}`,
    employeeId: employee.uuid,
    payload: { candidateId: cand.uuid, applicationId: app.uuid, requisitionId: app.requisitionId, openings: req?.openings ?? 1, startDate: startDate ?? null },
  });
  return updated!;
}

