import { PDFDocument, PDFFont, PDFImage, PDFPage, degrees, rgb, type Color } from "pdf-lib";
import { enc, embedLogo } from "./pdfPrimitives";
import { hexToRgb01 } from "../domain/brand";
import { STOCK_LETTERHEAD, fillTokens, type LetterheadDesign, type LetterheadSlot, type LetterheadToken } from "../domain/letterhead";

// The PAGE a document is printed on, independent of what is printed on it.
//
// A letterhead describes a sheet: its size, its margins, the stationery under the content, the header band at
// the top, the footer band at the bottom, the watermark through the middle. None of that knows or cares
// whether the thing between the bands is a letter or a payslip - which is the whole reason this module
// exists. The letter renderer (letterPdf.ts) and the payslip renderer (pdf.ts) each lay out their own body
// and hand the sheet to the same code, so a payslip issued on a letterhead comes out on the SAME page a
// letter does, down to the last hairline.
//
// Everything here is explicit parameters rather than a closure: it is shared by two renderers with entirely
// different internals, and the moment it starts reaching into one of them it stops being shareable.

export type FrameTokens = Partial<Record<LetterheadToken, string>>;

/** The org facts a frame prints when the design does not override them. */
export type FrameOrg = { name?: string; address?: string; logo?: string; legalName?: string };

export type PageFrame = {
  /** Sheet size, in points. */
  pw: number;
  ph: number;
  /** Content box: where a body may draw. `top` is the first baseline BELOW the header band. */
  left: number;
  right: number;
  top: (pageNo: number) => number;
  bottom: number;
  /** Stationery + watermark. Call FIRST on every new page - the body prints on top of these. */
  backdrop: (page: PDFPage, pageNo: number) => void;
  /** The header band. Call after `backdrop`; returns the baseline the body starts at. */
  header: (page: PDFPage, pageNo: number) => number;
  /** The footer band, drawn on every page once the page count is known. Call once, at the end. */
  footers: (doc: PDFDocument) => void;
  /** The palette the design asks for, so a body can match its own rules and headings to the page. */
  ink: Color;
  muted: Color;
  hairline: Color;
  accent: Color;
  /** Whether the design wants a serif body, so a body renderer can follow the page's typeface. */
  serif: boolean;
};

const LETTER_W = 612;
const LETTER_H = 792;
const A4_W = 595.28;
const A4_H = 841.89;

/**
 * Build the frame for one design. `fonts` are the caller's already-embedded faces (each renderer embeds its
 * own), `images` this version's artwork by slot, `stock` the palette to fall back to.
 */
