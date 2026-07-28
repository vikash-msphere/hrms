import { and, eq, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { notFound } from "../lib/errors";
import { softDeleteRow, restoreRow, purgeRow } from "./softDelete";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Acknowledgement records are CREATED only via org-documents :acknowledge (see documentService). Here we just
// read them (scope-limited, optionally filtered to one document for the HR "who signed" view) + admin cleanup.
export async function listDocumentAcknowledgements(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, documentRef?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.documentAcknowledgements.code, schema.documentAcknowledgements.employeeId)];
  const documentId = idFromPath(documentRef);
  if (documentId) conds.push(eq(schema.documentAcknowledgements.documentId, documentId));
  if (!showDeleted) conds.push(isNull(schema.documentAcknowledgements.deleteTime));
  return keysetPage<typeof schema.documentAcknowledgements.$inferSelect>(deps, schema.documentAcknowledgements, "document-acknowledgements", and(...(conds.filter(Boolean) as any)), { dir: "asc", max: maxPageSize, pageToken });
}

export async function getDocumentAcknowledgement(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.uuid, id)).limit(1))[0];
  if (!row) throw notFound("acknowledgement not found");
  return row;
}

export async function deleteDocumentAcknowledgement(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.documentAcknowledgements, "document_acknowledgement", "document-acknowledgements", id, ifMatch);
}

export async function restoreDocumentAcknowledgement(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.documentAcknowledgements, "document_acknowledgement", "document-acknowledgements", id);
}

export async function purgeDocumentAcknowledgement(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.documentAcknowledgements, "document_acknowledgement", "document-acknowledgements", id, ifMatch);
}
