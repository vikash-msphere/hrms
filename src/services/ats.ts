// ATS service: flat company-wide CRUD for job requisitions, candidates, and applications, plus the pipeline
// custom methods (`:advance`, `:reject`). NO access control here - the middleware gates each collection by
// path + grants (private by default; recruiter/HR granted via the ACL). Mirrors the flat-collection pattern
// of services/backgroundChecks.ts; the pipeline stage rules live in domain/ats.ts (pure + tested).
import { asc, eq, and, isNull, sql } from "drizzle-orm";
import { allocFlatCode, allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import { keysetPage } from "./keysetPage";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted, failedPrecondition, oneOf } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { idFromPath } from "./documentsCommon";
import { getSettingValue } from "./settings";
import { orgToday, orgTimezone, dayStartMs } from "./orgDay";
import { localDay } from "../domain/attendance";
import {
  DEFAULT_ATS_CONFIG, type AtsConfig, isStage, nextStage, statusForStage, bandPointAmount,
  REQUISITION_STATUSES, type RequisitionStatus, canOfferTransition, type OfferStatus,
} from "../domain/ats";
import { createEmployee } from "./employees";
import { reviseCompensation } from "./compensation";
import { emitEvent } from "./eventBus";
import { notify } from "./notifications";
import { renderEmail, loadEmailBrand, escapeHtml } from "../lib/emailLayout";
import { buildTimedIcs, icsUid } from "../lib/ics";
import { checkEtag, updateAtVersion } from "./versionGuard";

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
  pay_grade?: string | null;
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
  return keysetPage(deps, schema.jobRequisitions, "job-requisitions", conds.length ? and(...conds) : undefined, { max: maxPageSize, pageToken });
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
      payGradeId: input.pay_grade ? idFromPath(input.pay_grade) : null,
      status,
      openedDate: input.opened_date ? parseDate(input.opened_date, "opened_date") : status === "open" ? new Date() : null,
      closedDate: input.closed_date ? parseDate(input.closed_date, "closed_date") : null,
    })
    .returning())[0]!;
  await audit(deps, actor, "requisition.create", "job-requisitions", row.uuid, createdMeta(row, "job-requisitions"), row);
  return row;
}

export async function updateRequisition(deps: Deps, actor: AppUser, id: string, patch: RequisitionInput, ifMatch?: string) {
  const row = await getRequisition(deps, id);
  if (row.deleteTime) throw notFound("requisition not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.jobRequisitions> = { updatedAt: new Date() };
  if (patch.title !== undefined) { const t = (patch.title ?? "").trim(); if (!t) throw invalidArgument("title cannot be blank"); set.title = t; }
  if (patch.department !== undefined) set.departmentId = patch.department ? idFromPath(patch.department) : null;
  if (patch.hiring_manager !== undefined) set.hiringManagerId = patch.hiring_manager ? idFromPath(patch.hiring_manager) : null;
  if (patch.location !== undefined) set.location = patch.location?.trim() || null;
  if (patch.employment_type !== undefined) set.employmentType = patch.employment_type ? oneOf(patch.employment_type, EMPLOYMENT_TYPES, "invalid employment_type") : null;
  if (patch.openings !== undefined && patch.openings != null) { if (!(patch.openings > 0)) throw invalidArgument("openings must be greater than 0"); set.openings = patch.openings; }
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.pay_grade !== undefined) set.payGradeId = patch.pay_grade ? idFromPath(patch.pay_grade) : null;
  if (patch.opened_date !== undefined) set.openedDate = patch.opened_date ? parseDate(patch.opened_date, "opened_date") : null;
  if (patch.closed_date !== undefined) set.closedDate = patch.closed_date ? parseDate(patch.closed_date, "closed_date") : null;
  if (patch.status !== undefined) {
    const s = patch.status as RequisitionStatus;
    if (!REQUISITION_STATUSES.includes(s)) throw invalidArgument("invalid status");
    set.status = s;
    // Stamp lifecycle dates on first open / on close, without clobbering an explicit patch value.
    if (s === "open" && !row.openedDate && patch.opened_date === undefined) set.openedDate = deps.clock.now();
    if ((s === "closed" || s === "filled") && !row.closedDate && patch.closed_date === undefined) set.closedDate = deps.clock.now();
  }
  const updated = await updateAtVersion(deps, schema.jobRequisitions, "requisition", row, set);
  await audit(deps, actor, "requisition.update", "job-requisitions", id, diffMeta(row, updated, set, "job-requisitions"), updated);
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
  return keysetPage(deps, schema.candidates, "candidates", where, { max: maxPageSize, pageToken });
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
  await audit(deps, actor, "candidate.create", "candidates", row.uuid, createdMeta(row, "candidates"), row);
  return row;
}

