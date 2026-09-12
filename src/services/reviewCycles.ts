import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, type SQL } from "drizzle-orm";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { allocFlatCode, allocOwnedCodesFor } from "./codeAlloc";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted, failedPrecondition } from "../lib/errors";
import { paginate } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, purgeRow, type PurgeCascade } from "./softDelete";
import { byIdChunks, chunk, insertBatches, runBatch } from "../lib/dbBatch";
import { notifyMany } from "./notifications";
import { checkEtag, updateAtVersion } from "./versionGuard";

export type ReviewCycleInput = {
  name?: string;
  period_start?: string | null;
  period_end?: string | null;
  goal_setting_due_date?: string | null;
  self_due_date?: string | null;
  manager_due_date?: string | null;
  /** Which framework competencies this cycle rates. Empty or null = all of them. */
  competency_keys?: string[] | null;
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const dateOrNull = (s?: string | null) => (s ? new Date(Date.parse(s + "T00:00:00Z")) : null);

// THE CALLER'S SCOPE IS BOUND HERE. This used to take the actor and ignore it (`_actor`) and read the whole
// table. The breadth is the lesser half of what that skipped: `scope` also carries the caller's per-object
// shares and DENIES (resolved by middleware/authz.ts for every collection-level list), and `applyScope` is the
// only thing that binds them - so a per-object deny on a cycle had no effect on this list.
// `review-cycles` is a flat catalog with a `code` and no owner column, so an own-scoped caller gets nothing.
export async function listReviewCycles(deps: Deps, _actor: AppUser, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const conds: (SQL | undefined)[] = [applyScope(scope, schema.reviewCycles.code, undefined)];
  if (!showDeleted) conds.push(isNull(schema.reviewCycles.deleteTime));
  return keysetPage<typeof schema.reviewCycles.$inferSelect>(deps, schema.reviewCycles, "review-cycles", and(...conds.filter(Boolean) as SQL[]), {
    max: maxPageSize,
    pageToken,
  });
}

async function getReviewCycle(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, id)).limit(1))[0];
  if (!row) throw notFound("review cycle not found");
  return row;
}

// How many reviews each of the given cycles has (for the wire `review_count`), in one query.
export async function reviewCountsFor(deps: Deps, cycleIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!cycleIds.length) return map;
  // Chunked over D1's 100-parameter ceiling (PARAM_CAP), like every other id list this file binds.
  const rows = await byIdChunks(cycleIds, (group) =>
    deps.db.select({ c: schema.reviews.cycleId }).from(schema.reviews).where(inArray(schema.reviews.cycleId, group)),
  );
  for (const r of rows) map.set(r.c, (map.get(r.c) ?? 0) + 1);
  return map;
}

export async function createReviewCycle(deps: Deps, actor: AppUser, input: ReviewCycleInput, id?: string) {
  if (!input.name?.trim()) throw invalidArgument("name is required");
  for (const k of ["period_start", "period_end", "goal_setting_due_date", "self_due_date", "manager_due_date"] as const) {
    if (input[k] && Number.isNaN(dayMs(input[k]))) throw invalidArgument(`${k} is invalid`);
  }
  const row = (await deps.db
    .insert(schema.reviewCycles)
    .values({
      code: await allocFlatCode(deps, schema.reviewCycles),
      ...(id ? { uuid: id } : {}),
      name: input.name.trim(),
      periodStart: dateOrNull(input.period_start),
      periodEnd: dateOrNull(input.period_end),
      goalSettingDueDate: dateOrNull(input.goal_setting_due_date),
      selfDueDate: dateOrNull(input.self_due_date),
      managerDueDate: dateOrNull(input.manager_due_date),
      competencyKeysJson: input.competency_keys?.length ? JSON.stringify([...new Set(input.competency_keys)]) : null,
    })
    .returning())[0]!;
  await audit(deps, actor, "review-cycle.create", "review-cycles", row.uuid, createdMeta(row, "review-cycles"), row);
  return row;
}

