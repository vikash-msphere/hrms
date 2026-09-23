import { Hono } from "hono";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { reapplySplitCurrent, splitStatus } from "../services/compensation";

// Collection-level custom method `compensation:reapplySplit` (mounted at the full path in index.ts, as Hono's
// collection mount does not bind a `:verb` not preceded by an id). Re-derives basic + Special Allowance for
// every current comp row under the live ctc config, holding each row's annual CTC fixed. Payroll/super only
// (authz resolves the custom key `compensation.reapplySplit`); the route makes no access decision itself.
// `{ "dry_run": true }` returns the staleness counts (how many splits WOULD change) without writing - the same
// capability gate, so only reapply-capable callers see the "splits out of date" banner/prompt.
export const compensationReapply = new Hono<AppEnv>().post("/", async (c) => {
  const body = await jsonBody(c);
  const deps = c.get("deps");
  if (body && (body as { dry_run?: unknown }).dry_run === true) return c.json(await splitStatus(deps));
  return c.json(await reapplySplitCurrent(deps, c.get("user")));
});
