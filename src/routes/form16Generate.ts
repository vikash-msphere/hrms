import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { makeDocumentService } from "../services/documentService";
import { jsonBody } from "../http/jsonRequest";
import { toPersonalDocumentResource } from "../http/serialize";
import { assembleForm16 } from "../services/form16";
import { freezeLetterContent } from "../services/letterPrint";
import { idFromPath } from "../services/documentsCommon";
import { invalidArgument } from "../lib/errors";

// Collection-level custom method `personal-documents:generateForm16` - render an employee's annual Form 16
// (Part B) for a financial year from finalized payroll + tax math, and file it as their personal document.
// Mounted at the colon path in index.ts before the personal-documents mount. Access resolves to the custom key
// `personal-documents.generateForm16` (hr_admin / super only - the same gate as :generateLetter).
const svc = makeDocumentService({ table: schema.personalDocuments, collection: "personal-documents", singular: "personal document", owned: true });

const bodySchema = z.object({ employee: z.string(), financial_year: z.string().optional() }).strict();

export const form16Generate = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = bodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("body must be { employee, financial_year? }");
  const employeeId = idFromPath(parsed.data.employee);
  if (!employeeId) throw invalidArgument("employee is required");

  const deps = c.get("deps");
  const user = c.get("user");
  const { pdf, content, title, fileName, financialYear } = await assembleForm16(deps, employeeId, parsed.data.financial_year);

  const row = await svc.create(deps, user, { employee: parsed.data.employee, display_name: title, document_type: "FORM16", content_type: "application/pdf" });
  await deps.docs.put(row.r2Key, pdf, "application/pdf");
  // Filed like a letter, so it freezes like one: a Form 16 can be asked for on the letterhead's print page
  // later (:print), which re-renders THIS content rather than laying the figures out a second time.
  await freezeLetterContent(deps, row.r2Key, content);
  // Tag as the HRMS-generated Form 16 for this FY (official=false). The official TRACES copy, if uploaded
  // later via :uploadForm16, takes precedence in the UI.
  const updated = (await deps.db
    .update(schema.personalDocuments)
    .set({
      sizeBytes: pdf.byteLength, contentType: "application/pdf", fileName, financialYear, official: false,
      letterheadId: idFromPath(content.letterheadRef ?? "") ?? null, // for "is there a print version of this?"
      updatedAt: new Date(),
    })
    .where(eq(schema.personalDocuments.uuid, row.uuid))
    .returning())[0]!;
  return c.json(toPersonalDocumentResource(updated));
});