export async function updateReviewCycle(deps: Deps, actor: AppUser, id: string, patch: ReviewCycleInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.reviewCycles).where(eq(schema.reviewCycles.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("review cycle not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.reviewCycles> = { updatedAt: new Date() };
  const has = (k: keyof ReviewCycleInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name is required");
    set.name = patch.name.trim();
  }
  if (has("period_start")) set.periodStart = dateOrNull(patch.period_start);
  if (has("period_end")) set.periodEnd = dateOrNull(patch.period_end);
  if (has("goal_setting_due_date")) set.goalSettingDueDate = dateOrNull(patch.goal_setting_due_date);
  if (has("self_due_date")) set.selfDueDate = dateOrNull(patch.self_due_date);
  if (has("manager_due_date")) set.managerDueDate = dateOrNull(patch.manager_due_date);
  // An empty list means "all of them", the same as never having chosen - so it clears rather than storing a
  // selection that would narrow every review to nothing.
  if (has("competency_keys")) set.competencyKeysJson = patch.competency_keys?.length ? JSON.stringify([...new Set(patch.competency_keys)]) : null;
  const updated = await updateAtVersion(deps, schema.reviewCycles, "review cycle", row, set);
  await audit(deps, actor, "review-cycle.update", "review-cycles", id, diffMeta(row, updated, set, "review-cycles"), updated);
  return updated;
}

/**
 * Attach the reviewees' unclaimed in-window goals to the cycle they are being reviewed for.
 *
 * A goal set for "this quarter" is the same goal the quarter's review is about, but nobody re-states that by
 * hand for every person on the day the cycle launches - and before this link existed the review guessed it
 * from dates on every render, so the same goal could show up in two cycles or in none. Enrolling someone
 * claims their goals ONCE, explicitly, and the review reads the link from then on.
 *
 * Only goals that are unambiguous: open (a cancelled goal is nobody's objective), not already attached to
 * another cycle (an explicit link always wins over this inference), and due inside the review period. A cycle
 * with no period dates claims nothing - there is no window to be inside of - and HR attaches those by hand.
 */
async function claimGoalsForCycle(deps: Deps, cycle: typeof schema.reviewCycles.$inferSelect, employeeIds: string[]): Promise<number> {
  if (!cycle.periodStart || !cycle.periodEnd || !employeeIds.length) return 0;
  let claimed = 0;
  // Chunked: this binds one parameter per employee alongside the window bounds, and a launch names as many
  // employees as HR selected. Past the D1 100-parameter cap (lib/dbBatch.ts#PARAM_CAP) the statement is
  // `D1_ERROR: too many SQL variables`, which failed the launch of any cycle covering a hundred people - the
  // launches that matter most. 90 leaves room for the five bounds beside the id list.
  for (const ids of chunk(employeeIds, 90)) {
    const rows = await deps.db
      .update(schema.goals)
      .set({ cycleId: cycle.uuid })
      .where(and(
        inArray(schema.goals.employeeId, ids),
        isNull(schema.goals.cycleId),
        isNull(schema.goals.deleteTime),
        ne(schema.goals.status, "cancelled"),
        isNotNull(schema.goals.dueDate),
        gte(schema.goals.dueDate, new Date(cycle.periodStart)),
        lte(schema.goals.dueDate, new Date(cycle.periodEnd)),
      ))
      .returning({ uuid: schema.goals.uuid });
    claimed += rows.length;
  }
  return claimed;
}

// Create a review shell per selected employee that doesn't already have one in this cycle, notify each new
// reviewee that their self-assessment is open, and claim their in-window goals for the cycle. `actor`/
// `cycleName` power the notification attribution + body. Returns what actually happened, for the audit trail.
async function addReviewees(deps: Deps, cycle: typeof schema.reviewCycles.$inferSelect, employeeRefs: string[], actor: AppUser): Promise<{ added: string[]; goals: number }> {
  const ids = [...new Set(employeeRefs.map(idFromPath).filter(Boolean) as string[])];
  if (!ids.length) throw invalidArgument("select at least one employee");
  const existing = new Set(
    (await deps.db.select({ e: schema.reviews.employeeId }).from(schema.reviews).where(eq(schema.reviews.cycleId, cycle.uuid))).map((r) => r.e),
  );
  const added = ids.filter((id) => !existing.has(id));
  if (!added.length) return { added, goals: 0 };

  // A FAN-OUT, not a loop. Launching a cycle is the one action in this module that is inherently O(headcount),
  // and per employee it was a code allocation (read + write), an insert, and a `notify` (two reads, an insert
  // and a push) - about seven subrequests each, against a per-invocation budget of fifty. So launching a
  // cycle for a whole company died partway through, having opened reviews for the first handful of people and
  // told nobody else, with the cycle left ACTIVE as though it had worked. All three parts have a fan-out form:
  // one batch of counter bumps for the codes, chunked multi-row inserts for the rows, and `notifyMany` for the
  // announcement.
  const codes = await allocOwnedCodesFor(deps, schema.reviews, schema.reviews.employeeId, added);
  const rows = added
    .filter((employeeId) => codes.get(employeeId))
    .map((employeeId) => ({ code: codes.get(employeeId)!, cycleId: cycle.uuid, employeeId }));
  await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.reviews).values(group)));
  // The notification links to the cycle rather than to each person's own review row: one broadcast cannot
  // carry a different subject per recipient, and the reviews list is where a reviewee starts anyway.
  await notifyMany(deps, rows.map((r) => r.employeeId), {
    type: "review.opened",
    title: "Your performance review is open",
    body: `${cycle.name}: start your self-assessment.`,
    link: "reviews",
    subject: `review-cycles/${cycle.uuid}`,
    action: "respond",
    actorId: actor.employeeId,
  });
  return { added: rows.map((r) => r.employeeId), goals: await claimGoalsForCycle(deps, cycle, rows.map((r) => r.employeeId)) };
}

