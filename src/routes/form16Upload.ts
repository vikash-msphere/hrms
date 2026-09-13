import { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { makeDocumentService } from "../services/documentService";
import { toPersonalDocumentResource } from "../http/serialize";
import { idFromPath, isPdfUpload, assertUploadSize, requireCappedBody } from "../services/documentsCommon";
import { invalidArgument } from "../lib/errors";
import { queryParam } from "../http/query";

// Collection-level custom method `personal-documents:uploadForm16` - file the OFFICIAL TRACES Form 16 PDF for
// an employee + financial year, marked official=true so the UI prefers it over the HRMS-generated Part-B copy.
// Mounted at the colon path in index.ts before the personal-documents mount. Access resolves to the custom key
// `personal-documents.uploadForm16` (covered by hr_admin's `personal-documents.**` wildcard + super), same gate
// as :generateForm16. The PDF bytes ride in the request body (like :upload); employee + financial_year are
// query params. One call: create the row + store the file.
const svc = makeDocumentService({ table: schema.personalDocuments, collection: "personal-documents", singular: "personal document", owned: true });

// FY label like "2025-26".
function normalizeFy(label?: string): string {
  if (!label || !/^\d{4}-\d{2}$/.test(label.trim())) throw invalidArgument('financial_year must look like "2025-26"');
  return label.trim();
}

export const form16Upload = new Hono<AppEnv>().post("/", async (c) => {
  // THROUGH http/query.ts, because `employee` is a GATED parameter here. It is the declared owner ref for
  // `personal-documents`, so middleware/authz.ts reads it to decide whether this caller may file a document
  // under that person - and the pair that must agree is the gate and the handler (see the header of
  // http/query.ts, and `force` for what a disagreement cost). The rest of the handler's parameters read the
  // same way so no one has to remember which of the four is the one with a decision riding on it.
  const employee = queryParam(c, "employee");
  const employeeId = idFromPath(employee);
  if (!employeeId) throw invalidArgument("employee is required");
  const financialYear = normalizeFy(queryParam(c, "financial_year"));

  const fileName = queryParam(c, "file_name") ?? `Form16-${financialYear}-official.pdf`;
  const contentType = queryParam(c, "content_type") ?? "application/pdf";
  if (!isPdfUpload(fileName, contentType)) throw invalidArgument("Form 16 must be a PDF");

  // An oversized body never reaches here: middleware/bodyLimit.ts refuses it from `Content-Length` before any
  // handler reads, and `requireCappedBody` abandons a chunked one - which declares no length - at the same cap
  // rather than buffering to the end and measuring after the memory is spent. `assertUploadSize` stays as the
  // assertion on the bytes finally held.
  const bytes = await requireCappedBody(c.req.raw);
  if (bytes.byteLength === 0) throw invalidArgument("empty file");
  assertUploadSize(bytes.byteLength);

  const deps = c.get("deps");
  const user = c.get("user");

  const row = await svc.create(deps, user, { employee: employee!, display_name: `Form 16 — FY ${financialYear} (official)`, document_type: "FORM16", content_type: contentType });
  await deps.docs.put(row.r2Key, bytes, contentType);
  const updated = (await deps.db
    .update(schema.personalDocuments)
    .set({ sizeBytes: bytes.byteLength, contentType, fileName, financialYear, official: true, updatedAt: new Date() })
    .where(eq(schema.personalDocuments.uuid, row.uuid))
    .returning())[0]!;
  return c.json(toPersonalDocumentResource(updated));
});
