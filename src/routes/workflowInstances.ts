import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { keysetPage } from "../services/keysetPage";
import { toWorkflowInstanceResource } from "../http/serialize";

// Suspended / finished durable workflows (see services/automationEngine.ts waitFor). Read-only; admin-only
// (private by default). Newest first; optional `?status=` filter (e.g. waiting).
//
// Paged on the row's own `created_at` - keysetPage's default key - through the shared cursor, for the reason
// given in routes/eventLog.ts: a stuck workflow older than the first page was unreachable through the API.
export const workflowInstances = collectionRoutes({
  table: schema.workflowInstances,
  collection: "workflow-instances",
  auditName: "workflow_instance",
  notFound: "workflow instance not found",
  param: "instance",
  serialize: toWorkflowInstanceResource,
  list: async (c, page) => {
    const status = c.req.query("status");
    return keysetPage<typeof schema.workflowInstances.$inferSelect>(
      c.get("deps"),
      schema.workflowInstances,
      "workflow-instances",
      status ? eq(schema.workflowInstances.status, status as "waiting" | "done" | "expired" | "error") : undefined,
      { max: page.maxPageSize, pageToken: page.pageToken },
    );
  },
});
