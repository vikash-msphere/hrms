// Predefined ticket checklists: reusable, named lists of item texts copied onto a ticket. A first-class
// collection so each checklist is access-controlled individually (private-by-default; visibility is the
// read grant, managed in the ACL UI). Mirrors reimbursement-categories (a simple flat config collection).
import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { paginate } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete } from "./softDelete";

export type TicketChecklistInput = { display_name?: string; items?: string[] };

const cleanItems = (items?: string[]) => (items ?? []).map((s) => (s ?? "").trim()).filter(Boolean);

export async function listTicketChecklists(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.ticketChecklists), showDeleted);
  // Oldest first: a checklist template is read top-down, in the order its steps were written.
  const { items: slice, nextPageToken } = paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid, "asc");
  return { items: slice, nextPageToken };
}

async function getTicketChecklist(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.ticketChecklists).where(eq(schema.ticketChecklists.uuid, id)).limit(1))[0];
  if (!row) throw notFound("ticket checklist not found");
  return row;
}

export async function createTicketChecklist(deps: Deps, actor: AppUser, input: TicketChecklistInput, id?: string) {
  const name = (input.display_name ?? "").trim();
  if (!name) throw invalidArgument("display_name is required");
  const row = (await deps.db
    .insert(schema.ticketChecklists)
    .values({
      code: await allocFlatCode(deps, schema.ticketChecklists),
      ...(id ? { id } : {}),
      name,
      items: JSON.stringify(cleanItems(input.items)),
    })
    .returning())[0]!;
  await audit(deps, actor, "ticket_checklist.create", "ticket-checklists", row.uuid, undefined, row);
  return row;
}

export async function updateTicketChecklist(deps: Deps, actor: AppUser, id: string, patch: TicketChecklistInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.ticketChecklists).where(eq(schema.ticketChecklists.uuid, id)).limit(1))[0];
  if (!row) throw notFound("ticket checklist not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: SetOf<typeof schema.ticketChecklists> = { updatedAt: new Date() };
  const has = (k: keyof TicketChecklistInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) {
    const name = (patch.display_name ?? "").trim();
    if (!name) throw invalidArgument("display_name cannot be blank");
    set.name = name;
  }
  if (has("items")) set.items = JSON.stringify(cleanItems(patch.items));
  const updated = (await deps.db.update(schema.ticketChecklists).set(set).where(eq(schema.ticketChecklists.uuid, id)).returning())[0]!;
  await audit(deps, actor, "ticket_checklist.update", "ticket-checklists", id, diffMeta(row, updated, set), updated);
  return updated;
}

