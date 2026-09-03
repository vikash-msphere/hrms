// In-place e-signature for a generated letter/contract (a personal-document with an e-signature placeholder).
// OWNER-ONLY, enforced here at the service level regardless of grants (like the owner-private signature image):
// a signature is forgeable, so even HR's broad personal-documents.** can never sign on someone's behalf. The
// letter's resolved content was frozen as an R2 sidecar at generation; signing re-renders THAT exact content
// with the owner's signature image dropped into the placeholder block, replaces the file in place, then stamps
// the typed-name attestation + signedTime and locks the row.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notFound, invalidArgument, forbidden, failedPrecondition } from "../lib/errors";
import { renderLetterPdf, type LetterContent } from "../lib/letterPdf";
import { formatLongDate } from "../lib/pdfPrimitives";
import { rehydrateLetterhead } from "./letterheads";

export async function signLetter(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("document not found");
  // Hard owner-only rule (no grant override): only the document's owner may sign it.
  if (!actor.employeeId || actor.employeeId !== row.employeeId) throw forbidden("only the document owner can sign it");
  if (!row.requiresSignature) throw invalidArgument("this document does not require a signature");
  if (row.signedTime) throw invalidArgument("this document is already signed");

  // A digital signature image on file is mandatory: the e-signature embeds it, and a typed name alone is not
  // accepted. The owner uploads it on their profile (Signature tab).
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, row.employeeId)).limit(1))[0];
  if (!emp?.signatureKey) throw failedPrecondition("upload a signature image to your profile before signing documents");
  // The signatory name is the employee's LEGAL name (the name on official records), NOT a typed value - the
  // signer cannot alter it. Falls back to the display name when no legal name is recorded.
  const name = (emp.legalName || `${emp.firstName} ${emp.lastName}`).trim();

  // Load the frozen letter content (the exact letter generated) so the re-render matches it byte-for-byte
  // except for the filled-in signature.
  const contentBuf = await deps.docs.get(`${row.r2Key}.content`);
  if (!contentBuf) throw invalidArgument("this document cannot be signed (no template content on file)");
  const content = JSON.parse(new TextDecoder().decode(new Uint8Array(contentBuf))) as LetterContent;

  // The owner's stored signature image (owner-private; guaranteed present by the guard above).
  const sigBuf = await deps.docs.get(emp.signatureKey);
  const sigBytes = sigBuf ? new Uint8Array(sigBuf) : undefined;
  const date = formatLongDate(new Date());

  // Fill every e-signature placeholder block with the signature image + legal name + date.
  for (const b of content.blocks) {
    if (b.kind === "esignature") { b.signature = sigBytes; b.name = name; b.date = date; }
  }
  // The sidecar froze the letterhead's DESIGN but not its artwork (megabytes per document); fetch the image
  // back from the letterhead row so the signed page carries the same masthead the recipient saw.
  await rehydrateLetterhead(deps, content);
  const { bytes: pdf } = await renderLetterPdf(content);
  await deps.docs.put(row.r2Key, pdf, "application/pdf");

  const [updated] = await deps.db
    .update(schema.personalDocuments)
    .set({ sizeBytes: pdf.byteLength, signedTime: new Date(), signatureName: name, locked: true, updatedAt: new Date() })
    .where(eq(schema.personalDocuments.uuid, id))
    .returning();
  // That it was signed and when, never the attestation name itself: lib/audit strips `signature*` from any
  // meta, and this trail is read more widely than the signed document is.
  await audit(deps, actor, "personal-document.sign", "personal-documents", id, { diff: { signedTime: { from: row.signedTime, to: updated!.signedTime }, locked: { from: row.locked, to: true } } }, updated);
  return updated!;
}
