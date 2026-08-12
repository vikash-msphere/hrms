import { and, eq, isNull } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { crudService, type CrudSpec } from "./crud";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Acknowledgement records are CREATED only via org-documents :acknowledge (see documentService) and are never
// edited - a signature is a point-in-time fact. The spec therefore carries no `insert`/`patch`, which is what
// makes the factory mount no POST and no PATCH for this collection. What is left is reading them
// (scope-limited, optionally filtered to one document for the HR "who signed" view) + admin cleanup.
export async function listDocumentAcknowledgements(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, documentRef?: string, showDeleted = false) {
  const conds = [applyScope(scope, schema.documentAcknowledgements.code, schema.documentAcknowledgements.employeeId)];
  const documentId = idFromPath(documentRef);
  if (documentId) conds.push(eq(schema.documentAcknowledgements.documentId, documentId));
  if (!showDeleted) conds.push(isNull(schema.documentAcknowledgements.deleteTime));
  return keysetPage<typeof schema.documentAcknowledgements.$inferSelect>(deps, schema.documentAcknowledgements, "document-acknowledgements", and(...(conds.filter(Boolean) as any)), { dir: "asc", max: maxPageSize, pageToken });
}

export const documentAcknowledgementSpec: CrudSpec<never> = {
  table: schema.documentAcknowledgements,
  collection: "document-acknowledgements",
  auditName: "document_acknowledgement",
  notFound: "acknowledgement not found",
};

export const {
  get: getDocumentAcknowledgement,
  remove: deleteDocumentAcknowledgement,
  restore: restoreDocumentAcknowledgement,
  purge: purgeDocumentAcknowledgement,
} = crudService(documentAcknowledgementSpec);
