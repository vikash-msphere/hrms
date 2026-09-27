import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { positiveDays } from "../http/moneyField";
import { invalidArgument } from "../lib/errors";
import { importLeaveHistory, HISTORY_BATCH_MAX } from "../services/leaveHistoryImport";

const itemSchema = z
  .object({
    employee: z.string(),
    leave_type: z.string(),
    start_date: z.string(),
    end_date: z.string(),
    start_session: z.union([z.literal(1), z.literal(2)]).optional(),
    end_session: z.union([z.literal(1), z.literal(2)]).optional(),
    days: positiveDays().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .strict();
const importSchema = z.object({ items: z.array(itemSchema).min(1).max(HISTORY_BATCH_MAX), dry_run: z.boolean().optional() }).strict();

// Collection-level custom method `leave-requests:importHistory` (mounted at the full path in index.ts, before
// the collection mount): leave taken before HRMS, as approved history (services/leaveHistoryImport.ts).
// `{ items: [...] }` is the bulk envelope the authz middleware gates per item, so every `employee` in it is
// checked against the caller's write on that employee's leave. A body that forgets `dry_run` previews.
export const leaveHistoryImport = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = importSchema.safeParse(await jsonBody(c));
  if (!parsed.success) {
    throw invalidArgument(`send up to ${HISTORY_BATCH_MAX} leaves as { items: [{ employee, leave_type, start_date, end_date, start_session?, end_session?, days?, reason? }] }`);
  }
  return c.json(await importLeaveHistory(c.get("deps"), c.get("user"), parsed.data.items, parsed.data.dry_run !== false));
});
