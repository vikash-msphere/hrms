import { allocOwnedCode, withFreshCode } from "./codeAlloc";
// WORKFLOW resource template (custom methods :approve/:reject/:cancel).
import { eq, ne, and, gte, lte, inArray, isNull, sql } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import { scopeFor, type ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { round2 } from "../domain/money";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { restateLopForRange } from "./payroll";
import { dateWindow } from "./dateWindow";
import { leaveDays } from "../domain/leave";
import {
  checkLeaveRestrictions,
  hasAnyRestriction,
  historyWindow,
  mergeRestrictions,
  needsLifetime,
  parseRestrictions,
  sandwichOf,
  type LeaveNeighbour,
  type LeaveRestrictions,
  type Violation,
} from "../domain/leaveRestrictions";
import { holidayApplies } from "./holidays";
import { getSettingValue } from "./settings";
import { orgToday } from "./orgDay";
import { DEFAULT_ATTENDANCE, utcDay, type AttendanceConfig } from "../domain/attendance";
import { scheduleCtxWith } from "./workSchedule";
import { refHolidays, refLeaveTypes } from "../lib/refData";
import { getAttachment } from "./attachments";
import { runBatchChecked, type BatchStmt, type CheckedStmt } from "../lib/dbBatch";
import { assertNotSubject, assertReviewedVersion, requireRejectReason } from "./decisionGuard";

// Holidays (UTC YYYY-MM-DD) in [startMs, endMs] - the days leave shouldn't count. Non-deleted, non-disabled
// holidays of any kind, minus the location-scoped ones that aren't this employee's (a Mumbai-only holiday must
// not quietly stop a Delhi employee's leave being charged). Half-day holidays come back separately: they cost
// half a leave day, not none.
export async function holidaysInRange(
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
export const slotOf = (ms: number, session: number) => Math.round(ms / 86_400_000) * 2 + (session === 2 ? 1 : 0);

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
export const overlapping = (rows: LeaveRow[], startSlot: number, endSlot: number) =>
  rows.filter((r) => startSlot <= slotOf(+new Date(r.endDate), r.endSession) && slotOf(+new Date(r.startDate), r.startSession) <= endSlot);

/**
 * Did `a` get here before `b`? A TOTAL order over rows - creation instant, `uuid` to break a same-millisecond
 * tie - which is what makes "the later one gives way" decidable by each competitor on its own, with no lock and
 * no shared state. Ordering on `uuid` alone is not enough: it says nothing about who arrived first, so when one
 * writer's re-check ran before the other had even inserted, the one that saw nothing kept its row AND the one
 * that saw it could still "win" the comparison and keep its own. Both survived, which is the bug.
 */
export const arrivedFirst = (a: LeaveRow, b: LeaveRow) =>
  +new Date(a.createdAt) !== +new Date(b.createdAt) ? +new Date(a.createdAt) < +new Date(b.createdAt) : a.uuid < b.uuid;

// Org leave-request policy (generic settings key "leave-requests"). Default preserves the prior behaviour
// (back-dating allowed); HR can turn it off in Settings.
export const DEFAULT_LEAVE_REQUEST_CONFIG = { allow_backdated: true };

/**
 * The policy in force for one leave type: the org baseline (settings/leave_restrictions) with that type's own
 * overrides on top. See domain/leaveRestrictions.ts for what the two blobs mean together.
 */
/**
 * Does this caller's authority over leave requests reach past their own rows?
 *
 * Asked of the ENGINE rather than of the payload - see the note where it is used. It fails CLOSED: an actor
 * assembled without a grant (a caller that is not a real request - an internal helper, a test double) gets
 * "own", which waives nothing. Being wrong in that direction costs an HR user an exemption they can restore by
 * going through the API properly; being wrong in the other hands every employee a way past the org's policy.
 */
function reachesBeyondOwnRows(actor: AppUser): boolean {
  if (!actor.grant) return false;
  try {
    return scopeFor(actor, "leave-requests").breadth !== "own";
  } catch {
    // A grant the decision engine cannot read is not authority either.
    return false;
  }
}

export async function effectiveLeaveRules(deps: Deps, leaveType: { restrictions?: unknown }): Promise<LeaveRestrictions> {
  const org = await getSettingValue<Record<string, unknown>>(deps, "leave_restrictions", {});
  return mergeRestrictions(org, leaveType.restrictions);
}

/**
 * How far out to look for a combination rule some OTHER type declares about this one, or null when none does.
 *
 * A combination rule binds both types - "sick leave may not follow annual leave" is the same fact whichever of
 * the two it is written on, and the evaluator honours it from either side. But the request being filed only
 * consults ITS OWN policy to decide whether there is any policy to evaluate at all, so a rule written solely
 * on the other type would never be reached: the type being requested has an empty blob, the whole evaluation
 * is skipped as a no-policy request, and the rule silently does nothing on one side of the pair.
 *
 * Reads the cached leave-type snapshot (lib/refData.ts), so it costs no query of its own.
 */
async function inboundCombinationGap(deps: Deps, leaveTypeId: string): Promise<number | null> {
  const org = await getSettingValue<Record<string, unknown>>(deps, "leave_restrictions", {});
  let gap: number | null = null;
  for (const t of await refLeaveTypes(deps)) {
    if (t.uuid === leaveTypeId || t.deleteTime || t.disabled) continue;
    // Through the ONE merge, per type, rather than a cheaper hand-rolled read of the two leaves this needs:
    // the inheritance rule (absent inherits, null exempts) is subtle enough that a second implementation of it
    // here would be the place the two quietly disagree. It is object copying over a handful of types, not a
    // read - the cost that matters on this path is the queries, and this issues none.
    const c = mergeRestrictions(org, t.restrictions).combinations;
    if (!c.no_combination_with?.some((ref) => (ref.split("/").pop() ?? ref) === leaveTypeId)) continue;
    gap = Math.max(gap ?? 0, c.gap_days ?? 0);
  }
  return gap;
}

/**
 * Everything the pure evaluator needs that only the database knows, gathered under one rule: READ NOTHING A
 * CONFIGURED RULE DOES NOT ASK FOR.
 *
 * That is not tidiness. D1 bills rows read and this is the hot create path, so an org that has set no policy
 * at all must pay exactly what it paid before this feature existed - which is why `historyWindow` can answer
 * "no window" and every read below is behind its own rule being present.
 */
async function gatherPolicyFacts(
  deps: Deps,
  rules: LeaveRestrictions,
  a: {
    employeeId: string;
    leaveTypeId: string;
    start: number;
    end: number;
    liveRows: LeaveRow[]; // already read for the overlap check, over at least the policy window
    employeeEndMs: number | null;
    todayMs: number;
  },
) {
  const types = await refLeaveTypes(deps);
  const nameOf = new Map(types.map((t) => [t.uuid, t.name]));
  const exclusionsOf = new Map(types.map((t) => [t.uuid, parseRestrictions(t.restrictions).combinations.no_combination_with]));
  const neighbours: LeaveNeighbour[] = a.liveRows.map((r) => ({
    uuid: r.uuid,
    leaveTypeId: r.leaveTypeId,
    leaveTypeName: nameOf.get(r.leaveTypeId),
    startMs: +new Date(r.startDate),
    endMs: +new Date(r.endDate),
    startSession: r.startSession,
    endSession: r.endSession,
    noCombinationWith: exclusionsOf.get(r.leaveTypeId) ?? null,
  }));

  // Lifetime totals are an AGGREGATE, never a row read: "ever" is not a window, and a career of leave is not
  // something to pull into the isolate to add up.
  let lifetime: { requests: number; days: number } | null = null;
  if (needsLifetime(rules)) {
    const row = (await deps.db
      .select({ n: sql<number>`count(*)`, d: sql<number>`coalesce(sum(${schema.leaveRequests.days}), 0)` })
      .from(schema.leaveRequests)
      .where(and(
        eq(schema.leaveRequests.employeeId, a.employeeId),
        eq(schema.leaveRequests.leaveTypeId, a.leaveTypeId),
        inArray(schema.leaveRequests.state, ["PENDING", "APPROVED"]),
      )))[0];
    lifetime = { requests: Number(row?.n ?? 0), days: Number(row?.d ?? 0) };
  }

  // The exit window: a notice period being SERVED is the authoritative statement that someone is leaving; a
  // recorded last working day with no notice row is the fallback, because the two are entered independently
  // and a policy that only fired for one of them would look like it was not working.
  let exitWindow: { fromMs: number; toMs: number } | null = null;
  let exitDaysUsed = 0;
  if (rules.exit.during_notice && rules.exit.during_notice !== "allowed") {
    const serving = await deps.db
      .select({ noticeDate: schema.noticePeriods.noticeDate, lastWorkingDay: schema.noticePeriods.lastWorkingDay })
      .from(schema.noticePeriods)
      .where(and(
        eq(schema.noticePeriods.employeeId, a.employeeId),
        eq(schema.noticePeriods.status, "serving"),
        isNull(schema.noticePeriods.deleteTime),
      ));
    const latest = serving.sort((x, y) => +new Date(y.lastWorkingDay) - +new Date(x.lastWorkingDay))[0];
    if (latest) exitWindow = { fromMs: +new Date(latest.noticeDate), toMs: +new Date(latest.lastWorkingDay) };
    else if (a.employeeEndMs != null && a.employeeEndMs >= a.todayMs) exitWindow = { fromMs: a.todayMs, toMs: a.employeeEndMs };
    if (exitWindow && rules.exit.during_notice === "capped") {
      // Days on requests that OVERLAP the notice window, counted whole - a request that straddles the notice
      // date contributes all of itself. An aggregate is what keeps this one cheap statement rather than a page
      // of rows plus a recount, and the difference only shows on a request that begins before the person
      // resigned, which the cap is not really aimed at.
      const row = (await deps.db
        .select({ d: sql<number>`coalesce(sum(${schema.leaveRequests.days}), 0)` })
        .from(schema.leaveRequests)
        .where(and(
          eq(schema.leaveRequests.employeeId, a.employeeId),
          eq(schema.leaveRequests.leaveTypeId, a.leaveTypeId),
          inArray(schema.leaveRequests.state, ["PENDING", "APPROVED"]),
          gte(schema.leaveRequests.endDate, new Date(exitWindow.fromMs)),
          lte(schema.leaveRequests.startDate, new Date(exitWindow.toMs)),
        )))[0];
      exitDaysUsed = Number(row?.d ?? 0);
    }
  }
  return { neighbours, lifetime, exitWindow, exitDaysUsed };
}

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

  /**
   * "HR IS FILING THIS FOR SOMEBODY ELSE" - which waives the planning courtesies (notice, blackouts, blocked
   * weekdays, back-dating), because those exist to protect a team's plans from its own members' short notice,
   * not to stop HR recording leave that has already happened.
   *
   * IT IS A QUESTION ABOUT AUTHORITY, NOT ABOUT THE BODY. Naming another employee in the payload is something
   * any caller can do - the create gate on this collection is collection-level (`leave-requests: write` is how
   * self-service works), so it decides nothing about WHOSE leave is being filed. Reading the exemption off the
   * payload alone therefore handed every employee a way to file leave that skips the org's notice policy, by
   * addressing it to a colleague. The scope the caller actually holds is the honest question, and
   * `scopeFor` answers it with the same engine the middleware used to let the request in: only a caller whose
   * reach extends past their own rows (a manager over their department, HR over all) can be filing on anybody
   * else's behalf.
   */
  const subjectIsSomeoneElse = !!idFromPath(input.employee) && idFromPath(input.employee) !== actor.employeeId;
  const onBehalf = subjectIsSomeoneElse && reachesBeyondOwnRows(actor);

  // A disabled (or deleted) leave type can't be used for new requests. Read FIRST, because the type carries
  // the policy every check below is made under (its own back-dating window included).
  const leaveTypeId = idFromPath(input.leave_type)!;
  const lt = (await deps.db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.uuid, leaveTypeId)).limit(1))[0];
  if (!lt || lt.deleteTime || lt.disabled) throw invalidArgument("that leave type is unavailable");
  const rules = await effectiveLeaveRules(deps, lt);
  // A type with no policy of its own is still bound by a combination rule another type declares about it.
  const inboundGap = await inboundCombinationGap(deps, leaveTypeId);
  const policyOn = hasAnyRestriction(rules) || inboundGap !== null;

  // Back-dated requests: gated by the org policy toggle, but only for self-service. HR acting on behalf of
  // someone else (input.employee set to another person) can always back-date, e.g. to record past leave.
  //
  // A leave type that sets its OWN back-dating window takes over from the toggle entirely - the toggle is one
  // yes/no for the whole org, and "sick leave may be filed three days late, nothing else may be back-dated"
  // is a sentence the toggle cannot say. The per-type rule is enforced with the rest of the policy below.
  //
  // "Today" in the ORG's timezone, not the Worker's UTC. The requested `start` is a date-only value anchored
  // at UTC midnight, and so is this once it is parsed back - but WHICH calendar day it names is now the one
  // the employee is living in. Derived in UTC, this refused a request starting today for anyone west of UTC
  // after their evening rollover, and let a genuinely back-dated one through for the first hours of the local
  // day east of it. See services/orgDay.ts.
  const perTypeBackdating = rules.request.backdate_days !== null;
  const { allow_backdated } = await getSettingValue(deps, "leave-requests", DEFAULT_LEAVE_REQUEST_CONFIG);
  const needsToday = policyOn || (!onBehalf && !allow_backdated && !perTypeBackdating);
  const todayMs = needsToday ? dayMs(await orgToday(deps)) : 0;
  if (!onBehalf && !allow_backdated && !perTypeBackdating && start < todayMs) {
    throw failedPrecondition("back-dated leave requests aren't allowed - pick today or a future date");
  }

  // Probation policy. A request "during probation" is one whose leave starts on or before probation end.
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  const probationEndMs = emp?.probationEndDate ? +new Date(emp.probationEndDate) : null;
  const duringProbation = probationEndMs !== null && start <= probationEndMs;
  if (duringProbation && !lt.availableDuringProbation) throw failedPrecondition("that leave type is not available during probation");

  // ONE read of this employee's live leave, over the widest window anything needs. The overlap check below
  // only ever cared about the requested range, but the policy rules (quotas, gaps, combinations, the merged
  // run) look further out - and reading the union once is a query, where reading it twice is two. With no
  // policy configured `historyWindow` answers null and the window collapses back to the requested range,
  // which is exactly what this path read before.
  const ownWindow = policyOn ? historyWindow(rules, start, end, emp?.startDate ? +new Date(emp.startDate) : null) : null;
  // Widened for a rule declared on the other side of a combination: that neighbour has to be in the window or
  // the rule cannot see it.
  const inboundPad = inboundGap !== null ? (inboundGap + 1) * 86_400_000 : 0;
  const policyWindow = ownWindow || inboundPad
    ? { fromMs: Math.min(ownWindow?.fromMs ?? start, start - inboundPad), toMs: Math.max(ownWindow?.toMs ?? end, end + inboundPad) }
    : null;
  const liveRows = await liveLeaveInWindow(deps, employeeId, policyWindow?.fromMs ?? start, policyWindow?.toMs ?? end);

  // No overlapping leave for the same person (including self): a new request can't intersect an existing
  // PENDING/APPROVED leave for this employee. Half-day sessions are respected by mapping each endpoint to a
  // half-day slot, so a morning-ending leave can still abut an afternoon-starting one on the same day.
  const newStartSlot = slotOf(start, startSession);
  const newEndSlot = slotOf(end, endSession);
  if (overlapping(liveRows, newStartSlot, newEndSlot).length) {
    throw failedPrecondition("this overlaps an existing leave request for these dates");
  }

  // Chargeable days = configured working days in the range, minus holidays, honoring the start/end sessions -
  // and then whatever the sandwich rule puts back (domain/leave.ts). The holiday set is fetched over the whole
  // policy window, not just the requested range, because the same set answers the rules below; the flanking
  // sandwich and the "not next to a holiday" rule both look one day past each end, so the window is padded.
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const holidayFrom = Math.min(start, policyWindow?.fromMs ?? start) - 8 * 86_400_000;
  const holidayTo = Math.max(end, policyWindow?.toMs ?? end) + 8 * 86_400_000;
  const holidays = await holidaysInRange(deps, holidayFrom, holidayTo, await employeeLocation(deps, employeeId));
  // Whose working days these are (services/workSchedule.ts): a week of leave costs a Mon/Wed/Fri part-timer
  // three days, not the five an org-wide weekday set would charge them. Resolved over the POLICY window, not
  // just the requested range, because the restriction rules below walk the neighbours too.
  const schedOf = (await scheduleCtxWith(deps, att, utcDay(holidayFrom), utcDay(holidayTo), [employeeId]))(employeeId);
  const days = leaveDays(start, end, startSession, endSession, schedOf, holidays.full, holidays.half, sandwichOf(rules));
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

  // ---- The leave policy (domain/leaveRestrictions.ts) -------------------------------------------------------
  // Runs LAST of the checks, so the cheap structural refusals (a disabled type, an overlap, no balance) are
  // still what a caller hears first, and the reads it needs only happen for a request that would otherwise be
  // accepted. A hard violation refuses the request; a soft one (the org listed the rule in `soft_rules`) is
  // carried onto the row for the approver to weigh.
  //
  // THIS IS A READ, AND IT IS NOT RE-CHECKED AFTER THE INSERT - unlike the overlap invariant above, which is.
  // Two requests filed in the same instant by the same person can therefore both pass a quota that only one of
  // them fits, and both land. That is a deliberate line rather than an oversight: the guarded re-check costs a
  // second read of the window on EVERY create, and the two failures are not the same size. The balance cannot
  // be overdrawn whatever happens here (the debit below is a conditional decrement), so what a lost race costs
  // is a policy breach an approver still sees - where the overlap it does guard would double-book the same days
  // and debit them twice. The realistic way to submit twice at once is a double-clicked button, and that files
  // the SAME dates, which the overlap guard already catches.
  let warnings: Violation[] = [];
  if (policyOn) {
    const facts = await gatherPolicyFacts(deps, rules, {
      employeeId,
      leaveTypeId,
      start,
      end,
      liveRows,
      employeeEndMs: emp?.endDate ? +new Date(emp.endDate) : null,
      todayMs,
    });
    const violations = checkLeaveRestrictions({
      rules,
      leaveTypeId,
      leaveTypeName: lt.name,
      startMs: start,
      endMs: end,
      startSession,
      endSession,
      days,
      todayMs,
      employeeStartMs: emp?.startDate ? +new Date(emp.startDate) : null,
      onBehalf,
      // The row has to exist before bytes can hang off it (the attachment is a second call), so at create time
      // there is nothing to look for and the document rule is skipped here. It is enforced where the document
      // can actually be checked: on approval, below.
      hasDocument: null,
      reason: input.reason ?? null,
      schedOf,
      holidays: holidays.full,
      halfDayHolidays: holidays.half,
      ...facts,
    });
    const blocking = violations.filter((v) => v.severity === "error");
    if (blocking.length) throw failedPrecondition(blocking.map((v) => v.message).join(" "));
    warnings = violations;
  }
  // Allocated inside the retry (codeAlloc.ts): a long weekend is booked by the whole team in one afternoon,
  // and the second person to press should get their request rather than an error telling them to try again.
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.leaveRequests)
    .values({ code: await allocOwnedCode(deps, schema.leaveRequests, schema.leaveRequests.employeeId, employeeId), employeeId, leaveTypeId, startDate: new Date(start), endDate: new Date(end), days, startSession, endSession, reason: input.reason?.trim() || null, state: "PENDING", policyWarnings: warnings.length ? warnings.map((w) => ({ code: w.code, message: w.message })) : null })
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
  // The waived rules go into the trail and onto the event as well as onto the row: the audit entry is where
  // "who let this through" is answered later, and an automation that routes short-notice leave to a second
  // approver has nothing else to key on.
  const waivedMeta = warnings.length ? { note: `policy waived: ${warnings.map((w) => w.code).join(", ")}` } : {};
  await audit(deps, actor, "leave_request.create", "leave-requests", row.uuid, { ...createdMeta(row, "leave-requests"), ...waivedMeta }, row);
  await notifyManager(deps, employeeId, { type: "leave.requested", noun: "leave request" });
  await emitEvent(deps, actor, "leave.requested", {
    subject: `leave-requests/${row.uuid}`,
    employeeId,
    payload: {
      leaveTypeId,
      days,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      ...(warnings.length ? { policyWarnings: warnings.map((w) => w.code) } : {}),
    },
  });
  return row;
}

