import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { capabilitiesOf } from "../domain/permissions";
import { listUsers, getUser, updateUser } from "../services/users";
import { toUserResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z
  .object({
    role: z.enum(["employee", "manager", "hr_admin", "payroll_admin", "super_admin"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    employee: z.string().nullable().optional(),
  })
  .strict();

export const users = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listUsers(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"));
    return c.json({ results: items.map(toUserResource), next_page_token: nextPageToken });
  })
  .get("/:user_id", async (c) => {
    const id = c.req.param("user_id");
    // Anyone may read their own record via `me`; reading anyone else requires admin.
    const row = await getUser(c.get("deps"), c.get("user"), id);
    const res = toUserResource(row);
    // The caller's own record (users/me) carries their capability set for client-side UI gating (section 7),
    // plus the per-collection grantable scope tiers from the policy manifest (drives the ACL scope chips, so
    // the UI offers the relevant scopes for each collection instead of a hardcoded "all").
    if (id === "me") {
      const u = c.get("user");
      return c.json({ ...res, access: { capabilities: capabilitiesOf(u.grant), scopes: u.policy.supported_scopes ?? {} } });
    }
    return c.json(res);
  })
  .patch("/:user_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateUser(c.get("deps"), c.get("user"), c.req.param("user_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toUserResource(row));
  });
