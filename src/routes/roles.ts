import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listRoles, getRole, createRole, updateRole, deleteRole } from "../services/roles";
import { toRoleResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const createSchema = z.object({ name: z.string().optional(), label: z.string().optional(), protected: z.boolean().optional() }).strict();
const patchSchema = z.object({ name: z.string().optional(), label: z.string().optional(), protected: z.boolean().optional(), provisioned: z.boolean().optional() }).strict();

// Role catalog. Super-only by default (the middleware gates `roles.**`); grantable to others purely by data.
export const roles = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { items, nextPageToken } = await listRoles(c.get("deps"), clampPageSize(Number(c.req.query("max_page_size")) || undefined), c.req.query("page_token"));
    return c.json({ results: items.map(toRoleResource), next_page_token: nextPageToken });
  })
  .get("/:role_id", async (c) => c.json(toRoleResource(await getRole(c.get("deps"), c.req.param("role_id")))))
  .post("/", zValidator("json", createSchema), async (c) => {
    const row = await createRole(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toRoleResource(row));
  })
  .patch("/:role_id", zValidator("json", patchSchema), async (c) => {
    const row = await updateRole(c.get("deps"), c.get("user"), c.req.param("role_id"), c.req.valid("json"));
    return c.json(toRoleResource(row));
  })
  .delete("/:role_id", async (c) => {
    await deleteRole(c.get("deps"), c.get("user"), c.req.param("role_id"));
    return c.body(null, 204);
  });
