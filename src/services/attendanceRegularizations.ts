import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { chunk, ID_CHUNK, runBatch } from "../lib/dbBatch";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { orgToday } from "./orgDay";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, localDay } from "../domain/attendance";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { restateLopForDay } from "./payroll";
import { assertNotSubject, assertReviewedVersion } from "./decisionGuard";

// Attendance regularization requests: an employee asks to correct a whole day's clock times, submitting the
// COMPLETE intended set of in/out pairs for the day. A manager (own dept) or HR approves; on approval the
// day's existing punches are superseded and the requested pairs are written as `correction` sessions, so the
// derived day recomputes exactly - no double-counting, no manual reconciliation.
//
// TODAY'S LAST SESSION MAY BE OPEN. Someone who forgot the morning punch, or punched it late, is usually
// still at work when they notice: they know when they came in and cannot know when they will leave. Such a
// request omits that session's `clock_out`, and it means "in since X, still clocked in". Approval then reads
// the day at filing time: the punches that existed when it was filed are replaced, the ones made after it
// stand, and the open session ends where the employee actually stopped - see `planApproval`.
export type SessionInput = { clock_in: string; clock_out?: string | null }; // ISO datetimes
export type RegularizationInput = {
  employee?: string | null;
  date?: string; // YYYY-MM-DD
  sessions?: SessionInput[]; // the full intended day; [] = remove all punches
  reason?: string | null;
};
type RequestedSession = { clock_in: string; clock_out?: string };
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Validate + normalise the requested pairs: each in<out, sorted by start, no overlaps, and at most the last
// one open - only on the org's today, and only from a clock-in that has already happened. Returns ISO pairs.
function normalizeSessions(sessions: SessionInput[], openAllowed: { today: boolean; now: number }): RequestedSession[] {
  const pairs = sessions.map((s) => {
    const cin = Date.parse(s.clock_in);
    const cout = s.clock_out == null ? null : Date.parse(s.clock_out);
    if (Number.isNaN(cin) || (cout !== null && Number.isNaN(cout))) throw invalidArgument("each session needs a valid clock_in and clock_out");
    if (cout !== null && cout <= cin) throw invalidArgument("clock_out must be after clock_in");
    return { cin, cout };
  });
  pairs.sort((a, b) => a.cin - b.cin);
  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1]!;
    if (prev.cout === null) throw invalidArgument("only the last session can be left without a clock_out");
    if (pairs[i]!.cin < prev.cout) throw invalidArgument("sessions must not overlap");
  }
  const open = pairs.at(-1)?.cout === null ? pairs.at(-1)! : undefined;
  if (open && !openAllowed.today) throw invalidArgument("clock_out is required - only today's last session can be left open");
  if (open && open.cin > openAllowed.now) throw invalidArgument("a session left open must start before now");
  return pairs.map((p) => ({ clock_in: new Date(p.cin).toISOString(), ...(p.cout !== null ? { clock_out: new Date(p.cout).toISOString() } : {}) }));
}

// `employeeId` narrows to ONE person's requests, the same `?employee=` every profile panel already has
// (leaveBalances, bonuses, compensation, positions, assets). It narrows what the scope already allows and
// never widens it: an approver asking for their own rows is asking for a subset of what they may read, and a
// caller scoped to themselves passing somebody else's id still gets nothing.
export async function listRegularizations(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, employeeId?: string) {
  const conds = [applyScope(scope, schema.attendanceRegularizations.code, schema.attendanceRegularizations.employeeId)];
  if (stateFilter) conds.push(eq(schema.attendanceRegularizations.state, stateFilter as typeof schema.attendanceRegularizations.$inferSelect.state));
  if (employeeId) conds.push(eq(schema.attendanceRegularizations.employeeId, employeeId));
  return keysetPage<typeof schema.attendanceRegularizations.$inferSelect>(deps, schema.attendanceRegularizations, "attendance-regularizations", and(...(conds.filter(Boolean) as any)), { max: maxPageSize, pageToken });
}

// The read side of the collection is the factory's generic get (same select, same 404); this stays internal
// because every decision needs the stored row (and its requested pairs) first.
async function getRegularization(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.attendanceRegularizations).where(eq(schema.attendanceRegularizations.uuid, id)).limit(1))[0];
  if (!row) throw notFound("regularization request not found");
  return row;
}

