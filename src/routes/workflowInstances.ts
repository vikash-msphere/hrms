import { desc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { toWorkflowInstanceResource } from "../http/serialize";

// Suspended / finished durable workflows (see services/automationEngine.ts waitFor). Read-only; admin-only
// (private by default). Newest first; optional `?status=` filter (e.g. waiting).
export const workflowInstances = collectionRoutes({
  table: schema.workflowInstances,
  collection: "workflow-instances",
  auditName: "workflow_instance",
  notFound: "workflow instance not found",
  param: "instance",
  serialize: toWorkflowInstanceResource,
  list: async (c, page) => {
    const status = c.req.query("status");
    const q = c.get("deps").db.select().from(schema.workflowInstances);
    const items = status
      ? await q.where(eq(schema.workflowInstances.status, status as "waiting" | "done" | "expired" | "error")).orderBy(desc(schema.workflowInstances.createdAt)).limit(page.maxPageSize)
      : await q.orderBy(desc(schema.workflowInstances.createdAt)).limit(page.maxPageSize);
    return { items, nextPageToken: undefined };
  },
});
