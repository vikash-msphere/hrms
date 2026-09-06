import { allocOwnedCode, withFreshCode } from "./codeAlloc";
// WORKFLOW resource (custom methods :start/:resolve/:close/:reopen/:cancel + :assign/:comment). Categories
// and their default assignee are org config (the `ticket-categories` settings blob), not a collection.
import { eq, and, asc, inArray, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { searchFilter } from "./searchFilter";
import { keysetPage } from "./keysetPage";
import { notify, notifyMany } from "./notifications";
import { notifyMentions } from "./mentions";
import { emitEvent } from "./eventBus";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, stateMeta } from "../lib/audit";
import { aborted, invalidArgument, notFound, failedPrecondition } from "../lib/errors";
import { getSettingValue, getDefaultDepartmentId } from "./settings";
import { assertUploadSize, isAllowedUpload } from "./documentsCommon";
import { parseAttachments, safeAttachmentName, MAX_TICKET_ATTACHMENTS, type TicketAttachment } from "../domain/ticketAttachments";
import { DEFAULT_TICKET_WORKFLOW, transitionFor } from "../domain/stateMachines";
import { shareTicketWith, grantTicketRead, revokeTicketRead, usersForEmployees } from "./ticketShares";

// The shape and the starter list live in domain/tickets.ts, so bootstrap can seed the settings row from the
// same constant this falls back to. See the note there on why the two must not drift.
import { DEFAULT_TICKET_CATEGORIES, MAX_TICKET_RECORDINGS, REPLAY_ID_RE, parseRecordings, type TicketCategoriesConfig } from "../domain/tickets";
export type { TicketCategory, TicketCategoriesConfig } from "../domain/tickets";

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
  session_replay_id?: string | null; // Sentry replay of the minute before the ticket, when the requester opted in
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
    deps, schema.tickets, "tickets", and(...(conds.filter(Boolean) as any)), { max: maxPageSize, pageToken },
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
  const cfg = await getSettingValue<TicketCategoriesConfig>(deps, "ticket-categories", DEFAULT_TICKET_CATEGORIES);
  const cat = (cfg.categories ?? []).find((c) => c.key === key);
  if (!cat) return { ok: false, assigneeId: null };
  return { ok: true, assigneeId: cat.assignee ? idFromPath(cat.assignee)! : null };
}

// Everyone who may see EVERY ticket in a category: its assignee + configured members (employee ids).
async function categoryViewers(deps: Deps, key?: string | null): Promise<string[]> {
  if (!key) return [];
  const cfg = await getSettingValue<TicketCategoriesConfig>(deps, "ticket-categories", DEFAULT_TICKET_CATEGORIES);
  const cat = (cfg.categories ?? []).find((c) => c.key === key);
  if (!cat) return [];
  const refs = [cat.assignee, ...(cat.members ?? [])].filter((r): r is string => !!r);
  return [...new Set(refs.map((r) => idFromPath(r)!).filter(Boolean))];
}

