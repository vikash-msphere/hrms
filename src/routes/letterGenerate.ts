import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { makeDocumentService } from "../services/documentService";
import { jsonBody } from "../http/jsonRequest";
import { toPersonalDocumentResource } from "../http/serialize";
import { assembleLetterContext } from "../services/letterData";
import { findLetterTemplate } from "../services/letterTemplates";
import { letterheadDataUrl } from "../services/letterheadLogos";
import { resolveLetter } from "../domain/letters";
import { renderLetterPdf } from "../lib/letterPdf";
import { idFromPath } from "../services/documentsCommon";
import { canReadObjectId } from "../lib/objectAccess";
import { invalidArgument, forbidden, failedPrecondition } from "../lib/errors";
import { getSettingValue } from "../services/settings";
import { readIdentityValues } from "../services/identityDetails";
import { getProvider } from "../services/esign";
import { notify } from "../services/notifications";
import { DEFAULT_ESIGN, DEFAULT_ESIGN_METHOD, esignFor, type EsignConfig } from "../domain/esign";

// Collection-level custom method `personal-documents:generateLetter` - render an HR letter from a template
// (defined in the `letter-templates` setting) filled with the employee record + compensation + org letter-
// defaults, and store it as the employee's personal document. Mounted at the full colon path in index.ts
// (before the personal-documents mount). Access: the authz middleware resolves this to the custom key
// `personal-documents.generateLetter`, which only hr_admin (broad `personal-documents.**` allow) and
// super_admin (`**`) match - payroll/employees hold only `personal-documents.me.*`, so they can't generate.
const svc = makeDocumentService({ table: schema.personalDocuments, collection: "personal-documents", singular: "personal document", owned: true });

// `letterhead` overrides the template's own letterhead for THIS generation (a `letterhead-logos/<id>` ref,
// decoded at the edge); "" means the plain organization logo. Omitted = whatever the template says.
const bodySchema = z.object({ employee: z.string(), letter_type: z.string(), input: z.record(z.string(), z.string().max(20_000)).refine((o) => Object.keys(o).length <= 200, "too many input fields").optional(), letterhead: z.string().max(80).optional(), esign: z.boolean().optional() }).strict();

