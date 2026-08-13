import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { toEventLogResource } from "../http/serialize";
import { isSuperGrant } from "../domain/grants";

// The domain event log (see services/eventBus.ts). Read-only observability; admin-only (private by default -
// HR + super reach it via grant). This route makes no access decision; the authz middleware gates it.
// Newest event first; optional `?type=` filter. Append-only: the table has no delete_time, so the factory
// mounts no write, delete or restore - there is nothing to mount.
export const eventLog = collectionRoutes({
  table: schema.eventLog,
  collection: "event-log",
  auditName: "event",
  notFound: "event not found",
  param: "event",
  // The payload can name anything the system did, so it is redacted below super.
  serialize: (row, user) => toEventLogResource(row, !isSuperGrant(user!.grant)),
  list: async (c, page) => {
    const type = c.req.query("type");
    const q = c.get("deps").db.select().from(schema.eventLog);
    const items = type
      ? await q.where(eq(schema.eventLog.type, type)).orderBy(desc(schema.eventLog.occurredAt)).limit(page.maxPageSize)
      : await q.orderBy(desc(schema.eventLog.occurredAt)).limit(page.maxPageSize);
    return { items, nextPageToken: undefined };
  },
});
