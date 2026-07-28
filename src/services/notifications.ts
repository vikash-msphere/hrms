import { allocOwnedCode, CODE_WIDTH } from "./codeAlloc";
import { nextChildCode } from "../domain/codes";
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
import { queueForDigest } from "./notificationDigest";
import { activeDelegatesFor } from "./approvalDelegations";

// Full name of an employee-ish row, or null. Used to denormalize the actor's display name onto a notification.
const nameOf = (p?: { firstName?: string | null; lastName?: string | null } | null): string | null =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || null : null;

// Load the org notification config (one read). The engine gates emission + resolves priority from it.
const loadNotifConfig = (deps: Deps) => getSettingValue<NotificationConfig>(deps, "notifications", DEFAULT_NOTIFICATION_CONFIG);

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
      .select({ uuid: schema.employees.uuid, firstName: schema.employees.firstName, lastName: schema.employees.lastName, prefs: schema.employees.notificationPrefs })
      .from(schema.employees)
      .where(inArray(schema.employees.uuid, ids));
    const byId = new Map(people.map((p) => [p.uuid, p]));
    const prefs = parseNotificationPrefs(byId.get(recipientId)?.prefs);
    if (isMutedByUser(prefs, input.type)) return;
    const priority = input.priority ?? cfg.priority;
    // Digest opt-in: park low-signal informational items for the daily summary instead of the live feed.
    if (isDigestible(prefs, priority, input.action)) {
      await queueForDigest(deps, { recipientId, type: input.type, title: input.title, body: input.body, link: input.link });
      return;
    }
    await deps.db.insert(schema.notifications).values({
      code: await allocOwnedCode(deps, schema.notifications, schema.notifications.recipientId, recipientId),
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
    });
  } catch (e) {
    console.error("[notify] insert failed (non-fatal)", e);
  }
}

