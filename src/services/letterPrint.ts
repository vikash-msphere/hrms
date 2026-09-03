import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { notFound, failedPrecondition } from "../lib/errors";
import { renderLetterPdf, type LetterContent } from "../lib/letterPdf";
import { rehydrateLetterhead } from "./letterheads";
import { documentFileName } from "./documentsCommon";

// The PRINT copy of a generated letter.
//
// A letterhead is a pair of pages: the one documents render on, and the one they should come out of a printer
// on - typically the same page without the flooded background, or with the header band off entirely because
// the paper is already pre-printed stationery and only its height needs reserving. A document, though, is
// generated once. So the print copy is not a second document: it is the SAME letter re-rendered from the
// content frozen at generation (`<r2Key>.content`), on the letterhead's print page.
//
// Nothing is stored. The filed PDF stays the record of what was issued - including the e-signature, which is
// part of the frozen content and so appears on the print copy exactly as it does on screen.
/**
 * Freeze a filed document's resolved content beside its PDF, so it can be re-rendered later - with an
 * e-signature filled in (:sign), or on the letterhead's print page (:print).
 *
 * The ARTWORK is stripped first: it is by far the biggest thing in there (full-page stationery runs to
 * megabytes as a data URL) and it is already stored once, on the letterhead row. What is kept is the exact
 * design the document was rendered with, plus the ref to fetch artwork from at re-render time - so design
 * edits, the frequent kind, cannot rewrite history, while replacing artwork does show up.
 */
export async function freezeLetterContent(deps: Deps, r2Key: string, content: LetterContent): Promise<void> {
  const frozen = { ...content, ...(content.letterhead ? { letterhead: { design: content.letterhead.design } } : {}) };
  await deps.docs.put(`${r2Key}.content`, new TextEncoder().encode(JSON.stringify(frozen)), "application/json");
}

export async function printDocument(deps: Deps, id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = (await deps.db.select().from(schema.personalDocuments).where(eq(schema.personalDocuments.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("personal document not found");
  // Only generated letters have frozen content. An uploaded PDF, or one a vendor signed and returned, is bytes
  // we did not lay out - there is nothing to re-render onto another page, and pretending otherwise would hand
  // back a different document than the one on file.
  const buf = await deps.docs.get(`${row.r2Key}.content`);
  if (!buf) throw failedPrecondition("this document was not generated from a letter template, so it has no print version");
  const content = JSON.parse(new TextDecoder().decode(new Uint8Array(buf))) as LetterContent;
  await rehydrateLetterhead(deps, content, "print");
  const { bytes } = await renderLetterPdf(content);
  const name = documentFileName(row);
  return { bytes, fileName: name.replace(/\.pdf$/i, "") + " (print).pdf" };
}
