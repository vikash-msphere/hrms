// Deterministic PDF of the tag sheets - browser print dialogs silently rescale/re-margin, a PDF
// does not. Mirrors the on-screen Label/SheetView layout exactly (same mm proportions). Loaded
// lazily (pdf-lib) only when the user exports.
import { PDFDocument, StandardFonts, rgb, type PDFImage, type PDFPage } from "pdf-lib";
import { slotPos, fitLabelBlock, labelLineSpecs, labelTextBox, LABEL_LINE_HEIGHT, type SheetFormat } from "./assetTags";
// The SAME sanitizer the Worker's PDF renderers use (src/lib/winAnsi.ts), not a copy: the standard fonts here
// are WinAnsi-encoded exactly as they are there. See the note at the specs below for what it prevents.
import { enc } from "../../../src/lib/winAnsi";

const MM = 72 / 25.4; // mm -> pt
const A4 = { w: 210 * MM, h: 297 * MM };
// Ink per line, in the order labelLineSpecs() returns them; the same greys as the CSS preview.
const LINE_INK = [rgb(0.42, 0.44, 0.47), rgb(0, 0, 0), rgb(0.33, 0.33, 0.33), rgb(0.42, 0.44, 0.47), rgb(0.42, 0.44, 0.47)];

export type PdfLabel = {
  tag: string;
  name: string;
  serial?: string;
  codeDataUrl?: string; // QR (square) or Code128 (wide) PNG data-url
};
export type PdfSheet = (PdfLabel | null)[]; // slot index -> label (null = empty/used)

export type PdfOptions = {
  format: SheetFormat;
  offsetX: number;
  offsetY: number;
  sheets: PdfSheet[];
  orgName: string;
  logoDataUrl?: string;
  show: { name: boolean; serial: boolean; org: boolean; logo: boolean };
  footer?: string;
  codeType: "qr" | "code128";
  calibrate?: boolean; // outlines only
};

async function embedDataUrl(doc: PDFDocument, cache: Map<string, PDFImage>, dataUrl: string): Promise<PDFImage | null> {
  const hit = cache.get(dataUrl);
  if (hit) return hit;
  try {
    const base64 = dataUrl.split(",")[1] ?? "";
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const img = dataUrl.startsWith("data:image/jpeg") ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    cache.set(dataUrl, img);
    return img;
  } catch {
    return null; // a bad logo/code image should not sink the whole export
  }
}

export async function buildTagSheetsPdf(opts: PdfOptions): Promise<Uint8Array> {
  const { format: f, sheets, show } = opts;
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const images = new Map<string, PDFImage>();
  const logo = !opts.calibrate && show.org && show.logo && opts.logoDataUrl ? await embedDataUrl(doc, images, opts.logoDataUrl) : null;

  const drawLabel = async (page: PDFPage, x: number, y: number, label: PdfLabel) => {
    // x/y = top-left of the slot in pt (pdf y measured from bottom; we convert per line below).
    const pad = f.h * 0.04 * MM;
    const box = labelTextBox(f, opts.codeType); // mm, same box the CSS gives the text column
    let textX = x + pad;

    if (opts.codeType === "qr") {
      const qr = f.h * 0.78 * MM;
      const img = label.codeDataUrl ? await embedDataUrl(doc, images, label.codeDataUrl) : null;
      if (img) page.drawImage(img, { x: x + pad, y: y - pad - qr, width: qr, height: qr });
      textX = x + pad + qr + f.h * 0.05 * MM;
    }

    // Wrap and scale the whole column exactly as the preview does - Helvetica here is metric-compatible
    // with the preview's Arial, so the same words land on the same lines at the same size. Layout is in
    // mm (the size floor is a physical one); only the drawing converts to points.
    const withLogo = !!logo;
    // SANITIZED AT THE SOURCE, so wrapping, scaling and drawing all see the same string. pdf-lib encodes to
    // measure as well as to draw, so a character the base font cannot encode throws out of the measure
    // callback below rather than rendering as a blank - and every one of these fields is free text an
    // operator types: the org name, the sticker footer, an asset's name. A rupee sign in the footer or an
    // asset named in any non-Latin script took the whole sheet export down with it, which is the one moment
    // somebody is standing at a label printer. The HTML preview (AssetTagPrinter) is deliberately left
    // unsanitized: it can render those characters, and only the PDF has to give them up.
    const fitted = fitLabelBlock(
      labelLineSpecs({
        org: show.org && !withLogo ? enc(opts.orgName) : "",
        tag: enc(label.tag),
        name: show.name ? enc(label.name) : "",
        serial: show.serial ? enc(label.serial) : "",
        footer: enc(opts.footer ?? ""),
      }),
      box,
      f.h,
      (t, size, isBold) => (isBold ? bold : helv).widthOfTextAtSize(t, size * MM) / MM,
      withLogo ? f.h * 0.14 * 1.2 : 0,
    );

    let cursor = y - pad;
    if (logo) {
      const lh = f.h * 0.14 * MM;
      const scale = Math.min(lh / logo.height, (box.width * MM) / logo.width);
      cursor -= lh;
      page.drawImage(logo, { x: textX, y: cursor, width: logo.width * scale, height: logo.height * scale });
      cursor -= lh * 0.2;
    }
    for (const l of fitted.lines) {
      const size = l.size * MM;
      cursor -= size * LABEL_LINE_HEIGHT;
      // CSS puts the baseline a quarter-em up from the bottom of the line box; match it so the two
      // renderers stack identically.
      page.drawText(l.text, { x: textX, y: cursor + size * 0.25, size, font: l.bold ? bold : helv, color: LINE_INK[l.spec] ?? rgb(0, 0, 0) });
    }

    if (opts.codeType === "code128" && label.codeDataUrl) {
      // 1D barcode: full label width along the bottom (text sits above it).
      const img = await embedDataUrl(doc, images, label.codeDataUrl);
      if (img) {
        const bw = (f.w - f.h * 0.08) * MM;
        const bh = f.h * 0.34 * MM;
        page.drawImage(img, { x: x + pad, y: y - f.h * MM + pad, width: bw, height: bh });
      }
    }
  };

  for (const sheet of opts.calibrate ? sheets.slice(0, 1) : sheets) {
    const page = doc.addPage([A4.w, A4.h]);
    for (let i = 0; i < sheet.length; i++) {
      const { left, top } = slotPos(f, i, opts.offsetX, opts.offsetY);
      const x = left * MM;
      const yTop = A4.h - top * MM; // top edge of the slot, in pdf coords
      if (opts.calibrate) {
        page.drawRectangle({ x, y: yTop - f.h * MM, width: f.w * MM, height: f.h * MM, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
        continue;
      }
      const label = sheet[i];
      if (label) await drawLabel(page, x, yTop, label);
    }
  }
  return doc.save();
}

export function downloadPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
