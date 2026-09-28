import { Hono } from "hono";
import type { AppEnv } from "../env";
import { flushServerCaches } from "../services/cacheFlush";

// Collection-level custom method `operations:clearCache` - make every server instance reload what it holds in
// memory (services/cacheFlush.ts). Mounted at the full colon path in index.ts, like `cron-runs:run`. Super-only:
// the authz middleware resolves this to the custom key `operations.clearCache`, which no role's grant names, so
// only super_admin reaches it via the `**` wildcard until an admin grants it through the ACL. The mutation audit
// records it as `operations.clearCache`.
export const cacheFlush = new Hono<AppEnv>().post("/", async (c) => {
  await flushServerCaches(c.get("deps"));
  return c.json({ clear_time: new Date().toISOString() });
});
