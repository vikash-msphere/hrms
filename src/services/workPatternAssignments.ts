// Who is on which work pattern, and when - the middle layer of a resolved day (domain/workSchedule.ts).
// Employee-owned and code-scoped exactly like `shift-assignments`, so own/dept/all scoping is the middleware's
// and nothing here decides access.
import { and, eq, gte, isNull, lte, or, type SQL } from "drizzle-orm";
import { CODE_WIDTH, allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { utcDay } from "../domain/attendance";
import { alreadyExists, invalidArgument } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { has, type CrudSpec, type SetOf } from "./crud";
import { notify } from "./notifications";

export type WorkPatternAssignmentInput = {
  employee?: string | null;
  pattern?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  anchor_date?: string | null;
  note?: string | null;
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listWorkPatternAssignments(
  deps: Deps,
  scope: ListScope,
  maxPageSize: number,
  pageToken?: string,
  employee?: string,
  from?: string,
  to?: string,
  showDeleted = false,
  deletedOnly = false,
) {
  const t = schema.workPatternAssignments;
  const conds = [applyScope(scope, t.code, t.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(t.employeeId, empId));
  // `from`/`to` name a WINDOW, and an assignment matches it by OVERLAP rather than by containment: the roster
  // asks "who is on a schedule this month", and somebody who started in January and has not moved off is on
  // one this month. Containment would answer with nothing for exactly the people most likely to be on one.
  if (to && !Number.isNaN(dayMs(to))) conds.push(lte(t.startDate, new Date(dayMs(to))));
  if (from && !Number.isNaN(dayMs(from))) conds.push(or(isNull(t.endDate), gte(t.endDate, new Date(dayMs(from))))!);
  conds.push(deleteStateFilter(t.deleteTime, showDeleted, deletedOnly));
  const page = await keysetPage<typeof t.$inferSelect>(deps, t, "work-pattern-assignments", and(...(conds.filter(Boolean) as SQL[])), { dir: "desc", max: maxPageSize, pageToken });
  return { ...page, items: page.items.sort((a, b) => +new Date(a.startDate) - +new Date(b.startDate) || a.uuid.localeCompare(b.uuid)) };
}

/** One person's live assignments that overlap `[startMs, endMs]` (endMs null = open ended). */
async function overlapping(deps: Deps, employeeId: string, startMs: number, endMs: number | null, exceptUuid?: string) {
  const t = schema.workPatternAssignments;
  const conds: SQL[] = [
    eq(t.employeeId, employeeId),
    isNull(t.deleteTime),
    // The new window ends after an existing one starts...
    ...(endMs == null ? [] : [lte(t.startDate, new Date(endMs))]),
    // ...and the existing one has not already ended before the new one starts.
    or(isNull(t.endDate), gte(t.endDate, new Date(startMs)))!,
  ];
  return (await deps.db
    .select({ uuid: t.uuid, startDate: t.startDate, endDate: t.endDate })
    .from(t)
    .where(and(...conds)))
    .filter((r) => r.uuid !== exceptUuid);
}

/**
 * The window this write asks for, and what it does to whatever is already there.
 *
 * TWO LIVE ASSIGNMENTS CANNOT OVERLAP, because a day resolving to two patterns has no answer. SQLite cannot
 * express range overlap as an index, so this is the check, and it is made on both ways in (create and patch).
 *
 * The one overlap that is ACCEPTED is a new assignment starting inside an existing OPEN-ENDED one: that is
 * "Priya moves to the night rotation from March", which is the ordinary way a schedule changes. The old
 * assignment is closed the day before the new one starts and the change is named in the audit meta. Refusing
 * it would make the common case a two-step chore whose first step leaves somebody on no schedule at all.
 *
 * Every other overlap is refused by its dates, because it is not a change of schedule - it is two schedules.
 */
async function resolveWindow(deps: Deps, employeeId: string, startMs: number, endMs: number | null, exceptUuid?: string): Promise<{ truncate: { uuid: string; toMs: number } | null }> {
  const clashes = await overlapping(deps, employeeId, startMs, endMs, exceptUuid);
  if (!clashes.length) return { truncate: null };
  const openEndedBefore = clashes.length === 1 && clashes[0]!.endDate == null && +new Date(clashes[0]!.startDate) < startMs
    ? clashes[0]!
    : null;
  if (openEndedBefore) return { truncate: { uuid: openEndedBefore.uuid, toMs: startMs - 86_400_000 } };
  const c = clashes[0]!;
  const until = c.endDate ? utcDay(+new Date(c.endDate)) : "no end date";
  throw alreadyExists(`that overlaps a schedule they are already on (${utcDay(+new Date(c.startDate))} to ${until}) - change that one's dates first`);
}

/** The three dates a write carries, checked against each other. */
function windowOf(input: WorkPatternAssignmentInput, row?: typeof schema.workPatternAssignments.$inferSelect) {
  const startMs = has(input, "start_date") || !row ? dayMs(input.start_date) : +new Date(row.startDate);
  if (Number.isNaN(startMs)) throw invalidArgument("start_date is required");
  const endMs = has(input, "end_date")
    ? (input.end_date ? dayMs(input.end_date) : null)
    : (row?.endDate ? +new Date(row.endDate) : null);
  if (endMs != null && Number.isNaN(endMs)) throw invalidArgument("end_date is invalid");
  if (endMs != null && endMs < startMs) throw invalidArgument("end_date is before start_date");
  const anchorMs = has(input, "anchor_date")
    ? (input.anchor_date ? dayMs(input.anchor_date) : null)
    : (row?.anchorDate ? +new Date(row.anchorDate) : null);
  if (anchorMs != null && Number.isNaN(anchorMs)) throw invalidArgument("anchor_date is invalid");
  return { startMs, endMs, anchorMs };
}

export const workPatternAssignmentSpec: CrudSpec<WorkPatternAssignmentInput, typeof schema.workPatternAssignments> = {
  table: schema.workPatternAssignments,
  collection: "work-pattern-assignments",
  auditName: "work-pattern-assignment",
  notFound: "schedule assignment not found",
  allocCode: (deps, table, values, attempt) => allocOwnedCode(deps, table, schema.workPatternAssignments.employeeId, values.employeeId as string, CODE_WIDTH.owned, attempt > 1),
  insert: async (input, deps, actor) => {
    const employeeId = idFromPath(input.employee) ?? actor.employeeId;
    if (!employeeId) throw invalidArgument("employee is required");
    const patternId = idFromPath(input.pattern);
    if (!patternId) throw invalidArgument("pattern is required");
    const { startMs, endMs, anchorMs } = windowOf(input);
    const { truncate } = await resolveWindow(deps, employeeId, startMs, endMs);
    if (truncate) {
      await deps.db
        .update(schema.workPatternAssignments)
        .set({ endDate: new Date(truncate.toMs), updatedAt: new Date() })
        .where(eq(schema.workPatternAssignments.uuid, truncate.uuid));
    }
    return {
      employeeId,
      patternId,
      startDate: new Date(startMs),
      endDate: endMs == null ? null : new Date(endMs),
      anchorDate: anchorMs == null ? null : new Date(anchorMs),
      note: input.note?.trim() || null,
    };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.workPatternAssignments> = {};
    if (has(patch, "pattern")) {
      const p = idFromPath(patch.pattern);
      if (!p) throw invalidArgument("pattern is required");
      set.patternId = p;
    }
    // The three dates are read together for the same reason the create reads them together: moving one end
    // changes the window, and the window is what may not overlap.
    if (has(patch, "start_date") || has(patch, "end_date") || has(patch, "anchor_date")) {
      const { startMs, endMs, anchorMs } = windowOf(patch, row);
      // A PATCH never truncates somebody else's assignment: `resolveWindow` would close an open-ended
      // predecessor, which is a decision about a different row and belongs to the deliberate act of putting
      // someone on a new schedule. Editing an existing window that clashes is refused outright.
      const clashes = await overlapping(deps, row.employeeId as string, startMs, endMs, row.uuid as string);
      if (clashes.length) {
        const c = clashes[0]!;
        const until = c.endDate ? utcDay(+new Date(c.endDate)) : "no end date";
        throw alreadyExists(`that overlaps a schedule they are already on (${utcDay(+new Date(c.startDate))} to ${until}) - change that one's dates first`);
      }
      if (has(patch, "start_date")) set.startDate = new Date(startMs);
      if (has(patch, "end_date")) set.endDate = endMs == null ? null : new Date(endMs);
      if (has(patch, "anchor_date")) set.anchorDate = anchorMs == null ? null : new Date(anchorMs);
    }
    if (has(patch, "note")) set.note = patch.note?.trim() || null;
    return set;
  },
  // Being put on a schedule by somebody else changes which days you are expected in; putting yourself on one
  // is not news.
  afterCreate: async (deps, actor, row, input) => {
    if (row.employeeId === actor.employeeId) return;
    await notify(deps, {
      recipient: row.employeeId,
      type: "shift.assigned",
      title: "Schedule changed",
      body: `Your working schedule changes from ${input.start_date}.`,
      link: "schedule",
      subject: `work-pattern-assignments/${row.uuid}`,
      actorId: actor.employeeId,
    });
  },
};
