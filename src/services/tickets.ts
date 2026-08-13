import { allocOwnedCode } from "./codeAlloc";
// WORKFLOW resource (custom methods :start/:resolve/:close/:reopen/:cancel + :assign/:comment). Categories
// and their default assignee are org config (the `ticket-categories` settings blob), not a collection.
import { eq, and, asc, inArray, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import { keysetPage } from "./keysetPage";
import { notify, notifyMany } from "./notifications";
import { emitEvent } from "./eventBus";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { getSettingValue, getDefaultDepartmentId } from "./settings";
import { DEFAULT_TICKET_WORKFLOW, transitionFor } from "../domain/stateMachines";
import { shareTicketWith, grantTicketRead, revokeTicketRead, usersForEmployees } from "./ticketShares";

// `members` are extra employees (beyond the assignee) who can see EVERY ticket in this category - the basis
// of category-based visibility. Stored as "employees/<id>" refs alongside the assignee. `department` is the
// category's default servicing department ("departments/<id>"), stamped onto new tickets and re-routable.
export type TicketCategory = { key: string; name: string; assignee?: string | null; members?: string[]; department?: string | null };
export type TicketCategoriesConfig = { categories: TicketCategory[] };
// Sensible starter categories so tickets work out of the box (HR sets assignees/members in Settings). Keys are
// stable lowercase ids referenced by the UI dropdown and by automations (e.g. the new-hire provisioning rule).
const DEFAULT_CATEGORIES: TicketCategoriesConfig = {
  categories: [
    { key: "it", name: "IT & Systems" },
    { key: "facilities", name: "Facilities" },
    { key: "hr", name: "HR" },
    { key: "payroll", name: "Payroll" },
    { key: "general", name: "General" },
  ],
};


type TicketState = typeof schema.tickets.$inferSelect.state;
type TicketPriority = typeof schema.tickets.$inferSelect.priority;

export type TicketInput = {
  employee?: string | null; // on-behalf requester (owner); defaults to the caller. Middleware gates cross-owner.
  category?: string | null;
  department?: string | null; // servicing dept; defaults to the category's configured department when omitted
  subject?: string;
  description?: string | null;
  priority?: string | null;
  initial_todos?: string[]; // optional checklist to seed at creation (the dialog expands any chosen checklist to texts)
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const PRIORITIES = new Set(["low", "medium", "high"]);

export async function listTickets(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, stateFilter?: string, assigneeFilter?: string, actor?: AppUser, departmentFilter?: string, q?: string) {
  // Visibility decided by the middleware (scopeFor over the grant); here we only bind it to columns. The
  // owner (for "own") is the requester, exactly like leave-requests.
  const conds = [applyScope(scope, schema.tickets.code, schema.tickets.employeeId)];
  // Server-side text filter (FTS). Narrows the scope above; it can never widen it.
  const textMatch = await searchFilter(deps, "tickets", q, schema.tickets.uuid);
  if (textMatch) conds.push(textMatch);
  if (stateFilter) conds.push(eq(schema.tickets.state, stateFilter as TicketState));
  if (departmentFilter) {
    const deptId = idFromPath(departmentFilter);
    conds.push(deptId ? eq(schema.tickets.departmentId, deptId) : (undefined as never));
  }
  if (assigneeFilter) {
    // "?assignee=me" or an employees/<id> ref -> the assignee's queue (still bounded by the scope above).
    const assigneeId = assigneeFilter === "me" ? actor?.employeeId : idFromPath(assigneeFilter);
    conds.push(assigneeId ? eq(schema.tickets.assigneeId, assigneeId) : (undefined as never));
  }
  conds.push(isNull(schema.tickets.deleteTime));
  const { items: slice, nextPageToken } = await keysetPage<typeof schema.tickets.$inferSelect>(
    deps, schema.tickets, "tickets", and(...(conds.filter(Boolean) as any)), { dir: "asc", max: maxPageSize, pageToken },
  );
  // Attach a compact checklist progress (done/total) per row so the list table can show it without loading the
  // full items. One grouped read over just this page's tickets keeps it cheap.
  const ids = slice.map((r) => r.uuid);
  if (ids.length) {
    const todoRows = await deps.db.select({ ticketId: schema.ticketTodos.ticketId, done: schema.ticketTodos.done }).from(schema.ticketTodos).where(inArray(schema.ticketTodos.ticketId, ids));
    const agg = new Map<string, { total: number; done: number }>();
    for (const r of todoRows) {
      const a = agg.get(r.ticketId) ?? { total: 0, done: 0 };
      a.total++;
      if (r.done) a.done++;
      agg.set(r.ticketId, a);
    }
    for (const row of slice) {
      const a = agg.get(row.uuid);
      (row as typeof row & { todoTotal: number; todoDone: number }).todoTotal = a?.total ?? 0;
      (row as typeof row & { todoTotal: number; todoDone: number }).todoDone = a?.done ?? 0;
    }
  }
  return { items: slice, nextPageToken };
}

async function getTicket(deps: Deps, _actor: AppUser, id: string) {
  // Read access (own / dept / all) is enforced by the middleware on tickets/<code>.
  const row = (await deps.db.select().from(schema.tickets).where(eq(schema.tickets.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("ticket not found");
  return row;
}

/** A ticket plus its threaded comments and checklist (both oldest-first), for the Get route. */
export async function getTicketWithComments(deps: Deps, actor: AppUser, id: string) {
  const row = await getTicket(deps, actor, id);
  const comments = await deps.db.select().from(schema.ticketComments).where(eq(schema.ticketComments.ticketId, id)).orderBy(asc(schema.ticketComments.createdAt));
  const todos = await deps.db.select().from(schema.ticketTodos).where(eq(schema.ticketTodos.ticketId, id)).orderBy(asc(schema.ticketTodos.createdAt));
  return { ...row, comments, todos };
}

// Resolve a category key against the settings blob; returns its configured default assignee's employee id.
async function categoryAssignee(deps: Deps, key: string): Promise<{ ok: boolean; assigneeId: string | null }> {
  const cfg = await getSettingValue<TicketCategoriesConfig>(deps, "ticket-categories", DEFAULT_CATEGORIES);
  const cat = (cfg.categories ?? []).find((c) => c.key === key);
  if (!cat) return { ok: false, assigneeId: null };
  return { ok: true, assigneeId: cat.assignee ? idFromPath(cat.assignee)! : null };
}

// Everyone who may see EVERY ticket in a category: its assignee + configured members (employee ids).
async function categoryViewers(deps: Deps, key?: string | null): Promise<string[]> {
  if (!key) return [];
  const cfg = await getSettingValue<TicketCategoriesConfig>(deps, "ticket-categories", DEFAULT_CATEGORIES);
  const cat = (cfg.categories ?? []).find((c) => c.key === key);
  if (!cat) return [];
  const refs = [cat.assignee, ...(cat.members ?? [])].filter((r): r is string => !!r);
  return [...new Set(refs.map((r) => idFromPath(r)!).filter(Boolean))];
}

// The category's configured default servicing department (uuid), or null.
async function categoryDepartment(deps: Deps, key?: string | null): Promise<string | null> {
  if (!key) return null;
  const cfg = await getSettingValue<TicketCategoriesConfig>(deps, "ticket-categories", DEFAULT_CATEGORIES);
  const cat = (cfg.categories ?? []).find((c) => c.key === key);
  return cat?.department ? idFromPath(cat.department)! : null;
}

// The employees who manage a department (its `managerIds` JSON array). These get a per-ticket read share when
// the ticket is serviced by that department, so a dept lead sees their team's queue without a broad grant.
async function departmentManagers(deps: Deps, deptId?: string | null): Promise<string[]> {
  if (!deptId) return [];
  const d = (await deps.db.select({ managerIds: schema.departments.managerIds }).from(schema.departments).where(eq(schema.departments.uuid, deptId)).limit(1))[0];
  if (!d?.managerIds) return [];
  try {
    const ids = JSON.parse(d.managerIds) as string[];
    return [...new Set(ids.filter(Boolean))];
  } catch { return []; }
}

export async function createTicket(deps: Deps, actor: AppUser, input: TicketInput) {
  const subject = (input.subject ?? "").trim();
  if (!subject) throw invalidArgument("subject is required");
  // Requester = the caller by default (self-service). A privileged caller may raise a ticket ON BEHALF OF
  // another employee via `employee` (the ticket is owned by THEM, so they see it): the middleware's owner-ref
  // check (OWNER_REFS.tickets) has already confirmed the caller may create under that owner. This is what lets
  // a system automation (no employee record itself) open a provisioning ticket for a new hire.
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("a requester employee is required");
  const priority = (input.priority ?? "medium") as TicketPriority;
  if (!PRIORITIES.has(priority)) throw invalidArgument("priority must be low, medium or high");

  // Category drives auto-assignment. A category key is required and must exist in the org config.
  const categoryKey = (input.category ?? "").trim();
  if (!categoryKey) throw invalidArgument("category is required");
  const { ok, assigneeId } = await categoryAssignee(deps, categoryKey);
  if (!ok) throw invalidArgument("that ticket category is unavailable");

  // Servicing department: explicit override, else the category's configured default, else the org default.
  const departmentId = idFromPath(input.department) ?? (await categoryDepartment(deps, categoryKey)) ?? (await getDefaultDepartmentId(deps));

  const row = (await deps.db
    .insert(schema.tickets)
    .values({
      code: await allocOwnedCode(deps, schema.tickets, schema.tickets.employeeId, employeeId),
      employeeId,
      category: categoryKey,
      departmentId,
      assigneeId, // stamped from the category's default; reassignable via :assign
      subject,
      description: input.description ?? null,
      priority,
      state: "OPEN",
    })
    .returning())[0]!;
  // Optional checklist seeded at creation (custom items and/or a checklist the dialog expanded to texts).
  const items = (input.initial_todos ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  if (items.length) await deps.db.insert(schema.ticketTodos).values(items.map((text) => ({ ticketId: row.uuid, text })));
  // Visibility: share read with the category's viewers (assignee + members) AND the servicing department's
  // managers. The requester is excluded - they already see their own ticket via the owner scope.
  const viewers = [...new Set([...(await categoryViewers(deps, categoryKey)), ...(await departmentManagers(deps, departmentId))])].filter((e) => e !== employeeId);
  await shareTicketWith(deps, row.code!, viewers);
  await audit(deps, actor, "ticket.create", "tickets", row.uuid, undefined, row);
  await emitEvent(deps, actor, "ticket.created", { subject: `tickets/${row.uuid}`, employeeId, payload: { category: categoryKey, priority } });
  // Nudge whoever services this ticket (its assignee + category members + the servicing department's managers -
  // the same set just granted visibility) so a new request doesn't sit unseen. The requester is already excluded.
  await notifyMany(deps, viewers, {
    type: "ticket.created",
    title: "New support ticket",
    body: subject,
    link: "tickets",
    subject: `tickets/${row.uuid}`,
    actorId: actor.employeeId,
  });
  return row;
}

// The ticket lifecycle is DATA (settings key "ticket-workflow", default DEFAULT_TICKET_WORKFLOW): a declarative
// state machine (verb -> from-states -> to-state) an admin can reconfigure, instead of an inline transition map.
// Who may run each verb is still gated by the verb's grant (middleware); here only the instance state matters.
export async function transitionTicket(deps: Deps, actor: AppUser, id: string, verb: string) {
  const row = await getTicket(deps, actor, id);
  const sm = await getSettingValue(deps, "ticket-workflow", DEFAULT_TICKET_WORKFLOW);
  const t = transitionFor(sm, verb, row.state);
  if (!t) throw failedPrecondition(`a ${row.state.toLowerCase()} ticket cannot be ${verb}ed`);
  // Guard the flip on the read state so the transition is EXACTLY-ONCE (0 rows = a concurrent call moved it):
  // no double resolve/close/reopen notification to the requester.
  const [updated] = await deps.db.update(schema.tickets).set({ state: t.to as TicketState, updatedAt: new Date() }).where(and(eq(schema.tickets.uuid, id), eq(schema.tickets.state, row.state))).returning();
  if (!updated) throw failedPrecondition(`a ${row.state.toLowerCase()} ticket cannot be ${verb}ed`);
  await audit(deps, actor, `ticket.${verb}`, "tickets", id);
  // Tell the requester when their ticket is resolved/closed/reopened.
  if (verb === "resolve" || verb === "close" || verb === "reopen") {
    await notify(deps, { recipient: row.employeeId, type: `ticket.${verb}`, title: `Ticket ${t.to.toLowerCase().replace("_", " ")}`, body: row.subject, link: "tickets", actorId: actor.employeeId });
  }
  if (verb === "resolve") await emitEvent(deps, actor, "ticket.resolved", { subject: `tickets/${id}`, employeeId: row.employeeId, payload: { category: row.category } });
  return updated!;
}

export async function assignTicket(deps: Deps, actor: AppUser, id: string, assigneeRef?: string | null) {
  const row = await getTicket(deps, actor, id);
  if (row.state === "CLOSED" || row.state === "CANCELLED") throw failedPrecondition("a closed or cancelled ticket cannot be reassigned");
  const assigneeId = assigneeRef ? idFromPath(assigneeRef)! : null;
  if (assigneeId) {
    const emp = (await deps.db.select({ uuid: schema.employees.uuid }).from(schema.employees).where(eq(schema.employees.uuid, assigneeId)).limit(1))[0];
    if (!emp) throw invalidArgument("that assignee is not a known employee");
  }
  const [updated] = await deps.db.update(schema.tickets).set({ assigneeId, updatedAt: new Date() }).where(eq(schema.tickets.uuid, id)).returning();
  // Keep the assignee able to see the ticket: share read with the new assignee, and drop the previous one's
  // share unless they remain a category viewer (or the requester, who reads via the owner scope anyway).
  const prev = row.assigneeId;
  if (assigneeId && assigneeId !== prev) {
    for (const u of await usersForEmployees(deps, [assigneeId])) await grantTicketRead(deps, row.code!, u);
    await notify(deps, { recipient: assigneeId, type: "ticket.assigned", title: "Ticket assigned to you", body: row.subject, link: "tickets", action: "respond", actorId: actor.employeeId });
  }
  if (prev && prev !== assigneeId) {
    const viewers = await categoryViewers(deps, row.category);
    if (prev !== row.employeeId && !viewers.includes(prev)) {
      for (const u of await usersForEmployees(deps, [prev])) await revokeTicketRead(deps, row.code!, u);
    }
  }
  await audit(deps, actor, "ticket.assign", "tickets", id);
  return updated!;
}

// Re-route a ticket to a different servicing department. Maintains the dept-manager read shares like :assign:
// the new dept's managers gain read; the old dept's managers lose it unless they remain a category viewer,
// the assignee, or the requester (who all read the ticket by other means).
export async function routeTicket(deps: Deps, actor: AppUser, id: string, departmentRef?: string | null) {
  const row = await getTicket(deps, actor, id);
  const departmentId = departmentRef ? idFromPath(departmentRef)! : null;
  if (departmentId) {
    const dept = (await deps.db.select({ uuid: schema.departments.uuid }).from(schema.departments).where(eq(schema.departments.uuid, departmentId)).limit(1))[0];
    if (!dept) throw invalidArgument("that department is not known");
  }
  const prev = row.departmentId;
  if (departmentId === prev) return row; // no-op
  const [updated] = await deps.db.update(schema.tickets).set({ departmentId, updatedAt: new Date() }).where(eq(schema.tickets.uuid, id)).returning();
  const newMgrs = await departmentManagers(deps, departmentId);
  for (const u of await usersForEmployees(deps, newMgrs.filter((e) => e !== row.employeeId))) await grantTicketRead(deps, row.code!, u);
  // Drop the previous dept's managers, keeping anyone still entitled by another path.
  const keep = new Set([row.employeeId, row.assigneeId, ...(await categoryViewers(deps, row.category)), ...newMgrs].filter(Boolean) as string[]);
  const drop = (await departmentManagers(deps, prev)).filter((e) => !keep.has(e));
  for (const u of await usersForEmployees(deps, drop)) await revokeTicketRead(deps, row.code!, u);
  await audit(deps, actor, "ticket.route", "tickets", id, prev !== departmentId ? { from: prev ? `departments/${prev}` : null, to: departmentId ? `departments/${departmentId}` : null } : undefined);
  return updated!;
}

export async function setTicketPriority(deps: Deps, actor: AppUser, id: string, priority?: string | null) {
  await getTicket(deps, actor, id); // gate + existence
  const p = (priority ?? "") as TicketPriority;
  if (!PRIORITIES.has(p)) throw invalidArgument("priority must be low, medium or high");
  const [updated] = await deps.db.update(schema.tickets).set({ priority: p, updatedAt: new Date() }).where(eq(schema.tickets.uuid, id)).returning();
  await audit(deps, actor, "ticket.prioritize", "tickets", id);
  return updated!;
}

export async function commentTicket(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const t = await getTicket(deps, actor, id); // gate + existence
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("a comment body is required");
  await deps.db.insert(schema.ticketComments).values({ ticketId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  // Touch the ticket so its update_time reflects the latest activity.
  await deps.db.update(schema.tickets).set({ updatedAt: new Date() }).where(eq(schema.tickets.uuid, id));
  await audit(deps, actor, "ticket.comment", "tickets", id);
  // Notify the other party (requester <-> assignee) that there's a new comment on the thread.
  for (const rid of [t.employeeId, t.assigneeId].filter((r): r is string => !!r && r !== actor.employeeId))
    await notify(deps, { recipient: rid, type: "ticket.comment", title: "New comment on a ticket", body: t.subject, link: "tickets", subject: `tickets/${id}`, actorId: actor.employeeId });
  return getTicketWithComments(deps, actor, id);
}

// Touch the parent ticket's update_time so checklist activity surfaces it as recently active, mirroring comments.
async function touchTicket(deps: Deps, id: string) {
  await deps.db.update(schema.tickets).set({ updatedAt: new Date() }).where(eq(schema.tickets.uuid, id));
}

// Add one or more checklist items. The web sends a single item from the input box, or a whole predefined
// checklist's item texts when one is applied - the texts are snapshotted onto the ticket either way. Applying
// a predefined checklist is gated upstream: the picker only lists ticket-checklists the caller can read, so
// no template lookup (and no separate access check) happens here.
export async function addTodos(deps: Deps, actor: AppUser, id: string, texts?: string[]) {
  await getTicket(deps, actor, id); // gate + existence
  const items = (texts ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  if (!items.length) throw invalidArgument("a checklist item is required");
  await deps.db.insert(schema.ticketTodos).values(items.map((text) => ({ ticketId: id, text })));
  await touchTicket(deps, id);
  await audit(deps, actor, "ticket.addTodos", "tickets", id);
  return getTicketWithComments(deps, actor, id);
}

export async function toggleTodo(deps: Deps, actor: AppUser, id: string, todoId?: string | null, done?: boolean) {
  await getTicket(deps, actor, id); // gate + existence
  const tid = idFromPath(todoId);
  if (!tid) throw invalidArgument("a checklist item id is required");
  const item = (await deps.db.select().from(schema.ticketTodos).where(and(eq(schema.ticketTodos.uuid, tid), eq(schema.ticketTodos.ticketId, id))).limit(1))[0];
  if (!item) throw notFound("checklist item not found");
  await deps.db.update(schema.ticketTodos).set({ done: !!done, updatedAt: new Date() }).where(eq(schema.ticketTodos.uuid, tid));
  await touchTicket(deps, id);
  await audit(deps, actor, "ticket.toggleTodo", "tickets", id);
  return getTicketWithComments(deps, actor, id);
}

export async function removeTodo(deps: Deps, actor: AppUser, id: string, todoId?: string | null) {
  await getTicket(deps, actor, id); // gate + existence
  const tid = idFromPath(todoId);
  if (!tid) throw invalidArgument("a checklist item id is required");
  const item = (await deps.db.select().from(schema.ticketTodos).where(and(eq(schema.ticketTodos.uuid, tid), eq(schema.ticketTodos.ticketId, id))).limit(1))[0];
  if (!item) throw notFound("checklist item not found");
  await deps.db.delete(schema.ticketTodos).where(eq(schema.ticketTodos.uuid, tid));
  await touchTicket(deps, id);
  await audit(deps, actor, "ticket.removeTodo", "tickets", id);
  return getTicketWithComments(deps, actor, id);
}
