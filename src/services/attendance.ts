import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { and, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument, failedPrecondition, clockNetworkFence, isOpenAttendanceCollision } from "../lib/errors";
import { parseIpAllowList, ipMatchesAny } from "../lib/ipAllow";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, localDay, localMinutes } from "../domain/attendance";
import { getSettingValue } from "./settings";

// Attendance clock sessions. A session is one clock-in -> clock-out pair; an OPEN session (clockOut null)
// means the employee is currently clocked in. Breaks = clock out then clock in again (a new session).
// Per-day status (late/early/absent) is derived on the client from these sessions + the org schedule.

export type SessionFilters = { open?: boolean; from?: number; to?: number; employeeId?: string };

export async function listSessions(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, filters: SessionFilters = {}) {
  // Visibility (own / dept / all) was decided in the middleware; here we only bind it to columns.
  const conds = [applyScope(scope, schema.attendanceSessions.code, schema.attendanceSessions.employeeId), isNull(schema.attendanceSessions.supersededBy)];
  if (filters.open) conds.push(isNull(schema.attendanceSessions.clockOut));
  if (filters.employeeId) conds.push(eq(schema.attendanceSessions.employeeId, filters.employeeId));
  // THE DATE WINDOW IS BOUND IN SQL, and so is the page. Both used to be applied in JS over the whole scoped
  // table: for an HR caller the scope predicate is empty, so every request read `attendance_sessions` in
  // full - the highest-volume table in the app, two rows per employee per working day, growing with history
  // rather than headcount - and then kept ~one month of it. The Attendance page asks three times per view
  // and follows the cursor up to ten pages a time (web/src/lib/clock.tsx listAllSessions), so one page view
  // was up to thirty whole-table reads. D1 bills rows READ, which is what made it a cost and latency
  // problem long before it was a correctness one. Same treatment listTimeEntries already gets.
  if (filters.from !== undefined) conds.push(gte(schema.attendanceSessions.clockIn, new Date(filters.from)));
  if (filters.to !== undefined) conds.push(lte(schema.attendanceSessions.clockIn, new Date(filters.to)));
  // Most recent first (open sessions and today's punches surface at the top), keyed on the PUNCH rather than
  // the row's creation - which is what the cursor carries for this one collection, so the sort key is passed
  // to keysetPage explicitly. `clock_in` is NOT NULL for every row, which is what a keyset sort key needs.
  const where = conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as SQL[])) : undefined;
  return keysetPage<typeof schema.attendanceSessions.$inferSelect>(deps, schema.attendanceSessions, "attendance", where, {
    max: maxPageSize,
    pageToken,
    order: { expr: sql`${schema.attendanceSessions.clockIn}`, value: (r) => +new Date(r.clockIn) },
  });
}

// The caller's LIVE open session, or undefined. Both punches gate on it, so it decides whether a person can
// clock in at all.
//
// SUPERSEDED PUNCHES ARE NOT PUNCHES, and this was the one reader in the app that did not say so. Every other
// one filters it - `listSessions` directly above, services/compOff.ts, services/peopleAnalytics.ts, and the
// loss-of-pay assemblers in services/payroll.ts and services/settlements.ts, whose comment asserts that
// "every other reader of this table already filters it (services/attendance.ts, ...)". True of the list in
// this file; not true of this function.
//
// It is reachable with no race at all. An approved regularization supersedes the day's punches selected by
// `clock_in` with `superseded_by is null` (services/attendanceRegularizations.ts) - an OPEN session among them
// included - and writes only closed corrected pairs in their place. So correcting a day you are still clocked
// in on leaves a superseded row with `clock_out` still null, and unfiltered that row reads as "you are
// clocked in" FOREVER: `clockIn` answers "already clocked in" on every later attempt, the person can never
// punch again, and because loss of pay is derived from punches, every subsequent working day is docked as a
// full absence with nothing on screen explaining it. `clockOut` appears to release it only by writing
// `clock_out` onto a row that every derived reader ignores, so the punch is discarded.
//
// The partial unique index `att_open_emp_idx` matches these two columns exactly - one is the reader, the
// other the backstop, and neither is sufficient alone.
async function openSessionFor(deps: Deps, employeeId: string) {
  return (await deps.db
    .select()
    .from(schema.attendanceSessions)
    .where(and(
      eq(schema.attendanceSessions.employeeId, employeeId),
      isNull(schema.attendanceSessions.clockOut),
      isNull(schema.attendanceSessions.supersededBy),
    ))
    .limit(1))[0];
}

