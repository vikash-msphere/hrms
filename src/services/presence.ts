import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { dayStartMs, orgToday } from "./orgDay";

// Is this person reachable right now, and if not, who is? Derived, never stored: the profile header's status
// pill and its "on leave" note are a READING of attendance and leave, not a second copy of them that somebody
// has to remember to set. Nobody types a status here, so nobody can leave a stale one up - the failure mode of
// every hand-set presence field.
//
// Three states, in priority order. Leave outranks a clock-in because an approved absence is a fact about the
// whole day and a forgotten open session is not: somebody who clocked in on Friday, never clocked out, and is
// on leave today is on leave.
//   - on_leave  an APPROVED leave request covers the org's today
//   - in        an attendance session is open (clocked in, not yet out)
//   - out       neither
export type Presence = {
  state: "on_leave" | "in" | "out";
  /** Last covered day of the current leave, YYYY-MM-DD. Only on `on_leave`. */
  until?: string;
  /** When the open session started, ISO. Only on `in`. */
  since_time?: string;
  /** Who holds this person's approvals while they are away: `employees/{id}`. Only on `on_leave`. */
  covered_by?: string;
};

/**
 * One employee's presence.
 *
 * Read LAZILY by the profile header (never as part of the employee record), because this is three indexed
 * reads that the directory, the org chart and every picker would otherwise pay for on every row to render a
 * dot. Each is bounded to one employee and one day.
 *
 * Deliberately NOT access-gated beyond the caller's right to read the employee: "on leave until Friday" is
 * what an out-of-office reply says to anyone who writes to them, and the covering name is the whole point of
 * saying it. The leave TYPE - which could be medical - is never returned.
 */
export async function getPresence(deps: Deps, employeeId: string): Promise<Presence> {
  const today = await orgToday(deps);
  const todayMs = dayStartMs(today);

  const leave = (await deps.db
    .select({ endDate: schema.leaveRequests.endDate })
    .from(schema.leaveRequests)
    .where(and(
      eq(schema.leaveRequests.employeeId, employeeId),
      eq(schema.leaveRequests.state, "APPROVED"),
      lte(schema.leaveRequests.startDate, new Date(todayMs)),
      gte(schema.leaveRequests.endDate, new Date(todayMs)),
    ))
    // Longest-running first: overlapping approved leave is possible (a half day inside a block), and the date
    // the header promises to be back by has to be the last of them, not whichever row the index reached first.
    .orderBy(desc(schema.leaveRequests.endDate))
    .limit(1))[0];

  if (leave) {
    // Who is covering, if anyone: the approval delegation that spans today. Absent is the normal case.
    const cover = (await deps.db
      .select({ delegateId: schema.approvalDelegations.delegateId })
      .from(schema.approvalDelegations)
      .where(and(
        eq(schema.approvalDelegations.delegatorId, employeeId),
        lte(schema.approvalDelegations.fromDate, new Date(todayMs)),
        gte(schema.approvalDelegations.toDate, new Date(todayMs)),
      ))
      .limit(1))[0];
    return {
      state: "on_leave",
      until: new Date(leave.endDate).toISOString().slice(0, 10),
      ...(cover ? { covered_by: `employees/${cover.delegateId}` } : {}),
    };
  }

  const open = (await deps.db
    .select({ clockIn: schema.attendanceSessions.clockIn })
    .from(schema.attendanceSessions)
    .where(and(
      eq(schema.attendanceSessions.employeeId, employeeId),
      isNull(schema.attendanceSessions.clockOut),
      isNull(schema.attendanceSessions.supersededBy),
    ))
    .limit(1))[0];

  return open ? { state: "in", since_time: new Date(open.clockIn).toISOString() } : { state: "out" };
}
