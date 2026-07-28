import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import {
  listAutomations, getAutomation, createAutomation, updateAutomation, deleteAutomation,
  setAutomationEnabled, testAutomation,
} from "../services/automations";
import { toAutomationResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "automations";
// condition/actions are validated in depth by the pure domain validator (services/automations); the schema
// only enforces the transport shape (JSON objects), keeping the rule grammar in ONE place.
const writeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  trigger_type: z.string().min(1).optional(),
  condition: z.any().nullable().optional(),
  actions: z.array(z.any()).optional(),
  enabled: z.boolean().optional(),
}).strict();

export const automations = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listAutomations(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"));
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toAutomationResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:automation_id", async (c) => {
    const row = await getAutomation(c.get("deps"), c.get("user"), c.req.param("automation_id")!);
    return c.json(toAutomationResource(row));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createAutomation(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(toAutomationResource(row));
  })
  .patch("/:automation_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateAutomation(c.get("deps"), c.get("user"), c.req.param("automation_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(toAutomationResource(row));
  })
  .delete("/:automation_id", async (c) => {
    await deleteAutomation(c.get("deps"), c.get("user"), c.req.param("automation_id")!, c.req.header("If-Match"));
    return c.body(null, 204);
  })
  .post("/:automation_id", async (c) => {
    const { id, verb } = customMethod(c);
    if (verb === "enable" || verb === "disable") {
      const row = await setAutomationEnabled(c.get("deps"), c.get("user"), id, verb === "enable");
      return c.json(toAutomationResource(row));
    }
    if (verb === "test") {
      const body = await c.req.json().catch(() => ({}));
      const res = await testAutomation(c.get("deps"), c.get("user"), id, { employeeId: body.employee_id, payload: body.payload });
      return c.json(res);
    }
    return c.notFound();
  });