export async function updateCandidate(deps: Deps, actor: AppUser, id: string, patch: CandidateInput, ifMatch?: string) {
  const row = await getCandidate(deps, id);
  if (row.deleteTime) throw notFound("candidate not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.candidates> = { updatedAt: new Date() };
  if (patch.name !== undefined) { const n = (patch.name ?? "").trim(); if (!n) throw invalidArgument("name cannot be blank"); set.name = n; }
  if (patch.email !== undefined) set.email = patch.email?.trim() || null;
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.source !== undefined) set.source = patch.source?.trim() || null;
  if (patch.source_detail !== undefined) set.sourceDetail = patch.source_detail?.trim() || null;
  if (patch.referral !== undefined) set.referralId = patch.referral ? idFromPath(patch.referral) : null;
  if (patch.tags !== undefined) set.tags = patch.tags?.trim() || null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  const updated = await updateAtVersion(deps, schema.candidates, "candidate", row, set);
  await audit(deps, actor, "candidate.update", "candidates", id, diffMeta(row, updated, set, "candidates"), updated);
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
  return keysetPage(deps, schema.applications, "applications", conds.length ? and(...conds) : undefined, { max: maxPageSize, pageToken });
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
      appliedDate: input.applied_date ? parseDate(input.applied_date, "applied_date") : deps.clock.now(),
      stageChangedDate: deps.clock.now(),
    })
    .returning())[0]!;
  await audit(deps, actor, "application.create", "applications", row.uuid, createdMeta(row, "applications"), row);
  // A candidate entering the pipeline is the first transition, so it is an event like every other one: rules
  // acknowledge the applicant, alert the hiring manager, or route a referral.
  await emitApplicationEvent(deps, actor, "application.created", row);
  return row;
}

// ---- Pipeline events -----------------------------------------------------------------------------------------
//
// Everything a rule could want to know about an application, gathered once, so the ENGINE can ACT on a
// transition instead of only announcing it. The difference is concrete: a payload carrying the candidate, the
// requisition and the pay band is what lets the seeded "draft the offer" rule create a real, filled-in offer;
// a payload of `{stage, status}` can only send a message. Three small reads per transition is far cheaper than
// every rule doing its own apiCall reads, and it keeps rules declarative instead of turning them into scripts.
//
// Stage identity is carried BOTH ways on purpose: `stage` is the org's own key (what a condition reads today),
// while `stageKind`/`stageIndex` survive an org renaming or reordering its stages.
async function applicationEventPayload(
  deps: Deps,
  app: typeof schema.applications.$inferSelect,
  extra: Record<string, unknown> = {},
) {
  const cfg = await cfgOf(deps);
  const cand = (await deps.db.select().from(schema.candidates).where(eq(schema.candidates.uuid, app.candidateId)).limit(1))[0];
  const req = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, app.requisitionId)).limit(1))[0];
  const grade = req?.payGradeId
    ? (await deps.db.select().from(schema.payGrades).where(eq(schema.payGrades.uuid, req.payGradeId)).limit(1))[0]
    : undefined;
  const org = await getSettingValue<{ default_currency?: string }>(deps, "organization", {});
  const idx = cfg.stages.findIndex((s) => s.key === app.stage);
  const day = 86_400_000;
  // ORG-LOCAL, not UTC. These three are calendar DAYS an offer is dated and timed from, and the day an instant
  // falls in depends on the org's timezone (services/orgDay.ts). Derived as `ymd(now)` they were the UTC day,
  // so east of UTC an offer raised in the early hours carried yesterday's date and its notice and validity
  // windows shifted with it. `dayStartMs` turns the org-local day back into the UTC midnight a date-only
  // column stores, which is what the day arithmetic below steps over.
  const today = await orgToday(deps);
  const dayFrom = (n: number) => ymd(dayStartMs(today) + n * day);
  return {
    stage: app.stage,
    stageLabel: cfg.stages[idx]?.label ?? app.stage,
    stageKind: cfg.stages[idx]?.kind ?? "active",
    stageIndex: idx,
    status: app.status,
    applicationId: app.uuid,
    candidateId: app.candidateId,
    candidateName: cand?.name ?? null,
    candidateEmail: cand?.email ?? null,
    requisitionId: app.requisitionId,
    requisitionTitle: req?.title ?? null,
    openings: req?.openings ?? 1,
    departmentId: req?.departmentId ?? null,
    hiringManagerId: req?.hiringManagerId ?? null,
    source: app.source ?? cand?.source ?? null,
    referralId: app.referralId ?? cand?.referralId ?? null,
    // The money an offer needs, from the requisition's pay band, plus the figure the org's policy proposes.
    bandMin: grade?.bandMin ?? null,
    bandMid: grade?.bandMid ?? null,
    bandMax: grade?.bandMax ?? null,
    currency: grade?.currency ?? org.default_currency ?? "INR",
    offerAmount: bandPointAmount(cfg, { min: grade?.bandMin, mid: grade?.bandMid, max: grade?.bandMax }),
    // Dates computed here once, from settings, so a rule body holds no arithmetic and no magic numbers.
    offerDate: today,
    suggestedJoinDate: dayFrom(cfg.join_notice_days),
    suggestedExpiryDate: dayFrom(cfg.offer_validity_days),
    ...extra,
  };
}