export async function createRegularization(deps: Deps, actor: AppUser, input: RegularizationInput) {
  const date = dayMs(input.date);
  if (Number.isNaN(date)) throw invalidArgument("date is required");
  if (!Array.isArray(input.sessions)) throw invalidArgument("sessions is required (an empty array clears the day)");
  // The org's today costs a settings read, so it is asked only by a request that leaves a session open.
  const leavesOpen = input.sessions.some((s) => s?.clock_out == null);
  const now = +deps.clock.now();
  const sessions = normalizeSessions(input.sessions, { today: leavesOpen && input.date === (await orgToday(deps)), now });
  // Default the employee to the caller's own record unless an admin files on someone's behalf.
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  // What the day says right now, kept beside what it should say, so a request that moves one punch reads as
  // that one change to the requester, the approver and the audit trail alike.
  const recordedSessions = (await daySessions(deps, employeeId, date)).rows.map((s) => ({
    clock_in: new Date(s.clockIn).toISOString(),
    ...(s.clockOut ? { clock_out: new Date(s.clockOut).toISOString() } : {}),
  }));
  // Allocated inside the retry (codeAlloc.ts): a forgotten punch is noticed by half a team at once.
  // `createdAt` is stamped from the same clock the open-session check read: approval splits the day's punches
  // at this instant (planApproval), so the two must agree on when the request was filed.
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.attendanceRegularizations)
    .values({ code: await allocOwnedCode(deps, schema.attendanceRegularizations, schema.attendanceRegularizations.employeeId, employeeId), employeeId, date: new Date(date), sessions, recordedSessions, reason: input.reason?.trim() || null, state: "PENDING", createdAt: new Date(now) })
    .returning()))[0]!;
  await audit(deps, actor, "attendance-regularization.create", "attendance-regularizations", row.uuid, { employee: `employees/${employeeId}`, date: new Date(date).toISOString().slice(0, 10), sessions, ...(input.reason ? { reason: input.reason } : {}) }, row);
  await notifyManager(deps, employeeId, { type: "regularization.requested", noun: "attendance regularization" });
  await emitEvent(deps, actor, "attendanceRegularization.requested", { subject: `attendance-regularizations/${row.uuid}`, employeeId, payload: { date: new Date(date).toISOString() } });
  return row;
}

type Regularization = typeof schema.attendanceRegularizations.$inferSelect;
type CorrectionPlan = { supersede: string[]; sessions: { clockIn: Date; clockOut: Date | null }[] };

// What approving `row` writes. The regularization becomes the day's source of truth: every existing
// (non-superseded) punch on the org-local day is superseded and the requested pairs are written as
// `correction` sessions, so the derived day recomputes from these alone - no double-count, nothing to
// reconcile by hand.
//
// A request that leaves its last session OPEN was filed mid-day, and the day kept going after it. So the day
// is split at the filing instant: punches that existed then are what the request corrects and are
// superseded; punches made afterwards stand. The open session ends where work actually stopped - at the
// clock-out of the session that was running when the request was filed, or, if none was running, at the
// first punch made after it. If neither has happened yet the person is still at work, and it is written open
// so they clock out as usual.
// One employee's live (non-superseded) punches on one org-local day, earliest first. Read by the create, to
// record what the request changes, and by the approval, to decide what it replaces.
async function daySessions(deps: Deps, employeeId: string, date: Date | number) {
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const tz = att.timezone || "Asia/Kolkata";
  // `date` is a DATE-ONLY column, anchored at UTC midnight like every other one in the schema, so the day it
  // names is read in UTC. It was read with `localDay(..., tz)` instead, which asks a different question: west
  // of UTC, midnight-Z on the requested day is the PREVIOUS evening locally, so an approval superseded the
  // wrong day's punches while writing the (correct, absolute) corrected instants - leaving two days wrong at
  // once. Invisible in the default configuration, because Asia/Kolkata is +05:30 and midnight-Z is 05:30 the
  // same morning. The audit line in `decide` already read it this way; the two now agree. See
  // services/orgDay.ts `dayStartMs` for the same rule stated once.
  const targetYmd = new Date(date).toISOString().slice(0, 10);
  // WIDEN IN SQL, DECIDE IN JS - the pattern services/orgDay.ts describes. This used to read EVERY
  // non-superseded punch the employee had ever made and keep the one day of them, so an ordinary approval
  // grew a whole tenure's worth of row reads. No timezone is more than 14 hours from UTC, so one UTC day of
  // slack on each side cannot exclude an instant whose org-local day is `targetYmd`; the exact call stays
  // with `localDay`, which is the one definition of a local day in the app.
  const dayStart = Date.parse(`${targetYmd}T00:00:00Z`);
  const rows = (await deps.db
    .select({ uuid: schema.attendanceSessions.uuid, clockIn: schema.attendanceSessions.clockIn, clockOut: schema.attendanceSessions.clockOut })
    .from(schema.attendanceSessions)
    .where(and(
      eq(schema.attendanceSessions.employeeId, employeeId),
      isNull(schema.attendanceSessions.supersededBy),
      gte(schema.attendanceSessions.clockIn, new Date(dayStart - 86_400_000)),
      lt(schema.attendanceSessions.clockIn, new Date(dayStart + 2 * 86_400_000)),
    )))
    .filter((s) => localDay(+new Date(s.clockIn), tz) === targetYmd)
    .sort((a, b) => +new Date(a.clockIn) - +new Date(b.clockIn));
  return { tz, rows };
}

