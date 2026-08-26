import { allocOwnedCode } from "./codeAlloc";
import { and, eq, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { DEFAULT_ATTENDANCE, type AttendanceConfig, localDay } from "../domain/attendance";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { keysetPage } from "./keysetPage";

// Attendance regularization requests: an employee asks to correct a whole day's clock times, submitting the
// COMPLETE intended set of in/out pairs for the day. A manager (own dept) or HR approves; on approval the
// day's existing punches are superseded and the requested pairs are written as `correction` sessions, so the
// derived day recomputes exactly - no double-counting, no manual reconciliation.
export type SessionInput = { clock_in: string; clock_out: string }; // ISO datetimes
export type RegularizationInput = {
  employee?: string | null;
  date?: string; // YYYY-MM-DD
  sessions?: SessionInput[]; // the full intended day; [] = remove all punches
  reason?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Validate + normalise the requested pairs: each in<out, sorted by start, no overlaps. Returns ISO pairs.
function normalizeSessions(sessions: SessionInput[]): { clock_in: string; clock_out: string }[] {
  const pairs = sessions.map((s) => {
    const cin = Date.parse(s.clock_in);
    const cout = Date.parse(s.clock_out);
    if (Number.isNaN(cin) || Number.isNaN(cout)) throw invalidArgument("each session needs a valid clock_in and clock_out");
    if (cout <= cin) throw invalidArgument("clock_out must be after clock_in");
    return { cin, cout };
  });
  pairs.sort((a, b) => a.cin - b.cin);
  for (let i = 1; i < pairs.length; i++) if (pairs[i]!.cin < pairs[i - 1]!.cout) throw invalidArgument("sessions must not overlap");
  return pairs.map((p) => ({ clock_in: new Date(p.cin).toISOString(), clock_out: new Date(p.cout).toISOString() }));
}

export async function listRegularizations(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string) {
  const conds = [applyScope(scope, schema.attendanceRegularizations.code, schema.attendanceRegularizations.employeeId)];
  if (stateFilter) conds.push(eq(schema.attendanceRegularizations.state, stateFilter as typeof schema.attendanceRegularizations.$inferSelect.state));
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
  const sessions = normalizeSessions(input.sessions);
  // Default the employee to the caller's own record unless an admin files on someone's behalf.
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const row = (await deps.db
    .insert(schema.attendanceRegularizations)
    .values({ code: await allocOwnedCode(deps, schema.attendanceRegularizations, schema.attendanceRegularizations.employeeId, employeeId), employeeId, date: new Date(date), sessions, reason: input.reason ?? null, state: "PENDING" })
    .returning())[0]!;
  await audit(deps, actor, "attendance-regularization.create", "attendance-regularizations", row.uuid, { employee: `employees/${employeeId}`, date: new Date(date).toISOString().slice(0, 10), sessions, ...(input.reason ? { reason: input.reason } : {}) }, row);
  await notifyManager(deps, employeeId, { type: "regularization.requested", noun: "attendance regularization" });
  await emitEvent(deps, actor, "attendanceRegularization.requested", { subject: `attendance-regularizations/${row.uuid}`, employeeId, payload: { date: new Date(date).toISOString() } });
  return row;
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED") {
  const row = await getRegularization(deps, actor, id);
  // Who may approve/reject/cancel is gated by the verb's grant (middleware). Here only state matters.
  if (row.state !== "PENDING") throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  // Guard the flip on PENDING so approval is EXACTLY-ONCE: without it a double-clicked approve would
  // supersede the day's punches + insert the correction sessions twice (0 rows = already decided).
  const [updated] = await deps.db
    .update(schema.attendanceRegularizations)
    .set({ state: to, decidedBy: actor.uuid, updatedAt: new Date() })
    .where(and(eq(schema.attendanceRegularizations.uuid, id), eq(schema.attendanceRegularizations.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  // On approval the regularization becomes the day's source of truth: supersede every existing (non-superseded)
  // punch that falls on the org-local day, then write the requested pairs as `correction` sessions. The derived
  // day recomputes from these alone - no double-count, nothing to reconcile by hand.
  if (to === "APPROVED") {
    const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
    const tz = att.timezone || "Asia/Kolkata";
    const targetYmd = localDay(+new Date(row.date), tz);
    const existing = (await deps.db
      .select({ uuid: schema.attendanceSessions.uuid, clockIn: schema.attendanceSessions.clockIn })
      .from(schema.attendanceSessions)
      .where(and(eq(schema.attendanceSessions.employeeId, row.employeeId), isNull(schema.attendanceSessions.supersededBy))))
      .filter((s) => localDay(+new Date(s.clockIn), tz) === targetYmd);
    for (const s of existing) {
      await deps.db.update(schema.attendanceSessions).set({ supersededBy: id, updatedAt: new Date() }).where(eq(schema.attendanceSessions.uuid, s.uuid));
    }
    for (const p of row.sessions) {
      await deps.db.insert(schema.attendanceSessions).values({
        code: await allocOwnedCode(deps, schema.attendanceSessions, schema.attendanceSessions.employeeId, row.employeeId),
        employeeId: row.employeeId,
        clockIn: new Date(p.clock_in),
        clockOut: new Date(p.clock_out),
        source: "correction",
        note: row.reason ?? null,
      });
    }
  }
  const verb = to === "APPROVED" ? "approve" : to === "REJECTED" ? "reject" : "cancel";
  await audit(deps, actor, `attendance-regularization.${verb}`, "attendance-regularizations", id, { employee: `employees/${row.employeeId}`, date: new Date(row.date).toISOString().slice(0, 10) });
  if (to === "APPROVED" || to === "REJECTED") {
    await notify(deps, { recipient: row.employeeId, type: `regularization.${to.toLowerCase()}`, title: `Regularization ${to.toLowerCase()}`, body: `Your attendance regularization was ${to.toLowerCase()}.`, link: "attendance", subject: `attendance-regularizations/${id}`, actorId: actor.employeeId });
  }
  if (to === "APPROVED") await emitEvent(deps, actor, "attendanceRegularization.approved", { subject: `attendance-regularizations/${id}`, employeeId: row.employeeId, payload: { date: new Date(row.date).toISOString() } });
  return updated;
}

export const approveRegularization = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "APPROVED");
export const rejectRegularization = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "REJECTED");
export const cancelRegularization = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");
