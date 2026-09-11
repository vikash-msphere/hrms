import { allocOwnedCode, withFreshCode } from "./codeAlloc";
// WORKFLOW resource template (custom methods :approve/:reject/:cancel).
import { eq, ne, and, gte, lte, inArray, sql } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { round2 } from "../domain/money";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { dateWindow } from "./dateWindow";
import { leaveDays } from "../domain/leave";
import { holidayApplies } from "./holidays";
import { getSettingValue } from "./settings";
import { orgToday } from "./orgDay";
import { DEFAULT_ATTENDANCE, type AttendanceConfig } from "../domain/attendance";
import { refHolidays } from "../lib/refData";

// Holidays (UTC YYYY-MM-DD) in [startMs, endMs] - the days leave shouldn't count. Non-deleted, non-disabled
// holidays of any kind, minus the location-scoped ones that aren't this employee's (a Mumbai-only holiday must
// not quietly stop a Delhi employee's leave being charged). Half-day holidays come back separately: they cost
// half a leave day, not none.
async function holidaysInRange(
  deps: Deps,
  startMs: number,
  endMs: number,
  location: string | null,
): Promise<{ full: Set<string>; half: Set<string> }> {
  const rows = (await refHolidays(deps)).filter(
    (h) =>
      !h.deleteTime &&
      !h.disabled &&
      +new Date(h.date) >= startMs &&
      +new Date(h.date) <= endMs &&
      holidayApplies(h.location, location),
  );
  const ymd = (h: (typeof rows)[number]) => new Date(h.date).toISOString().slice(0, 10);
  return {
    full: new Set(rows.filter((h) => !h.halfDay).map(ymd)),
    half: new Set(rows.filter((h) => h.halfDay).map(ymd)),
  };
}

/** The work location of the employee the request is FOR (not the caller - a manager may file on their behalf). */
async function employeeLocation(deps: Deps, employeeId: string): Promise<string | null> {
  const rows = await deps.db
    .select({ location: schema.positions.location, effectiveTo: schema.positions.effectiveTo })
    .from(schema.positions)
    .where(eq(schema.positions.employeeId, employeeId));
  return rows.find((r) => !r.effectiveTo)?.location ?? null;
}