// The category's configured default servicing department (uuid), or null.
async function categoryDepartment(deps: Deps, key?: string | null): Promise<string | null> {
  if (!key) return null;
  const cfg = await getSettingValue<TicketCategoriesConfig>(deps, "ticket-categories", DEFAULT_TICKET_CATEGORIES);
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

  // The recording that came with the report, if there was one. Same shape as the ones added later.
  const firstReplay = input.session_replay_id?.trim() || null;
  if (firstReplay && !REPLAY_ID_RE.test(firstReplay)) throw invalidArgument("session_replay_id must be a 32-character hex replay id");

  // Servicing department: explicit override, else the category's configured default, else the org default.
  const departmentId = idFromPath(input.department) ?? (await categoryDepartment(deps, categoryKey)) ?? (await getDefaultDepartmentId(deps));

  // Allocated inside the retry: two tickets raised in the same moment both get filed (codeAlloc.ts).
  const row = (await withFreshCode(async () => deps.db
    .insert(schema.tickets)
    .values({
      code: await allocOwnedCode(deps, schema.tickets, schema.tickets.employeeId, employeeId),
      employeeId,
      category: categoryKey,
      departmentId,
      assigneeId, // stamped from the category's default; reassignable via :assign
      subject,
      description: input.description?.trim() || null,
      priority,
      state: "OPEN",
      sessionReplaysJson: JSON.stringify(firstReplay ? [{ id: firstReplay, created_at: Date.now(), by: employeeId }] : []),
    })
    .returning()))[0]!;
  // Optional checklist seeded at creation (custom items and/or a checklist the dialog expanded to texts).
  const items = (input.initial_todos ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  if (items.length) await deps.db.insert(schema.ticketTodos).values(items.map((text) => ({ ticketId: row.uuid, text })));
  // Visibility: share read with the category's viewers (assignee + members) AND the servicing department's
  // managers. The requester is excluded - they already see their own ticket via the owner scope.
  const viewers = [...new Set([...(await categoryViewers(deps, categoryKey)), ...(await departmentManagers(deps, departmentId))])].filter((e) => e !== employeeId);
  await shareTicketWith(deps, row.code!, viewers);
  await audit(deps, actor, "ticket.create", "tickets", row.uuid, createdMeta(row, "tickets"), row);
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
  await audit(deps, actor, `ticket.${verb}`, "tickets", id, stateMeta(row.state, t.to, { employee: `employees/${row.employeeId}` }), updated);
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
  await audit(deps, actor, "ticket.assign", "tickets", id, { diff: { assignee: { from: prev ? `employees/${prev}` : null, to: assigneeId ? `employees/${assigneeId}` : null } } }, updated);
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
  const row = await getTicket(deps, actor, id); // gate + existence, and the priority this replaces
  const p = (priority ?? "") as TicketPriority;
  if (!PRIORITIES.has(p)) throw invalidArgument("priority must be low, medium or high");
  const [updated] = await deps.db.update(schema.tickets).set({ priority: p, updatedAt: new Date() }).where(eq(schema.tickets.uuid, id)).returning();
  await audit(deps, actor, "ticket.prioritize", "tickets", id, { diff: { priority: { from: row.priority, to: p } } }, updated);
  return updated!;
}

export async function commentTicket(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const t = await getTicket(deps, actor, id); // gate + existence
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("a comment body is required");
  await deps.db.insert(schema.ticketComments).values({ ticketId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  // Touch the ticket so its update_time reflects the latest activity.
  await deps.db.update(schema.tickets).set({ updatedAt: new Date() }).where(eq(schema.tickets.uuid, id));
  await audit(deps, actor, "ticket.comment", "tickets", id, { note: text.length > 140 ? `${text.slice(0, 140)}…` : text }, t);
  // Notify the other party (requester <-> assignee) that there's a new comment on the thread.
  for (const rid of [t.employeeId, t.assigneeId].filter((r): r is string => !!r && r !== actor.employeeId))
    await notify(deps, { recipient: rid, type: "ticket.comment", title: "New comment on a ticket", body: t.subject, link: "tickets", subject: `tickets/${id}`, actorId: actor.employeeId });
  // Anyone else named in the reply: pulling a third person into a thread is most of what @ is for on a
  // support ticket. Notification only - it grants nothing (see services/mentions.ts).
  await notifyMentions(deps, actor, { subject: `tickets/${id}`, link: "tickets", type: "ticket.mention", body: text, title: t.subject });
  return getTicketWithComments(deps, actor, id);
}

// Touch the parent ticket's update_time so checklist activity surfaces it as recently active, mirroring comments.
async function touchTicket(deps: Deps, id: string) {
  await deps.db.update(schema.tickets).set({ updatedAt: new Date() }).where(eq(schema.tickets.uuid, id));
}

// ---- attachments -------------------------------------------------------------------------------------------
// A screenshot is usually the whole bug report, so a ticket takes files. They live in the ticket's JSON column
// with the bytes in R2 (encrypted app-side by the document store, same as every other upload), which means an
// attachment is readable exactly when its ticket is: no second collection, no second access surface, and
// nothing to leave behind when the ticket is purged.

/**
 * Both writers below change ONE JSON column by reading it, editing it in memory and writing it back, so both
 * guard the write with a compare-and-set on the exact value that was read. Two people attaching at the same
 * moment (a screenshot each, on the same ticket) used to leave the loser's entry out of the row while its bytes
 * stayed in R2 - an invisible attachment and an orphaned object. On a lost race the whole step re-runs against
 * the fresh list, so caps and lookups are re-checked rather than carried over from a stale read. Bounded, so a
 * pathological hot row fails loudly instead of spinning.
 */
async function writeAttachments(deps: Deps, id: string, step: (current: TicketAttachment[]) => TicketAttachment[]): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = (await deps.db.select({ attachmentsJson: schema.tickets.attachmentsJson }).from(schema.tickets).where(eq(schema.tickets.uuid, id)).limit(1))[0];
    if (!row) throw notFound("ticket not found");
    const next = step(parseAttachments(row.attachmentsJson));
    const [updated] = await deps.db
      .update(schema.tickets)
      .set({ attachmentsJson: JSON.stringify(next), updatedAt: new Date() })
      .where(and(eq(schema.tickets.uuid, id), row.attachmentsJson === null ? isNull(schema.tickets.attachmentsJson) : eq(schema.tickets.attachmentsJson, row.attachmentsJson)))
      .returning({ uuid: schema.tickets.uuid });
    if (updated) return;
  }
  throw aborted("this ticket's attachments are being changed by somebody else - try again");
}

/** Attach one uploaded file. The R2 key is generated here - a client-supplied key would be a path to anywhere. */
/**
 * Add a session recording to an existing ticket.
 *
 * The recording that arrives with a report is the one the reporter happened to make at the time; support's
 * next question is nearly always "can you show me that again?", and before this there was nowhere for the
 * answer to go. Appends rather than replaces, so a ticket accumulates the attempts in order.
 *
 * Anyone who can WRITE the ticket may add one - the requester demonstrating again, or an agent who reproduced
 * it themselves. The verb's own grant decides that; nothing here re-derives it.
 */
export async function attachRecordingToTicket(deps: Deps, actor: AppUser, id: string, replayId: string) {
  const t = await getTicket(deps, actor, id); // gate + existence
  const clean = (replayId ?? "").trim();
  if (!REPLAY_ID_RE.test(clean)) throw invalidArgument("session_replay_id must be a 32-character hex replay id");

  const existing = parseRecordings(t.sessionReplaysJson);
  // Idempotent: a double-tapped button, or a retry after a dropped response, must not list the same recording
  // twice. Returning the ticket unchanged is the honest answer - it is already attached.
  if (existing.some((r) => r.id === clean)) return t;
  if (existing.length >= MAX_TICKET_RECORDINGS)
    throw invalidArgument(`a ticket can hold ${MAX_TICKET_RECORDINGS} recordings`);

  const next = [...existing, { id: clean, created_at: Date.now(), by: actor.employeeId ?? null }];
  const row = (await deps.db
    .update(schema.tickets)
    .set({ sessionReplaysJson: JSON.stringify(next), updatedAt: new Date() })
    .where(eq(schema.tickets.uuid, id))
    .returning())[0]!;
  await audit(deps, actor, "ticket.attachRecording", "tickets", id, { diff: { recordings: { from: next.length - 1, to: next.length } } }, row);
  return row;
}

export async function attachToTicket(
  deps: Deps,
  actor: AppUser,
  id: string,
  bytes: ArrayBuffer,
  opts: { fileName?: string; contentType?: string } = {},
) {
  const t = await getTicket(deps, actor, id); // gate + existence
  assertUploadSize(bytes.byteLength);
  if (!isAllowedUpload(opts.fileName, opts.contentType))
    throw invalidArgument("unsupported file type; allowed: documents, spreadsheets, presentations, images");
  if (parseAttachments(t.attachmentsJson).length >= MAX_TICKET_ATTACHMENTS)
    throw invalidArgument(`a ticket can hold ${MAX_TICKET_ATTACHMENTS} attachments; remove one first`);
  const key = `tickets/${id}/${crypto.randomUUID()}`;
  const contentType = opts.contentType || "application/octet-stream";
  await deps.docs.put(key, bytes, contentType);
  const entry: TicketAttachment = {
    key,
    name: safeAttachmentName(opts.fileName),
    content_type: contentType,
    size_bytes: bytes.byteLength,
    created_at: new Date().toISOString(),
    ...(actor.employeeId ? { by: actor.employeeId } : {}),
  };
  await writeAttachments(deps, id, (current) => {
    // Re-checked against the CURRENT list, not the one read before the upload: the cap has to hold even when
    // several people attach at once, which is exactly the case the guarded write below exists for.
    if (current.length >= MAX_TICKET_ATTACHMENTS) throw invalidArgument(`a ticket can hold ${MAX_TICKET_ATTACHMENTS} attachments; remove one first`);
    return [...current, entry];
  });
  await audit(deps, actor, "ticket.attach", "tickets", id, { name: entry.name, size_bytes: entry.size_bytes });
  return getTicketWithComments(deps, actor, id);
}

/** Remove one attachment, bytes and all. Gated by the verb, so whoever may attach may also tidy up. */
export async function detachFromTicket(deps: Deps, actor: AppUser, id: string, key?: string | null) {
  const t = await getTicket(deps, actor, id); // gate + existence
  const found = parseAttachments(t.attachmentsJson).find((a) => a.key === key);
  if (!found) throw notFound("attachment not found");
  // Row first, bytes second: the row is what the reader sees, so an object whose row entry is already gone is
  // merely unreferenced, whereas bytes deleted ahead of a write that then loses its guard would leave the
  // ticket listing an attachment nobody can open.
  await writeAttachments(deps, id, (current) => {
    if (!current.some((a) => a.key === found.key)) throw notFound("attachment not found");
    return current.filter((a) => a.key !== found.key);
  });
  await deps.docs.delete(found.key).catch(() => { /* already gone: the row is what the reader sees */ });
  await audit(deps, actor, "ticket.detach", "tickets", id, { name: found.name });
  return getTicketWithComments(deps, actor, id);
}

/** The bytes of one attachment. The key must already be on THIS ticket, so a key alone opens nothing. */
export async function readTicketAttachment(deps: Deps, actor: AppUser, id: string, key?: string | null) {
  const t = await getTicket(deps, actor, id); // gate + existence
  const found = parseAttachments(t.attachmentsJson).find((a) => a.key === key);
  if (!found) throw notFound("attachment not found");
  const bytes = await deps.docs.get(found.key);
  if (!bytes) throw notFound("the attached file is no longer stored");
  await audit(deps, actor, "ticket.attachment", "tickets", id, { name: found.name });
  return { bytes, fileName: found.name, contentType: found.content_type };
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
  await audit(deps, actor, "ticket.addTodos", "tickets", id, { fields: items.slice(0, 12) });
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
  await audit(deps, actor, "ticket.toggleTodo", "tickets", id, { note: item.text, diff: { done: { from: item.done, to: !!done } } });
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
  await audit(deps, actor, "ticket.removeTodo", "tickets", id, { note: item.text });
  return getTicketWithComments(deps, actor, id);
}