/**
 * How many of each cycle's reviewees actually have a goal attached to it, in one query.
 *
 * A review whose reviewee set no goals still runs - it just has nothing to score, and the manager finds that
 * out one review at a time. HR needs it as a number on the cycle ("9 of 12 have goals") while the cycle is
 * young enough to fix, which is the whole reason this rides the cycle resource rather than being counted from
 * the reviews the page happens to have loaded.
 */
export async function goalCoverageFor(deps: Deps, cycleIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!cycleIds.length) return map;
  const rows = await deps.db
    .selectDistinct({ c: schema.goals.cycleId, e: schema.goals.employeeId })
    .from(schema.goals)
    .where(and(inArray(schema.goals.cycleId, cycleIds), isNull(schema.goals.deleteTime)));
  for (const r of rows) if (r.c) map.set(r.c, (map.get(r.c) ?? 0) + 1);
  return map;
}

// Launch a DRAFT cycle: create reviews for the selected employees and mark it ACTIVE.
export async function launchReviewCycle(deps: Deps, actor: AppUser, id: string, employees: string[]) {
  const row = await getReviewCycle(deps, actor, id);
  if (row.state !== "DRAFT") throw failedPrecondition("only a draft cycle can be launched");
  // CLAIM THE LAUNCH FIRST (guarded DRAFT -> ACTIVE), then open the reviews.
  //
  // The work used to come first and the flip was unguarded, so two concurrent launches both passed the read
  // above and both ran `addReviewees` - which decides who is missing by READING the cycle's existing reviews,
  // so both read an empty set and both inserted the whole roster. Everyone ends up with two review rows and
  // two "your review is open" notices, and is counted twice in calibration and in the analytics.
  //
  // And this is the one action in the module shaped to provoke it: `addReviewees` is explicitly O(headcount)
  // (see its own note), so the button sits unresponsive for seconds, which is when people press it again -
  // and web/src/api.ts deliberately neither retries nor dedupes a POST.
  //
  // Claiming first means the loser stops on the guard having done NO work, rather than both racing through it
  // and one of them merely winning the stamp afterwards. `review_cycle_emp_idx` is the backstop underneath,
  // for the sibling path that stays racy by nature (`:addReviewees` on an already-ACTIVE cycle).
  //
  // If the fan-out then fails part-way the cycle is ACTIVE with some reviews open, which is recoverable in the
  // UI (`addRevieweesToCycle` requires exactly that state) and is the better of the two failure modes: the old
  // order could leave reviews opened and notices sent under a cycle still reading DRAFT.
  const updated = (await deps.db.update(schema.reviewCycles)
    .set({ state: "ACTIVE", updatedAt: new Date() })
    .where(and(eq(schema.reviewCycles.uuid, id), eq(schema.reviewCycles.state, "DRAFT"))).returning())[0];
  if (!updated) throw failedPrecondition("the cycle is no longer a draft");
  const { goals } = await addReviewees(deps, row, employees, actor);
  await audit(deps, actor, "review-cycle.launch", "review-cycles", id, stateMeta(row.state, "ACTIVE", {
    fields: employees.slice(0, 12),
    // Launching moves goals onto the cycle, which is a write nobody asked for by name - the trail says so.
    ...(goals ? { note: `attached ${goals} in-window goal${goals === 1 ? "" : "s"} to the cycle` } : {}),
  }), updated);
  return updated;
}