// The employee's balance row for a leave type, created at zero if they have none yet (so an approval before
// any accrual still has somewhere to record the usage).
async function leaveBalanceRow(deps: Deps, employeeId: string, leaveTypeId: string) {
  const bal = (await deps.db
    .select()
    .from(schema.leaveBalances)
    .where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId)))
    .limit(1))[0];
  if (bal) return bal;
  return (await withFreshCode(async () => deps.db
    .insert(schema.leaveBalances)
    .values({ code: await allocOwnedCode(deps, schema.leaveBalances, schema.leaveBalances.employeeId, employeeId), employeeId, leaveTypeId, balanceDays: 0 })
    .returning()))[0]!;
}

// Add `delta` days to an employee's balance for a leave type (negative = consume).
async function adjustLeaveBalance(deps: Deps, employeeId: string, leaveTypeId: string, delta: number) {
  const bal = await leaveBalanceRow(deps, employeeId, leaveTypeId);
  // SQL-side delta (not a JS read-modify-write): an increment computed in the DB can't lose a concurrent
  // reserve/release on the same balance row the way read-then-write would. Mirrors the guarded debit above.
  await deps.db
    .update(schema.leaveBalances)
    .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} + ${delta}) * 100) / 100`, updatedAt: new Date() })
    .where(eq(schema.leaveBalances.uuid, bal.uuid));
}

// The refund half of a decision, as ONE statement that can go in the same batch as the state flip - and that
// carries the SAME precondition the flip does, so it cannot apply on its own. The balance row is materialized
// first because a conditional INSERT is not expressible as a single statement, and a zero-day row is inert if
// the decision then fails.
//
// Returned as an ARRAY, never a bare statement: a drizzle builder is a thenable, so an async function that
// RESOLVES with one has the promise machinery await it - i.e. run the query - and hand back its rows instead.
// Every other statement builder in the app returns an array for the same reason (loans.ts, payroll.ts).
async function leaveRefundStmts(deps: Deps, requestId: string, from: string, employeeId: string, leaveTypeId: string, days: number): Promise<BatchStmt[]> {
  const bal = await leaveBalanceRow(deps, employeeId, leaveTypeId);
  return [deps.db
    .update(schema.leaveBalances)
    .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} + ${days}) * 100) / 100`, updatedAt: new Date() })
    .where(and(
      eq(schema.leaveBalances.uuid, bal.uuid),
      // "...only if this request is still the thing I read". Runs BEFORE the flip in the batch, so it sees the
      // pre-decision state; if somebody else decided the request first, this matches nothing and the flip's
      // own guard matches nothing either, so a lost race refunds no days rather than refunding them twice.
      sql`exists (select 1 from ${schema.leaveRequests} where ${schema.leaveRequests.uuid} = ${requestId} and ${schema.leaveRequests.state} = ${from})`,
    ))];
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED", ifMatch?: string, reason?: string) {
  const row = await getLeaveRequest(deps, actor, id);
  assertReviewedVersion(row, ifMatch);
  // Approved leave excuses the days it covers (and unpaid leave is only docked if somebody else decided it), so
  // the person on leave may not be the one approving it.
  if (to === "APPROVED") await assertNotSubject(deps, actor, row.employeeId, "approve", "leave request");
  // Who may approve/reject/cancel is gated by the verb's grant (middleware). Here only the instance state +
  // dates matter. Approve/reject act on a PENDING request; cancel also works on an APPROVED leave that
  // hasn't started yet (so an employee can call off an upcoming approved leave and get the balance back).
  // Leave brought in from before HRMS (`source: import`) is a record of what happened, not a plan: it is
  // cancelled only to take a wrong import back out, which is HR's act on somebody else's record - never the
  // person's own, who could otherwise erase leave that counts against their quota. It started long ago by
  // definition, so the "already started" rule below does not apply to it.
  const imported = row.source === "import";
  if (to === "CANCELLED" && imported) {
    if (row.state !== "APPROVED") throw failedPrecondition("only approved leave can be cancelled");
    if (actor.employeeId && actor.employeeId === row.employeeId) {
      throw failedPrecondition("leave from before HRMS is removed by HR, not by the person it belongs to");
    }
  } else if (to === "CANCELLED") {
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
  // The one policy rule that cannot be checked when the request is filed: the supporting document is uploaded
  // against the row, so at create time there is nothing to look for. Approval is where it can be answered, and
  // is also where it matters - "a sick note is required past three days" is a condition of allowing the leave,
  // not of asking for it. Only read when the rule is actually configured for this type.
  if (to === "APPROVED") {
    // From the CACHED leave-type snapshot (lib/refData.ts), not a query of its own: this runs on every
    // approval in the org, and an org that has configured no document rule must not pay a read to find that
    // out. The snapshot is already in hand for any request that touched leave types this invocation.
    const lt = (await refLeaveTypes(deps)).find((t) => t.uuid === row.leaveTypeId);
    const rules = lt ? await effectiveLeaveRules(deps, lt) : null;
    const over = rules?.request.document_required_over_days ?? null;
    if (over !== null && row.days > over + 1e-9) {
      const doc = await getAttachment(deps, "leave-requests", row.uuid);
      if (!doc) {
        const soft = (rules?.soft_rules ?? []).includes("document_required");
        if (!soft) throw failedPrecondition(`${lt!.name} over ${over} day(s) needs a supporting document before it can be approved.`);
      }
    }
  }
  // Guard the flip on the state we just validated so the decision is EXACTLY-ONCE: a concurrent or
  // double-clicked reject/cancel that also read PENDING loses here (0 rows) instead of both refunding the
  // balance twice (leave days are encashable = money, so a double refund is a real payout). 0 rows = someone
  // else already decided it.
  const from = row.state;
  const flip: CheckedStmt = {
    stmt: deps.db
      .update(schema.leaveRequests)
      .set({ state: to, decidedBy: actor.uuid, decisionNote: reason ?? null, updatedAt: new Date() })
      .where(and(eq(schema.leaveRequests.uuid, id), eq(schema.leaveRequests.state, from)))
      .returning(),
    expect: 1,
    label: "leave request",
  };
  // Balance is reserved at request time, so approval changes nothing; rejecting or cancelling releases it back
  // - IN THE SAME BATCH as the flip, because the two are one act. As two statements, a D1 error or the
  // invocation ending between them left the request CANCELLED with the days simply gone, and the exactly-once
  // guard made that permanent: a retry re-reads the row, finds it is no longer `from`, and refuses, so the
  // refund could never be attempted again. Nothing reconciles leave balances (the accrual job only ever adds),
  // so the only repair was somebody editing a balance by hand - on the action an employee takes when they
  // decide not to go away after all. One batch is one implicit transaction: either the request is decided and
  // the days are back, or neither happened and the caller may try again. The refund goes FIRST and carries the
  // same `state = from` precondition, so a lost race writes neither half (a batch reports a short count, it
  // does not roll one statement back).
  // Imported leave never reserved anything (the opening balance already has it taken off), so there is
  // nothing to give back.
  const refund = (to === "REJECTED" || to === "CANCELLED") && !imported ? await leaveRefundStmts(deps, id, from, row.employeeId, row.leaveTypeId, row.days) : [];
  const drifted = await runBatchChecked(deps.db, [...refund, flip]);
  if (drifted.length) throw failedPrecondition("request was already decided");
  const updated = (await deps.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.uuid, id)).limit(1))[0]!;
  await audit(deps, actor, `leave_request.${to.toLowerCase()}`, "leave-requests", id, stateMeta(from, to, { employee: `employees/${row.employeeId}`, ...(reason ? { reason } : {}) }), updated);
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `leave.${to.toLowerCase()}`, title: `Leave ${to.toLowerCase()}`, body: reason ? `Your leave request was rejected: ${reason}` : `Your leave request was ${to.toLowerCase()}.`, link: "leave-requests/history", subject: `leave-requests/${id}`, actorId: actor.employeeId });
  }
  // No event for taking an import back out: it is a correction to history, and an automation keyed on
  // "leave cancelled" (a cover arrangement, a calendar entry) has nothing to act on for leave years ago.
  if (!imported) {
    await emitEvent(deps, actor, `leave.${to.toLowerCase()}`, {
      subject: `leave-requests/${id}`,
      employeeId: row.employeeId,
      payload: { leaveTypeId: row.leaveTypeId, days: row.days, from: new Date(row.startDate).toISOString(), to: new Date(row.endDate).toISOString() },
    });
  }
  // Approved leave EXCUSES an absence, and cancelling approved leave un-excuses it, so both directions can
  // change what a period should have docked. A request spanning a month boundary touches two periods, which
  // is why this is the range form. Only periods with a committed run do anything; an open one is re-read by
  // its own build. Best-effort, and deliberately after the state is committed - see `restateLopForDay`.
  if (to === "APPROVED" || to === "CANCELLED") {
    await restateLopForRange(deps, row.employeeId, +new Date(row.startDate), +new Date(row.endDate));
  }
  return updated;
}

export const approveLeaveRequest = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => decide(deps, actor, id, "APPROVED", ifMatch);
export const rejectLeaveRequest = async (deps: Deps, actor: AppUser, id: string, reason: string, ifMatch?: string) => decide(deps, actor, id, "REJECTED", ifMatch, requireRejectReason(reason));
export const cancelLeaveRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");
