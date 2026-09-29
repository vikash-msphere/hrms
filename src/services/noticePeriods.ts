import { allocOwnedCode } from "./codeAlloc";
import { and, asc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, stateMeta } from "../lib/audit";
import { dayStartMs, orgToday } from "./orgDay";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { createTransition, terminateForOffboarding } from "./transitions";
import { notify, managerIdOf } from "./notifications";
import { checkEtag, updateAtVersion } from "./versionGuard";

// Notice-period tracking: a departing employee's notice + last working day, with a derived countdown.
// Employee-owned + code-scoped (own/dept/all); NO access control here (middleware gates by path + grants,
// private by default). Plain CRUD + soft-delete/restore; status (serving/completed/withdrawn) is a PATCH.
const TYPES = ["resignation", "termination", "retirement", "other"] as const;
const STATUSES = ["serving", "completed", "withdrawn"] as const;
type Type = (typeof TYPES)[number];
type Status = (typeof STATUSES)[number];

export type NoticePeriodInput = {
  employee?: string | null;
  type?: Type;
  notice_date?: string; // YYYY-MM-DD
  last_working_day?: string; // YYYY-MM-DD
  status?: Status;
  reason?: string | null;
  notes?: string | null;
  start_offboarding?: boolean; // create-only: also kick off an offboarding transition for this employee
  template?: string | null; // offboarding template id to instantiate (with start_offboarding)
};
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s: string, field: string): number => {
  const ms = Date.parse(s + "T00:00:00Z");
  if (Number.isNaN(ms)) throw invalidArgument(`${field} must be YYYY-MM-DD`);
  return ms;
};

export async function listNoticePeriods(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, statusFilter?: string, showDeleted = false, deletedOnly = false) {
  const conds = [applyScope(scope, schema.noticePeriods.code, schema.noticePeriods.employeeId)];
  if (statusFilter) conds.push(eq(schema.noticePeriods.status, statusFilter as Status));
  conds.push(deleteStateFilter(schema.noticePeriods.deleteTime, showDeleted, deletedOnly));
  return keysetPage<typeof schema.noticePeriods.$inferSelect>(deps, schema.noticePeriods, "notice-periods", and(...(conds.filter(Boolean) as any)), { max: maxPageSize, pageToken });
}