// Add more reviewees to an already-active cycle (HR onboarding someone mid-cycle).
export async function addRevieweesToCycle(deps: Deps, actor: AppUser, id: string, employees: string[]) {
  const row = await getReviewCycle(deps, actor, id);
  if (row.state !== "ACTIVE") throw failedPrecondition("the cycle must be active to add reviewees");
  const { goals } = await addReviewees(deps, row, employees, actor);
  // WHO was added. "Someone was added to the cycle mid-flight" is the question this entry exists to answer.
  await audit(deps, actor, "review-cycle.addReviewees", "review-cycles", id, {
    fields: employees.slice(0, 12),
    ...(goals ? { note: `attached ${goals} in-window goal${goals === 1 ? "" : "s"} to the cycle` } : {}),
  }, row);
  return row;
}

export async function setReviewCycleState(deps: Deps, actor: AppUser, id: string, state: "ACTIVE" | "CLOSED") {
  const row = await getReviewCycle(deps, actor, id);
  if (state === "CLOSED" && row.state !== "ACTIVE") throw failedPrecondition("only an active cycle can be closed");
  if (state === "ACTIVE" && row.state !== "CLOSED") throw failedPrecondition("only a closed cycle can be reopened");
  const updated = (await deps.db.update(schema.reviewCycles).set({ state, updatedAt: new Date() }).where(eq(schema.reviewCycles.uuid, id)).returning())[0]!;
  await audit(deps, actor, `review-cycle.${state === "CLOSED" ? "close" : "reopen"}`, "review-cycles", id, stateMeta(row.state, state), updated);
  return updated;
}

export async function deleteReviewCycle(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.reviewCycles, "review-cycle", "review-cycles", id, ifMatch);
}

// The cycle's one-hop children. Named and exported so test/purgeCascadeDrift can hold it against the foreign
// keys the schema declares - `bonuses.cycle_id` is the one that was missing.
export const REVIEW_CYCLE_PURGE_CASCADE: PurgeCascade = {
  remove: [{ table: schema.reviews, column: schema.reviews.cycleId }],
  // A goal set for this cycle, and a bonus awarded by it, are the person's own record and outlive the cycle -
  // the pointer is cut, not the record.
  detach: [
    { table: schema.goals, column: schema.goals.cycleId },
    { table: schema.bonuses, column: schema.bonuses.cycleId },
  ],
};

export async function purgeReviewCycle(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  // Tear down children bottom-up (FKs): feedback on the cycle's reviews, then the reviews, then the cycle.
  //
  // ALL OF IT DECLARED, so it rides the purge's single transaction. Run as awaited statements ahead of the
  // call, they committed whatever the purge then did - and the purge could still refuse, because
  // `bonuses.cycle_id` was never handled at all: any cycle that had paid out variable pay answered 409 with
  // every review of that cycle, and every piece of 360 feedback on them, already deleted. Feedback hangs off
  // the REVIEW rather than the cycle, which is what `first` is for.
  const reviewIds = (await deps.db.select({ uuid: schema.reviews.uuid }).from(schema.reviews).where(eq(schema.reviews.cycleId, id))).map((r) => r.uuid);
  const first = chunk(reviewIds, 90).map((group) => deps.db.delete(schema.reviewFeedback).where(inArray(schema.reviewFeedback.reviewId, group)));
  await purgeRow(deps, actor, schema.reviewCycles, "review-cycle", "review-cycles", id, ifMatch, undefined, { ...REVIEW_CYCLE_PURGE_CASCADE, first });
}