async function planApproval(deps: Deps, row: Regularization): Promise<CorrectionPlan> {
  const { tz, rows: existing } = await daySessions(deps, row.employeeId, row.date);
  const sessions = row.sessions.map((p) => ({ clockIn: new Date(p.clock_in), clockOut: p.clock_out ? new Date(p.clock_out) : null }));
  const open = sessions.at(-1)?.clockOut === null ? sessions.at(-1)! : undefined;
  if (!open) return { supersede: existing.map((s) => s.uuid), sessions };

  const filedAt = +new Date(row.createdAt);
  const before = existing.filter((s) => +new Date(s.clockIn) <= filedAt);
  const after = existing.filter((s) => +new Date(s.clockIn) > filedAt); // earliest first, as read
  const running = before.find((s) => s.clockOut === null || +new Date(s.clockOut) > filedAt);
  open.clockOut = running ? running.clockOut : after[0]?.clockIn ?? null;
  if (open.clockOut === null) {
    // Written open, it becomes the person's ONE live open session (`att_open_emp_idx`). One still open on
    // another day - a forgotten clock-out - would collide, so say which punch is in the way instead.
    const other = (await deps.db
      .select({ uuid: schema.attendanceSessions.uuid, clockIn: schema.attendanceSessions.clockIn })
      .from(schema.attendanceSessions)
      .where(and(eq(schema.attendanceSessions.employeeId, row.employeeId), isNull(schema.attendanceSessions.clockOut), isNull(schema.attendanceSessions.supersededBy)))
      .limit(1))[0];
    if (other && !before.some((s) => s.uuid === other.uuid)) {
      throw failedPrecondition(`still clocked in from ${localDay(+new Date(other.clockIn), tz)} - that session needs a clock-out before this correction can leave the day open`);
    }
  }
  return { supersede: before.map((s) => s.uuid), sessions };
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED", ifMatch?: string) {
  const row = await getRegularization(deps, actor, id);
  // Who may approve/reject/cancel is gated by the verb's grant (middleware). Here: state, the version the
  // decider read, and - to approve - that it is not their own, since approval rewrites the day's punches and
  // with them the day's loss of pay.
  if (row.state !== "PENDING") throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  assertReviewedVersion(row, ifMatch);
  if (to === "APPROVED") await assertNotSubject(deps, actor, row.employeeId, "approve", "regularization");
  // Planned BEFORE the flip, so a correction that cannot be written is refused while it is still pending.
  const plan = to === "APPROVED" ? await planApproval(deps, row) : undefined;
  // Guard the flip on PENDING so approval is EXACTLY-ONCE: without it a double-clicked approve would
  // supersede the day's punches + insert the correction sessions twice (0 rows = already decided).
  const [updated] = await deps.db
    .update(schema.attendanceRegularizations)
    .set({ state: to, decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.attendanceRegularizations.uuid, id), eq(schema.attendanceRegularizations.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  if (plan) {
    // ONE atomic batch, not one UPDATE per punch. Sequentially they were N subrequests against the
    // per-invocation budget AND non-atomic: a failure partway left the day's punches superseded with no
    // correction rows written to replace them, which reads as a day nobody worked.
    if (plan.supersede.length) {
      await runBatch(deps.db, chunk(plan.supersede, ID_CHUNK).map((ids) =>
        deps.db.update(schema.attendanceSessions).set({ supersededBy: id, updatedAt: new Date() }).where(inArray(schema.attendanceSessions.uuid, ids))));
    }
    for (const p of plan.sessions) {
      // Each corrected session allocates its own code, so each is retried on its own: an approval that
      // writes three sessions must not fail on the third because somebody else clocked in mid-write.
      await withFreshCode(async () =>
        deps.db.insert(schema.attendanceSessions).values({
          code: await allocOwnedCode(deps, schema.attendanceSessions, schema.attendanceSessions.employeeId, row.employeeId),
          employeeId: row.employeeId,
          clockIn: p.clockIn,
          clockOut: p.clockOut,
          source: "correction",
          note: row.reason ?? null,
        }),
      );
    }
  }
  const verb = to === "APPROVED" ? "approve" : to === "REJECTED" ? "reject" : "cancel";
  await audit(deps, actor, `attendance-regularization.${verb}`, "attendance-regularizations", id, { employee: `employees/${row.employeeId}`, date: new Date(row.date).toISOString().slice(0, 10) });
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `regularization.${to.toLowerCase()}`, title: `Regularization ${to.toLowerCase()}`, body: `Your attendance regularization was ${to.toLowerCase()}.`, link: "attendance", subject: `attendance-regularizations/${id}`, actorId: actor.employeeId });
  }
  if (to === "APPROVED") await emitEvent(deps, actor, "attendanceRegularization.approved", { subject: `attendance-regularizations/${id}`, employeeId: row.employeeId, payload: { date: new Date(row.date).toISOString() } });
  // A regularization fixes the punches for one day, which can change that day's loss of pay. If the day sits
  // in a period whose run has already published, the correction is carried into the next run rather than
  // silently disagreeing with a payslip nobody can rebuild. Best-effort: the attendance fact is already
  // recorded and correct, and failing the decision because a correction could not be raised would refuse a
  // true statement about somebody's attendance to protect a number.
  await restateLopForDay(deps, row.employeeId, +new Date(row.date));
  return updated;
}

export const approveRegularization = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => decide(deps, actor, id, "APPROVED", ifMatch);
export const rejectRegularization = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => decide(deps, actor, id, "REJECTED", ifMatch);
export const cancelRegularization = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");
