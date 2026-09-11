import { eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { keysetPage } from "../services/keysetPage";
import { toEventLogResource } from "../http/serialize";
import { isSuperGrant } from "../domain/grants";

// The domain event log (see services/eventBus.ts). Read-only observability; admin-only (private by default -
// HR + super reach it via grant). This route makes no access decision; the authz middleware gates it.
// Newest event first; optional `?type=` filter. Append-only: the table has no delete_time, so the factory
// mounts no write, delete or restore - there is nothing to mount.
//
// PAGED, through the same keyset cursor every other list uses. It used to answer the newest `max_page_size`
// rows and return no `nextPageToken` at all - a hard wall at 100 with no way past it, and no `hasMore` for the
// table to admit the truncation with. This is one of the three tables somebody reads WHEN SOMETHING HAS GONE
// WRONG (with automation-runs and workflow-instances), and "the event you are looking for is older than the
// last hundred" is exactly the case that matters. `occurred_at` is the reading order and is NOT NULL, so it is
// the sort key; the cursor carries it.
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
    return keysetPage<typeof schema.eventLog.$inferSelect>(
      c.get("deps"),
      schema.eventLog,
      "event-log",
      type ? eq(schema.eventLog.type, type) : undefined,
      {
        max: page.maxPageSize,
        pageToken: page.pageToken,
        order: { expr: sql`${schema.eventLog.occurredAt}`, value: (r) => +new Date(r.occurredAt) },
      },
    );
  },
});
