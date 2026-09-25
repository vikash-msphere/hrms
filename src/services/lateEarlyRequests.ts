import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { notify, notifyManager } from "./notifications";
import { emitEvent } from "./eventBus";
import { getSettingValue } from "./settings";
import { orgToday, dayStartMs } from "./orgDay";
import { refHolidays } from "../lib/refData";
import { keysetPage } from "./keysetPage";
import { restateLopForDay } from "./payroll";
import { assertNotSubject, assertReviewedVersion } from "./decisionGuard";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { localMinutes, utcDay } from "../domain/attendance";
import {
  checkFiling, excusalsByDay, fmtMinutes, KIND_LABEL, LATE_EARLY_KINDS, leaveHalves, punctualityPolicyOf, shiftScheduleOf,
  type DayExcusal, type LateEarlyKind, type PunctualityPolicy,
} from "../domain/punctuality";

// Late arrival / early departure requests: an employee asks to come in late or leave early on one working day;
// a manager (own dept) or HR approves or rejects it; the owner cancels it while it is pending. Who may do which
// is the verb's grant (middleware). The service decides only what the ORG'S POLICY decides - whether the
// request may be filed at all, whether it is past the monthly allowance, whether it is approved on filing
// (settings/punctuality, domain/punctuality.ts#checkFiling) - plus the state machine and maker-checker.
//
// Nothing is written to the attendance record when one is approved. The request IS the fact every reader of the
// day consults (the grid, analytics, the payroll build), so withdrawing or changing the policy changes every day
// it covers without a row to rewrite.
export type LateEarlyInput = {
  employee?: string | null;
  date?: string; // YYYY-MM-DD, the org-local day
  kind?: string;
  at?: string; // HH:MM wall clock in the org timezone
  reason?: string | null;
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LIVE = ["PENDING", "APPROVED"] as const;
type Row = typeof schema.lateEarlyRequests.$inferSelect;

/** The org's punctuality policy, read leaf by leaf (a stored section replaces the default one wholesale). */
export async function punctualityPolicy(deps: Deps): Promise<PunctualityPolicy> {
  return punctualityPolicyOf(await getSettingValue<unknown>(deps, "punctuality", {}));
}

/**
 * `?employee=` narrows to one person and `?from`/`?to` to a window of days - the filters every attendance surface
 * passes. Both narrow what the scope allows and neither widens it: `applyScope` is ANDed in regardless.
 */
export async function listLateEarlyRequests(
  deps: Deps,
  scope: ListScope,
  maxPageSize: number,
  pageToken?: string,
  filters: { state?: string; employeeId?: string; from?: string; to?: string } = {},
) {
  const t = schema.lateEarlyRequests;
  // Spelled out in full, not through `t`: test/listOwnerColumns.test.ts reads this binding back against the
  // registry's owner column, and it recognises only the `schema.<table>` form.
  const conds = [applyScope(scope, schema.lateEarlyRequests.code, schema.lateEarlyRequests.employeeId)];
  if (filters.state) conds.push(eq(t.state, filters.state as Row["state"]));
  if (filters.employeeId) conds.push(eq(t.employeeId, filters.employeeId));
  const from = filters.from ? dayStartMs(filters.from.slice(0, 10)) : NaN;
  const to = filters.to ? dayStartMs(filters.to.slice(0, 10)) : NaN;
  // An unparseable bound narrows nothing, like services/dateWindow.ts.
  if (!Number.isNaN(from)) conds.push(gte(t.date, new Date(from)));
  if (!Number.isNaN(to)) conds.push(lte(t.date, new Date(to)));
  return keysetPage<Row>(deps, t, "late-early-requests", and(...(conds.filter(Boolean) as never[])), { max: maxPageSize, pageToken });
}

async function getRequest(deps: Deps, id: string): Promise<Row> {
  const row = (await deps.db.select().from(schema.lateEarlyRequests).where(eq(schema.lateEarlyRequests.uuid, id)).limit(1))[0];
  if (!row) throw notFound("late arrival / early departure request not found");
  return row;
}

const nounOf = (kind: LateEarlyKind) => KIND_LABEL[kind].toLowerCase();

export async function createLateEarlyRequest(deps: Deps, actor: AppUser, input: LateEarlyInput): Promise<Row> {
  const ymd = input.date?.slice(0, 10) ?? "";
  const dateMs = dayStartMs(ymd);
  if (Number.isNaN(dateMs) || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw invalidArgument("date is required (YYYY-MM-DD)");
  const kind = input.kind as LateEarlyKind;
  if (!LATE_EARLY_KINDS.includes(kind)) throw invalidArgument(`kind must be one of ${LATE_EARLY_KINDS.join(", ")}`);
  const at = input.at?.trim() ?? "";
  if (!HHMM.test(at)) throw invalidArgument("at must be a wall-clock time HH:MM");
  // Default to the caller's own record unless an admin files on someone's behalf (owner-create is gated by the
  // middleware's owner_refs check, so a non-admin can only create under their own employee).
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const reason = input.reason?.trim() || null;

  const policy = await punctualityPolicy(deps);
  const sched = shiftScheduleOf(await getSettingValue<Record<string, unknown>>(deps, "attendance", {}));
  const todayYmd = await orgToday(deps);
  const t = schema.lateEarlyRequests;

  // A day outside the person's employment is nobody's attendance - the grid omits it and payroll prorates it
  // away - so a request for it would be a row about a day that is never judged.
  const person = (await deps.db
    .select({ startDate: schema.employees.startDate, endDate: schema.employees.endDate })
    .from(schema.employees)
    .where(eq(schema.employees.uuid, employeeId))
    .limit(1))[0];
  if (!person) throw notFound("employee not found");
  if (person.startDate && ymd < utcDay(+new Date(person.startDate))) throw invalidArgument("That day is before they joined.");
  if (person.endDate && ymd > utcDay(+new Date(person.endDate))) throw invalidArgument("That day is after their last working day.");

  // The same day's facts the payroll build reads. A holiday blocks only when it applies to everybody for the
  // whole day: a regional or half-day holiday leaves somebody who may still be working that day.
  const isHoliday = (await refHolidays(deps)).some((h) => !h.deleteTime && !h.disabled && !h.halfDay && !h.location && utcDay(+new Date(h.date)) === ymd);
  const leave = (await deps.db
    .select({ startDate: schema.leaveRequests.startDate, endDate: schema.leaveRequests.endDate, startSession: schema.leaveRequests.startSession, endSession: schema.leaveRequests.endSession })
    .from(schema.leaveRequests)
    .where(and(eq(schema.leaveRequests.employeeId, employeeId), eq(schema.leaveRequests.state, "APPROVED"), lte(schema.leaveRequests.startDate, new Date(dateMs)), gte(schema.leaveRequests.endDate, new Date(dateMs)))))
    .map((l) => ({ start: utcDay(+new Date(l.startDate)), end: utcDay(+new Date(l.endDate)), startSession: l.startSession, endSession: l.endSession }));
  const halves = leaveHalves(ymd, leave);

  // This person's live requests in the same calendar month: the allowance, and the one-per-day-and-kind rule.
  const monthStart = dayStartMs(`${ymd.slice(0, 7)}-01`);
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const month = await deps.db
    .select({ date: t.date, kind: t.kind, minutes: t.minutes })
    .from(t)
    .where(and(eq(t.employeeId, employeeId), inArray(t.state, [...LIVE]), gte(t.date, new Date(monthStart)), lte(t.date, new Date(+nextMonth - 86_400_000))));
  if (month.some((m) => utcDay(+new Date(m.date)) === ymd && m.kind === kind)) {
    throw failedPrecondition(`there is already a ${nounOf(kind)} request for that day - cancel it or ask for it to be rejected before filing another`);
  }

  const verdict = checkFiling({
    kind, date: ymd, at, reason, sched, policy, todayYmd,
    nowMin: localMinutes(+deps.clock.now(), sched.timezone),
    isHoliday,
    onFullLeave: halves.am && halves.pm,
    monthRequests: month.map((m) => ({ kind: m.kind, minutes: m.minutes, date: utcDay(+new Date(m.date)) })),
  });
  if (verdict.errors.length) throw invalidArgument(verdict.errors.join(" "));

  const state = verdict.autoApprove ? "APPROVED" : "PENDING";
  let row: Row;
  try {
    // Allocated inside the retry (codeAlloc.ts): a transit strike files a whole team's requests at once.
    row = (await withFreshCode(async () => deps.db
      .insert(t)
      .values({
        // Named off `schema` rather than the local alias: test/reparenting.test.ts reads this call to check the
        // table is wired into the reparenting cascade, and an alias is a table it cannot name.
        code: await allocOwnedCode(deps, schema.lateEarlyRequests, schema.lateEarlyRequests.employeeId, employeeId),
        employeeId, date: new Date(dateMs), kind, at, minutes: verdict.minutes, reason, state,
        overLimit: verdict.overLimit, autoApproved: verdict.autoApprove,
      })
      .returning()))[0]!;
  } catch (e) {
    // `ler_live_idx`: a second press, or two tabs, filing the same day and kind at once. The read above says it
    // in words for the ordinary case; this is the race it cannot see.
    if (e instanceof Error && /UNIQUE constraint failed: late_early_requests\.employee_id/.test(e.message)) {
      throw failedPrecondition(`there is already a ${nounOf(kind)} request for that day`);
    }
    throw e;
  }
  await audit(deps, actor, "late_early_request.create", "late-early-requests", row.uuid, createdMeta(row, "late-early-requests"), row);
  const subject = `late-early-requests/${row.uuid}`;
  const payload = { date: ymd, kind, minutes: verdict.minutes, overLimit: verdict.overLimit, autoApproved: verdict.autoApprove };
  if (state === "PENDING") {
    await notifyManager(deps, employeeId, { type: "lateEarly.requested", noun: `${nounOf(kind)} request` });
    await emitEvent(deps, actor, "lateEarly.requested", { subject, employeeId, payload });
  } else {
    // Approved by the policy on filing, so there is nobody to ask - but the approval is still an approval, with
    // the same consequences for the day as a person's, so rules that react to one react to this.
    await audit(deps, actor, "late_early_request.approve", "late-early-requests", row.uuid, stateMeta("PENDING", "APPROVED", { employee: `employees/${employeeId}`, reason: `approved on filing: at most ${fmtMinutes(policy.requests.auto_approve_minutes ?? 0)}` }), row);
    await emitEvent(deps, actor, "lateEarly.approved", { subject, employeeId, payload });
    await restateLopForDay(deps, employeeId, dateMs);
  }
  return row;
}

async function decide(deps: Deps, actor: AppUser, id: string, to: "APPROVED" | "REJECTED" | "CANCELLED", note?: string | null, ifMatch?: string): Promise<Row> {
  const row = await getRequest(deps, id);
  if (row.state !== "PENDING") throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  assertReviewedVersion(row, ifMatch);
  // An approval changes how the day is judged and, under the org's policy, what it pays - so the person it is
  // about may not be the one approving it.
  if (to === "APPROVED") await assertNotSubject(deps, actor, row.employeeId, "approve", "late arrival / early departure request");
  // Guard the flip on PENDING so the decision is EXACTLY-ONCE: a double-clicked or concurrent call that also read
  // PENDING loses here (0 rows) instead of firing the notification, the event and the restatement twice.
  const [updated] = await deps.db
    .update(schema.lateEarlyRequests)
    .set({ state: to, decidedBy: to === "CANCELLED" ? null : actor.uuid, decisionNote: note?.trim() || null, updatedAt: new Date() })
    .where(and(eq(schema.lateEarlyRequests.uuid, id), eq(schema.lateEarlyRequests.state, "PENDING")))
    .returning();
  if (!updated) throw failedPrecondition(to === "CANCELLED" ? "only pending requests can be cancelled" : "request is not pending");
  const ymd = utcDay(+new Date(row.date));
  await audit(deps, actor, `late_early_request.${to.toLowerCase()}`, "late-early-requests", id, stateMeta(row.state, to, { employee: `employees/${row.employeeId}`, date: ymd, ...(note ? { reason: note } : {}) }), updated);
  const subject = `late-early-requests/${id}`;
  if (to === "APPROVED" || to === "REJECTED") {
    const what = `${KIND_LABEL[row.kind]} on ${ymd} at ${row.at}`;
    await notify(deps, { recipient: row.employeeId, type: `lateEarly.${to.toLowerCase()}`, title: `${KIND_LABEL[row.kind]} ${to.toLowerCase()}`, body: `Your ${what} was ${to.toLowerCase()}.${note ? ` ${note}` : ""}`, link: "late-early/history", subject, actorId: actor.employeeId });
  }
  if (to === "APPROVED") {
    await emitEvent(deps, actor, "lateEarly.approved", { subject, employeeId: row.employeeId, payload: { date: ymd, kind: row.kind, minutes: row.minutes, autoApproved: false } });
    // The day is judged differently from now on, which can change its loss of pay. A day in a period whose run
    // has already published is carried into the next run rather than disagreeing with a payslip nobody can
    // rebuild. Best-effort (payroll.ts#restateLopForDay says why).
    await restateLopForDay(deps, row.employeeId, +new Date(row.date));
  }
  return updated;
}

export const approveLateEarlyRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null, ifMatch?: string) => decide(deps, actor, id, "APPROVED", note, ifMatch);
export const rejectLateEarlyRequest = (deps: Deps, actor: AppUser, id: string, note?: string | null, ifMatch?: string) => decide(deps, actor, id, "REJECTED", note, ifMatch);
export const cancelLateEarlyRequest = (deps: Deps, actor: AppUser, id: string) => decide(deps, actor, id, "CANCELLED");

/**
 * The APPROVED windows over a range of days, as every reader of a day consults them: employee -> day -> window.
 * Bound to the range in SQL (the `ler_state_date_idx` index). `employeeIds` narrows to one person or a few; the
 * payroll build passes none and reads the period for everybody in one query.
 */
export async function approvedExcusals(deps: Deps, fromMs: number, toMs: number, employeeIds?: readonly string[]): Promise<Map<string, Map<string, DayExcusal>>> {
  const t = schema.lateEarlyRequests;
  const conds = [eq(t.state, "APPROVED" as const), gte(t.date, new Date(fromMs)), lte(t.date, new Date(toMs))];
  if (employeeIds?.length === 1) conds.push(eq(t.employeeId, employeeIds[0]!));
  const rows = (await deps.db.select({ employeeId: t.employeeId, date: t.date, kind: t.kind, at: t.at }).from(t).where(and(...conds)))
    .filter((r) => !employeeIds || employeeIds.includes(r.employeeId));
  const byEmp = new Map<string, { date: string; kind: LateEarlyKind; at: string }[]>();
  for (const r of rows) (byEmp.get(r.employeeId) ?? byEmp.set(r.employeeId, []).get(r.employeeId)!).push({ date: utcDay(+new Date(r.date)), kind: r.kind, at: r.at });
  return new Map([...byEmp].map(([emp, reqs]) => [emp, excusalsByDay(reqs)]));
}
