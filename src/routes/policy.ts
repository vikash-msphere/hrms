import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listPolicies, getPolicy, updatePolicy } from "../services/policy";
import { toPolicyResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const patchSchema = z.object({ value: z.unknown().optional(), key: z.string().optional() }).strict();

// Global body-AC manifest documents. Super-only by default (the middleware gates `policy.**`).
export const policy = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { items, nextPageToken } = await listPolicies(c.get("deps"), clampPageSize(Number(c.req.query("max_page_size")) || undefined), c.req.query("page_token"));
    return c.json({ results: items.map(toPolicyResource), next_page_token: nextPageToken });
  })
  .get("/:policy_id", async (c) => c.json(toPolicyResource(await getPolicy(c.get("deps"), c.req.param("policy_id")))))
  .patch("/:policy_id", zValidator("json", patchSchema), async (c) => {
    const row = await updatePolicy(c.get("deps"), c.get("user"), c.req.param("policy_id"), c.req.valid("json").value);
    return c.json(toPolicyResource(row));
  });