export async function buildPageFrame(opts: {
  doc: PDFDocument;
  design: LetterheadDesign;
  org: FrameOrg;
  images?: Partial<Record<LetterheadSlot, string>>;
  tokens: FrameTokens;
  font: PDFFont;
  bold: PDFFont;
  stock: { ink: Color; muted: Color; hairline: Color };
}): Promise<PageFrame> {
  const { doc, design, org, images = {}, tokens, font, bold, stock } = opts;
  const pageOpts = { ...STOCK_LETTERHEAD.page, ...design.page };
  const margin = { ...STOCK_LETTERHEAD.page.margin, ...design.page?.margin } as { top: number; right: number; bottom: number; left: number };
  const bg = { ...STOCK_LETTERHEAD.background, ...design.background };
  const head = { ...STOCK_LETTERHEAD.header, ...design.header };
  const foot = { ...STOCK_LETTERHEAD.footer, ...design.footer };
  const mark = { ...STOCK_LETTERHEAD.header.mark, ...design.header?.mark };

  const pw = pageOpts.size === "letter" ? LETTER_W : A4_W;
  const ph = pageOpts.size === "letter" ? LETTER_H : A4_H;
  const paint = (hex: string | undefined, dflt: Color): Color => (hex ? rgb(...hexToRgb01(hex)) : dflt);
  const INK = paint(pageOpts.ink, stock.ink);
  const MUTED = paint(pageOpts.muted, stock.muted);
  const HAIR = paint(pageOpts.hairline, stock.hairline);
  const ACCENT = paint(pageOpts.accent ?? pageOpts.ink, stock.ink);

  const ML = margin.left;
  const MR = pw - margin.right;
  const WIDTH = MR - ML;
  const MT = ph - margin.top;
  const footerHeight = foot.show ? foot.height ?? 26 : 0;

  const logo = mark.show === false ? null : ((await embedLogo(doc, images.mark)) ?? (await embedLogo(doc, org.logo)));
  const pageArt = bg.show === false ? null : await embedLogo(doc, images.stationery);
  const wmImage = design.watermark?.show === false ? null : await embedLogo(doc, images.watermark);

  const draw = (page: PDFPage, s: string, x: number, y: number, f: PDFFont, size: number, color: Color) =>
    page.drawText(enc(s), { x, y, size, font: f, color });
  const line = (page: PDFPage, x1: number, y: number, x2: number, thickness: number, color: Color) =>
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  const cover = (page: PDFPage, img: PDFImage, opacity: number) => {
    const scale = Math.max(pw / img.width, ph / img.height); // no bare margin on any edge
    const iw = img.width * scale;
    const ih = img.height * scale;
    page.drawImage(img, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih, opacity });
  };

  function backdrop(page: PDFPage, pageNo: number) {
    if (pageArt && (bg.pages === "all" || pageNo === 1)) cover(page, pageArt, bg.opacity ?? 1);
    const wm = design.watermark ?? {};
    if (wm.show === false || (!wm.text && !wmImage)) return;
    const opacity = wm.opacity ?? 0.08;
    const angle = wm.angle ?? 45;
    if (wmImage) {
      const h = wm.size ?? 260;
      const scale = h / wmImage.height;
      const iw = wmImage.width * scale;
      page.drawImage(wmImage, { x: (pw - iw) / 2, y: (ph - h) / 2, width: iw, height: h, opacity, rotate: degrees(angle) });
      return;
    }
    if (!wm.text) return;
    const size = wm.size ?? 72;
    const s = enc(fillTokens(wm.text, tokens));
    const tw = bold.widthOfTextAtSize(s, size);
    const rad = (angle * Math.PI) / 180;
    // Rotation pivots on the anchor, so step back along the rotated baseline to centre the string on the sheet.
    page.drawText(s, {
      x: pw / 2 - (tw / 2) * Math.cos(rad),
      y: ph / 2 - (tw / 2) * Math.sin(rad) - size * 0.35,
      size,
      font: bold,
      color: paint(wm.color, MUTED),
      opacity,
      rotate: degrees(angle),
    });
  }

  /** One header line at its own alignment. */
  function bandLine(page: PDFPage, s: string, size: number, f: PDFFont, color: Color, align: "left" | "center" | "right", y: number) {
    const filled = fillTokens(s, tokens);
    const w = f.widthOfTextAtSize(enc(filled), size);
    const x = align === "left" ? ML : align === "right" ? MR - w : ML + (WIDTH - w) / 2;
    draw(page, filled, x, y, f, size, color);
  }

  function header(page: PDFPage, pageNo: number): number {
    const full = pageNo === 1;
    const variant = full ? "full" : head.repeat ?? "slim";
    if (head.show === false || variant === "none") return MT - (head.height ?? 0);
    if (variant === "slim") {
      const name = head.name?.text || org.name || "";
      let y = MT;
      draw(page, head.name?.case === "asis" ? name : name.toUpperCase(), ML, y, bold, 7.5, MUTED);
      y -= 8;
      if (head.rule?.show !== false) line(page, ML, y, MR, 0.75, HAIR);
      return y - 18;
    }

    const top = MT;
    let ay = MT;
    const nameCfg = head.name ?? {};
    if (nameCfg.show !== false) {
      const raw = nameCfg.text || org.name || "";
      const size = nameCfg.size ?? 10;
      bandLine(page, nameCfg.case === "asis" ? raw : raw.toUpperCase(), size, nameCfg.weight === "regular" ? font : bold, paint(nameCfg.color, INK), "left", ay);
      ay -= size + 3;
    }
    const addrCfg = head.address ?? {};
    if (addrCfg.show !== false) {
      const size = addrCfg.size ?? 7.5;
      for (const ln of (addrCfg.text ?? org.address ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        bandLine(page, ln, size, font, paint(addrCfg.color, MUTED), "left", ay);
        ay -= size + 2.5;
      }
    }
    for (const ln of head.lines ?? []) {
      const size = ln.size ?? 7.5;
      bandLine(page, ln.text, size, ln.weight === "bold" ? bold : font, paint(ln.color, MUTED), ln.align ?? "left", ay);
      ay -= size + 2.5;
    }
    if (logo) {
      const h = mark.height ?? 46;
      const scale = h / logo.height;
      const lw = logo.width * scale;
      const x = mark.align === "left" ? ML : mark.align === "center" ? ML + (WIDTH - lw) / 2 : MR - lw;
      page.drawImage(logo, { x, y: top - h + 8, width: lw, height: h });
      ay = Math.min(ay, top - h + 8);
    }
    // A fixed height pins where the body starts regardless of how many lines the band drew - the setting that
    // makes a design line up with artwork measured in a design tool.
    let y = head.height != null ? top - head.height : ay - 8;
    if (head.rule?.show !== false) {
      y -= head.rule?.gap ?? 0;
      line(page, ML, y, MR, head.rule?.weight ?? 2, paint(head.rule?.color, ACCENT));
    }
    return y - 24;
  }

  function footers(document: PDFDocument) {
    if (foot.show !== true) return;
    const size = foot.size ?? 7.5;
    const height = foot.height ?? 26;
    const color = paint(foot.color, MUTED);
    const sheets = document.getPages();
    sheets.forEach((p, i) => {
      const pageNo = i + 1;
      const on = foot.pages === "first" ? pageNo === 1 : foot.pages === "continuation" ? pageNo > 1 : true;
      if (!on) return;
      const vals = { ...tokens, page: String(pageNo), pages: String(sheets.length) };
      const ruleY = margin.bottom + height - 6;
      if (foot.rule?.show !== false) line(p, ML, ruleY, MR, foot.rule?.weight ?? 0.5, paint(foot.rule?.color, HAIR));
      const baseline = ruleY - size - 5;
      const cell = (raw: string | undefined, align: "left" | "center" | "right") => {
        if (!raw) return;
        const s = enc(fillTokens(raw, vals));
        const w = font.widthOfTextAtSize(s, size);
        const x = align === "left" ? ML : align === "right" ? MR - w : ML + (WIDTH - w) / 2;
        p.drawText(s, { x, y: baseline, size, font, color });
      };
      cell(foot.left, "left");
      cell(foot.center, "center");
      cell(foot.right, "right");
    });
  }

  return {
    pw,
    ph,
    left: ML,
    right: MR,
    top: (pageNo: number) => (pageNo === 1 ? MT : MT),
    bottom: margin.bottom + footerHeight,
    backdrop,
    header,
    footers,
    ink: INK,
    muted: MUTED,
    hairline: HAIR,
    accent: ACCENT,
    serif: pageOpts.font !== "sans",
  };
}
