import { allocOwnedCode, allocOwnedCodesFor, withFreshCode, CODE_WIDTH } from "./codeAlloc";
import { and, or, eq, gt, lte, isNull, isNotNull, inArray, count } from "drizzle-orm";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound, aborted } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { getSettingValue } from "./settings";
import { DEFAULT_NOTIFICATION_CONFIG, eventConfig, isMutedByUser, isDigestible, parseNotificationPrefs, type NotificationConfig, type NotificationPriority } from "../domain/notificationConfig";
import { queueForDigest, queueManyForDigest } from "./notificationDigest";
import { pushToEmployee } from "./webPush";
import { byIdChunks, insertBatches, runBatch } from "../lib/dbBatch";
import { activeDelegatesFor } from "./approvalDelegations";
import { ENCODABLE } from "../middleware/encodeWireIds";
import { checkEtag, updateAtVersion } from "./versionGuard";
import { liveEmployee, isLiveEmployee, LIVE_EMPLOYEE_COLUMNS, type LiveEmployeeColumns } from "./liveEmployee";

// Full name of an employee-ish row, or null. Used to denormalize the actor's display name onto a notification.
const nameOf = (p?: { firstName?: string | null; lastName?: string | null } | null): string | null =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || null : null;

// Load the org notification config (one read). The engine gates emission + resolves priority from it.
const loadNotifConfig = (deps: Deps) => getSettingValue<NotificationConfig>(deps, "notifications", DEFAULT_NOTIFICATION_CONFIG);

// A stored `link` is an INTERNAL path ("reviews/<internal-id>", "announcements/<internal-id>/view"): the JSON
// response encoder rewrites the id on the way out, so the feed is fine. Web push does not pass through that
// edge - it leaves as an outbound fetch - so the pushed link is encoded here, and prefixed "#/" because the
// push service worker navigates hash routes (a bare "approvals" resolved against the origin, not the router).
async function pushLink(deps: Deps, link?: string | null): Promise<string | undefined> {
  const raw = link?.trim();
  if (!raw) return undefined;
  const m = /^([a-z][a-z-]*)\/([0-9a-hj-km-np-tv-z]{13})((?::[a-zA-Z]+|\/[a-z][a-z-]*)?)$/.exec(raw);
  if (!m || !ENCODABLE.has(m[1]!)) return `#/${raw.replace(/^#\/?/, "")}`;
  return `#/${m[1]}/${await deps.idCodec.encode(m[1]!, m[2]!)}${m[3]}`;
}

// Audience for a broadcast emission. `everyone` = all active employees; `department` = direct members of a dept
// (by uuid); `employees` = an explicit list of employee uuids; `none` = emit nothing.
export type Audience =
  | { kind: "everyone" }
  | { kind: "department"; department: string }
  | { kind: "employees"; employees: string[] }
  | { kind: "none" };

// In-app notifications. Owned by the RECIPIENT (code-scoped, owner = recipientId), private by default. Rows
// are NOT created by callers - they are emitted server-side by event services via `notify`/`notifyMany`,
// which run with `deps` and bypass caller authz. The recipient reads/marks their own once an org grants
// `notifications` read/write to `everyone`.

export type NotifyInput = {
  recipient: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  subject?: string | null; // resource path "<collection>/<id>" this is about; flags the web list row "New"
  priority?: NotificationPriority; // explicit priority overrides the configured category default
  action?: string | null; // a CTA verb, e.g. "sign" / "acknowledge"; null = informational
  actorId?: string | null; // the person who caused this (approver, giver, ...); resolves the avatar + attribution
};