/** Announce a pipeline transition with that full context. */
async function emitApplicationEvent(
  deps: Deps,
  actor: AppUser,
  type: string,
  app: typeof schema.applications.$inferSelect,
  extra: Record<string, unknown> = {},
) {
  await emitEvent(deps, actor, type, {
    subject: `applications/${app.uuid}`,
    employeeId: app.hiredEmployeeId ?? null,
    payload: await applicationEventPayload(deps, app, extra),
  });
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
    .set({ stage, status: statusForStage(cfg, stage), rejectionReason: null, stageChangedDate: deps.clock.now(), updatedAt: new Date() })
    .where(eq(schema.applications.uuid, id))
    .returning();
  await audit(deps, actor, "application.stage", "applications", id, { diff: { stage: { from: row.stage, to: stage }, status: { from: row.status, to: updated!.status } } }, updated);
  // `previousStage` is what makes "moved FORWARD into offer" expressible - without it a rule can't tell a
  // genuine advance from a card being dragged back and forth.
  await emitApplicationEvent(deps, actor, "application.stageChanged", updated!, { previousStage: row.stage });
  return updated!;
}

export async function updateApplication(deps: Deps, actor: AppUser, id: string, patch: ApplicationInput & { status?: string | null }, ifMatch?: string) {
  const row = await getApplication(deps, id);
  if (row.deleteTime) throw notFound("application not found");
  checkEtag(row, ifMatch);
  if (patch.stage !== undefined && patch.stage) return setStage(deps, actor, id, patch.stage);
  const set: SetOf<typeof schema.applications> = { updatedAt: new Date() };
  if (patch.source !== undefined) set.source = patch.source?.trim() || null;
  if (patch.referral !== undefined) set.referralId = patch.referral ? idFromPath(patch.referral) : null;
  if (patch.applied_date !== undefined) set.appliedDate = patch.applied_date ? parseDate(patch.applied_date, "applied_date") : null;
  if (patch.status !== undefined && patch.status === "withdrawn") set.status = "withdrawn";
  const updated = await updateAtVersion(deps, schema.applications, "application", row, set);
  await audit(deps, actor, "application.update", "applications", id, diffMeta(row, updated, set, "applications"), updated);
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
export async function rejectApplication(deps: Deps, actor: AppUser, id: string, reason?: string, notifyCandidate?: boolean) {
  const row = await getApplication(deps, id);
  if (row.deleteTime) throw notFound("application not found");
  const [updated] = await deps.db
    .update(schema.applications)
    .set({ status: "rejected", rejectionReason: reason?.trim() || null, stageChangedDate: deps.clock.now(), updatedAt: new Date() })
    .where(eq(schema.applications.uuid, id))
    .returning();
  await audit(deps, actor, "application.reject", "applications", id, { reason, notified: !!notifyCandidate });
  // The end of a pipeline is a transition too: rules tell the hiring manager, and a "position filled" reason
  // can close the search. `notified` says whether the candidate was already written to, so a rule doesn't
  // write to them twice.
  await emitApplicationEvent(deps, actor, "application.rejected", updated!, { reason: reason?.trim() || null, notified: !!notifyCandidate });
  // Telling the candidate is opt-in and deliberately silent about the reason: the internal taxonomy ("Failed
  // interview") is a record for the hiring team, not a message to a person. Best-effort - the rejection itself
  // is already filed, and a bounced mail must not undo it.
  if (notifyCandidate) {
    try { await emailCandidateRejection(deps, row); }
    catch (e) { console.error("[ats] rejection email failed (non-fatal)", e); }
  }
  return updated!;
}

/** The polite, reason-free note a candidate gets when the team opts to tell them. */
async function emailCandidateRejection(deps: Deps, app: typeof schema.applications.$inferSelect) {
  const cand = (await deps.db.select().from(schema.candidates).where(eq(schema.candidates.uuid, app.candidateId)).limit(1))[0];
  if (!cand?.email) return;
  const req = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, app.requisitionId)).limit(1))[0];
  const brand = await loadEmailBrand(deps);
  const role = req?.title ? ` for <strong>${escapeHtml(req.title)}</strong>` : "";
  const html = renderEmail(
    {
      heading: "Thank you for your time",
      preheader: `An update on your application${req?.title ? ` for ${req.title}` : ""}`,
      bodyHtml:
        `<p>Hello ${escapeHtml(cand.name.split(/\s+/)[0] ?? cand.name)},</p>` +
        `<p>Thank you for applying${role} at ${escapeHtml(brand.orgName)}, and for the time you gave us. On this occasion we have decided not to take your application further.</p>` +
        `<p>We keep the details you shared on file, and we would be glad to hear from you again for a role that fits.</p>`,
    },
    brand,
  );
  await deps.email.send(cand.email, `Your application at ${brand.orgName}`, html);
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
  return keysetPage(deps, schema.interviews, "interviews", conds.length ? and(...conds) : undefined, { max: maxPageSize, pageToken });
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
  await audit(deps, actor, "interview.create", "interviews", row.uuid, createdMeta(row, "interviews"), row);
  // Notify each interviewer they're scheduled (with the candidate + time).
  const candName = await candidateNameForApplication(deps, applicationId);
  const when = row.scheduledStart ? ` on ${new Date(row.scheduledStart).toLocaleString()}` : "";
  for (const iv of parseIdList(row.interviewerIds).filter((x) => x !== actor.employeeId))
    await notify(deps, { recipient: iv, type: "recruiting.interview_scheduled", title: "Interview scheduled", body: `${title} with ${candName}${when}.`, link: "interviews", subject: `interviews/${row.uuid}`, action: "respond", actorId: actor.employeeId });
  await emitInterviewEvent(deps, actor, "interview.scheduled", row);
  return row;
}

