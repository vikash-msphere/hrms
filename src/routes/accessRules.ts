import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listAccessRules, getAccessRule, createAccessRule, deleteAccessRule } from "../services/accessRules";
import { clampPageSize } from "../http/pagination";

// The single access-control management surface: one rule (role OR user) per row. Super-only by default via
// the `access-rules` collection key (the middleware gates it). No update - edit = delete + create.
export const accessRules = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { results, nextPageToken } = await listAccessRules(c.get("deps"), clampPageSize(Number(c.req.query("max_page_size")) || undefined), c.req.query("page_token"));
    return c.json({ results, next_page_token: nextPageToken });
  })
  .get("/:access_rule_id", async (c) => c.json(await getAccessRule(c.get("deps"), c.req.param("access_rule_id"))))
  .post("/", async (c) => c.json(await createAccessRule(c.get("deps"), c.get("user"), await c.req.json())))
  .delete("/:access_rule_id", async (c) => {
    await deleteAccessRule(c.get("deps"), c.get("user"), c.req.param("access_rule_id"));
    return c.body(null, 204);
  });