// Fan-out the same notification to many recipients (e.g. a published announcement). Resolves every recipient's
// owner code in TWO reads (employee codes + existing notification codes) and writes via chunked multi-row
// inserts, instead of the per-recipient read+read+insert that an announcement broadcast would otherwise do
// O(employees) times in one request (a CPU/duration/subrequest DoS at scale). Best-effort: never throws.
// Rows per multi-row insert. Cloudflare D1 caps bound parameters at 100 PER STATEMENT. Each row binds ~11
// (the 8 set columns + the uuid/createdAt/updatedAt defaults drizzle materializes), so a chunk of 8 (~88
// params) stays safely under the cap. (Larger chunks silently fail the WHOLE batch with "too many SQL variables".)
const INSERT_CHUNK = 8;
export async function notifyMany(deps: Deps, recipients: string[], input: Omit<NotifyInput, "recipient">): Promise<void> {
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
        .select({ uuid: schema.employees.uuid, code: schema.employees.code, firstName: schema.employees.firstName, lastName: schema.employees.lastName, prefs: schema.employees.notificationPrefs })
        .from(schema.employees)
        .where(inArray(schema.employees.uuid, c)),
    );
    const empCode = new Map(emps.map((e) => [e.uuid, e.code]));
    // Drop recipients who have muted this category for themselves (per-user prefs layered over the org config).
    const mutedFor = new Set(emps.filter((e) => isMutedByUser(parseNotificationPrefs(e.prefs), input.type)).map((e) => e.uuid));
    // Denormalize the actor's display name once (a broadcast usually has none - it's a system event).
    const actorName = input.actorId ? nameOf(emps.find((e) => e.uuid === input.actorId)) : null;
    // Existing notification codes per owner, so each new code is the next free child in that owner's namespace.
    const existing = await inChunks(uniq, (c) =>
      deps.db.select({ recipientId: schema.notifications.recipientId, code: schema.notifications.code }).from(schema.notifications).where(inArray(schema.notifications.recipientId, c)),
    );
    const siblings = new Map<string, (string | null)[]>();
    for (const r of existing) {
      const arr = siblings.get(r.recipientId) ?? [];
      arr.push(r.code);
      siblings.set(r.recipientId, arr);
    }
    const body = input.body?.trim() || null;
    const link = input.link?.trim() || null;
    const actorId = input.actorId || null;
    const rows = uniq
      .filter((rid) => !mutedFor.has(rid))
      .map((rid) => ({
        code: nextChildCode(siblings.get(rid) ?? [], empCode.get(rid) ?? null, CODE_WIDTH.owned),
        recipientId: rid,
        type: input.type,
        title: input.title,
        body,
        link,
        priority,
        action,
        actorId,
        actorName,
      }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await deps.db.insert(schema.notifications).values(rows.slice(i, i + INSERT_CHUNK));
    }
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

// Resolve an audience to the (active) employee uuids it targets. Shared by notifyAudience and the automation
// engine's emailAudience action, so both broadcast to the same set. `none` -> [].
export async function audienceEmployeeIds(deps: Deps, audience: Audience): Promise<string[]> {
  if (audience.kind === "none") return [];
  if (audience.kind === "everyone") return activeEmployeeIds(deps);
  if (audience.kind === "employees") return audience.employees;
  // department: direct members, excluding deleted.
  const rows = await deps.db
    .select({ uuid: schema.employees.uuid, deleteTime: schema.employees.deleteTime })
    .from(schema.employees)
    .where(eq(schema.employees.departmentId, audience.department));
  return rows.filter((r) => !r.deleteTime).map((r) => r.uuid);
}

// Notify an employee's manager that a report filed something needing review (the natural approver). No-op if
// the employee has no manager or is their own manager. Resolves the requester's name in the same read it uses
// for the manager id, and templates the message off `noun` (e.g. "leave request", "reimbursement claim").
export async function notifyManager(deps: Deps, employeeId: string, opts: { type: string; noun: string }): Promise<void> {
  if (!employeeId) return;
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  const managerId = emp?.managerId;
  if (!managerId || managerId === employeeId) return;
  const name = emp ? `${emp.firstName} ${emp.lastName}` : "An employee";
  // Always points at the Approvals inbox - that's where every pending decision is actioned, not the per-page
  // tabs (a page's Requests tab shows only the caller's own items; History shows only decided ones). The
  // requester is the actor (their face shows on the manager's item).
  await notify(deps, { recipient: managerId, type: opts.type, title: `New ${opts.noun} to review`, body: `${name} submitted a ${opts.noun}.`, link: "approvals", actorId: employeeId });
  // Out-of-office cover: while the manager has an active approval delegation, copy the delegate so nothing
  // stalls in the manager's absence. Best-effort - a delegation lookup must never block the manager's nudge.
  try {
    for (const delegateId of await activeDelegatesFor(deps, managerId, deps.clock.now())) {
      if (delegateId === employeeId) continue; // never ask the requester to approve their own request
      await notify(deps, { recipient: delegateId, type: opts.type, title: `New ${opts.noun} to review (delegated)`, body: `${name} submitted a ${opts.noun}. You're covering approvals for their manager.`, link: "approvals", actorId: employeeId });
    }
  } catch (e) {
    console.error("[notifications] delegate copy failed (non-fatal)", e);
  }
}

// The manager of an employee, or null when they have none / are their own manager. A shared helper for the
// many "tell the report's manager" notifications across modules.
export async function managerIdOf(deps: Deps, employeeId: string): Promise<string | null> {
  if (!employeeId) return null;
  const e = (await deps.db.select({ m: schema.employees.managerId }).from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  return e?.m && e.m !== employeeId ? e.m : null;
}

// All active (non-deleted) employee uuids - the broadcast audience for org-wide notifications (announcements).
export async function activeEmployeeIds(deps: Deps): Promise<string[]> {
  const rows = await deps.db.select({ uuid: schema.employees.uuid, deleteTime: schema.employees.deleteTime }).from(schema.employees);
  return rows.filter((r) => !r.deleteTime).map((r) => r.uuid);
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
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Partial<typeof schema.notifications.$inferInsert> = { updatedAt: new Date() };
  if (input.read === true) set.readTime = row.readTime ?? new Date();
  if (input.read === false) set.readTime = null;
  if ("snoozeUntil" in input) set.snoozeUntil = input.snoozeUntil ?? null;
  if (input.dismissed === true) {
    set.dismissedTime = new Date();
    set.readTime = row.readTime ?? new Date();
  }
  if (input.dismissed === false) set.dismissedTime = null;
  const updated = (await deps.db.update(schema.notifications).set(set).where(eq(schema.notifications.uuid, id)).returning())[0]!;
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
