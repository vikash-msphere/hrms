import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { toOperationResource } from "../http/serialize";
import { notFound } from "../lib/errors";
import { applyScope } from "../services/listScope";
import { keysetPage } from "../services/keysetPage";
import { runJob } from "../cron";

// AEP-151 operations endpoints. Paths are matched by the linter, so they are exactly /v1/operations and
// /v1/operations/{operation}. Operations are employee-owned (like leave-requests): access is the middleware's
// path-based grant, and this route makes no access decision. A job is written by the queue and read back -
// never created, edited or deleted through the API - so list, get and :run are the whole surface.
export const operations = collectionRoutes({
  table: schema.jobs,
  collection: "operations",
  auditName: "operation",
  notFound: "operation not found",
  param: "operation",
  serialize: toOperationResource,
  // PAGED, on created_at. `jobs` is append-only and never pruned - every payslip publish, email fan-out and
  // workflow timer adds a row - and this took `limit(maxPageSize)` while answering `nextPageToken: undefined`,
  // which is the one combination that lies: the answer WAS truncated and the client was told it held
  // everything, so the Operations page could only ever show the newest hundred and nothing said so.
  list: (c, page) =>
    keysetPage<typeof schema.jobs.$inferSelect>(
      c.get("deps"),
      schema.jobs,
      "operations",
      applyScope(c.get("scope"), schema.jobs.code, schema.jobs.employeeId),
      { max: page.maxPageSize, pageToken: page.pageToken },
    ),
  verbs: {
    // Run a single job on demand (queued / errored / orphaned). The middleware resolves this to the custom key
    // operations.<code>.run; no role's grant allows it, so only super_admin reaches it via the `**` wildcard.
    run: {
      run: async (deps, _user, id) => {
        const job = await runJob(deps, id);
        if (!job) throw notFound("operation not found");
        return job;
      },
    },
  },
});