// Where a punch came from, resolved by the route from the request. `allowList` is the raw
// ATTENDANCE_ALLOWED_IPS value; `ip` is the client address Cloudflare vouches for (null if it could not be
// established). Both punches take it so the fence cannot be bypassed by reaching a punch through another
// entry point - the internal batch dispatcher included.
export type PunchOrigin = { ip: string | null; allowList?: string };

// Whether an APPROVED remote-work request covers the instant `at` for this employee - the fence's one
// exception. Half-day sessions are honored via the same half-day slot arithmetic leave-requests uses for
// overlap: each endpoint maps to a slot (day * 2, +1 for the PM half) and the punch maps to the slot its own
// wall clock falls in, read in the ORG timezone - the same timezone that decides which calendar day a punch
// belongs to everywhere else (domain/attendance.ts). AM/PM split at 12:00 local, as "first half / second
// half" implies. So an afternoon-only approval does not excuse a 09:00 punch from the wrong network.
//
// APPROVED only. A PENDING request must never ease the fence, or filing one would be a self-service bypass.
async function remoteWorkCovers(deps: Deps, employeeId: string, at: number): Promise<boolean> {
  // THE DATE BOUND IS IN SQL. This used to select every APPROVED remote-work request the employee had ever
  // had, with no bound at all, and filter in JS - on a table that only grows, for a read paid by every
  // off-network punch in a remote-first org. The sibling reads in this file push their windows into SQL and
  // the repo's D1 discipline is explicit about it; this is that pair of predicates.
  //
  // WIDE IN SQL, EXACT IN JS - the rule services/orgDay.ts states. `start_date`/`end_date` are DATE-ONLY
  // columns anchored at UTC midnight, while `at` is an INSTANT, and the slot arithmetic below decides the call
  // in the ORG timezone. No zone is more than 14 hours from UTC, so a punch on the last covered local day can
  // sit up to a day and a half past that day's UTC-midnight anchor: two days of slack at each end covers every
  // row the slot test could possibly match, and the test itself still makes the decision.
  const slackMs = 2 * 86_400_000;
  const approved = await deps.db
    .select()
    .from(schema.remoteWorkRequests)
    .where(and(
      eq(schema.remoteWorkRequests.employeeId, employeeId),
      eq(schema.remoteWorkRequests.state, "APPROVED"),
      gte(schema.remoteWorkRequests.endDate, new Date(at - slackMs)),
      lte(schema.remoteWorkRequests.startDate, new Date(at + slackMs)),
    ));
  if (!approved.length) return false;
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const tz = att.timezone || DEFAULT_ATTENDANCE.timezone;
  const dayIndex = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
  const slotOf = (ms: number, session: number) => Math.round(ms / 86_400_000) * 2 + (session === 2 ? 1 : 0);
  const punchSlot = dayIndex(localDay(at, tz)) * 2 + (localMinutes(at, tz) >= 720 ? 1 : 0);
  return approved.some((r) => slotOf(+new Date(r.startDate), r.startSession) <= punchSlot && punchSlot <= slotOf(+new Date(r.endDate), r.endSession));
}

