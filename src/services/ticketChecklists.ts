// Predefined ticket checklists: reusable, named lists of item texts copied onto a ticket. A first-class
// collection so each checklist is access-controlled individually (private-by-default; visibility is the
// read grant, managed in the ACL UI). Mirrors reimbursement-categories (a simple flat config collection).
import { and, eq, type SQL } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { deleteStateFilter } from "./softDelete";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditUpdate, createdMeta, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { keysetPage } from "./keysetPage";
import { etagOf } from "../http/serialize";
import { checkEtag, updateAtVersion } from "./versionGuard";

export type TicketChecklistInput = { display_name?: string; items?: string[] };

const cleanItems = (items?: string[]) => (items ?? []).map((s) => (s ?? "").trim()).filter(Boolean);

export async function listTicketChecklists(deps: Deps, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false, deletedOnly = false) {
  // Oldest first: a checklist template is read top-down, in the order its steps were written. Paged in SQL
  // (services/keysetPage.ts), soft-delete filter included, rather than reading the catalog whole.
  //
  // SCOPED, like the generic list this hook replaces. It took the actor as `_actor` and read the whole
  // catalogue - so the route's own claim that "the list scopes by the caller" was not true of it, and a
  // per-object DENY on one checklist (this collection is private-by-default and managed entirely through the
  // ACL, which is the only way its visibility is set) simply evaporated on the list while still hiding the
  // item. `applyScope` decides nothing; it binds the breadth the middleware already resolved, and the
  // catalogue has no owner column, so a breadth it cannot answer yields no rows rather than all of them.
  const conds = [applyScope(scope, schema.ticketChecklists.code, undefined), deleteStateFilter(schema.ticketChecklists.deleteTime, showDeleted, deletedOnly)];
  const { items: slice, nextPageToken } = await keysetPage<typeof schema.ticketChecklists.$inferSelect>(
    deps,
    schema.ticketChecklists,
    "ticket-checklists",
    and(...(conds.filter(Boolean) as SQL[])),
    { dir: "asc", max: maxPageSize, pageToken },
  );
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
      ...(id ? { uuid: id } : {}), // the primary key; `{ id }` named no column, so the caller's id was dropped
      name,
      items: JSON.stringify(cleanItems(input.items)),
    })
    .returning())[0]!;
  await audit(deps, actor, "ticket_checklist.create", "ticket-checklists", row.uuid, createdMeta(row, "ticket-checklists"), row);
  return row;
}

export async function updateTicketChecklist(deps: Deps, actor: AppUser, id: string, patch: TicketChecklistInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.ticketChecklists).where(eq(schema.ticketChecklists.uuid, id)).limit(1))[0];
  if (!row) throw notFound("ticket checklist not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.ticketChecklists> = { updatedAt: new Date() };
  const has = (k: keyof TicketChecklistInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) {
    const name = (patch.display_name ?? "").trim();
    if (!name) throw invalidArgument("display_name cannot be blank");
    set.name = name;
  }
  if (has("items")) set.items = JSON.stringify(cleanItems(patch.items));
  const updated = await updateAtVersion(deps, schema.ticketChecklists, "ticket checklist", row, set);
  await auditUpdate(deps, actor, "ticket_checklist.update", "ticket-checklists", id, diffMeta(row, updated, set, "ticket-checklists"), updated);
  return updated;
}

