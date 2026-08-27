import { allocOwnedCode } from "./codeAlloc";
import { and, eq, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument, failedPrecondition, clockNetworkFence } from "../lib/errors";
import { parseIpAllowList, ipMatchesAny } from "../lib/ipAllow";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, localDay, localMinutes } from "../domain/attendance";
import { getSettingValue } from "./settings";
import { paginate } from "../http/pagination";

// Attendance clock sessions. A session is one clock-in -> clock-out pair; an OPEN session (clockOut null)
// means the employee is currently clocked in. Breaks = clock out then clock in again (a new session).
// Per-day status (late/early/absent) is derived on the client from these sessions + the org schedule.

export type SessionFilters = { open?: boolean; from?: number; to?: number; employeeId?: string };

export async function listSessions(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, filters: SessionFilters = {}) {
  // Visibility (own / dept / all) was decided in the middleware; here we only bind it to columns.
  const conds = [applyScope(scope, schema.attendanceSessions.code, schema.attendanceSessions.employeeId), isNull(schema.attendanceSessions.supersededBy)];
  if (filters.open) conds.push(isNull(schema.attendanceSessions.clockOut));
  if (filters.employeeId) conds.push(eq(schema.attendanceSessions.employeeId, filters.employeeId));
  const rows = (await deps.db.select().from(schema.attendanceSessions).where(conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as any)) : undefined))
    .filter((r) => {
      const t = +new Date(r.clockIn);
      return (filters.from === undefined || t >= filters.from) && (filters.to === undefined || t <= filters.to);
    });
  // Most recent first (open sessions and today's punches surface at the top), keyed on the PUNCH rather than
  // the row's creation - which is what the cursor carries for this one collection.
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.clockIn), (r) => r.uuid);
}

async function openSessionFor(deps: Deps, employeeId: string) {
  return (await deps.db
    .select()
    .from(schema.attendanceSessions)
    .where(and(eq(schema.attendanceSessions.employeeId, employeeId), isNull(schema.attendanceSessions.clockOut)))
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
  const approved = await deps.db
    .select()
    .from(schema.remoteWorkRequests)
    .where(and(eq(schema.remoteWorkRequests.employeeId, employeeId), eq(schema.remoteWorkRequests.state, "APPROVED")));
  if (!approved.length) return false;
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  const tz = att.timezone || DEFAULT_ATTENDANCE.timezone;
  const dayIndex = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
  const slotOf = (ms: number, session: number) => Math.round(ms / 86_400_000) * 2 + (session === 2 ? 1 : 0);
  const punchSlot = dayIndex(localDay(at, tz)) * 2 + (localMinutes(at, tz) >= 720 ? 1 : 0);
  return approved.some((r) => slotOf(+new Date(r.startDate), r.startSession) <= punchSlot && punchSlot <= slotOf(+new Date(r.endDate), r.endSession));
}

// The network fence. Empty/unset list = no fence. With a fence configured an unresolvable client IP is a
// denial, not a pass: a punch we cannot place is exactly what the fence exists to stop.
//
// The fence answers "are you at work?", and approved remote work is the sanctioned answer "no, and that was
// agreed" - so an off-network punch is allowed for exactly the approved period, and is fenced again the
// moment that period ends. The lookup runs ONLY after the IP misses, so the ordinary in-office punch (and
// every punch in a deployment with no fence) still costs no extra read.
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
  const row = (await deps.db
    .insert(schema.attendanceSessions)
    .values({ code: await allocOwnedCode(deps, schema.attendanceSessions, schema.attendanceSessions.employeeId, employeeId), employeeId, clockIn: new Date(at), source: "clock" })
    .returning())[0]!;
  return row;
}

// Clock out: close the caller's open session now. Errors if none is open.
export async function clockOut(deps: Deps, actor: AppUser, origin: PunchOrigin) {
  const employeeId = actor.employeeId;
  if (!employeeId) throw invalidArgument("you are not linked to an employee record");
  const at = +deps.clock.now();
  await assertPunchOrigin(deps, employeeId, at, origin);
  const open = await openSessionFor(deps, employeeId);
  if (!open) throw failedPrecondition("not clocked in");
  const [row] = await deps.db
    .update(schema.attendanceSessions)
    .set({ clockOut: new Date(at), updatedAt: new Date() })
    .where(eq(schema.attendanceSessions.uuid, open.uuid))
    .returning();
  return row!;
}