// The network fence, on CLOCK-IN ONLY. Empty/unset list = no fence. With a fence configured an unresolvable
// client IP is a denial, not a pass: a punch we cannot place is exactly what the fence exists to stop.
//
// The fence answers "are you at work?", and approved remote work is the sanctioned answer "no, and that was
// agreed" - so an off-network punch is allowed for exactly the approved period, and is fenced again the
// moment that period ends. The lookup runs ONLY after the IP misses, so the ordinary in-office punch (and
// every punch in a deployment with no fence) still costs no extra read.
//
// WHY CLOCK-OUT IS NOT FENCED. "Are you at work?" is the question whose answer is NO at the moment somebody
// leaves the building, so fencing the closing punch refused it for the ordinary case it was aimed at. The
// session then stays open, `att_open_emp_idx` is a partial unique index on (employee, open), so every later
// `clockIn` answers "already clocked in" and the person can never punch again - and loss of pay is derived
// from punches, so every subsequent working day reads as a full absence (services/payroll.ts#assembleLop)
// with nothing on screen explaining why. Recovery needed an approved regularization, i.e. an approver, before
// the employee could clock in again. Closing a session you already opened asserts nothing about where you
// are; the in-office punch that OPENED it is the one this fence exists to check.
async function assertPunchOrigin(deps: Deps, employeeId: string, at: number, origin: PunchOrigin): Promise<void> {
  const rules = parseIpAllowList(origin.allowList);
  if (!rules.length) return;
  if (ipMatchesAny(origin.ip, rules)) return;
  if (await remoteWorkCovers(deps, employeeId, at)) return;
  throw clockNetworkFence("attendance clock in/out is only allowed from an approved network, or during approved remote work");
}

// Clock in: open a new session for the caller now. Errors if one is already open.
export async function clockIn(deps: Deps, actor: AppUser, origin: PunchOrigin) {
  const employeeId = actor.employeeId;
  if (!employeeId) throw invalidArgument("you are not linked to an employee record");
  // One instant for both the fence and the stamp, so a punch can never be judged against a moment other than
  // the one it is recorded at (an approval expiring mid-request would otherwise decide it either way).
  const at = +deps.clock.now();
  await assertPunchOrigin(deps, employeeId, at, origin);
  if (await openSessionFor(deps, employeeId)) throw failedPrecondition("already clocked in");
  // Allocated inside the retry: a shift change is everybody clocking in at once (codeAlloc.ts).
  //
  // The read above and this insert are two statements, so a second punch arriving between them passes the
  // same check - `att_open_emp_idx` is what stops both rows existing. Translated to the answer the check
  // above gives in words rather than surfacing as a 500: the caller is not wrong, they are already clocked
  // in. See lib/errors.ts#isOpenAttendanceCollision for what two open rows actually cost.
  let row: typeof schema.attendanceSessions.$inferSelect;
  try {
    row = (await withFreshCode(async () => deps.db
      .insert(schema.attendanceSessions)
      .values({ code: await allocOwnedCode(deps, schema.attendanceSessions, schema.attendanceSessions.employeeId, employeeId), employeeId, clockIn: new Date(at), source: "clock" })
      .returning()))[0]!;
  } catch (e) {
    if (isOpenAttendanceCollision(e)) throw failedPrecondition("already clocked in");
    throw e;
  }
  return row;
}

// Clock out: close the caller's open session now. Errors if none is open.
export async function clockOut(deps: Deps, actor: AppUser) {
  const employeeId = actor.employeeId;
  if (!employeeId) throw invalidArgument("you are not linked to an employee record");
  const at = +deps.clock.now();
  // NOT fenced - see assertPunchOrigin. Refusing the closing punch locks the session open, and an open
  // session is what docks every later day as a full absence.
  const open = await openSessionFor(deps, employeeId);
  if (!open) throw failedPrecondition("not clocked in");
  const [row] = await deps.db
    .update(schema.attendanceSessions)
    .set({ clockOut: new Date(at), updatedAt: new Date() })
    .where(eq(schema.attendanceSessions.uuid, open.uuid))
    .returning();
  return row!;
}