export async function updateInterview(deps: Deps, actor: AppUser, id: string, patch: InterviewInput, ifMatch?: string) {
  const row = await getInterview(deps, id);
  if (row.deleteTime) throw notFound("interview not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.interviews> = { updatedAt: new Date() };
  if (patch.title !== undefined) { const t = (patch.title ?? "").trim(); if (!t) throw invalidArgument("title cannot be blank"); set.title = t; }
  if (patch.mode !== undefined) set.mode = patch.mode ? oneOf(patch.mode, INTERVIEW_MODES, "invalid mode") : "video";
  if (patch.scheduled_start_time !== undefined) set.scheduledStart = patch.scheduled_start_time ? parseTs(patch.scheduled_start_time, "scheduled_start_time") : null;
  if (patch.scheduled_end_time !== undefined) set.scheduledEnd = patch.scheduled_end_time ? parseTs(patch.scheduled_end_time, "scheduled_end_time") : null;
  if (patch.interviewers !== undefined) set.interviewerIds = interviewersJson(patch.interviewers);
  if (patch.location !== undefined) set.location = patch.location?.trim() || null;
  const updated = await updateAtVersion(deps, schema.interviews, "interview", row, set);
  await audit(deps, actor, "interview.update", "interviews", id, diffMeta(row, updated, set, "interviews"), updated);
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
  await audit(deps, actor, `interview.${status === "done" ? "complete" : "cancel"}`, "interviews", id, stateMeta(row.status, status), updated);
  await emitInterviewEvent(deps, actor, status === "done" ? "interview.completed" : "interview.cancelled", updated!);
  return updated!;
}

/** An interview event, carrying its panel and its application's context. */
async function emitInterviewEvent(deps: Deps, actor: AppUser, type: string, iv: typeof schema.interviews.$inferSelect) {
  const app = (await deps.db.select().from(schema.applications).where(eq(schema.applications.uuid, iv.applicationId)).limit(1))[0];
  const panel = parseIdList(iv.interviewerIds);
  await emitEvent(deps, actor, type, {
    subject: `interviews/${iv.uuid}`,
    payload: {
      ...(app ? await applicationEventPayload(deps, app) : {}),
      interviewId: iv.uuid,
      interviewTitle: iv.title,
      mode: iv.mode,
      interviewStatus: iv.status,
      // `panelSize` lets a rule ask "is every scorecard in?" without reading the panel itself.
      panel,
      panelSize: panel.length,
      scheduledStart: iv.scheduledStart ? new Date(iv.scheduledStart).toISOString() : null,
      location: iv.location ?? null,
    },
  });
}
export const completeInterview = (deps: Deps, actor: AppUser, id: string) => setInterviewStatus(deps, actor, id, "done");
export const cancelInterview = (deps: Deps, actor: AppUser, id: string) => setInterviewStatus(deps, actor, id, "cancelled");

// `:invite` - mail the CANDIDATE their slot, with a calendar attachment.
//
// Scheduling has always notified the panel and told the candidate nothing: somebody then copied the time into
// a mail client by hand, which is where the wrong timezone and the missing meeting link come from. This sends
// the round, the time, the mode and the link from the record itself, so the invitation and the schedule cannot
// disagree. Explicit, not automatic - the recruiter decides when the candidate is told.
export async function inviteCandidate(deps: Deps, actor: AppUser, id: string) {
  const row = await getInterview(deps, id);
  if (row.deleteTime) throw notFound("interview not found");
  if (row.status === "cancelled") throw failedPrecondition("this interview is cancelled");
  if (!row.scheduledStart) throw failedPrecondition("give the interview a time before inviting the candidate");
  const app = (await deps.db.select().from(schema.applications).where(eq(schema.applications.uuid, row.applicationId)).limit(1))[0];
  if (!app) throw failedPrecondition("application not found");
  const cand = (await deps.db.select().from(schema.candidates).where(eq(schema.candidates.uuid, app.candidateId)).limit(1))[0];
  if (!cand?.email) throw failedPrecondition("the candidate has no email address on file");
  const req = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, app.requisitionId)).limit(1))[0];

  const start = new Date(row.scheduledStart).toISOString();
  const end = new Date(row.scheduledEnd ?? +new Date(row.scheduledStart) + 3_600_000).toISOString();
  const brand = await loadEmailBrand(deps);
  const when = new Date(start).toUTCString().replace(" GMT", " UTC");
  const modeLine = row.mode === "video" ? "Video call" : row.mode === "phone" ? "Phone call" : "In person";
  const html = renderEmail(
    {
      heading: `${row.title}${req?.title ? ` · ${req.title}` : ""}`,
      preheader: `Your interview is booked for ${when}`,
      bodyHtml:
        `<p>Hello ${escapeHtml(cand.name.split(/\s+/)[0] ?? cand.name)},</p>` +
        `<p>Your <strong>${escapeHtml(row.title)}</strong>${req?.title ? ` for <strong>${escapeHtml(req.title)}</strong>` : ""} at ${escapeHtml(brand.orgName)} is booked.</p>` +
        `<p><strong>When:</strong> ${escapeHtml(when)}<br/><strong>How:</strong> ${escapeHtml(modeLine)}` +
        (row.location ? `<br/><strong>Where:</strong> ${escapeHtml(row.location)}` : "") +
        `</p><p>The attached calendar file adds it to your own calendar in your local time. If the slot does not work, reply to this email and we will move it.</p>`,
    },
    brand,
  );
  const ics = buildTimedIcs(
    [{
      uid: icsUid("interview", row.uuid),
      start,
      end,
      summary: `${row.title}${req?.title ? ` · ${req.title}` : ""} · ${brand.orgName}`,
      description: modeLine,
      location: row.location ?? undefined,
    }],
    "Interview",
    +deps.clock.now(),
  );
  await deps.email.send(cand.email, `Interview: ${row.title}${req?.title ? ` · ${req.title}` : ""}`, html, [
    { filename: "interview.ics", content: new TextEncoder().encode(ics), contentType: "text/calendar" },
  ]);
  await audit(deps, actor, "interview.invite", "interviews", id, { to: cand.email });
  return row;
}


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
  return keysetPage(deps, schema.interviewFeedback, "interview-feedback", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
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
  await audit(deps, actor, "interview-feedback.create", "interview-feedback", row.uuid, createdMeta(row, "interview-feedback"), row);
  return row;
}