// Emit one notification. Gated + prioritized by the org config AND the recipient's own mute prefs: a disabled
// (org) or muted (user) category emits nothing, and the category's configured priority is used unless
// `input.priority` is set. When `actorId` is set, its display name is denormalized onto the row (one read
// resolves both the recipient's prefs and the actor's name). Best-effort: a failure here must never break the
// action that triggered it (an approval still succeeds even if the insert fails) - swallowed.
export async function notify(deps: Deps, input: NotifyInput): Promise<void> {
  const recipientId = input.recipient;
  if (!recipientId || !input.title) return;
  try {
    const cfg = eventConfig(await loadNotifConfig(deps), input.type);
    if (!cfg.enabled) return;
    // One read resolves the recipient's per-user mute prefs and (when present) the actor's display name.
    const ids = [...new Set([recipientId, input.actorId].filter(Boolean) as string[])];
    const people = await deps.db
      .select({ uuid: schema.employees.uuid, firstName: schema.employees.firstName, lastName: schema.employees.lastName, prefs: schema.employees.notificationPrefs, ...LIVE_EMPLOYEE_COLUMNS })
      .from(schema.employees)
      .where(inArray(schema.employees.uuid, ids));
    const byId = new Map(people.map((p) => [p.uuid, p]));
    // THE RECIPIENT HAS TO STILL BE SOMEBODY. `middleware/auth.ts#assertLive` refuses a terminated, deleted or
    // disabled employee a session, so a row written to one is a row nobody can ever read - and it is not free:
    // each one spends an allocation off that person's `code_sequences` counter. The rule was bound on the
    // AUDIENCE arm (`audienceEmployeeIds`) and nowhere else, which left every single-recipient path - the
    // fourteen modules whose approval nudge routes through `notifyManager` below, every direct `notify()` -
    // addressing people who cannot sign in. Binding it HERE makes the guarantee structural rather than
    // something each of the twenty callers has to remember.
    //
    // Checked on the row rather than in the `where`, because this same read resolves the ACTOR's display name:
    // an approval granted by somebody who has since left still shows their name on the notification, and a SQL
    // predicate would drop that row along with the dead recipient.
    if (!isLiveEmployee(byId.get(recipientId))) return;
    const prefs = parseNotificationPrefs(byId.get(recipientId)?.prefs);
    if (isMutedByUser(prefs, input.type)) return;
    const priority = input.priority ?? cfg.priority;
    // Digest opt-in: park low-signal informational items for the daily summary instead of the live feed.
    if (isDigestible(prefs, priority, input.action)) {
      await queueForDigest(deps, { recipientId, type: input.type, title: input.title, body: input.body, link: input.link });
      return;
    }
    // Retried on a lost code race, because the catch below is the difference between "told" and "not told":
    // two things happening to one person at the same moment used to have the second notification collide on
    // its code, and the failure was swallowed as non-fatal - a notification nobody ever saw. Everything the
    // app tells anybody comes through here, so this is the write most likely to be racing in the first place.
    await withFreshCode(async (attempt) =>
      deps.db.insert(schema.notifications).values({
        // `attempt > 1` re-establishes this person's counter against what is actually stored. A counter left
        // behind by an older write path hands out numbers that are already on disk, and retrying without the
        // resync walks it forward one place per attempt - which is exactly how it used to run out of attempts.
        code: await allocOwnedCode(deps, schema.notifications, schema.notifications.recipientId, recipientId, CODE_WIDTH.owned, attempt > 1),
        recipientId,
        type: input.type,
        title: input.title,
        body: input.body?.trim() || null,
        link: input.link?.trim() || null,
        subject: input.subject?.trim() || null,
        priority,
        action: input.action?.trim() || null,
        actorId: input.actorId || null,
        actorName: input.actorId ? nameOf(byId.get(input.actorId)) : null,
      }),
    );
    // Bonus channel: mirror the notification to the recipient's registered browsers (only when VAPID keys are
    // configured AND this person opted in). Deliberately single-recipient only - the notifyMany broadcast path
    // must not fan external fetches out per device x per employee inside one request (subrequest cap).
    await pushToEmployee(deps, recipientId, {
      title: input.title,
      body: input.body?.trim() || undefined,
      link: await pushLink(deps, input.link),
    });
  } catch (e) {
    console.error("[notify] insert failed (non-fatal)", e);
  }
}

// Fan-out the same notification to many recipients (e.g. a published announcement). Resolves every recipient's
// prefs and owner code in ONE read plus one batch of counter bumps, and writes via chunked multi-row inserts,
// instead of the per-recipient read+read+insert that an announcement broadcast would otherwise do
// O(employees) times in one request (a CPU/duration/subrequest DoS at scale). Best-effort: never throws - but
// a lost code race is retried rather than swallowed, so "best-effort" never quietly means "not told".
/**
 * `subjectFor` names a DIFFERENT resource per recipient, for the fan-outs where the thing being announced is
 * one row EACH rather than one row everybody shares.
 *
 * A broadcast usually has a single subject (the post, the ticket), which `input.subject` covers. Applying a
 * goal template does not: thirty people are told about thirty goals, and the subject is what the web draws
 * the "New" marker from and what the activity trail resolves - so a shared subject would point all thirty at
 * one goal. Without this, such a caller has to loop `notify()` per person, which is the per-employee cost this
 * function exists to remove.
 */
