import { makeDocumentService } from "../services/documentService";
import { makeDocumentRoutes } from "./documentRoutes";
import { toOrgDocumentResource } from "../http/serialize";
import * as schema from "../db/schema";

// Org-wide documents. Flat code, no owner. Access is purely the grants (default: HR/super only).
const cfg = { table: schema.orgDocuments, collection: "org-documents", singular: "org document" };
const svc = makeDocumentService({ ...cfg, owned: false, acknowledgeable: true });
export const orgDocuments = makeDocumentRoutes(cfg, svc, toOrgDocumentResource);
