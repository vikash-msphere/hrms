import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listTicketChecklists, createTicketChecklist, updateTicketChecklist, type TicketChecklistInput } from "../services/ticketChecklists";
import { toTicketChecklistResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  items: z.array(z.string()).optional(),
}).strict();

// Predefined checklists a ticket can be seeded from. Plain CRUD over the shared lane; the list scopes by the
// caller. Its soft delete now comes with the `:restore` the hand-written route never mounted - the table has
// always kept a delete_time, so a deleted checklist was recoverable in the database and not through the API.
export const ticketChecklists = collectionRoutes<TicketChecklistInput>({
  table: schema.ticketChecklists,
  collection: "ticket-checklists",
  auditName: "ticket_checklist",
  notFound: "ticket checklist not found",
  param: "checklist_id",
  writeSchema,
  serialize: toTicketChecklistResource,
  overrides: {
    create: (deps, actor, input, id) => createTicketChecklist(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateTicketChecklist(deps, actor, id, patch, ifMatch),
  },
  list: (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    return listTicketChecklists(c.get("deps"), c.get("user"), maxPageSize, c.req.query("page_token"), c.req.query("show_deleted") === "true");
  },
});