export async function notifyMany(
  deps: Deps,
  recipients: string[],
  input: Omit<NotifyInput, "recipient"> & {
    subjectFor?: (recipientId: string) => string | null | undefined;
    // PER-RECIPIENT text, for the same reason `subjectFor` exists. A fan-out whose wording differs per person -
    // "your probation ends today" to the employee and "<name>'s probation ends today" to their manager, "happy
    // <n>-year anniversary", "<n> optional holidays left to pick" - could not use this function at all, so the
    // nightly cron looped `notify()` over the whole active roster instead. At roughly three D1 calls each (the
    // recipient/actor read, the owned-code allocation, the insert) plus a fourth when push is configured, one
    // subtask spent more than the invocation's whole subrequest budget on a real headcount - and because the
    // twenty-two subtasks share one invocation, every subtask AFTER the one that hit the ceiling failed too.
    // Two of them are date-triggered rather than state-triggered, so a night lost there is never retried.
    //
    // `title` stays required and is the fallback: it is the category wording, and a resolver that returns
    // nothing for someone falls back to it rather than dropping them.
    //
    // NO BROWSER PUSH, and that is the trade this function is. `notify()` pushes to the recipient's registered
    // devices, which costs a preferences read and an outbound vendor call PER PERSON - the very thing a
    // fan-out cannot afford. So a broadcast has always landed in the bell and not on a lock screen (mentions
    // and announcements have worked this way from the start), and the cron reminders moved onto this function
    // now behave the same. If one of them ever needs push, the answer is to enqueue it as a job with a bounded
    // batch per invocation (see `reminder.email` in src/cron.ts), not to loop `notify()`.
    titleFor?: (recipientId: string) => string | null | undefined;
    bodyFor?: (recipientId: string) => string | null | undefined;
  },
): Promise<void> {
  const uniq = [...new Set(recipients.filter(Boolean))];
  if (!uniq.length || !input.title) return;
  try {
    const cfg = eventConfig(await loadNotifConfig(deps), input.type);
    if (!cfg.enabled) return;
    const priority = input.priority ?? cfg.priority;
    const action = input.action?.trim() || null;
    // D1 caps bound params at 100, so chunk every inArray read (a broadcast can have hundreds of recipients).
    const IN_CHUNK = 90;
    const inChunks = async <R>(ids: string[], run: (chunk: string[]) => Promise<R[]>): Promise<R[]> => {
      const out: R[] = [];
      for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...(await run(ids.slice(i, i + IN_CHUNK))));
      return out;
    };
    const emps = await inChunks(uniq, (c) =>
      deps.db
        .select({ uuid: schema.employees.uuid, code: schema.employees.code, firstName: schema.employees.firstName, lastName: schema.employees.lastName, prefs: schema.employees.notificationPrefs, ...LIVE_EMPLOYEE_COLUMNS })
        .from(schema.employees)
        .where(inArray(schema.employees.uuid, c)),
    );
    const empCode = new Map(emps.map((e) => [e.uuid, e.code]));
    const prefsFor = new Map(emps.map((e) => [e.uuid, parseNotificationPrefs(e.prefs)]));
    // Drop recipients who have muted this category for themselves (per-user prefs layered over the org config).
    const mutedFor = new Set(emps.filter((e) => isMutedByUser(prefsFor.get(e.uuid), input.type)).map((e) => e.uuid));
    // Denormalize the actor's display name once (a broadcast usually has none - it's a system event).
    const actorName = input.actorId ? nameOf(emps.find((e) => e.uuid === input.actorId)) : null;
    const body = input.body?.trim() || null;
    const link = input.link?.trim() || null;
    // The resource this is about. notify() has always stored it; the fan-out silently dropped it, so every
    // broadcast notification - a mention, a new ticket to its servicing team - arrived with no record of what
    // it was about, and the "New" marker the web draws from `subject` never appeared for any of them.
    const subject = input.subject?.trim() || null;
    const actorId = input.actorId || null;
    const titleOf = (rid: string) => (input.titleFor ? input.titleFor(rid)?.trim() : null) || input.title!;
    const bodyOf = (rid: string) => (input.bodyFor ? input.bodyFor(rid)?.trim() || null : body);
    // Same liveness rule as `notify()` above, for the same reason and off the same read - `audienceEmployeeIds`
    // filters the audiences it RESOLVES, but a caller that hands this function a list of its own (a goal
    // template applied to thirty people, a ticket fanned out to a team) was never filtered by anything. This
    // also drops ids that resolve to no employee at all, which used to reach the insert and fail the foreign
    // key inside the catch below - "best-effort" quietly meaning "not told".
    const live = new Set(emps.filter((e) => isLiveEmployee(e)).map((e) => e.uuid));
    const remaining = uniq.filter((rid) => live.has(rid) && !mutedFor.has(rid));
    // THE DIGEST PREFERENCE APPLIES HERE TOO. `notify()` parks low-signal informational items for the daily
    // summary; this path read the same prefs blob (it parses it for the mute check one line up) and applied
    // only the mute half, so every fan-out went straight to the bell - mentions, announcements, ticket
    // fan-outs, and, since the nightly reminders moved onto this function, precisely the low-priority no-CTA
    // items the digest exists for. Somebody turning "daily digest" on saw essentially no change.
    //
    // The partition is per recipient because the preference is: one audience can hold both kinds of person.
    // The digest side is parked in ONE batch (`queueManyForDigest`), so honouring the preference costs the
    // fan-out a single extra round-trip rather than the per-recipient write this function exists to avoid.
    const digestFor = remaining.filter((rid) => isDigestible(prefsFor.get(rid), priority, action));
    if (digestFor.length) {
      await queueManyForDigest(
        deps,
        digestFor.map((rid) => ({ recipientId: rid, type: input.type, title: titleOf(rid), body: bodyOf(rid), link })),
      );
    }
    const digested = new Set(digestFor);
    const targets = remaining.filter((rid) => !digested.has(rid));
    if (!targets.length) return;
    // Retried on a lost code race, for the reason notify() is: allocation and insert are not one statement, so
    // a burst against the same person can still have a loser, and the whole batch used to go out through the
    // catch below as "non-fatal" - a notification nobody ever saw.
    //
    // The codes come from the SAME per-(table, recipient) counters the single-recipient path takes, allocated
    // for the whole audience at once. Composing them from a sibling read instead (which is what this did) left
    // every broadcast row invisible to the counter, so the next single notify() to a busy person handed out
    // numbers that were already on disk and lost the notification four retries later. Re-allocated per attempt,
    // so a loser takes numbers the winner has already moved past.
    await withFreshCode(async (attempt) => {
      const codes = await allocOwnedCodesFor(deps, schema.notifications, schema.notifications.recipientId, targets, CODE_WIDTH.owned, empCode, attempt > 1);
      const rows = targets.map((rid) => ({
        code: codes.get(rid)!,
        recipientId: rid,
        type: input.type,
        title: titleOf(rid),
        body: bodyOf(rid),
        link,
        subject: input.subjectFor ? input.subjectFor(rid)?.trim() || null : subject,
        priority,
        action,
        actorId,
        actorName,
      }));
      // One batch = one subrequest for the whole fan-out (each chunk is a statement inside it), and the
      // broadcast lands atomically - no half-notified audience on a crash.
      await runBatch(deps.db, insertBatches(rows, (c) => deps.db.insert(schema.notifications).values(c)));
    });
  } catch (e) {
    console.error("[notifyMany] broadcast failed (non-fatal)", e);
  }
}