export async function updateInterviewFeedback(deps: Deps, actor: AppUser, id: string, patch: FeedbackInput, ifMatch?: string) {
  const row = await getInterviewFeedback(deps, id);
  if (row.deleteTime) throw notFound("scorecard not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.interviewFeedback> = { updatedAt: new Date() };
  if (patch.ratings !== undefined) set.ratingsJson = patch.ratings ? JSON.stringify(patch.ratings) : null;
  if (patch.overall_rating !== undefined) set.overallRating = patch.overall_rating ?? null;
  if (patch.recommendation !== undefined) set.recommendation = patch.recommendation ? oneOf(patch.recommendation, RECOMMENDATIONS, "invalid recommendation") : null;
  if (patch.comment !== undefined) set.comment = patch.comment?.trim() || null;
  const updated = await updateAtVersion(deps, schema.interviewFeedback, "scorecard", row, set);
  await audit(deps, actor, "interview-feedback.update", "interview-feedback", id, diffMeta(row, updated, set, "interview-feedback"), updated);
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
  return keysetPage(deps, schema.offers, "offers", conds.length ? and(...conds) : undefined, { max: maxPageSize, pageToken });
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
  await audit(deps, actor, "offer.create", "offers", row.uuid, createdMeta(row, "offers"), row);
  // Emitted whether a person wrote the offer or the "draft the offer" rule did, so approval chasing is one rule
  // either way.
  await emitOfferEvent(deps, actor, "offer.created", row);
  return row;
}

export async function updateOffer(deps: Deps, actor: AppUser, id: string, patch: OfferInput, ifMatch?: string) {
  const row = await getOffer(deps, id);
  if (row.deleteTime) throw notFound("offer not found");
  checkEtag(row, ifMatch);
  if (row.status !== "draft") throw failedPrecondition("only a draft offer can be edited");
  const set: SetOf<typeof schema.offers> = { updatedAt: new Date() };
  if (patch.base_comp !== undefined) set.baseComp = patch.base_comp ?? null;
  if (patch.currency_code !== undefined) set.currency = patch.currency_code?.trim() || "INR";
  if (patch.offer_date !== undefined) set.offerDate = patch.offer_date ? parseDate(patch.offer_date, "offer_date") : null;
  if (patch.join_date !== undefined) set.joinDate = patch.join_date ? parseDate(patch.join_date, "join_date") : null;
  if (patch.expiry_date !== undefined) set.expiryDate = patch.expiry_date ? parseDate(patch.expiry_date, "expiry_date") : null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  const updated = await updateAtVersion(deps, schema.offers, "offer", row, set);
  await audit(deps, actor, "offer.update", "offers", id, diffMeta(row, updated, set, "offers"), updated);
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
  await audit(deps, actor, `offer.${to}`, "offers", id, stateMeta(row.status, to), updated);
  // Every step of the offer workflow is an event, so chasing an unanswered offer and reacting to a "no" are
  // rules rather than more code. `accepted` is emitted by acceptOffer instead - it means far more than a status
  // change, and it carries the hire it produced.
  if (to !== "accepted") await emitOfferEvent(deps, actor, `offer.${to}`, updated);
  return updated;
}

/** An offer event, carrying its terms and its application's context (so a rule can name the candidate). */
async function emitOfferEvent(deps: Deps, actor: AppUser, type: string, offer: typeof schema.offers.$inferSelect) {
  const app = (await deps.db.select().from(schema.applications).where(eq(schema.applications.uuid, offer.applicationId)).limit(1))[0];
  await emitEvent(deps, actor, type, {
    subject: `offers/${offer.uuid}`,
    payload: {
      ...(app ? await applicationEventPayload(deps, app) : {}),
      offerId: offer.uuid,
      offerStatus: offer.status,
      baseComp: offer.baseComp ?? null,
      offerCurrency: offer.currency,
      joinDate: offer.joinDate ? ymd(offer.joinDate) : null,
      expiryDate: offer.expiryDate ? ymd(offer.expiryDate) : null,
      approverId: offer.approverId ?? null,
    },
  });
}
export const approveOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "approved", { approverId: actor.employeeId ?? null });
export const extendOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "extended", { offerDate: undefined });
export const declineOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "declined");
export const rescindOffer = (deps: Deps, actor: AppUser, id: string) => transitionOffer(deps, actor, id, "rescinded");

