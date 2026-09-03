import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { assembleLetterContext } from "../services/letterData";
import { resolveLetter, type LetterTemplate } from "../domain/letters";
import { documentLetterhead, type OrgWithDocumentLogos } from "../services/letterheads";
import { getSettingValue } from "../services/settings";
import { renderLetterPdf } from "../lib/letterPdf";
import { idFromPath } from "../services/documentsCommon";
import { invalidArgument } from "../lib/errors";

// Collection-level custom method `personal-documents:previewLetter` - render a DRAFT template inline against
// an employee and return the PDF WITHOUT persisting anything (no DB row, no R2 object). Powers the live
// preview in the Settings letter-template editor. Same HR + super gate as generateLetter (the authz
// middleware resolves this to the custom key `personal-documents.previewLetter`). The resolver only honors a
// closed vocabulary of block kinds, so an arbitrary inline template can't do anything unsafe.
const bodySchema = z
  .object({
    employee: z.string(),
    template: z.object({
      id: z.string().optional(),
      label: z.string().optional(),
      filename: z.string().optional(),
      letterhead: z.string().max(80).optional(),
      inputs: z.array(z.any()).max(200).optional(),
      blocks: z.array(z.any()).max(500),
    }),
    input: z.record(z.string(), z.string().max(20_000)).refine((o) => Object.keys(o).length <= 200, "too many input fields").optional(),
    // Per-generation letterhead override, mirroring `:generateLetter` - so the preview shows the logo the
    // generated letter will actually carry. "" = the plain organization logo.
    letterhead: z.string().max(80).optional(),
  })
  .strict();

export const letterPreview = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = bodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("body must be { employee, template }");
  const { employee, template, input, letterhead: letterheadRef } = parsed.data;
  const employeeId = idFromPath(employee);
  if (!employeeId) throw invalidArgument("employee is required");

  const ctx = await assembleLetterContext(c.get("deps"), employeeId);
  const org = await getSettingValue<OrgWithDocumentLogos>(c.get("deps"), "organization", {});
  const letterhead = await documentLetterhead(c.get("deps"), org, "letter", [letterheadRef, template.letterhead]);
  if (letterhead) ctx.letterhead = letterhead;
  const tpl: LetterTemplate = { id: template.id ?? "preview", label: template.label ?? "Preview", filename: template.filename, letterhead: template.letterhead, inputs: template.inputs as LetterTemplate["inputs"], blocks: template.blocks as LetterTemplate["blocks"] };
  const { bytes: pdf } = await renderLetterPdf(resolveLetter(tpl, ctx, input ?? {}).content);
  // pdf-lib returns a Uint8Array; hand c.body a plain ArrayBuffer (matches the download path's bytes type).
  const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
  return c.body(body, 200, { "Content-Type": "application/pdf" });
});
