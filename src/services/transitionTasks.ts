import { eq, and } from "drizzle-orm";
import { applyScope } from "./listScope";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, stateMeta } from "../lib/audit";
import { notFound, failedPrecondition } from "../lib/errors";
import { paginate } from "../http/pagination";
import { makeDocumentService } from "./documentService";
import { VALID_DOC_TYPES, type DocType } from "./documentsCommon";

// Personal-document service instance, reused to file a new hire's uploaded document under the subject.
const personalDocs = makeDocumentService({ table: schema.personalDocuments, collection: "personal-documents", singular: "personal document", owned: true });

export async function listTransitionTasks(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, statusFilter?: string, transition?: string) {
  const conds = [applyScope(scope, schema.transitionTasks.code, schema.transitionTasks.assigneeId)];
  if (statusFilter) conds.push(eq(schema.transitionTasks.status, statusFilter as typeof schema.transitionTasks.$inferSelect.status));
  const transitionId = transition ? transition.split("/").pop()! : undefined;
  if (transitionId) conds.push(eq(schema.transitionTasks.transitionId, transitionId));
  const all = await deps.db.select().from(schema.transitionTasks).where(conds.filter(Boolean).length ? and(...conds.filter(Boolean)) : undefined);
  // Paged on `createdAt` (the cursor's key) and, unlike the streams, OLDEST first: a joiner's checklist is read
  // forwards, and its first tasks are the ones due first. Due date orders the page, not the paging - sorting the
  // whole set by `dueDate` while seeking on `createdAt` is what let a task slip between two pages.
  const page = paginate(all, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.uuid, "asc");
  return {
    ...page,
    items: page.items.sort((a, b) => +new Date(a.dueDate ?? a.createdAt) - +new Date(b.dueDate ?? b.createdAt) || a.uuid.localeCompare(b.uuid)),
  };
}

export async function getTransitionTask(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.transitionTasks).where(eq(schema.transitionTasks.uuid, id)).limit(1))[0];
  if (!row) throw notFound("task not found");
  return row;
}

export async function completeTransitionTask(deps: Deps, actor: AppUser, id: string, note?: string | null) {
  const row = (await deps.db.select().from(schema.transitionTasks).where(eq(schema.transitionTasks.uuid, id)).limit(1))[0];
  if (!row) throw notFound("task not found");
  const set: SetOf<typeof schema.transitionTasks> = { status: "DONE", completedAt: new Date(), updatedAt: new Date() };
  if (note !== undefined) set.note = note?.trim() || null;
  const updated = (await deps.db.update(schema.transitionTasks).set(set).where(eq(schema.transitionTasks.uuid, id)).returning())[0]!;
  await audit(deps, actor, "transition-task.complete", "transition-tasks", id, stateMeta(row.status, "DONE", { employee: `employees/`, ...(note?.trim() ? { note: note.trim() } : {}) }), updated);
  return updated;
}

export async function reopenTransitionTask(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.transitionTasks).where(eq(schema.transitionTasks.uuid, id)).limit(1))[0];
  if (!row) throw notFound("task not found");
  if (row.status !== "DONE") throw failedPrecondition("the task is not done");
  const updated = (await deps.db.update(schema.transitionTasks).set({ status: "TODO", completedAt: null, updatedAt: new Date() }).where(eq(schema.transitionTasks.uuid, id)).returning())[0]!;
  await audit(deps, actor, "transition-task.reopen", "transition-tasks", id, stateMeta(row.status, "TODO", { employee: `employees/` }), updated);
  return updated;
}

// Typed file-upload task: the assignee (the new hire) uploads a file, which is filed as a personal-document of
// the task's docType for the SUBJECT, linked back to the task, and the upload marks the task DONE. Re-uploading
// replaces the same document. Reuses the personal-document service so the file goes through the normal R2 +
// validation path; the personal-doc is owned by the subject (= the assignee for these tasks).
export async function uploadTransitionTaskDocument(deps: Deps, actor: AppUser, id: string, bytes: ArrayBuffer, opts: { fileName?: string; contentType?: string } = {}) {
  const row = (await deps.db.select().from(schema.transitionTasks).where(eq(schema.transitionTasks.uuid, id)).limit(1))[0];
  if (!row) throw notFound("task not found");
  if (!row.docType) throw failedPrecondition("this task does not collect a document");
  const documentType = (VALID_DOC_TYPES as readonly string[]).includes(row.docType) ? (row.docType as DocType) : "OTHER";
  // Replace the file on an existing linked doc, or create one (filed under the subject) on first upload.
  let docId: string;
  if (row.documentId) docId = row.documentId;
  else docId = (await personalDocs.create(deps, actor, { employee: `employees/${row.subjectId}`, document_type: documentType, display_name: row.title })).uuid;
  await personalDocs.upload(deps, actor, docId, bytes, opts);
  const updated = (await deps.db.update(schema.transitionTasks).set({ documentId: docId, status: "DONE", completedAt: new Date(), updatedAt: new Date() }).where(eq(schema.transitionTasks.uuid, id)).returning())[0]!;
  await audit(deps, actor, "transition-task.upload", "transition-tasks", id, { document: docId });
  return updated;
}
