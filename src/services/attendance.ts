import { allocOwnedCode } from "./codeAlloc";
import { and, eq, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument, failedPrecondition, notFound } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";

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
    })
    // Most recent first (open sessions and today's punches surface at the top).
    .sort((a, b) => +new Date(b.clockIn) - +new Date(a.clockIn) || b.uuid.localeCompare(a.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? rows.findIndex((e) => +new Date(e.clockIn) < cur.createTimeMs || (+new Date(e.clockIn) === cur.createTimeMs && e.uuid < cur.uid)) : 0;
  const slice = start < 0 ? [] : rows.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < rows.length && last ? encodeCursor(+new Date(last.clockIn), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

async function openSessionFor(deps: Deps, employeeId: string) {
  return (await deps.db
    .select()
    .from(schema.attendanceSessions)
    .where(and(eq(schema.attendanceSessions.employeeId, employeeId), isNull(schema.attendanceSessions.clockOut)))
    .limit(1))[0];
}

// Clock in: open a new session for the caller now. Errors if one is already open.
export async function clockIn(deps: Deps, actor: AppUser) {
  const employeeId = actor.employeeId;
  if (!employeeId) throw invalidArgument("you are not linked to an employee record");
  if (await openSessionFor(deps, employeeId)) throw failedPrecondition("already clocked in");
  const row = (await deps.db
    .insert(schema.attendanceSessions)
    .values({ code: await allocOwnedCode(deps, schema.attendanceSessions, schema.attendanceSessions.employeeId, employeeId), employeeId, clockIn: new Date(deps.clock.now()), source: "clock" })
    .returning())[0]!;
  return row;
}

// Clock out: close the caller's open session now. Errors if none is open.
export async function clockOut(deps: Deps, actor: AppUser) {
  const employeeId = actor.employeeId;
  if (!employeeId) throw invalidArgument("you are not linked to an employee record");
  const open = await openSessionFor(deps, employeeId);
  if (!open) throw failedPrecondition("not clocked in");
  const [row] = await deps.db
    .update(schema.attendanceSessions)
    .set({ clockOut: new Date(deps.clock.now()), updatedAt: new Date() })
    .where(eq(schema.attendanceSessions.uuid, open.uuid))
    .returning();
  return row!;
}