export type LeaveRequestInput = {
  employee?: string | null;
  leave_type?: string | null;
  start_date?: string; // YYYY-MM-DD
  end_date?: string;
  start_session?: number; // 1 = first half (AM), 2 = second half (PM); leave begins this session of start_date
  end_session?: number; // 1 = first half (AM), 2 = second half (PM); leave ends this session of end_date
  reason?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// A day maps to two half-day slots, so an overlap test can distinguish "ends the morning of the 3rd" from
// "starts the afternoon of the 3rd" - which is what lets those two abut rather than collide.
const slotOf = (ms: number, session: number) => Math.round(ms / 86_400_000) * 2 + (session === 2 ? 1 : 0);

/**
 * The employee's LIVE leave (pending or approved) that could touch `[startMs, endMs]`, at day granularity.
 *
 * Bounded in SQL on both axes - state AND the date window. It used to read every leave request the person had
 * ever filed and filter in JS, on the hot create path, and the probation cap below did the same again: two
 * whole-history scans per submission, over a table that only ever grows, on a database that bills rows read.
 * The window is the same predicate the JS loop applied, so nothing is decided differently here; the half-day
 * slot refinement stays with the caller because it is finer than a date column can express.
 *
 * `exceptUuid` drops one row from the answer - the row the caller has just inserted, when it is asking whether
 * anyone landed on top of it.
 */
function liveLeaveInWindow(deps: Deps, employeeId: string, startMs: number, endMs: number, exceptUuid?: string) {
  return deps.db
    .select()
    .from(schema.leaveRequests)
    .where(
      and(
        eq(schema.leaveRequests.employeeId, employeeId),
        inArray(schema.leaveRequests.state, ["PENDING", "APPROVED"]),
        gte(schema.leaveRequests.endDate, new Date(startMs)),
        lte(schema.leaveRequests.startDate, new Date(endMs)),
        ...(exceptUuid ? [ne(schema.leaveRequests.uuid, exceptUuid)] : []),
      ),
    );
}

type LeaveRow = typeof schema.leaveRequests.$inferSelect;

/** The first of `rows` that really overlaps `[startSlot, endSlot]` once half-day sessions are honoured. */
const overlapping = (rows: LeaveRow[], startSlot: number, endSlot: number) =>
  rows.filter((r) => startSlot <= slotOf(+new Date(r.endDate), r.endSession) && slotOf(+new Date(r.startDate), r.startSession) <= endSlot);

/**
 * Did `a` get here before `b`? A TOTAL order over rows - creation instant, `uuid` to break a same-millisecond
 * tie - which is what makes "the later one gives way" decidable by each competitor on its own, with no lock and
 * no shared state. Ordering on `uuid` alone is not enough: it says nothing about who arrived first, so when one
 * writer's re-check ran before the other had even inserted, the one that saw nothing kept its row AND the one
 * that saw it could still "win" the comparison and keep its own. Both survived, which is the bug.
 */
const arrivedFirst = (a: LeaveRow, b: LeaveRow) =>
  +new Date(a.createdAt) !== +new Date(b.createdAt) ? +new Date(a.createdAt) < +new Date(b.createdAt) : a.uuid < b.uuid;

// Org leave-request policy (generic settings key "leave-requests"). Default preserves the prior behaviour
// (back-dating allowed); HR can turn it off in Settings.
export const DEFAULT_LEAVE_REQUEST_CONFIG = { allow_backdated: true };

export async function listLeaveRequests(
  deps: Deps,
  scope: ListScope,
  maxPageSize: number,
  pageToken?: string,
  stateFilter?: string,
  q?: string,
  leaveTypeFilter?: string,
  fromYmd?: string,
  toYmd?: string,
  employeeFilter?: string,
) {
  // Visibility was decided in the middleware (scopeFor over the grant); here we only bind it to columns.
  const conds = [applyScope(scope, schema.leaveRequests.code, schema.leaveRequests.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "leave-requests", q, schema.leaveRequests.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.leaveRequests.state, stateFilter as typeof schema.leaveRequests.$inferSelect.state));
  // One leave type, as `leave-types/{leave_type_id}`. The edge already decoded the wire token, so the id is
  // internal here. Narrowing at the DB reaches rows past the 100-row page a client-side filter can only window.
  const leaveTypeId = idFromPath(leaveTypeFilter);
  if (leaveTypeId) conds.push(eq(schema.leaveRequests.leaveTypeId, leaveTypeId));
  // One person, as `employees/{employee_id}` (the edge decoded the token, so this is an internal id). What an
  // employee's profile asks for: without it that page read a page of the whole collection and filtered it in
  // the browser - dearer, and blind to any request of theirs sitting past the cursor. Narrows the scope above,
  // never widens it: a caller who may not see this person's leave still gets nothing.
  const employeeId = idFromPath(employeeFilter);
  if (employeeId) conds.push(eq(schema.leaveRequests.employeeId, employeeId));
  // `?from=&to=`: the window a calendar month asks for (see services/dateWindow.ts).
  conds.push(...dateWindow(schema.leaveRequests.startDate, schema.leaveRequests.endDate, fromYmd, toYmd));
  // SQL-side keyset pagination (DB orders + LIMITs) so an all-scope list never loads the whole table.
  return keysetPage(deps, schema.leaveRequests, "leave-requests", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
}

async function getLeaveRequest(deps: Deps, _actor: AppUser, id: string) {
  return getLeaveRequestRow(deps, id);
}

// The stored row by id. Read access (own / dept / all) is enforced by the middleware on leave-requests/<code>,
// so this is a plain fetch - exported for the attachment verbs, which answer with the request they documented.
export async function getLeaveRequestRow(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, id)).limit(1))[0];
  if (!row) throw notFound("leave request not found");
  return row;
}

