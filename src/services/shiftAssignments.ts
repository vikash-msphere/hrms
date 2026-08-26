import { eq, and, gte, lte } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument } from "../lib/errors";
import { paginate } from "../http/pagination";
import { has, type CrudSpec, type SetOf } from "./crud";
import { notify } from "./notifications";

export type ShiftAssignmentInput = {
  employee?: string | null;
  shift?: string | null;
  date?: string | null;
  note?: string | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

export async function listShiftAssignments(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, from?: string, to?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.shiftAssignments.code, schema.shiftAssignments.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.shiftAssignments.employeeId, empId));
  if (from && !Number.isNaN(dayMs(from))) conds.push(gte(schema.shiftAssignments.date, new Date(dayMs(from))));
  if (to && !Number.isNaN(dayMs(to))) conds.push(lte(schema.shiftAssignments.date, new Date(dayMs(to) + 86_399_999)));
  const all = (await deps.db.select().from(schema.shiftAssignments).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((a) => showDeleted || !a.deleteTime);
  // Paged on `createdAt`, which is what the cursor carries - sorting the whole roster by DATE and seeking on
  // `createdAt` were two different orders, so a shift added out of date order could fall between two pages.
  // The roster reads forwards through the week, so the page comes back in date order.
  const page = paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid);
  return { ...page, items: page.items.sort((a, b) => +new Date(a.date) - +new Date(b.date) || a.uuid.localeCompare(b.uuid)) };
}

// One employee rostered onto one shift on one day. Owned by that employee (the code embeds the owner, so
// own/dept/all scoping works); the write only decides which shift, which day and the note.
export const shiftAssignmentSpec: CrudSpec<ShiftAssignmentInput, typeof schema.shiftAssignments> = {
  table: schema.shiftAssignments,
  collection: "shift-assignments",
  auditName: "shift-assignment",
  notFound: "shift assignment not found",
  allocCode: (deps, table, values) => allocOwnedCode(deps, table, schema.shiftAssignments.employeeId, values.employeeId as string),
  insert: (input, _deps, actor) => {
    const employeeId = idFromPath(input.employee) ?? actor.employeeId;
    if (!employeeId) throw invalidArgument("employee is required");
    const shiftId = idFromPath(input.shift);
    if (!shiftId) throw invalidArgument("shift is required");
    const ms = dayMs(input.date);
    if (Number.isNaN(ms)) throw invalidArgument("date is required");
    return { employeeId, shiftId, date: new Date(ms), note: input.note?.trim() || null };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.shiftAssignments> = {};
    if (has(patch, "shift")) { const s = idFromPath(patch.shift); if (!s) throw invalidArgument("shift is required"); set.shiftId = s; }
    if (has(patch, "date")) { const ms = dayMs(patch.date); if (Number.isNaN(ms)) throw invalidArgument("date is invalid"); set.date = new Date(ms); }
    if (has(patch, "note")) set.note = patch.note?.trim() || null;
    return set;
  },
  // Being rostered by someone else is news; rostering yourself is not.
  afterCreate: async (deps, actor, row, input) => {
    if (row.employeeId === actor.employeeId) return;
    await notify(deps, { recipient: row.employeeId, type: "shift.assigned", title: "Shift assigned", body: `You've been rostered for ${input.date}.`, link: "schedule", subject: `shift-assignments/${row.uuid}`, actorId: actor.employeeId });
  },
};
