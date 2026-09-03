import { eq, and, isNotNull, notInArray } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldDiff, stateMeta } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { notify, managerIdOf } from "./notifications";
import { getSettingValue } from "./settings";
import { documentLetterhead, type LetterheadMedia, type OrgWithDocumentLogos } from "./letterheads";
import { DEFAULT_PERFORMANCE, type PerformanceFramework } from "../domain/performance";
import { renderLetterPdf, type LetterBlock } from "../lib/letterPdf";
import { formatLongDate } from "../lib/pdfPrimitives";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
type State = typeof schema.reviews.$inferSelect.state;
const NEXT: Record<State, State | null> = { SELF: "MANAGER", MANAGER: "SHARED", SHARED: "ACKNOWLEDGED", ACKNOWLEDGED: null };

export async function listReviews(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, cycle?: string, stateFilter?: string) {
  const conds = [applyScope(scope, schema.reviews.code, schema.reviews.employeeId)];
  const cycleId = idFromPath(cycle);
  if (cycleId) conds.push(eq(schema.reviews.cycleId, cycleId));
  if (stateFilter) conds.push(eq(schema.reviews.state, stateFilter as State));
  // Reviews have no delete_time of their own: they live and die with their cycle. Soft-deleting a cycle must
  // therefore take its reviews off the list too, or every enrolled employee keeps a nameless, un-dated review
  // card for a cycle that no longer exists (restoring the cycle brings them back).
  const dead = (await deps.db.select({ uuid: schema.reviewCycles.uuid }).from(schema.reviewCycles).where(isNotNull(schema.reviewCycles.deleteTime))).map((c) => c.uuid);
  if (dead.length) conds.push(notInArray(schema.reviews.cycleId, dead));
  return keysetPage(deps, schema.reviews, "reviews", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
}


async function loadInState(deps: Deps, id: string, required: State): Promise<typeof schema.reviews.$inferSelect> {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  if (row.state !== required) throw failedPrecondition(`this review is not in the ${required.toLowerCase()} stage`);
  return row;
}
// Guards the write on the state the caller validated (`from`) so a stage advance is EXACTLY-ONCE: a
// double-clicked/concurrent submit that also read that state loses here (0 rows) instead of both firing
// the stage-handoff notification twice.
async function applyState(deps: Deps, id: string, from: State, set: Record<string, unknown>) {
  const updated = (await deps.db.update(schema.reviews).set({ ...set, updatedAt: new Date() }).where(and(eq(schema.reviews.uuid, id), eq(schema.reviews.state, from))).returning())[0];
  if (!updated) throw failedPrecondition("this review has already moved past that stage");
  return updated;
}

// SELF -> MANAGER: the employee records their self-assessment (comment + optional per-competency self ratings).
export async function submitSelf(deps: Deps, actor: AppUser, id: string, selfComment?: string | null, selfRatings?: Record<string, number>) {
  await loadInState(deps, id, "SELF");
  // Self ratings are competency-key -> number, like the manager's; drop non-numeric values defensively.
  const ratings = selfRatings && typeof selfRatings === "object"
    ? Object.fromEntries(Object.entries(selfRatings).filter(([, v]) => typeof v === "number" && !Number.isNaN(v)))
    : null;
  const row = await applyState(deps, id, "SELF", {
    selfComment: selfComment?.trim() || null,
    selfRatingsJson: ratings && Object.keys(ratings).length ? JSON.stringify(ratings) : null,
    state: "MANAGER",
  });
  await audit(deps, actor, "review.submitSelf", "reviews", id, stateMeta("SELF", "MANAGER", { employee: `employees/${row.employeeId}` }), row);
  // Hand the review to the employee's manager for the manager stage.
  const mgr = await managerIdOf(deps, row.employeeId);
  if (mgr) await notify(deps, { recipient: mgr, type: "review.self_submitted", title: "Self-review submitted", body: "A report finished their self-assessment. Your review is next.", link: `reviews/${id}`, subject: `reviews/${id}`, action: "respond", actorId: row.employeeId });
  return row;
}

// MANAGER -> SHARED: the manager records ratings + comment and shares the result with the employee.
export async function submitManager(deps: Deps, actor: AppUser, id: string, input: { ratings?: Record<string, number>; manager_comment?: string | null; overall_rating?: number | null }) {
  const before = await loadInState(deps, id, "MANAGER"); // also the scores this submission replaces, for the audit diff
  // Ratings are competency-key -> number; stored as JSON. Drop non-numeric values defensively.
  const ratings = input.ratings && typeof input.ratings === "object"
    ? Object.fromEntries(Object.entries(input.ratings).filter(([, v]) => typeof v === "number" && !Number.isNaN(v)))
    : {};
  if (input.overall_rating != null && (typeof input.overall_rating !== "number" || Number.isNaN(input.overall_rating))) {
    throw invalidArgument("overall_rating must be a number");
  }
  const row = await applyState(deps, id, "MANAGER", {
    ratingsJson: JSON.stringify(ratings),
    managerComment: input.manager_comment?.trim() || null,
    overallRating: input.overall_rating ?? null,
    state: "SHARED",
  });
  // The per-competency scores are the substance of a manager review, and `ratingsJson` was excluded from every
  // diff as a blob. lib/audit expands it for this collection, so `fieldDiff` states each rating that was set.
  await audit(deps, actor, "review.submitManager", "reviews", id, stateMeta("MANAGER", "SHARED", {
    employee: `employees/${row.employeeId}`,
    diff: {
      state: { from: "MANAGER", to: "SHARED" },
      overallRating: { from: null, to: input.overall_rating ?? null },
      ...fieldDiff({ ratingsJson: before?.ratingsJson ?? null }, { ratingsJson: row.ratingsJson }, ["ratingsJson"], "reviews"),
    },
  }), row);
  // The result is now shared with the employee to review + acknowledge.
  await notify(deps, { recipient: row.employeeId, type: "review.shared", title: "Your review is ready", body: "Your manager shared your performance review.", link: `reviews/${id}`, subject: `reviews/${id}`, action: "acknowledge", actorId: actor.employeeId });
  return row;
}

// SHARED -> ACKNOWLEDGED: the employee acknowledges they've seen the shared review, optionally with a note
// (context or disagreement) that stays on the review for the manager/HR to see.
export async function acknowledgeReview(deps: Deps, actor: AppUser, id: string, comment?: string | null) {
  await loadInState(deps, id, "SHARED");
  const row = await applyState(deps, id, "SHARED", { state: "ACKNOWLEDGED", ackComment: comment?.trim() || null });
  await audit(deps, actor, "review.acknowledge", "reviews", id, stateMeta("SHARED", "ACKNOWLEDGED", { employee: `employees/${row.employeeId}`, ...(comment?.trim() ? { note: comment.trim() } : {}) }), row);
  // A note on the acknowledgement is feedback aimed at the manager - surface it, don't bury it.
  if (comment?.trim()) {
    const mgr = await managerIdOf(deps, row.employeeId);
    if (mgr) await notify(deps, { recipient: mgr, type: "review.acknowledged", title: "Review acknowledged with a note", body: comment.trim().slice(0, 200), link: `reviews/${id}`, subject: `reviews/${id}`, actorId: row.employeeId });
  }
  return row;
}

// Remind whoever owns the review's current stage: the employee in SELF/SHARED, the manager in MANAGER.
// No state change; just a notification from a manager/HR unblocking a stalled review.
export async function nudgeReview(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  if (row.state === "ACKNOWLEDGED") throw failedPrecondition("this review is already complete");
  const recipient = row.state === "MANAGER" ? await managerIdOf(deps, row.employeeId) : row.employeeId;
  if (!recipient) throw failedPrecondition("this review's current stage has no owner to remind");
  const body = row.state === "SELF" ? "Reminder: your self-assessment is waiting." : row.state === "MANAGER" ? "Reminder: your manager review is waiting." : "Reminder: your shared review is waiting for your acknowledgement.";
  await notify(deps, { recipient, type: "review.nudge", title: "Review reminder", body, link: `reviews/${id}`, subject: `reviews/${id}`, action: "respond", actorId: actor.employeeId });
  // Which stage was nudged, and whose inbox it went to - a reminder with neither is unauditable as chasing.
  await audit(deps, actor, "review.nudge", "reviews", id, { employee: `employees/${recipient}`, note: `at the ${row.state.toLowerCase()} stage` }, row);
  return row;
}

// The finished review as a letter-style PDF (the employee's record copy). Only a SHARED/ACKNOWLEDGED review
// renders - before that the manager assessment is still private to its author, and a PDF is a copy that
// leaves the app, so nothing unshared may be in it. Layout rides the letterhead renderer; content only here.
export async function renderReviewPdf(deps: Deps, _actor: AppUser, id: string, media: LetterheadMedia = "screen"): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  if (row.state !== "SHARED" && row.state !== "ACKNOWLEDGED") throw failedPrecondition("only a shared or acknowledged review can be exported");

  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, row.employeeId)).limit(1))[0];
  const cycle = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, row.cycleId)).limit(1))[0];
  const org = await getSettingValue<{ name?: string; legal_name?: string; address?: string; logo?: string } & OrgWithDocumentLogos>(deps, "organization", {});
  // A review export is rendered on demand and never filed, so the print page is chosen per request.
  const letterhead = await documentLetterhead(deps, org, "review", [], media);
  const framework = await getSettingValue<PerformanceFramework>(deps, "performance", DEFAULT_PERFORMANCE);
  const scaleLabel = (v: number | null | undefined) => (v == null ? "-" : `${v} (${framework.scale.find((s) => s.value === v)?.label ?? ""})`);

  const empName = emp ? `${emp.firstName} ${emp.lastName}` : "Employee";
  const ratings: Record<string, number> = row.ratingsJson ? JSON.parse(row.ratingsJson) : {};
  const selfRatings: Record<string, number> = row.selfRatingsJson ? JSON.parse(row.selfRatingsJson) : {};
  const hasSelfRatings = Object.keys(selfRatings).length > 0;
  const period = cycle?.periodStart && cycle?.periodEnd
    ? `${formatLongDate(new Date(cycle.periodStart))} to ${formatLongDate(new Date(cycle.periodEnd))}`
    : undefined;

  const paras = (s: string): LetterBlock[] => s.split(/\n{2,}/).map((p) => ({ kind: "para", runs: [p.trim()] as const }) as LetterBlock).filter((b) => (b as any).runs[0]);
  const blocks: LetterBlock[] = [
    { kind: "subject", text: `Performance review: ${cycle?.name ?? "review"}` },
    ...(period ? [{ kind: "para", runs: ["Review period: ", { b: period }] } as LetterBlock] : []),
    {
      kind: "table",
      table: {
        title: "Ratings",
        columns: hasSelfRatings ? ["Competency", "Self", "Manager"] : ["Competency", "Rating"],
        rows: framework.competencies.map((c) =>
          hasSelfRatings
            ? [c.label, selfRatings[c.key] != null ? String(selfRatings[c.key]) : "-", scaleLabel(ratings[c.key])]
            : [c.label, scaleLabel(ratings[c.key])],
        ),
        total: row.overallRating != null
          ? (hasSelfRatings ? ["Overall", "", scaleLabel(row.overallRating)] : ["Overall", scaleLabel(row.overallRating)])
          : undefined,
      },
    },
  ];
  if (row.selfComment) blocks.push({ kind: "subject", text: "Self-assessment" }, ...paras(row.selfComment));
  if (row.managerComment) blocks.push({ kind: "subject", text: "Manager feedback" }, ...paras(row.managerComment));
  if (row.state === "ACKNOWLEDGED") {
    blocks.push({ kind: "note", text: `Acknowledged by ${empName} on ${formatLongDate(new Date(row.updatedAt))}.` });
    if (row.ackComment) blocks.push(...paras(`Acknowledgement note: ${row.ackComment}`));
  }

  const { bytes } = await renderLetterPdf({
    org: { name: org.name || "", address: org.address, logo: org.logo, legalName: org.legal_name || undefined },
    ...(letterhead ? { letterhead } : {}),
    date: formatLongDate(new Date()),
    to: { name: empName, lines: cycle?.name ? [cycle.name] : [] },
    blocks,
  });
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "-");
  return { bytes, fileName: `review-${safe(empName)}-${safe(cycle?.name ?? "cycle")}.pdf` };
}

// Skip the current stage: advance one state without filling its content (a stage can always be skipped).
export async function skipReviewStage(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviews).where(eq(schema.reviews.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review not found");
  const next = NEXT[row.state];
  if (!next) throw failedPrecondition("this review is already complete");
  const updated = await applyState(deps, id, row.state, { state: next });
  await audit(deps, actor, "review.skipStage", "reviews", id, stateMeta(row.state, next, { employee: `employees/${row.employeeId}` }), updated);
  return updated;
}