// Resolve an audience to employee uuids, then fan out. The configurable entry point for "who gets notified"
// when publishing a document / announcement (everyone, a department, or specific employees). `excludeId` drops
// the actor (don't notify yourself). No-op for `none`.
export async function notifyAudience(
  deps: Deps,
  audience: Audience,
  input: Omit<NotifyInput, "recipient">,
  excludeId?: string | null,
): Promise<void> {
  const recipients = await audienceEmployeeIds(deps, audience);
  await notifyMany(deps, recipients.filter((id) => id !== excludeId), input);
}

// The id inside a `<collection>/<id>` ref, or the string as given when it is already a bare id.
const bareId = (ref: string) => (ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref);

// Resolve an audience to the (active) employee uuids it targets. Shared by notifyAudience and the automation
// engine's emailAudience action, so both broadcast to the same set. `none` -> [].
export async function audienceEmployeeIds(deps: Deps, audience: Audience): Promise<string[]> {
  if (audience.kind === "none") return [];
  if (audience.kind === "everyone") return activeEmployeeIds(deps);
  if (audience.kind === "employees") {
    // NAMED PEOPLE ARE STILL FILTERED FOR LIVENESS. This arm used to return the rule's list verbatim - no
    // liveness check and no existence check - while the two arms either side of it bind `LIVE_EMPLOYEE`, so
    // the function's own first line ("the (active) employee uuids") was false for exactly the case an author
    // writes by hand. The email half happens to be covered, by a second filter in a different file
    // (services/emailFanOut.ts re-reads the recipients before sending); the in-app half had nothing: a rule
    // naming a terminated or soft-deleted employee minted `notifications` rows nobody can ever read
    // (middleware/auth.ts#assertLive refuses them a session), each one spending a `code_sequences` allocation,
    // and a stale id that no longer resolves failed the FK and was swallowed as a non-fatal insert failure.
    const named = audience.employees.map(bareId).filter(Boolean);
    if (!named.length) return [];
    // `byIdChunks`, because D1 binds at most 100 parameters per statement and an audience naming more people
    // than that is an ordinary way to write a rule.
    const rows = await byIdChunks(named, (group) => deps.db
      .select({ uuid: schema.employees.uuid })
      .from(schema.employees)
      .where(and(inArray(schema.employees.uuid, group), ...LIVE_EMPLOYEE)));
    // Back into the order the rule named them in, so a digest reads the way its author wrote it.
    const live = new Set(rows.map((r) => r.uuid));
    return named.filter((id) => live.has(id));
  }
  // department: its LIVE members. The audience is written by the workflow builder, which stores the department
  // the way every other ref on the wire is written (`departments/<id>`) so the inbound edge decodes it; a bare
  // id is accepted too, for a rule authored against the raw column. Same roster rule as `activeEmployeeIds`
  // below - see the note there for why `status` has to be part of it.
  const rows = await deps.db
    .select({ uuid: schema.employees.uuid })
    .from(schema.employees)
    .where(and(eq(schema.employees.departmentId, bareId(audience.department)), ...LIVE_EMPLOYEE));
  return rows.map((r) => r.uuid);
}

