import { and, eq, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { keysetPage } from "../services/keysetPage";
import { applyScope } from "../services/listScope";
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
    // THE SCOPE THE MIDDLEWARE DECIDED IS BOUND HERE, like every other list in the app. This hook used to
    // ignore `c.get("scope")` entirely and answer with the whole table - so a grant NARROWED through the ACL
    // (the bare `event-log` list gate plus, say, `event-log.my-dept.**`) resolved to `breadth: "dept"` and was
    // silently widened back to every row. Nothing reaches it today (bootstrap seeds `event-log.**`, i.e. `all`,
    // to hr_admin), which is exactly why it could sit here: the fail-open only appears the first time somebody
    // authors a narrower rule. `applyScope` decides nothing - it maps the breadth onto this table's columns,
    // and answers no rows for a breadth a flat-coded table cannot satisfy (services/listScope.ts), which is
    // the same fail-closed answer the generic list gives.
    const conds = [applyScope(c.get("scope"), schema.eventLog.code, undefined), type ? eq(schema.eventLog.type, type) : undefined];
    return keysetPage<typeof schema.eventLog.$inferSelect>(
      c.get("deps"),
      schema.eventLog,
      "event-log",
      and(...(conds.filter(Boolean) as SQL[])),
      {
        max: page.maxPageSize,
        pageToken: page.pageToken,
        order: { expr: sql`${schema.eventLog.occurredAt}`, value: (r) => +new Date(r.occurredAt) },
      },
    );
  },
});