// The candidate -> employee conversion, shared by the two ways a hire happens: accepting an offer, and hiring
// straight off the pipeline board (`applications:hire`, for teams who never write an offer down here). It
// creates the employee, seeds compensation when there is an agreed figure, links the referral that produced
// them, and stamps the application with who it became.
//
// Onboarding is deliberately NOT opened here: createEmployee emits `employee.created`, and the seeded "Onboard
// a new hire" automation opens the onboarding transition (+ enrols benefits, etc.). That keeps the
// hire->onboarding hand-off DATA, editable in the Workflows builder, rather than hardcoded here. Disable that
// rule and no transition opens - the point of a workflow engine.
async function convertCandidate(
  deps: Deps,
  actor: AppUser,
  app: typeof schema.applications.$inferSelect,
  cand: typeof schema.candidates.$inferSelect,
  terms: { startDate?: string; baseComp?: number | null; currency?: string | null },
) {
  const req = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, app.requisitionId)).limit(1))[0];
  // Split the candidate's display name into first / last (last defaults to "." so the employee validator passes).
  const parts = cand.name.trim().split(/\s+/);
  const firstName = parts[0] || cand.name.trim();
  const lastName = parts.slice(1).join(" ") || ".";
  const employee = await createEmployee(deps, actor, {
    first_name: firstName,
    last_name: lastName,
    work_email: cand.email!,
    job_title: req?.title ?? null,
    department: req?.departmentId ? `departments/${req.departmentId}` : null,
    start_date: terms.startDate ?? null,
  });

  // Seed the hire's compensation from the agreed figure, so it is authoritative and HR doesn't re-key it
  // (risking drift). Goes through reviseCompensation - not a raw insert - so the CTC split, structure
  // application and CTC-line derivation match every other surface. Best-effort: if the figure can't be split
  // under the current config (e.g. too low for the basic %), fall back to manual comp entry rather than
  // failing the whole hire (the employee already exists at this point).
  if (terms.baseComp && terms.baseComp > 0) {
    try {
      await reviseCompensation(deps, actor, {
        employee: `employees/${employee.uuid}`,
        annual_ctc: terms.baseComp,
        currency_code: terms.currency ?? undefined,
        // The org's day, not UTC's: this is the date a compensation row takes effect from, and a hire recorded
        // in the early hours east of UTC took effect a day before it was agreed. See services/orgDay.ts.
        effective_from: terms.startDate ?? (await orgToday(deps)),
      });
    } catch { /* best-effort: leave comp for manual entry if the agreed CTC can't be split under current config */ }
  }

  const cfg = await cfgOf(deps);
  const hiredStage = cfg.stages.find((s) => s.kind === "hired")?.key ?? app.stage;
  await deps.db
    .update(schema.applications)
    .set({ status: "hired", stage: hiredStage, hiredEmployeeId: employee.uuid, stageChangedDate: deps.clock.now(), updatedAt: new Date() })
    .where(eq(schema.applications.uuid, app.uuid));

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
  return employee;
}