/**
 * The first manager UP THE CHAIN who can actually be told something, starting at `startId`.
 *
 * THE POINTER IS NEVER CLEARED, so it outlives the person. Neither exit reparents anybody: `removeEmployee`
 * soft-deletes the row and disables the login without touching another employee's `manager_id`, and
 * `terminateForOffboarding` stamps `status: "terminated"` and likewise reparents nobody. So
 * `employees.manager_id` can point at somebody who left months ago, and `middleware/auth.ts#assertLive`
 * guarantees that person will never open a session to see what was sent to them.
 *
 * Walking up is the honest answer rather than returning null: winding a team down offboards the manager
 * first and their reports afterwards, and with a bare null every offboarding checklist that follows loses its
 * "collect the laptop" / "revoke system access" nudge entirely. The skip-level manager is who covers those
 * reports in any org chart, so that is who is told.
 *
 * ONE READ PER HOP and no more: each node's row carries both the liveness columns and the next pointer, so a
 * live manager (the overwhelming case) costs exactly one. The cap and the `seen` set bound a cycle - the org
 * chart is a tree by construction, but this is a loop over data an admin can edit.
 */
const MAX_MANAGER_HOPS = 8;
async function firstLiveManagerId(deps: Deps, startId: string, subjectId: string): Promise<string | null> {
  const seen = new Set<string>([subjectId]);
  let id: string | null = startId;
  for (let hop = 0; hop < MAX_MANAGER_HOPS && id; hop++) {
    if (seen.has(id)) return null;
    seen.add(id);
    const node: ({ managerId: string | null } & LiveEmployeeColumns) | undefined = (await deps.db
      .select({ managerId: schema.employees.managerId, ...LIVE_EMPLOYEE_COLUMNS })
      .from(schema.employees)
      .where(eq(schema.employees.uuid, id))
      .limit(1))[0];
    if (!node) return null; // the pointer names a row that no longer exists at all
    if (isLiveEmployee(node)) return id;
    id = node.managerId;
  }
  return null;
}

