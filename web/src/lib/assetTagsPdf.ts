// Deterministic PDF of the tag sheets - browser print dialogs silently rescale/re-margin, a PDF
// does not. Mirrors the on-screen Label/SheetView layout exactly (same mm proportions). Loaded
// lazily (pdf-lib) only when the user exports.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { slotPos, type SheetFormat } from "./assetTags";

const MM = 72 / 25.4; // mm -> pt
const A4 = { w: 210 * MM, h: 297 * MM };

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

// Truncate a line to its box width (the CSS layout clips with overflow:hidden; PDF must do it manually).
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxWidth) t = t.slice(0, -1);
  return t + "…";
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
    const grey = rgb(0.33, 0.33, 0.33);
    const lightGrey = rgb(0.42, 0.44, 0.47);
    let textX = x + pad;
    let textMaxW = (f.w - f.h * 0.04 * 2) * MM;

    if (opts.codeType === "qr") {
      const qr = f.h * 0.78 * MM;
      const img = label.codeDataUrl ? await embedDataUrl(doc, images, label.codeDataUrl) : null;
      if (img) page.drawImage(img, { x: x + pad, y: y - pad - qr, width: qr, height: qr });
      textX = x + pad + qr + f.h * 0.05 * MM;
      textMaxW = x + f.w * MM - pad - textX;
    }

    // Stack the text lines from the top; sizes mirror the CSS (fractions of the label height).
    let cursor = y - pad;
    const line = (text: string, size: number, font: PDFFont, color = rgb(0, 0, 0)) => {
      cursor -= size;
      page.drawText(fit(text, font, size, textMaxW), { x: textX, y: cursor, size, font, color });
      cursor -= size * 0.3;
    };
    if (show.org) {
      if (logo) {
        const lh = f.h * 0.14 * MM;
        const scale = Math.min(lh / logo.height, (f.w * 0.4 * MM) / logo.width);
        cursor -= lh;
        page.drawImage(logo, { x: textX, y: cursor, width: logo.width * scale, height: logo.height * scale });
        cursor -= lh * 0.2;
      } else {
        line(opts.orgName, f.h * 0.07 * MM, helv, lightGrey);
      }
    }
    line(label.tag, f.h * 0.12 * MM, bold);
    if (show.name && label.name) line(label.name, f.h * 0.08 * MM, helv, grey);
    if (show.serial && label.serial) line(`SN ${label.serial}`, f.h * 0.07 * MM, helv, lightGrey);
    if (opts.footer) line(opts.footer, f.h * 0.065 * MM, helv, lightGrey);

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
