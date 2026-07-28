import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listTicketChecklists, getTicketChecklist, createTicketChecklist,
  updateTicketChecklist, deleteTicketChecklist, purgeTicketChecklist,
} from "../services/ticketChecklists";
import { toTicketChecklistResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";

const COL = "ticket-checklists";
const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  items: z.array(z.string()).optional(),
}).strict();

export const ticketChecklists = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listTicketChecklists(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toTicketChecklistResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:checklist_id", async (c) => {
    const row = await getTicketChecklist(c.get("deps"), c.get("user"), c.req.param("checklist_id")!);
    return c.json(withAccess(toTicketChecklistResource(row), c.get("user"), COL, row.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createTicketChecklist(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toTicketChecklistResource(row), c.get("user"), COL, row.code, c.get("objectGrant")));
  })
  .patch("/:checklist_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateTicketChecklist(c.get("deps"), c.get("user"), c.req.param("checklist_id")!, c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toTicketChecklistResource(row), c.get("user"), COL, row.code, c.get("objectGrant")));
  })
  .delete("/:checklist_id", async (c) => {
    const id = c.req.param("checklist_id")!;
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeTicketChecklist(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteTicketChecklist(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  });