export async function createLeaveRequest(deps: Deps, actor: AppUser, input: LeaveRequestInput) {
  const start = dayMs(input.start_date);
  const end = dayMs(input.end_date);
  if (!input.leave_type || Number.isNaN(start) || Number.isNaN(end)) throw invalidArgument("leave_type, start_date, end_date are required");
  if (end < start) throw invalidArgument("end_date must be on or after start_date");
  const startSession = input.start_session === 2 ? 2 : 1;
  const endSession = input.end_session === 1 ? 1 : 2;
  // On a single day the leave can't end before it begins (afternoon-start + morning-end is empty).
  if (start === end && startSession > endSession) throw invalidArgument("the start session must be on or before the end session");
  // Default the employee to the caller's own employee record unless an admin specifies one.
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");

  // Back-dated requests: gated by the org policy toggle, but only for self-service. HR acting on behalf of
  // someone else (input.employee set to another person) can always back-date, e.g. to record past leave.
  const onBehalf = !!idFromPath(input.employee) && idFromPath(input.employee) !== actor.employeeId;
  if (!onBehalf) {
    const { allow_backdated } = await getSettingValue(deps, "leave-requests", DEFAULT_LEAVE_REQUEST_CONFIG);
    if (!allow_backdated) {
      // "Today" in the ORG's timezone, not the Worker's UTC. The requested `start` is a date-only value
      // anchored at UTC midnight, and so is this once it is parsed back - but WHICH calendar day it names is
      // now the one the employee is living in. Derived in UTC, this refused a request starting today for
      // anyone west of UTC after their evening rollover, and let a genuinely back-dated one through for the
      // first hours of the local day east of it. See services/orgDay.ts.
      const todayMs = dayMs(await orgToday(deps));
      if (start < todayMs) throw failedPrecondition("back-dated leave requests aren't allowed - pick today or a future date");
    }
  }

  // No overlapping leave for the same person (including self): a new request can't intersect an existing
  // PENDING/APPROVED leave for this employee. Half-day sessions are respected by mapping each endpoint to a
  // half-day slot, so a morning-ending leave can still abut an afternoon-starting one on the same day.
  const newStartSlot = slotOf(start, startSession);
  const newEndSlot = slotOf(end, endSession);
  if (overlapping(await liveLeaveInWindow(deps, employeeId, start, end), newStartSlot, newEndSlot).length) {
    throw failedPrecondition("this overlaps an existing leave request for these dates");
  }

  // A disabled (or deleted) leave type can't be used for new requests.
  const leaveTypeId = idFromPath(input.leave_type)!;
  const lt = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.uuid, leaveTypeId)).limit(1))[0];
  if (!lt || lt.deleteTime || lt.disabled) throw invalidArgument("that leave type is unavailable");
  // Probation policy. A request "during probation" is one whose leave starts on or before probation end.
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  const probationEndMs = emp?.probationEndDate ? +new Date(emp.probationEndDate) : null;
  const duringProbation = probationEndMs !== null && start <= probationEndMs;
  if (duringProbation && !lt.availableDuringProbation) throw failedPrecondition("that leave type is not available during probation");

  // Chargeable days = configured working days in the range, minus holidays, honoring the start/end sessions.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const holidays = await holidaysInRange(deps, start, end, await employeeLocation(deps, employeeId));
  const days = leaveDays(start, end, startSession, endSession, att.work_days, holidays.full, holidays.half);
  if (days <= 0) throw invalidArgument("no working days in the selected range (weekends and holidays aren't counted) - pick a working day");

  // Balance check: a paid (entitlement-tracked) leave type can't be drawn below zero. The balance is reserved
  // at request time, so it already nets out earlier pending/approved requests. Unpaid types aren't balance-
  // limited. (idFromPath strips deleted/disabled types above.)
  if (lt.paid) {
    const bal = (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1))[0];
    const available = bal?.balanceDays ?? 0;
    if (days > available + 1e-9) {
      throw failedPrecondition(`not enough ${lt.name} balance: requested ${days} day(s) but only ${available} available`);
    }
  }

  // Probation usage cap: total days of this type TAKEN during probation may not exceed probationCapDays.
  // Every condition in SQL: this was the second whole-history scan of the create path, and the probation
  // window is a bound the column can express (a request STARTING on or before probation end).
  if (duringProbation && lt.probationCapDays != null) {
    const prior = await deps.db
      .select({ days: schema.leaveRequests.days })
      .from(schema.leaveRequests)
      .where(
        and(
          eq(schema.leaveRequests.employeeId, employeeId),
          eq(schema.leaveRequests.leaveTypeId, leaveTypeId),
          inArray(schema.leaveRequests.state, ["PENDING", "APPROVED"]),
          lte(schema.leaveRequests.startDate, new Date(probationEndMs!)),
        ),
      );
    const used = prior.reduce((s, r) => s + r.days, 0);
    if (used + days > lt.probationCapDays + 1e-9) {
      throw failedPrecondition(`exceeds the probation cap of ${lt.probationCapDays} day(s) for this leave type (already used ${used})`);
    }
  }
  // Allocated inside the retry (codeAlloc.ts): a long weekend is booked by the whole team in one afternoon,
  // and the second person to press should get their request rather than an error telling them to try again.
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.leaveRequests)
    .values({ code: await allocOwnedCode(deps, schema.leaveRequests, schema.leaveRequests.employeeId, employeeId), employeeId, leaveTypeId, startDate: new Date(start), endDate: new Date(end), days, startSession, endSession, reason: input.reason?.trim() || null, state: "PENDING" })
    .returning()))[0]!;

  // INSERT, THEN LOOK AGAIN. The check above is a read, and two submissions for the same dates - a double-
  // clicked button, or the same person on two devices - both pass it before either writes, so the same days
  // were booked twice and the balance debited twice for them. The balance debit below already defends itself
  // with a conditional decrement; this is the same defence for the invariant next to it.
  //
  // It has to run AFTER the insert: only once both rows exist can a competitor see the other at all. The rule
  // is THE LATER ROW GIVES WAY, ordered by `arrivedFirst` - and it has to be arrival order rather than a bare
  // id comparison, because the two checks do not have to be simultaneous. Whichever way they interleave, every
  // row that finds an earlier one steps back and the earliest never does, so exactly one survives: never both
  // (the earliest sees only later rows and keeps its place) and never none (nothing is earlier than the
  // earliest). Unwinding is a delete of the row we just made, before the balance has been touched, so a loser
  // leaves nothing behind to reconcile.
  const clashes = overlapping(await liveLeaveInWindow(deps, employeeId, start, end, row.uuid), newStartSlot, newEndSlot);
  if (clashes.some((c) => arrivedFirst(c, row))) {
    await deps.db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, row.uuid));
    throw failedPrecondition("this overlaps an existing leave request for these dates");
  }

  // Reserve the balance at request time; released if later rejected/cancelled. For a paid (entitlement) type
  // decrement CONDITIONALLY (WHERE balance_days >= days) so two concurrent requests can't both clear the
  // read-time check above and overdraw the balance - the loser matches 0 rows and we unwind the just-created
  // request. Unpaid types aren't entitlement-limited, so they use the plain adjust (may create the row).
  if (lt.paid) {
    const reserved = await deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} - ${days}) * 100) / 100`, updatedAt: new Date() })
      .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId), gte(schema.leaveBalances.balanceDays, days)))
      .returning();
    if (!reserved.length) {
      await deps.db.delete(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, row.uuid));
      throw failedPrecondition(`not enough ${lt.name} balance`);
    }
  } else {
    await adjustLeaveBalance(deps, employeeId, leaveTypeId, -days);
  }
  await audit(deps, actor, "leave_request.create", "leave-requests", row.uuid, createdMeta(row, "leave-requests"), row);
  await notifyManager(deps, employeeId, { type: "leave.requested", noun: "leave request" });
  await emitEvent(deps, actor, "leave.requested", {
    subject: `leave-requests/${row.uuid}`,
    employeeId,
    payload: { leaveTypeId, days, from: new Date(start).toISOString(), to: new Date(end).toISOString() },
  });
  return row;
}

// Add `delta` days to an employee's balance for a leave type (negative = consume). Creates the row if the
// employee has no balance for that type yet (so an approval before any accrual still records the usage).
async function adjustLeaveBalance(deps: Deps, employeeId: string, leaveTypeId: string, delta: number) {
  const bal = (await deps.db
    .select()
    .from(schema.leaveBalances)
    .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId)))
    .limit(1))[0];
  if (bal) {
    // SQL-side delta (not a JS read-modify-write): an increment computed in the DB can't lose a concurrent
    // reserve/release on the same balance row the way read-then-write would. Mirrors the guarded debit above.
    await deps.db
      .update(schema.leaveBalances)
      .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} + ${delta}) * 100) / 100`, updatedAt: new Date() })
      .where(eq(schema.leaveBalances.uuid, bal.uuid));
  } else {
    await withFreshCode(async () =>
      deps.db
        .insert(schema.leaveBalances)
        .values({ code: await allocOwnedCode(deps, schema.leaveBalances, schema.leaveBalances.employeeId, employeeId), employeeId, leaveTypeId, balanceDays: round2(delta) }),
    );
  }
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED") {
  const row = await getLeaveRequest(deps, actor, id);
  // Who may approve/reject/cancel is gated by the verb's grant (middleware). Here only the instance state +
  // dates matter. Approve/reject act on a PENDING request; cancel also works on an APPROVED leave that
  // hasn't started yet (so an employee can call off an upcoming approved leave and get the balance back).
  if (to === "CANCELLED") {
    if (row.state !== "PENDING" && row.state !== "APPROVED") throw failedPrecondition("only pending or approved leave can be cancelled");
    // "Has already started" is a question about CALENDAR DAYS, and both sides have to be the same kind of
    // thing. `start_date` is date-only, anchored at UTC midnight; comparing it against the raw instant asked
    // whether the UTC clock had passed that midnight, which is a different question everywhere but UTC. East
    // of UTC it stayed answerable "no" into the morning of the leave itself (until 05:30 in IST), so an
    // employee could cancel - and be refunded - a day they were already on. West of UTC it flipped to "yes"
    // the evening BEFORE, refusing to cancel leave that had not begun. Both sides are days now, read in the
    // org's timezone, the same way the back-dating gate above reads its "today". See services/orgDay.ts.
    if (row.state === "APPROVED" && +new Date(row.startDate) <= dayMs(await orgToday(deps))) {
      throw failedPrecondition("approved leave that has already started cannot be cancelled");
    }
  } else if (row.state !== "PENDING") {
    throw failedPrecondition("request is not pending");
  }
  // Guard the flip on the state we just validated so the decision is EXACTLY-ONCE: a concurrent or
  // double-clicked reject/cancel that also read PENDING loses here (0 rows) instead of both refunding the
  // balance twice (leave days are encashable = money, so a double refund is a real payout). 0 rows = someone
  // else already decided it.
  const from = row.state;
  const [updated] = await deps.db
    .update(schema.leaveRequests)
    .set({ state: to, decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.leaveRequests.uuid, id), eq(schema.leaveRequests.state, from)))
    .returning();
  if (!updated) throw failedPrecondition("request was already decided");
  // Balance is reserved at request time, so approval changes nothing; rejecting or cancelling releases it back.
  if (to === "REJECTED" || to === "CANCELLED") await adjustLeaveBalance(deps, row.employeeId, row.leaveTypeId, row.days);
  await audit(deps, actor, `leave_request.${to.toLowerCase()}`, "leave-requests", id, stateMeta(from, to, { employee: `employees/${row.employeeId}` }), updated);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `leave.${to.toLowerCase()}`, title: `Leave ${to.toLowerCase()}`, body: `Your leave request was ${to.toLowerCase()}.`, link: "leave-requests/history", subject: `leave-requests/${id}`, actorId: actor.employeeId });
  }
  await emitEvent(deps, actor, `leave.${to.toLowerCase()}`, {
    subject: `leave-requests/${id}`,
    employeeId: row.employeeId,
    payload: { leaveTypeId: row.leaveTypeId, days: row.days, from: new Date(row.startDate).toISOString(), to: new Date(row.endDate).toISOString() },
  });
  return updated;
}

export const approveLeaveRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "APPROVED");
export const rejectLeaveRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "REJECTED");
export const cancelLeaveRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");