export const letterGenerate = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = bodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("body must be { employee, letter_type }");
  const { employee, letter_type, input, letterhead: letterheadRef, esign: esignOverride } = parsed.data;
  const employeeId = idFromPath(employee);
  if (!employeeId) throw invalidArgument("employee is required");

  const deps = c.get("deps");
  const user = c.get("user");
  const template = await findLetterTemplate(deps, letter_type);
  if (!template) throw invalidArgument(`unknown letter_type "${letter_type}"`);
  // Per-template access gate (the real engine): the caller must be able to READ this letter-template object.
  if (!(await canReadObjectId(deps, user, "letter-templates", template.id))) throw forbidden("that letter type isn't available to you");

  const ctx = await assembleLetterContext(deps, employeeId);
  // Letterhead: the request's choice wins over the template's, and either falls back to the organization logo
  // when the id is blank, unknown or its image has gone. The resolved data URL is baked into `content`, so the
  // frozen sidecar an internal e-sign re-renders from keeps the very logo the recipient saw.
  const letterhead = await letterheadDataUrl(deps, letterheadRef !== undefined ? letterheadRef : template.letterhead);
  if (letterhead) ctx.org.logo = letterhead;
  const { content, title, fileName } = resolveLetter(template, ctx, input ?? {});
  const { bytes: pdf, signAnchors } = await renderLetterPdf(content);

  // Vendor-agnostic e-sign decision (see src/domain/esign.ts). The e-signature block on the template is the
  // switch AND carries the METHOD ("internal" in-app image, default, or "cashfree" Aadhaar) - it is no longer
  // a global setting. `cfg.enabled` is the master switch; a single generation can force signing on/off via the
  // `esign` request flag.
  const cfg = await getSettingValue<EsignConfig>(deps, "esign", DEFAULT_ESIGN);
  const esigBlock = content.blocks.find((b): b is Extract<typeof b, { kind: "esignature" }> => b.kind === "esignature");
  const wantEsign = esignFor(cfg, !!esigBlock, esignOverride);
  const providerId = wantEsign ? (esigBlock?.method ?? DEFAULT_ESIGN_METHOD) : "none";
  const external = wantEsign && providerId !== "internal";

  // For an external Aadhaar vendor, resolve the signer up front and fail BEFORE creating any row if a
  // required Aadhaar is missing (mirrors letterSign's signature-image precondition). The fallible vendor
  // `createRequest` itself is deferred until after the row exists so its `reference` can point at the real
  // document uuid; a vendor failure there is unwound by deleting the freshly-created row + R2 object, so no
  // orphan LETTER document is left behind.
  let provider: ReturnType<typeof getProvider>;
  let signer: { name: string; aadhaar?: string; email?: string } | null = null;
  if (external) {
    provider = getProvider(providerId);
    if (!provider) throw invalidArgument(`unknown e-sign provider "${providerId}"`);
    const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
    if (!emp) throw invalidArgument("employee not found");
    const aadhaar = (await readIdentityValues(deps, emp)).aadhaar;
    if (provider.requiresAadhaar && !aadhaar) throw failedPrecondition("this employee has no Aadhaar on file; cannot request Aadhaar e-sign");
    signer = { name: (emp.legalName || `${emp.firstName} ${emp.lastName}`).trim(), aadhaar, email: emp.workEmail };
  }

  // Create the owned personal-document row (allocates the r2 key), then store the rendered bytes + stamp size.
  const row = await svc.create(deps, user, { employee, display_name: title, document_type: "LETTER", content_type: "application/pdf" });
  await deps.docs.put(row.r2Key, pdf, "application/pdf");
  // The `internal` driver signs in place later (:sign), re-rendering the frozen content with the image
  // embedded - so freeze the resolved content as a sidecar. External vendors return their own signed PDF, so
  // no sidecar is needed there.
  if (wantEsign && !external) await deps.docs.put(`${row.r2Key}.content`, new TextEncoder().encode(JSON.stringify(content)), "application/json");

  const esignFields: Record<string, unknown> = {};
  if (external && provider && signer) {
    let res;
    try {
      res = await provider.createRequest({
        pdf, fileName, docId: row.uuid,
        signers: [signer],
        signAnchors,
        cfg: cfg.providers?.[providerId] ?? {},
        secrets: deps.esignSecrets?.[providerId] ?? {},
      });
    } catch (e) {
      // Unwind the half-created document so a vendor outage doesn't leave an orphan row + R2 object.
      await deps.docs.delete(row.r2Key).catch(() => {});
      await deps.db.delete(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, row.uuid));
      throw e;
    }
    esignFields.esignProvider = providerId;
    esignFields.esignRequestId = res.providerRef;
    esignFields.esignStatus = res.status;
    esignFields.esignUri = res.signUrl ?? null;
    esignFields.esignSentAt = new Date();
  } else if (wantEsign) {
    // internal: mark it awaiting in-app signature so the UI prompts the owner.
    esignFields.esignProvider = "internal";
    esignFields.esignStatus = "sent";
    esignFields.esignSentAt = new Date();
  }

  const updated = (await deps.db
    .update(schema.personalDocuments)
    .set({ sizeBytes: pdf.byteLength, contentType: "application/pdf", fileName, requiresSignature: wantEsign, ...esignFields, updatedAt: new Date() })
    .where(eq(schema.personalDocuments.uuid, row.uuid))
    .returning())[0]!;
  // Let the employee know a document was issued to them. When it needs their in-app signature it's an ACTION
  // item ("review & sign", document priority = high); an external-vendor request sends the signer to the
  // vendor's flow, and a plain letter is purely informational. Skip if HR generated it for themselves.
  if (employeeId !== user.employeeId)
    await notify(deps, {
      recipient: employeeId,
      type: wantEsign ? "document.sign" : "document.issued",
      title: wantEsign ? `Review & sign: ${title}` : `New document: ${title}`,
      body: wantEsign
        ? external
          ? "A document is awaiting your signature - open it to sign."
          : "A document needs your e-signature."
        : title,
      link: "documents",
      subject: `personal-documents/${updated.uuid}`,
      action: wantEsign && !external ? "sign" : wantEsign ? "respond" : null,
      actorId: user.employeeId,
    });
  return c.json(toPersonalDocumentResource(updated));
});