// Notify an employee's manager that a report filed something needing review (the natural approver). No-op if
// the employee has no manager or is their own manager, and it escalates past a manager who has left (see
// `firstLiveManagerId`) rather than writing into a mailbox nobody can open. Resolves the requester's name in
// the same read it uses for the manager id, and templates the message off `noun` (e.g. "leave request",
// "reimbursement claim").
export async function notifyManager(deps: Deps, employeeId: string, opts: { type: string; noun: string }): Promise<void> {
  if (!employeeId) return;
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  const pointer = emp?.managerId;
  if (!pointer || pointer === employeeId) return;
  const managerId = await firstLiveManagerId(deps, pointer, employeeId);
  // Nobody live above them. The request does NOT stall - the approve grants are scoped by DEPARTMENT
  // (`leave-requests.my-dept.approve`) and by `*` for hr_admin, not by the reporting line, so another manager
  // in the department or HR can still decide it. What would be lost silently is the nudge, so say so once
  // rather than writing a row into a switched-off mailbox and reporting success.
  if (!managerId) {
    console.warn(`[notifications] ${opts.type}: employees/${employeeId} has no live manager above them; nobody was nudged`);
    return;
  }
  const name = emp ? `${emp.firstName} ${emp.lastName}` : "An employee";
  // Always points at the Approvals inbox - that's where every pending decision is actioned, not the per-page
  // tabs (a page's Requests tab shows only the caller's own items; History shows only decided ones). The
  // requester is the actor (their face shows on the manager's item).
  await notify(deps, { recipient: managerId, type: opts.type, title: `New ${opts.noun} to review`, body: `${name} submitted a ${opts.noun}.`, link: "approvals", actorId: employeeId });
  // Out-of-office cover: while the manager has an active approval delegation, copy the delegate so nothing
  // stalls in the manager's absence. Best-effort - a delegation lookup must never block the manager's nudge.
  try {
    for (const delegateId of await activeDelegatesFor(deps, managerId)) {
      if (delegateId === employeeId) continue; // never ask the requester to approve their own request
      await notify(deps, { recipient: delegateId, type: opts.type, title: `New ${opts.noun} to review (delegated)`, body: `${name} submitted a ${opts.noun}. You're covering approvals for their manager.`, link: "approvals", actorId: employeeId });
    }
  } catch (e) {
    console.error("[notifications] delegate copy failed (non-fatal)", e);
  }
}

// The manager of an employee, or null when they have none / are their own manager. A shared helper for the
// many "tell the report's manager" notifications across modules.
//
// LIVE MANAGERS ONLY, escalating past one who has left (see `firstLiveManagerId` above). Every caller uses the
// answer as a person: a recipient to notify, or - in `reviewerIdOf` - who WRITES somebody's review. A pointer
// at a terminated employee is not an answer to either question, and the review one is the sharper case: a
// cycle launched after the manager left had its write-up assigned to them, where it sat.
export async function managerIdOf(deps: Deps, employeeId: string): Promise<string | null> {
  if (!employeeId) return null;
  const e = (await deps.db.select({ m: schema.employees.managerId }).from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!e?.m || e.m === employeeId) return null;
  return firstLiveManagerId(deps, e.m, employeeId);
}

/**
 * Everyone still HERE - the broadcast audience for org-wide notifications (announcements) and, through
 * `audienceEmployeeIds`, for the workflow engine's `emailAudience` action.
 *
 * The rule itself (three columns, and why each one is needed) lives in services/liveEmployee.ts, so the other
 * surfaces that need it can take the predicate without taking this whole module with it. Aliased to the name
 * the readers of this file already know.
 */
const LIVE_EMPLOYEE = liveEmployee();

export async function activeEmployeeIds(deps: Deps): Promise<string[]> {
  const rows = await deps.db.select({ uuid: schema.employees.uuid }).from(schema.employees).where(and(...LIVE_EMPLOYEE));
  return rows.map((r) => r.uuid);
}

