import { eq, and, gte, isNull, lte, type SQL } from "drizzle-orm";
import { CODE_WIDTH, allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { alreadyExists, invalidArgument } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { has, type CrudSpec, type SetOf } from "./crud";
import { notify } from "./notifications";

export type ShiftAssignmentInput = {
  employee?: string | null;
  shift?: string | null;
  kind?: string | null;
  date?: string | null;
  note?: string | null;
};
const KINDS = ["shift", "off"] as const;
type AssignmentKind = (typeof KINDS)[number];
const kindOf = (v: unknown): AssignmentKind => {
  if (v == null || v === "") return "shift";
  if (!(KINDS as readonly string[]).includes(v as string)) throw invalidArgument(`kind must be one of ${KINDS.join(", ")}`);
  return v as AssignmentKind;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listShiftAssignments(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, from?: string, to?: string, showDeleted = false, deletedOnly = false) {
  const conds = [applyScope(scope, schema.shiftAssignments.code, schema.shiftAssignments.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.shiftAssignments.employeeId, empId));
  if (from && !Number.isNaN(dayMs(from))) conds.push(gte(schema.shiftAssignments.date, new Date(dayMs(from))));
  if (to && !Number.isNaN(dayMs(to))) conds.push(lte(schema.shiftAssignments.date, new Date(dayMs(to) + 86_399_999)));
  conds.push(deleteStateFilter(schema.shiftAssignments.deleteTime, showDeleted, deletedOnly));
  // Paged in SQL (services/keysetPage.ts) on `createdAt`, which is what the cursor carries. It used to read
  // every assignment the filters matched and slice a page out of it in the isolate - a roster grows as
  // headcount x days, and D1 bills rows read, so an unfiltered list cost the whole table to answer with 50
  // rows. The soft-delete filter went into the WHERE with it rather than being applied to rows already read.
  //
  // Sorting the roster by DATE and seeking on `createdAt` would be two different orders, so a shift added out
  // of date order could fall between two pages; the roster reads forwards through the week, so date orders
  // the page that came back, below.
  const page = await keysetPage<typeof schema.shiftAssignments.$inferSelect>(deps, schema.shiftAssignments, "shift-assignments", and(...(conds.filter(Boolean) as SQL[])), { dir: "desc", max: maxPageSize, pageToken });
  return { ...page, items: page.items.sort((a, b) => +new Date(a.date) - +new Date(b.date) || a.uuid.localeCompare(b.uuid)) };
}

// The live roster entry for one person on one day, if there is one. `sa_emp_day_idx` is what ENFORCES the
// one-per-day rule; this read is what lets a write say which entry is in the way instead of answering with a
// constraint name. Two indexed columns, so it costs one lookup on a path that is already writing.
async function rosteredOn(deps: Deps, employeeId: string, date: Date, exceptUuid?: string) {
  const rows = await deps.db
    .select({ uuid: schema.shiftAssignments.uuid, shiftId: schema.shiftAssignments.shiftId })
    .from(schema.shiftAssignments)
    .where(and(
      eq(schema.shiftAssignments.employeeId, employeeId),
      eq(schema.shiftAssignments.date, date),
      isNull(schema.shiftAssignments.deleteTime),
    ));
  return rows.find((r) => r.uuid !== exceptUuid);
}

// One employee rostered onto one shift on one day. Owned by that employee (the code embeds the owner, so
// own/dept/all scoping works); the write only decides which shift, which day and the note.
//
// ONE ENTRY PER PERSON PER DAY, checked here and enforced by the index. Every reader of the roster already
// assumes it - the grid keys its cells by (employee, date) - so a second entry for the same cell is one the
// screen cannot show, and the fix is to move the existing one rather than add another.
export const shiftAssignmentSpec: CrudSpec<ShiftAssignmentInput, typeof schema.shiftAssignments> = {
  table: schema.shiftAssignments,
  collection: "shift-assignments",
  auditName: "shift-assignment",
  notFound: "shift assignment not found",
  allocCode: (deps, table, values, attempt) => allocOwnedCode(deps, table, schema.shiftAssignments.employeeId, values.employeeId as string, CODE_WIDTH.owned, attempt > 1),
  insert: async (input, deps, actor) => {
    const employeeId = idFromPath(input.employee) ?? actor.employeeId;
    if (!employeeId) throw invalidArgument("employee is required");
    // "off" is a REST DAY - a day this person is explicitly not working, whatever their pattern or the org's
    // week says - so it names no shift. Anything else has to name one.
    const kind = kindOf(input.kind);
    const shiftId = idFromPath(input.shift) ?? null;
    if (kind === "shift" && !shiftId) throw invalidArgument("shift is required");
    const ms = dayMs(input.date);
    if (Number.isNaN(ms)) throw invalidArgument("date is required");
    const date = new Date(ms);
    if (await rosteredOn(deps, employeeId, date)) throw alreadyExists(`that employee is already rostered on ${input.date} - change the existing entry instead`);
    return { employeeId, shiftId: kind === "off" ? null : shiftId, kind, date, note: input.note?.trim() || null };
  },
  // A patch can MOVE an entry onto an occupied day, so the same check runs here - against the row being
  // edited, which is excluded (moving an entry onto the day it already sits on is a no-op, not a clash).
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.shiftAssignments> = {};
    // The two fields move together, because the pair is what has to stay consistent: turning an entry into a
    // rest day clears its shift, and naming a shift turns it back into a worked day. Read from the patch where
    // it sets them and from the row where it does not, so a patch that sets only one of them is still checked
    // against what the other will be.
    if (has(patch, "kind") || has(patch, "shift")) {
      const kind = has(patch, "kind") ? kindOf(patch.kind) : (row.kind as AssignmentKind);
      const shiftId = has(patch, "shift") ? idFromPath(patch.shift) ?? null : (row.shiftId as string | null);
      if (kind === "shift" && !shiftId) throw invalidArgument("shift is required");
      set.kind = kind;
      set.shiftId = kind === "off" ? null : shiftId;
    }
    if (has(patch, "date")) {
      const ms = dayMs(patch.date);
      if (Number.isNaN(ms)) throw invalidArgument("date is invalid");
      const date = new Date(ms);
      if (await rosteredOn(deps, row.employeeId as string, date, row.uuid as string)) {
        throw alreadyExists(`that employee is already rostered on ${patch.date} - change the existing entry instead`);
      }
      set.date = date;
    }
    if (has(patch, "note")) set.note = patch.note?.trim() || null;
    return set;
  },
  // Being rostered by someone else is news; rostering yourself is not.
  afterCreate: async (deps, actor, row, input) => {
    if (row.employeeId === actor.employeeId) return;
    await notify(deps, { recipient: row.employeeId, type: "shift.assigned", title: "Shift assigned", body: `You've been rostered for ${input.date}.`, link: "schedule", subject: `shift-assignments/${row.uuid}`, actorId: actor.employeeId });
  },
};