// The read side of the collection is the factory's generic get; this stays internal because the update needs
// the stored row first, and refuses to edit one that is in the trash (restore it before editing).
async function getNoticePeriod(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.noticePeriods).where(eq(schema.noticePeriods.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("notice period not found");
  return row;
}

function validate(input: NoticePeriodInput) {
  if (input.type && !TYPES.includes(input.type)) throw invalidArgument("invalid type");
  if (input.status && !STATUSES.includes(input.status)) throw invalidArgument("invalid status");
}

export async function createNoticePeriod(deps: Deps, actor: AppUser, input: NoticePeriodInput) {
  if (!input.notice_date) throw invalidArgument("notice_date is required");
  if (!input.last_working_day) throw invalidArgument("last_working_day is required");
  validate(input);
  const notice = dayMs(input.notice_date, "notice_date");
  const lwd = dayMs(input.last_working_day, "last_working_day");
  if (lwd < notice) throw invalidArgument("last_working_day cannot be before notice_date");
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  const row = (await deps.db
    .insert(schema.noticePeriods)
    .values({
      code: await allocOwnedCode(deps, schema.noticePeriods, schema.noticePeriods.employeeId, employeeId),
      employeeId,
      type: input.type ?? "resignation",
      noticeDate: new Date(notice),
      lastWorkingDay: new Date(lwd),
      status: input.status ?? "serving",
      // Empty string clears, like an omitted field: the SPA sends "" for a text box the user left blank
      // (nothing on the wire is ever null - see web/src/api.ts).
      reason: input.reason?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .returning())[0]!;
  // Tell the employee's manager a report has entered their notice period.
  const mgr = await managerIdOf(deps, employeeId);
  if (mgr && mgr !== actor.employeeId)
    await notify(deps, { recipient: mgr, type: "notice.filed", title: `Notice period: ${row.type}`, body: `A report is serving notice; last working day ${input.last_working_day}.`, link: "notice-periods", subject: `notice-periods/${row.uuid}`, actorId: employeeId });
  // Optionally kick off the offboarding process: create an offboarding transition anchored to the last working
  // day (instantiating the chosen template's tasks) and link it back. Reuses the transitions service (one-way
  // import, no cycle). Best-effort - a transition failure must not fail recording the notice.
  if (input.start_offboarding) {
    try {
      const tr = await createTransition(deps, actor, { employee: `employees/${employeeId}`, kind: "offboarding", anchor_date: input.last_working_day, template: input.template ?? undefined });
      const [linked] = await deps.db.update(schema.noticePeriods).set({ transitionId: tr.uuid }).where(eq(schema.noticePeriods.uuid, row.uuid)).returning();
      await audit(deps, actor, "notice_period.create", "notice-periods", row.uuid, { offboarding: tr.uuid }, row);
      return linked!;
    } catch (e) {
      console.error("offboarding transition from notice failed", e);
    }
  }
  await audit(deps, actor, "notice_period.create", "notice-periods", row.uuid, createdMeta(row, "notice-periods"), row);
  return row;
}

export async function updateNoticePeriod(deps: Deps, actor: AppUser, id: string, patch: NoticePeriodInput, ifMatch?: string) {
  const row = await getNoticePeriod(deps, actor, id);
  checkEtag(row, ifMatch);
  validate(patch);
  const has = (k: keyof NoticePeriodInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: SetOf<typeof schema.noticePeriods> = { updatedAt: new Date() };
  if (has("type")) set.type = patch.type;
  if (has("notice_date") && patch.notice_date) set.noticeDate = new Date(dayMs(patch.notice_date, "notice_date"));
  if (has("last_working_day") && patch.last_working_day) set.lastWorkingDay = new Date(dayMs(patch.last_working_day, "last_working_day"));
  if (has("status")) set.status = patch.status;
  if (has("reason")) set.reason = patch.reason?.trim() || null;
  if (has("notes")) set.notes = patch.notes?.trim() || null;
  // Guard the date ordering against either field changing.
  const notice = +new Date((set.noticeDate as Date) ?? row.noticeDate);
  const lwd = +new Date((set.lastWorkingDay as Date) ?? row.lastWorkingDay);
  if (lwd < notice) throw invalidArgument("last_working_day cannot be before notice_date");
  const updated = await updateAtVersion(deps, schema.noticePeriods, "record", row, set);
  // Keep a linked offboarding transition in sync: the last working day -> its anchor; the notice status ->
  // its state (completed -> COMPLETED, withdrawn -> CANCELLED, serving -> ACTIVE).
  if (updated.transitionId && (has("last_working_day") || has("status"))) {
    const tset: Record<string, unknown> = { updatedAt: new Date() };
    if (has("last_working_day")) tset.anchorDate = updated.lastWorkingDay;
    if (has("status")) tset.state = updated.status === "completed" ? "COMPLETED" : updated.status === "withdrawn" ? "CANCELLED" : "ACTIVE";
    await deps.db.update(schema.transitions).set(tset).where(eq(schema.transitions.uuid, updated.transitionId));
  }
  // Marking the notice exited = the offboarding is complete -> terminate the employee (same as completing the
  // linked transition, which this path sets directly above).
  if (has("status") && updated.status === "completed") {
    await terminateForOffboarding(deps, actor, updated.employeeId, updated.lastWorkingDay);
  }
  await audit(deps, actor, "notice_period.update", "notice-periods", id, diffMeta(row, updated, set, "notice-periods"), updated);
  return updated;
}

/** How many people one nightly tick exits. About four writes each, inside a tick that shares one invocation's
 *  subrequest budget with every other nightly job; anyone past the cap is picked up the next night. */
const EXIT_BATCH = 10;

/**
 * The nightly exit: everyone whose last working day has PASSED loses access, without waiting for HR to click.
 *
 * "Passed" is the org-local calendar day (services/orgDay.ts): the last working day itself is still worked, so
 * a notice ending today is left alone and exits on tomorrow's tick.
 *
 * Two sources, because an exit is recorded two ways:
 * - A SERVING notice period past its last working day. The notice is flipped to `completed` by a guarded write
 *   (only a row still `serving` moves), so an overlapping manual trigger or a re-run cannot exit someone twice.
 * - An ACTIVE offboarding past its anchor date that no serving notice speaks for - an offboarding HR started
 *   directly, with no notice behind it.
 *
 * THE CHECKLIST STAYS OPEN. Ending access is what cannot wait; "collect the laptop" and "revoke system access"
 * are still work somebody owes, and HR completes the offboarding when they are done. That is why the notice is
 * written here directly rather than through `updateNoticePeriod`, whose sync would close the linked transition
 * along with it. Completing it later is harmless: `terminateForOffboarding` does nothing to someone already out.
 *
 * Returns how many people it exited, for the cron_runs summary.
 */
export async function exitDueEmployees(deps: Deps): Promise<number> {
  const todayStart = dayStartMs(await orgToday(deps));
  // Audited as "system", like every nightly job's writes; the tick's `actingAs` names the cron run.
  const actor = "system";
  let exited = 0;

  const notices = await deps.db
    .select()
    .from(schema.noticePeriods)
    .where(and(eq(schema.noticePeriods.status, "serving"), isNull(schema.noticePeriods.deleteTime), lt(schema.noticePeriods.lastWorkingDay, new Date(todayStart))))
    .orderBy(asc(schema.noticePeriods.lastWorkingDay))
    .limit(EXIT_BATCH);
  for (const n of notices) {
    const [done] = await deps.db
      .update(schema.noticePeriods)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(schema.noticePeriods.uuid, n.uuid), eq(schema.noticePeriods.status, "serving")))
      .returning();
    if (!done) continue;
    await audit(deps, actor, "notice_period.update", "notice-periods", n.uuid, stateMeta("serving", "completed", { employee: `employees/${n.employeeId}`, via: "exit-sweep" }), done);
    if (await terminateForOffboarding(deps, actor, n.employeeId, n.lastWorkingDay)) {
      exited++;
      await tellManagerAccessEnded(deps, n.employeeId, n.lastWorkingDay, `notice-periods/${n.uuid}`);
    }
  }

  const room = EXIT_BATCH - notices.length;
  if (room <= 0) return exited;
  const due = await deps.db
    .select({ uuid: schema.transitions.uuid, employeeId: schema.transitions.employeeId, anchorDate: schema.transitions.anchorDate })
    .from(schema.transitions)
    .innerJoin(schema.employees, eq(schema.employees.uuid, schema.transitions.employeeId))
    .where(
      and(
        eq(schema.transitions.kind, "offboarding"),
        eq(schema.transitions.state, "ACTIVE"),
        isNull(schema.transitions.deleteTime),
        lt(schema.transitions.anchorDate, new Date(todayStart)),
        ne(schema.employees.status, "terminated"),
      ),
    )
    .orderBy(asc(schema.transitions.anchorDate))
    .limit(room);
  if (!due.length) return exited;
  // A notice still serving owns the date - its last working day may have moved past this anchor - so an
  // offboarding it is linked to waits for the notice rather than exiting on the older date.
  const owned = new Set(
    (await deps.db
      .select({ t: schema.noticePeriods.transitionId })
      .from(schema.noticePeriods)
      .where(and(inArray(schema.noticePeriods.transitionId, due.map((d) => d.uuid)), eq(schema.noticePeriods.status, "serving"), isNull(schema.noticePeriods.deleteTime))))
      .map((r) => r.t),
  );
  for (const t of due) {
    if (owned.has(t.uuid) || !t.anchorDate) continue;
    if (await terminateForOffboarding(deps, actor, t.employeeId, t.anchorDate)) {
      exited++;
      await tellManagerAccessEnded(deps, t.employeeId, t.anchorDate, `transitions/${t.uuid}`);
    }
  }
  return exited;
}

/** The leaver's manager (first live one up the chain) hears that access ended, so an exit that happened
 *  overnight is not discovered by the next person who tries to assign them something. */
async function tellManagerAccessEnded(deps: Deps, employeeId: string, lastDay: Date, subject: string) {
  const mgr = await managerIdOf(deps, employeeId);
  if (!mgr) return;
  const day = new Date(lastDay).toISOString().slice(0, 10);
  await notify(deps, { recipient: mgr, type: "notice.exited", title: "A report has exited", body: `Their last working day was ${day}; their login is now disabled.`, link: "notice-periods", subject, actorId: employeeId });
}

