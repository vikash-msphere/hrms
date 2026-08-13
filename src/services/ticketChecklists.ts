// Predefined ticket checklists: reusable, named lists of item texts copied onto a ticket. A first-class
// collection so each checklist is access-controlled individually (private-by-default; visibility is the
// read grant, managed in the ACL UI). Mirrors reimbursement-categories (a simple flat config collection).
import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete } from "./softDelete";

export type TicketChecklistInput = { display_name?: string; items?: string[] };

const cleanItems = (items?: string[]) => (items ?? []).map((s) => (s ?? "").trim()).filter(Boolean);

export async function listTicketChecklists(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.ticketChecklists), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
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
  const set: Record<string, unknown> = { updatedAt: new Date() };
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

