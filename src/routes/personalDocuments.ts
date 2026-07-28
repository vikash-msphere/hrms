import { makeDocumentService } from "../services/documentService";
import { makeDocumentRoutes } from "./documentRoutes";
import { toPersonalDocumentResource } from "../http/serialize";
import * as schema from "../db/schema";

// Personal (employee-owned) documents. Owner-embedded code. Access: owner via personal-documents.me +
// doc-admin. The `employee` owner field on create is gated by the middleware owner-ref (P1.5).
const cfg = { table: schema.personalDocuments, collection: "personal-documents", singular: "personal document" };
const svc = makeDocumentService({ ...cfg, owned: true });
export const personalDocuments = makeDocumentRoutes(cfg, svc, toPersonalDocumentResource);
