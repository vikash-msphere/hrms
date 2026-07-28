import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listNotifications, getNotification, patchNotification, markAllRead } from "../services/notifications";
import { toNotificationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "notifications";

// Recipient-driven state on a notification (rows are emitted server-side; content is not editable). `read`
// toggles the read flag; `snooze_until_time` (ISO, or null to clear) hides it until a later time; `dismissed`
// archives it out of the feed. All write-level, me-scoped by the middleware.
const patchSchema = z
  .object({
    read: z.boolean().optional(),
    snooze_until_time: z.string().datetime().nullable().optional(),
    dismissed: z.boolean().optional(),
  })
  .strict();

export const notifications = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const user = c.get("user");
    const res = await listNotifications(c.get("deps"), c.get("scope"), maxPageSize, {
      pageToken: c.req.query("page_token"),
      unread: c.req.query("unread") === "true",
      snoozed: c.req.query("snoozed") === "true",
    });
    const { items, nextPageToken } = res;
    const snoozedCount = "snoozedCount" in res ? res.snoozedCount : undefined;
    return c.json({
      results: items.map((r) => withAccess(toNotificationResource(r), user, COL, r.code)),
      next_page_token: nextPageToken,
      ...(snoozedCount !== undefined ? { snoozed_count: snoozedCount } : {}),
    });
  })
  .get("/:notification_id", async (c) => {
    const row = await getNotification(c.get("deps"), c.get("user"), c.req.param("notification_id"));
    return c.json(withAccess(toNotificationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:notification_id", zValidator("json", patchSchema), async (c) => {
    const b = c.req.valid("json");
    const row = await patchNotification(
      c.get("deps"),
      c.get("user"),
      c.req.param("notification_id"),
      { read: b.read, dismissed: b.dismissed, ...("snooze_until_time" in b ? { snoozeUntil: b.snooze_until_time ? new Date(b.snooze_until_time) : null } : {}) },
      c.req.header("If-Match"),
    );
    return c.json(withAccess(toNotificationResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  });

// Collection-level custom method `notifications:markAllRead` (mounted at the full path in index.ts, before the
// collection mount - Hono won't bind a `:verb` not preceded by an id). The authz middleware resolves it to the
// custom key `notifications.markAllRead`.
export const notificationsMarkAll = new Hono<AppEnv>().post("/", async (c) => {
  const { cleared } = await markAllRead(c.get("deps"), c.get("user"));
  return c.json({ cleared });
});
