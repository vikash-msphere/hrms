import { eq, and } from "drizzle-orm";
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

export type ActionItem = { text: string; done?: boolean };
export type CheckInCadence = "weekly" | "biweekly" | "monthly";
export type CheckInInput = {
  employee?: string | null;
  counterpart?: string | null;
  meeting_date?: string | null;
  notes?: string | null;
  action_items?: ActionItem[];
  cadence?: CheckInCadence | null;
  /** Your own private note. Which column it lands in is decided by who you are, never by what you send. */
  private_note?: string | null;
  /** How the meeting felt, 1-5. The employee's own; a counterpart may read it but not write it. */
  pulse?: number | null;
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
    .filter((c) => showDeleted || !c.deleteTime);
  // Paged on `createdAt` (what the cursor carries), newest first. Sorting the whole set by MEETING date and then
  // seeking on `createdAt` was two different orders, and a 1:1 logged out of order fell through the gap between
  // pages. The meeting date is a presentation order, so it orders the page that came back.
  const page = paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid);
  return {
    ...page,
    items: page.items.sort((a, b) => +new Date(b.meetingDate ?? b.createdAt) - +new Date(a.meetingDate ?? a.createdAt) || a.uuid.localeCompare(b.uuid)),
  };
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
  patch: (patch, row, _deps, actor) => {
    const set: SetOf<typeof schema.checkIns> = {};
    if (has(patch, "counterpart")) set.counterpartId = idFromPath(patch.counterpart) ?? null;
    if (has(patch, "meeting_date")) {
      if (patch.meeting_date && Number.isNaN(dayMs(patch.meeting_date))) throw invalidArgument("meeting_date is invalid");
      set.meetingDate = patch.meeting_date ? new Date(dayMs(patch.meeting_date)) : null;
    }
    if (has(patch, "notes")) set.notes = patch.notes?.trim() || null;
    if (has(patch, "action_items")) set.actionItemsJson = cleanItems(patch.action_items);
    if (has(patch, "cadence")) set.cadence = patch.cadence ?? null;
    // A private note belongs to whoever wrote it, so the SIDE decides the column: the same request body writes
    // the employee's note for the employee and the counterpart's note for their manager, and an HR admin with
    // write access on the row is neither and so cannot write either. That is the point - a note only one person
    // can read is worth nothing if a third party can quietly replace it.
    if (has(patch, "private_note")) {
      const text = patch.private_note?.trim() || null;
      if (actor.employeeId && actor.employeeId === row.employeeId) set.employeeNote = text;
      else if (actor.employeeId && actor.employeeId === row.counterpartId) set.counterpartNote = text;
      else throw invalidArgument("only the two people in a 1:1 can keep a private note on it");
    }
    // The pulse is the employee's own read on the meeting. A manager rating their report's mood would be a
    // different (and much worse) feature.
    if (has(patch, "pulse")) {
      if (patch.pulse != null && (!Number.isInteger(patch.pulse) || patch.pulse < 1 || patch.pulse > 5)) throw invalidArgument("pulse must be a whole number from 1 to 5");
      if (!actor.employeeId || actor.employeeId !== row.employeeId) throw invalidArgument("the pulse is the employee's own; only they can set it");
      set.pulse = patch.pulse ?? null;
    }
    return set;
  },
  // Tell the other party (or both, if HR logged it) that a 1:1 was recorded.
  afterCreate: async (deps, actor, row, input) => {
    for (const rid of [row.employeeId, row.counterpartId].filter((r): r is string => !!r && r !== actor.employeeId))
      await notify(deps, { recipient: rid, type: "checkin.scheduled", title: "1:1 check-in logged", body: input.meeting_date ? `A 1:1 was scheduled for ${input.meeting_date}.` : "A 1:1 check-in was recorded with you.", link: "check-ins", subject: `check-ins/${row.uuid}`, actorId: actor.employeeId });
  },
};
