import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import { nonNegativeDays, signedDays } from "../http/moneyField";
import { toLeaveAdjustmentResource } from "../http/serialize";
import { invalidArgument } from "../lib/errors";
import { createCorrection, importOpenings, listLeaveAdjustments, OPENING_BATCH_MAX, type CorrectionInput } from "../services/leaveAdjustments";

// The leave balance ledger (services/leaveAdjustments.ts). A row is never edited or deleted - a mistake is
// corrected by another row - so the collection is list + get + create, and the create is a CORRECTION: an
// opening only ever arrives through `:importOpenings`, which is where its arithmetic lives.
const writeSchema = z
  .object({
    employee: z.string(),
    leave_type: z.string(),
    days: signedDays(),
    reason: z.string(),
  })
  .strict();

export const leaveAdjustments = collectionRoutes<CorrectionInput, typeof schema.leaveAdjustments>({
  table: schema.leaveAdjustments,
  collection: "leave-adjustments",
  auditName: "leave_adjustment",
  notFound: "leave adjustment not found",
  param: "leave_adjustment_id",
  writeSchema,
  serialize: toLeaveAdjustmentResource,
  overrides: {
    create: (deps, actor, input) => createCorrection(deps, actor, input),
  },
  list: (c, page) =>
    listLeaveAdjustments(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), c.req.query("leave_type")),
});

const importSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            employee: z.string(),
            leave_type: z.string(),
            opening_days: nonNegativeDays(),
            encashed_days: nonNegativeDays().nullable().optional(),
            as_of: z.string().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(OPENING_BATCH_MAX),
    dry_run: z.boolean().optional(),
  })
  .strict();

// Collection-level custom method `leave-adjustments:importOpenings` (mounted at the full path in index.ts,
// before the collection mount). `{ items: [...] }` is the bulk envelope the authz middleware gates per item,
// so every `employee` in it is checked against the caller's write on that employee's ledger (the owner ref),
// exactly as a single create is. Like compensation:increment, the default is the SAFE one: a body that forgets
// `dry_run` previews rather than applies.
export const leaveAdjustmentImport = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = importSchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument(`send up to ${OPENING_BATCH_MAX} opening balances as { items: [{ employee, leave_type, opening_days, encashed_days?, as_of? }] }`);
  const dryRun = parsed.data.dry_run !== false;
  return c.json(await importOpenings(c.get("deps"), c.get("user"), parsed.data.items, dryRun));
});
