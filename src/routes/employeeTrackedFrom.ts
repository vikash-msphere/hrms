import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { invalidArgument } from "../lib/errors";
import { setTrackedFrom } from "../services/trackedFrom";

// Collection-level custom method `employees:setTrackedFrom` (mounted at the full path in index.ts, before the
// employees mount). Authz resolves it to the `employees.setTrackedFrom` verb: a 2-token key, so only an
// org-wide grant reaches it - HR's `employees.**` in the seeded roles, the same authority that edits anyone's
// start date. Answers with the plan, not with employees.
const bodySchema = z
  .object({
    date: z.string(),
    dry_run: z.boolean().optional(),
  })
  .strict();

export const employeeTrackedFrom = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = bodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("send the date HRMS records start, as { date: \"YYYY-MM-DD\" }");
  // The default is the SAFE one, as on compensation:increment: a body that forgets `dry_run` previews who would
  // get which date rather than writing it.
  const dryRun = parsed.data.dry_run !== false;
  return c.json(await setTrackedFrom(c.get("deps"), c.get("user"), { date: parsed.data.date, dryRun }));
});
