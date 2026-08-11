import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import { listApiKeys, getApiKey, createApiKey, revokeApiKey, deleteApiKey } from "../services/apiKeys";
import { toApiKeyResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const scopeSchema = z
  .object({
    collections: z.union([z.literal("*"), z.array(z.string())]).optional(),
    max_level: z.enum(["read", "write", "admin"]).optional(),
    verbs: z.union([z.literal("*"), z.array(z.string())]).optional(),
  })
  .strict();

const writeSchema = z
  .object({
    display_name: z.string().min(1).optional(),
    owner: z.string().optional(),
    scope: scopeSchema.optional(),
    expire_time: z.string().optional(),
  })
  .strict();

export const apiKeys = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listApiKeys(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toApiKeyResource(r), user, "api-keys", r.code)), next_page_token: nextPageToken });
  })
  .get("/:api_key_id", async (c) => {
    const row = await getApiKey(c.get("deps"), c.get("user"), c.req.param("api_key_id")!);
    return c.json(toApiKeyResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const { row, token } = await createApiKey(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    // The ONLY response that ever carries the plaintext. Nothing stores it, so there is no second chance.
    return c.json(toApiKeyResource({ ...row, secret: token }));
  })
  .delete("/:api_key_id", async (c) => {
    await deleteApiKey(c.get("deps"), c.get("user"), c.req.param("api_key_id")!, c.req.header("If-Match"));
    return c.body(null, 204);
  })
  .post("/:api_key_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb !== "revoke") return c.notFound();
    const row = await revokeApiKey(c.get("deps"), c.get("user"), id);
    return c.json(toApiKeyResource(row));
  });