// `:hire` - the hired column, made real. Moving a card into a hired stage only ever changed a string: the
// person had no employee record, so onboarding had nothing to open and the "hire" existed on the board only.
// This performs the conversion the hired column has always implied, and is what the board's one hired-card
// action calls.
//
// Idempotent by design, because the board offers the action on every hired card: an application already
// stamped with its hire returns unchanged, an accepted offer's employee is adopted rather than duplicated, and
// an employee who already exists on that email is linked instead of created again (work_email is unique, so a
// racing second call fails at the database rather than making a second person).
export async function hireApplication(deps: Deps, actor: AppUser, id: string) {
  const app = await getApplication(deps, id);
  if (app.deleteTime) throw notFound("application not found");
  if (app.hiredEmployeeId) return app;
  if (app.status === "rejected" || app.status === "withdrawn") throw failedPrecondition(`cannot hire a ${app.status} application`);
  const cand = (await deps.db.select().from(schema.candidates).where(eq(schema.candidates.uuid, app.candidateId)).limit(1))[0];
  if (!cand) throw failedPrecondition("candidate not found");
  if (!cand.email) throw failedPrecondition("the candidate needs an email address before they can be hired - it becomes their work email");

  // Already converted elsewhere? Adopt that employee. Two ways it happens: an offer on this application was
  // accepted (before this column existed, or by someone else a moment ago), or the person was created by hand.
  const offers = await deps.db.select().from(schema.offers).where(eq(schema.offers.applicationId, app.uuid));
  const converted = offers.find((o) => o.createdEmployeeId)?.createdEmployeeId ?? null;
  // ASKED THE WAY middleware/auth.ts ASKS IT: case-insensitively.
  //
  // This was `eq(workEmail, cand.email)` - an exact, case-SENSITIVE match over a column stored verbatim
  // (`createEmployee` writes `work_email` as typed; only `provisionAccount` lowercases, and only for
  // `users.email`), against a candidate email that is only trimmed. So a candidate who wrote
  // `Asha.Rao@corp.com` against an employee row holding `asha.rao@corp.com` was not detected, and the
  // conversion below inserted a SECOND employee for one person - which the UNIQUE index accepts, because the
  // strings differ. That is the state auth.ts already has a hard error for ("your work email is linked to a
  // different sign-in account"), reached here by nothing more than how a candidate capitalised their address.
  //
  // Ordered, because `lower(work_email)` is not the unique one: two rows differing only in case can both sit
  // behind it, and which person a hire attaches to must not be a query-plan detail. Same rule, same reason, as
  // loadUserRow's `stable` lookup.
  //
  // SOFT-DELETED ROWS ARE FOUND BUT NOT ADOPTED, and that distinction has to be made HERE rather than by
  // filtering them out. A leaver is not somebody to hire into - attaching the application to a deleted record
  // means no onboarding transition, no compensation off the offer, and a `hired_employee_id` no list will ever
  // return. But `work_email` is UNIQUE regardless of `delete_time`, so simply skipping the row sends
  // `convertCandidate` into a UNIQUE violation and answers 500 for what is an ordinary situation with an
  // ordinary fix. So it is named: a rehire is a decision somebody makes, not a side effect of pressing Hire.
  const match = converted
    ? null
    : (await deps.db
        .select({ uuid: schema.employees.uuid, deleteTime: schema.employees.deleteTime })
        .from(schema.employees)
        .where(sql`lower(${schema.employees.workEmail}) = ${cand.email.toLowerCase()}`)
        .orderBy(asc(schema.employees.createdAt), asc(schema.employees.uuid))
        .limit(1))[0] ?? null;
  if (match?.deleteTime) {
    throw failedPrecondition(
      "a deleted employee record already uses that work email - restore it to rehire this person, or give the candidate a different address",
    );
  }
  const existing = match?.uuid ?? null;
  const already = converted ?? existing;

  if (!already) {
    // Terms, if anyone wrote them down: the live offer's join date and CTC beat re-keying them by hand.
    const live = offers.filter((o) => o.status !== "declined" && o.status !== "rescinded").sort((a, b) => +b.updatedAt - +a.updatedAt)[0];
    await convertCandidate(deps, actor, app, cand, {
      startDate: live?.joinDate ? ymd(live.joinDate) : undefined,
      baseComp: live?.baseComp ?? null,
      currency: live?.currency ?? null,
    });
  } else {
    const cfg = await cfgOf(deps);
    const hiredStage = cfg.stages.find((s) => s.kind === "hired")?.key ?? app.stage;
    await deps.db
      .update(schema.applications)
      .set({ status: "hired", stage: hiredStage, hiredEmployeeId: already, updatedAt: new Date() })
      .where(eq(schema.applications.uuid, app.uuid));
  }

  await audit(deps, actor, "application.hire", "applications", id, { existing: !!already });
  // One hire event for BOTH routes into a hire (here and `offers:accept`), so the rules that close the
  // requisition and tell the hiring manager fire whichever way the team works.
  const hired = await getApplication(deps, id);
  await emitApplicationEvent(deps, actor, "application.hired", hired, { existing: !!already, viaOffer: false });
  return hired;
}

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
  const startDate = offer.joinDate ? ymd(offer.joinDate) : undefined;

  // Claim the offer FIRST, after the (read-only) validation above: flip extended->accepted with a conditional
  // update guarded on the current status. Two concurrent accepts both pass the read-time canOfferTransition
  // check, but only one wins this update - the loser gets 0 rows and aborts, so the candidate is never
  // converted to an employee twice. createdEmployeeId is stamped after the conversion below; a crash between
  // leaves an accepted offer with a null createdEmployeeId (visible, recoverable) rather than a duplicate hire.
  const claim = await deps.db
    .update(schema.offers)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(and(eq(schema.offers.uuid, id), eq(schema.offers.status, "extended")))
    .returning();
  if (!claim.length) throw aborted("this offer has already been accepted");

  const employee = await convertCandidate(deps, actor, app, cand, { startDate, baseComp: offer.baseComp, currency: offer.currency });
  const req = (await deps.db.select().from(schema.jobRequisitions).where(eq(schema.jobRequisitions.uuid, app.requisitionId)).limit(1))[0];

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
  // Two events, deliberately: `offer.accepted` is about the OFFER (a candidate said yes - offer-specific rules
  // hang off it), while `application.hired` is about the HIRE and is emitted by both routes into one, so the
  // rules that close the requisition and announce the hire don't care how the team works.
  await emitEvent(deps, actor, "offer.accepted", {
    subject: `offers/${id}`,
    employeeId: employee.uuid,
    payload: { candidateId: cand.uuid, applicationId: app.uuid, requisitionId: app.requisitionId, openings: req?.openings ?? 1, startDate: startDate ?? null },
  });
  await emitApplicationEvent(deps, actor, "application.hired", await getApplication(deps, app.uuid), { existing: false, viaOffer: true, offerId: id });
  return updated!;
}


