import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listTicketChecklists, createTicketChecklist, updateTicketChecklist, type TicketChecklistInput } from "../services/ticketChecklists";
import { toTicketChecklistResource } from "../http/serialize";
import { MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_ITEM_LEN } from "../domain/tickets";

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  // The same cap the ticket and card `initial_todos` carry: a catalogue entry longer than the add limit is a
  // checklist that cannot be applied.
  items: z.array(z.string().max(MAX_CHECKLIST_ITEM_LEN)).max(MAX_CHECKLIST_ITEMS).optional(),
}).strict();

// Predefined checklists a ticket can be seeded from. Plain CRUD over the shared lane; the list scopes by the
// caller. Its soft delete now comes with the `:restore` the hand-written route never mounted - the table has
// always kept a delete_time, so a deleted checklist was recoverable in the database and not through the API.
export const ticketChecklists = collectionRoutes<TicketChecklistInput, typeof schema.ticketChecklists>({
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
  list: (c, page) => listTicketChecklists(c.get("deps"), c.get("user"), page.maxPageSize, page.pageToken, page.showDeleted),
});
