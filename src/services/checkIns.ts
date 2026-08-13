import { eq, and } from "drizzle-orm";
import { allocOwnedCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { has, type CrudSpec, type SetOf } from "./crud";
import { notify } from "./notifications";

export type ActionItem = { text: string; done?: boolean };
export type CheckInCadence = "weekly" | "biweekly" | "monthly";
export type CheckInInput = {
  employee?: string | null;
  counterpart?: string | null;
  meeting_date?: string | null;
  notes?: string | null;
  action_items?: ActionItem[];
  cadence?: CheckInCadence | null;
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const cleanItems = (items?: ActionItem[]) =>
  Array.isArray(items) ? JSON.stringify(items.filter((i) => i?.text?.trim()).map((i) => ({ text: i.text.trim(), done: !!i.done }))) : null;

export async function listCheckIns(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.checkIns.code, schema.checkIns.employeeId)];
  const empId = idFromPath(employee);
  if (empId) conds.push(eq(schema.checkIns.employeeId, empId));
  const all = (await deps.db.select().from(schema.checkIns).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined))
    .filter((c) => showDeleted || !c.deleteTime)
    .sort((a, b) => +new Date(b.meetingDate ?? b.createdAt) - +new Date(a.meetingDate ?? a.createdAt) || a.uuid.localeCompare(b.uuid));
  const cur = decodeCursor(pageToken);
  const start = cur ? all.findIndex((e) => +new Date(e.createdAt) < cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid)) : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

// A 1:1 record, owned by the employee it is about (the code embeds the owner, so own/dept/all scoping works).
// The write decides who the counterpart is, when they met, the notes and the action items; paging, If-Match,
// the audit diff and soft delete/restore are the shared lane.
export const checkInSpec: CrudSpec<CheckInInput, typeof schema.checkIns> = {
  table: schema.checkIns,
  collection: "check-ins",
  auditName: "check-in",
  notFound: "check-in not found",
  allocCode: (deps, table, values) => allocOwnedCode(deps, table, schema.checkIns.employeeId, values.employeeId as string),
  insert: async (input, deps, actor) => {
    const employeeId = idFromPath(input.employee) ?? actor.employeeId;
    if (!employeeId) throw invalidArgument("employee is required");
    if (input.meeting_date && Number.isNaN(dayMs(input.meeting_date))) throw invalidArgument("meeting_date is invalid");
    // Counterpart defaults to the report's manager (the usual 1:1 partner).
    let counterpartId = idFromPath(input.counterpart) ?? null;
    if (!counterpartId) {
      const subject = (await deps.db.select({ managerId: schema.employees.managerId }).from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
      counterpartId = subject?.managerId ?? null;
    }
    return {
      employeeId,
      counterpartId,
      meetingDate: input.meeting_date ? new Date(dayMs(input.meeting_date)) : null,
      notes: input.notes?.trim() || null,
      actionItemsJson: cleanItems(input.action_items),
      cadence: input.cadence ?? null,
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.checkIns> = {};
    if (has(patch, "counterpart")) set.counterpartId = idFromPath(patch.counterpart) ?? null;
    if (has(patch, "meeting_date")) {
      if (patch.meeting_date && Number.isNaN(dayMs(patch.meeting_date))) throw invalidArgument("meeting_date is invalid");
      set.meetingDate = patch.meeting_date ? new Date(dayMs(patch.meeting_date)) : null;
    }
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    if (has(patch, "action_items")) set.actionItemsJson = cleanItems(patch.action_items);
    if (has(patch, "cadence")) set.cadence = patch.cadence ?? null;
    return set;
  },
  // Tell the other party (or both, if HR logged it) that a 1:1 was recorded.
  afterCreate: async (deps, actor, row, input) => {
    for (const rid of [row.employeeId, row.counterpartId].filter((r): r is string => !!r && r !== actor.employeeId))
      await notify(deps, { recipient: rid, type: "checkin.scheduled", title: "1:1 check-in logged", body: input.meeting_date ? `A 1:1 was scheduled for ${input.meeting_date}.` : "A 1:1 check-in was recorded with you.", link: "check-ins", subject: `check-ins/${row.uuid}`, actorId: actor.employeeId });
  },
};
