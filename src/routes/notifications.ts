import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { listNotifications, getNotification, patchNotification, markAllRead } from "../services/notifications";
import { toNotificationResource } from "../http/serialize";

// Recipient-driven state on a notification (rows are emitted server-side; content is not editable). `read`
// toggles the read flag; `snooze_until_time` (ISO, or null to clear) hides it until a later time; `dismissed`
// archives it out of the feed. All write-level, me-scoped by the middleware. There is no create (the server
// emits these) and no delete (the table has no delete_time - dismissing is the archive).
const patchSchema = z
  .object({
    read: z.boolean().optional(),
    snooze_until_time: z.string().datetime().nullable().optional(),
    dismissed: z.boolean().optional(),
  })
  .strict();

type NotificationPatch = z.infer<typeof patchSchema>;

export const notifications = collectionRoutes<NotificationPatch>({
  table: schema.notifications,
  collection: "notifications",
  auditName: "notification",
  notFound: "notification not found",
  param: "notification_id",
  updateSchema: patchSchema,
  serialize: toNotificationResource,
  overrides: {
    get: getNotification,
    // The wire shape is not the service shape: snooze_until_time is an ISO string (or null to clear) and the
    // service takes a Date. `"snooze_until_time" in b` distinguishes "clear it" from "leave it alone".
    update: (deps, actor, id, b, ifMatch) =>
      patchNotification(
        deps,
        actor,
        id,
        { read: b.read, dismissed: b.dismissed, ...("snooze_until_time" in b ? { snoozeUntil: b.snooze_until_time ? new Date(b.snooze_until_time) : null } : {}) },
        ifMatch,
      ),
  },
  list: async (c, page) => {
    const res = await listNotifications(c.get("deps"), c.get("scope"), page.maxPageSize, {
      pageToken: page.pageToken,
      unread: c.req.query("unread") === "true",
      snoozed: c.req.query("snoozed") === "true",
    });
    const snoozedCount = "snoozedCount" in res ? res.snoozedCount : undefined;
    return { items: res.items, nextPageToken: res.nextPageToken, ...(snoozedCount !== undefined ? { extra: { snoozed_count: snoozedCount } } : {}) };
  },
});

// Collection-level custom method `notifications:markAllRead` (mounted at the full path in index.ts, before the
// collection mount - Hono won't bind a `:verb` not preceded by an id). The authz middleware resolves it to the
// custom key `notifications.markAllRead`.
export const notificationsMarkAll = new Hono<AppEnv>().post("/", async (c) => {
  const { cleared } = await markAllRead(c.get("deps"), c.get("user"));
  return c.json({ cleared });
});
