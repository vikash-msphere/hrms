// Stamp a signature image (+ optional typed name/date attestation) onto an EXISTING uploaded PDF at a chosen
// box. Used by the internal document-acknowledgement path: the employee's on-file signature image is drawn
// in-place on the org policy PDF at the box HR positioned. Coordinates are PDF points, bottom-left origin,
// 1-based page - the same anchor shape the letter renderer emits and Cashfree consumes.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type SignAnchor = { page: number; x1: number; y1: number; x2: number; y2: number };

export async function stampSignature(
  pdfBytes: Uint8Array,
  imageBytes: Uint8Array | undefined,
  anchor: SignAnchor,
  attest?: { name?: string; date?: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  if (pages.length === 0) throw new Error("cannot stamp an empty PDF");
  // Clamp to a real page (1-based anchor); fall back to the last page if the anchor points past the end.
  const page = pages[Math.min(Math.max(1, Math.round(anchor.page)), pages.length) - 1]!;

  // Normalize the box to bottom-left origin regardless of which corners the anchor used.
  const bx = Math.min(anchor.x1, anchor.x2);
  const by = Math.min(anchor.y1, anchor.y2);
  const bw = Math.abs(anchor.x2 - anchor.x1);
  const bh = Math.abs(anchor.y1 - anchor.y2);

  // Reserve a strip at the bottom of the box for the attestation line, if any.
  const nameH = attest?.name ? 10 : 0;
  const imgAreaH = Math.max(1, bh - nameH);

  if (imageBytes && imageBytes.byteLength > 0) {
    let img = null;
    try { img = await doc.embedPng(imageBytes); }
    catch { try { img = await doc.embedJpg(imageBytes); } catch { img = null; } }
    if (img) {
      const scale = Math.min(bw / img.width, imgAreaH / img.height); // fit inside the box, preserve aspect
      const iw = img.width * scale;
      const ih = img.height * scale;
      // Center horizontally; sit the image above the attestation strip.
      page.drawImage(img, { x: bx + (bw - iw) / 2, y: by + nameH + (imgAreaH - ih) / 2, width: iw, height: ih });
    }
  }

  if (attest?.name) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size = 8;
    const label = attest.date ? `${attest.name}  ·  ${attest.date}` : attest.name;
    const tw = font.widthOfTextAtSize(label, size);
    page.drawText(label, { x: bx + Math.max(0, (bw - tw) / 2), y: by + 1, size, font, color: rgb(0.25, 0.25, 0.25) });
  }

  return await doc.save();
}