export async function listNotifications(
  deps: Deps,
  scope: ListScope,
  maxPageSize: number,
  opts: { pageToken?: string; unread?: boolean; snoozed?: boolean } = {},
) {
  // A notification feed is inherently personal: only ever the caller's own, regardless of any broad read grant.
  // (super_admin's `**` must not turn the bell into an org-wide firehose - that made badges count everyone's
  // unread while the page showed only the caller's own rows.) Force the recipient filter to the caller.
  const conds: any[] = [eq(schema.notifications.recipientId, scope.ownerId ?? "")];
  // A dismissed (archived) row is out of every feed.
  conds.push(isNull(schema.notifications.dismissedTime));
  const now = new Date();
  if (opts.snoozed) {
    // The snoozed view is the inverse of the live feed: rows still sleeping (a wake time in the future), so the
    // recipient can see what they've parked and wake it early. Read state is irrelevant here.
    conds.push(isNotNull(schema.notifications.snoozeUntil));
    conds.push(gt(schema.notifications.snoozeUntil, now));
    // Newest first (a notification feed reads top-down).
    return keysetPage(deps, schema.notifications, "notifications", and(...(conds.filter(Boolean) as any)), { dir: "desc", max: maxPageSize, pageToken: opts.pageToken });
  }
  if (opts.unread) conds.push(isNull(schema.notifications.readTime));
  // A snoozed row stays hidden until its wake time passes, then resurfaces (still unread) - so include rows
  // with no snooze or a snooze that has already elapsed.
  conds.push(or(isNull(schema.notifications.snoozeUntil), lte(schema.notifications.snoozeUntil, now)));
  const page = await keysetPage(deps, schema.notifications, "notifications", and(...(conds.filter(Boolean) as any)), { dir: "desc", max: maxPageSize, pageToken: opts.pageToken });
  // Ride the count of still-sleeping rows along on the feed read (the snoozed rows themselves are fetched lazily
  // only when the Snoozed view opens). Lets the client show an accurate Snoozed badge from first load, without a
  // second request. Cheap: one COUNT on the same recipient-scoped, indexed predicate.
  const snoozedCount = (
    await deps.db
      .select({ c: count() })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.recipientId, scope.ownerId ?? ""), isNull(schema.notifications.dismissedTime), isNotNull(schema.notifications.snoozeUntil), gt(schema.notifications.snoozeUntil, now)))
  )[0]?.c ?? 0;
  return { ...page, snoozedCount };
}

export async function getNotification(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.notifications).where(eq(schema.notifications.uuid, id)).limit(1))[0];
  if (!row) throw notFound("notification not found");
  return row;
}

// Recipient-driven state change on one notification: mark read/unread, snooze until a time (or clear it), or
// dismiss/restore (archive out of the feed). All write-level - ownership is enforced by the middleware
// (me-scoped write on the item), the service does no access check. Idempotent per field. Dismissing also
// stamps read (an archived item isn't unread noise).
export async function patchNotification(
  deps: Deps,
  actor: AppUser,
  id: string,
  input: { read?: boolean; snoozeUntil?: Date | null; dismissed?: boolean },
  ifMatch?: string,
) {
  const row = await getNotification(deps, actor, id);
  checkEtag(row, ifMatch);
  const set: Partial<typeof schema.notifications.$inferInsert> = { updatedAt: new Date() };
  if (input.read === true) set.readTime = row.readTime ?? new Date();
  if (input.read === false) set.readTime = null;
  if ("snoozeUntil" in input) set.snoozeUntil = input.snoozeUntil ?? null;
  if (input.dismissed === true) {
    set.dismissedTime = new Date();
    set.readTime = row.readTime ?? new Date();
  }
  if (input.dismissed === false) set.dismissedTime = null;
  const updated = await updateAtVersion(deps, schema.notifications, "record", row, set);
  return updated;
}

// Mark every unread notification of the CALLER read in one request. Returns the count cleared.
export async function markAllRead(deps: Deps, actor: AppUser): Promise<{ cleared: number }> {
  if (!actor.employeeId) return { cleared: 0 };
  const now = new Date();
  const updated = await deps.db
    .update(schema.notifications)
    .set({ readTime: now, updatedAt: now })
    .where(and(eq(schema.notifications.recipientId, actor.employeeId), isNull(schema.notifications.readTime)))
    .returning();
  return { cleared: updated.length };
}