// ── Chasing scorecards ──────────────────────────────────────────────────────────────────────────────────────
//
// The commonest reason a hiring decision stalls is not disagreement, it is silence: a round is held, marked
// done, and two of the four panelists never file. Nothing ever asked them twice. This is the same ladder the
// policy chase-up uses - a fixed set of ages rather than a daily nag, so the age of the interview IS the
// schedule and no per-person reminder state has to be stored.
//
// NO access control here: the cron runs as the system principal.
const DAY = 86_400_000;
/** Days after a held interview at which the automatic chase-up fires. */
export const SCORECARD_NUDGE_DAYS = [1, 3, 7];

export async function nudgeMissingScorecards(deps: Deps): Promise<number> {
  const now = +deps.clock.now();
  // BOTH SIDES of the age below read their day in the ORG's timezone, which is the day an "N days after the
  // interview" ladder is counted in. `scheduledStart` is an instant, so in UTC the rung an interview lands on
  // flipped with the time of day it was held - the tick runs at 02:00 UTC, which is the previous evening west
  // of UTC. Changing only one side would break the invariant the ladder depends on (the age must advance by
  // exactly one per nightly tick, or a rung is skipped and nobody is ever chased), so they share one helper.
  const tz = await orgTimezone(deps);
  const dayOf = (ms: number) => Date.parse(`${localDay(ms, tz)}T00:00:00Z`);
  const today = dayOf(now);
  const held = await deps.db.select().from(schema.interviews).where(eq(schema.interviews.status, "done"));
  let sent = 0;
  for (const iv of held) {
    if (iv.deleteTime) continue;
    // The slot is the clock, not the day it was marked done: an interview closed a week late should not start
    // its ladder a week late too.
    const at = iv.scheduledStart ? +new Date(iv.scheduledStart) : +new Date(iv.updatedAt);
    const age = Math.round((today - dayOf(at)) / DAY);
    if (!SCORECARD_NUDGE_DAYS.includes(age)) continue;
    const panel = parseIdList(iv.interviewerIds);
    if (!panel.length) continue;
    // A WITHDRAWN scorecard is not a filed one: `interview_feedback` is soft-deletable, and without the
    // delete filter a panelist who deleted theirs counted as done and was never nudged again - the silence
    // this sweep exists to break.
    const filed = await deps.db.select({ authorId: schema.interviewFeedback.authorId }).from(schema.interviewFeedback).where(and(eq(schema.interviewFeedback.interviewId, iv.uuid), isNull(schema.interviewFeedback.deleteTime)));
    const done = new Set(filed.map((f) => f.authorId));
    const owed = panel.filter((id) => !done.has(id));
    if (!owed.length) continue;
    const candName = await candidateNameForApplication(deps, iv.applicationId);
    for (const employeeId of owed) {
      await notify(deps, {
        recipient: employeeId,
        type: "recruiting.scorecard_due",
        title: `Scorecard still owed: ${iv.title}`,
        body: `${candName} was interviewed ${age === 1 ? "yesterday" : `${age} days ago`} and the decision is waiting on your verdict.`,
        link: "interviews",
        subject: `interviews/${iv.uuid}`,
        action: "respond",
        priority: age >= SCORECARD_NUDGE_DAYS[SCORECARD_NUDGE_DAYS.length - 1]! ? "high" : "normal",
      });
      sent++;
    }
    // One escalation signal at the end of the ladder, so a rule can chase the hiring manager instead.
    if (age === SCORECARD_NUDGE_DAYS[SCORECARD_NUDGE_DAYS.length - 1]) {
      await emitEvent(deps, null, "interview.scorecardOverdue", {
        subject: `interviews/${iv.uuid}`,
        payload: { title: iv.title, candidate: candName, pending: owed.length, daysOpen: age },
      });
    }
  }
  return sent;
}
