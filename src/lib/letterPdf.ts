import { PDFDocument, PDFFont, PDFPage, StandardFonts, type Color } from "pdf-lib";
import { DARK, SLATE, MUTED, HAIR, FAINT, PAGE_W, PAGE_H, enc, embedLogo } from "./pdfPrimitives";

// Generic A4 letterhead renderer for HR letters (offer, increment, appraisal, relieving, experience), mirroring
// offer-letter.html: a company name/address + logo header with a heavy rule, serif justified-ish body with
// word-wrapped paragraphs (inline bold runs), bullet lists, ledger-style tables (monospaced figures), a
// signature block and an optional acceptance block. The renderer is content-agnostic - WHAT each letter says
// lives in src/domain/letters.ts; this only knows HOW to lay blocks out and flow them across pages.

// A run of text within a paragraph: a plain string, or { b } for bold. Lets a sentence bold a name/amount
// inline without the caller doing any layout.
export type Run = string | { b: string };

export type LetterTable = {
  title?: string;
  columns: string[]; // first column is left-aligned text; the rest are right-aligned figures
  rows: string[][];
  total?: string[]; // optional bold total row with a heavy top border
};

export type LetterBlock =
  | { kind: "subject"; text: string }
  | { kind: "para"; runs: Run[]; bold?: boolean }
  | { kind: "bullets"; items: Run[][]; ordered?: boolean }
  | { kind: "table"; table: LetterTable }
  | { kind: "note"; text: string } // small muted footnote-style line
  | { kind: "signature"; closing?: string; name: string; title?: string; signatureImage?: string; stampImage?: string } // employer (1st-party) sign-off; signatureImage = authorized-signatory signature (data URL) embedded above the name; stampImage = company seal/stamp (data URL) overlaid beside the signatory
  | { kind: "acceptance"; name: string }
  // Recipient e-signature placeholder: a ruled signature line + name (+ optional title/label). Before signing
  // it renders blank (the placeholder); when `signature` image bytes are present it embeds them above the line
  // and stamps the date - the in-place signing fill. PNG or JPG (try/fallback), scaled to ~36px tall.
  | { kind: "esignature"; name: string; label?: string; withDate?: boolean; method?: "internal" | "cashfree"; signature?: Uint8Array; date?: string }
  | { kind: "gap"; height: number }
  | { kind: "pageBreak" };

export type LetterContent = {
  org: { name: string; address?: string; logo?: string };
  date: string; // pre-formatted, e.g. "13 June 2026"
  ref?: string; // optional reference line
  to: { name: string; lines?: string[] };
  blocks: LetterBlock[];
};

// Where an `esignature` placeholder actually landed on the rendered page - captured so a vendor that must be
// told where to stamp the signature (e.g. Cashfree's sign_positions) gets the real per-document box instead of
// a guessed static coordinate. Points, PDF bottom-left origin; (x1,y1) top-left, (x2,y2) bottom-right; page is
// 1-based. Empty when the letter has no e-signature block.
export type SignAnchor = { page: number; x1: number; y1: number; x2: number; y2: number };
export type RenderedLetter = { bytes: Uint8Array; signAnchors: SignAnchor[] };

const ML = 54; // left margin
const MR = 541; // right edge of content
const MT = PAGE_H - 54; // top start (below page edge)
const MB = 56; // bottom margin (stop drawing below this)
const WIDTH = MR - ML;

export async function renderLetterPdf(content: LetterContent): Promise<RenderedLetter> {
  const doc = await PDFDocument.create();
  // Serif body for a formal feel; monospaced figures so table money columns align like a ledger.
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);
  const logo = await embedLogo(doc, content.org.logo);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = MT;
  let firstPage = true;
  let pageIndex = 1; // 1-based page the cursor is on; captured with each e-signature anchor
  const signAnchors: SignAnchor[] = [];

  const w = (s: string, f: PDFFont, size: number) => f.widthOfTextAtSize(enc(s), size);
  const text = (s: string, x: number, yy: number, f: PDFFont, size: number, color: Color) =>
    page.drawText(enc(s), { x, y: yy, size, font: f, color });
  const rightText = (s: string, xr: number, yy: number, f: PDFFont, size: number, color: Color) =>
    text(s, xr - w(s, f, size), yy, f, size, color);
  const rule = (x1: number, yy: number, x2: number, thickness = 0.5, color = HAIR) =>
    page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });

  // Letterhead: company name + address (left), logo (right), heavy rule. Drawn full on page 1; a slim
  // repeat (name + rule) tops continuation pages so a multi-page letter still reads as one document.
  function drawHeader(full: boolean) {
    if (full) {
      text((content.org.name || "").toUpperCase(), ML, y, bold, 10, DARK);
      let ay = y - 13;
      for (const ln of (content.org.address || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        text(ln, ML, ay, font, 7.5, MUTED); ay -= 10;
      }
      if (logo) {
        const h = 46, scale = h / logo.height, lw = logo.width * scale;
        page.drawImage(logo, { x: MR - lw, y: y - h + 8, width: lw, height: h });
        ay = Math.min(ay, y - h + 8);
      }
      y = ay - 8;
      rule(ML, y, MR, 2, DARK);
      y -= 24;
    } else {
      text((content.org.name || "").toUpperCase(), ML, y, bold, 7.5, MUTED);
      y -= 8;
      rule(ML, y, MR, 0.75, HAIR);
      y -= 18;
    }
  }

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = MT;
    firstPage = false;
    pageIndex++;
    drawHeader(false);
  }

  // Reserve vertical space; spill to a new page if it won't fit above the bottom margin.
  function need(h: number) {
    if (y - h < MB) newPage();
  }

  drawHeader(true);

  // ── Word-wrap a paragraph of runs at WIDTH, switching fonts per run; returns nothing (advances y). ──
  function drawRuns(runs: Run[], opts: { size?: number; color?: Color; allBold?: boolean; lineGap?: number; x?: number; maxX?: number } = {}) {
    const size = opts.size ?? 10.5;
    const color = opts.color ?? SLATE;
    const lineHeight = size * 1.45;
    const x0 = opts.x ?? ML;
    const maxX = opts.maxX ?? MR;
    // Tokenize runs into (word, bold) tokens with single-space separators preserved between words.
    type Tok = { s: string; b: boolean; space: boolean };
    const toks: Tok[] = [];
    for (const r of runs) {
      const str = typeof r === "string" ? r : r.b;
      const b = typeof r === "object" || !!opts.allBold; // a { b } run, or a wholly-bold paragraph
      for (const wd of str.split(/(\s+)/).filter((p) => p.length > 0)) {
        if (/^\s+$/.test(wd)) toks.push({ s: " ", b, space: true });
        else toks.push({ s: wd, b, space: false });
      }
    }
    let cx = x0;
    let lineHasContent = false;
    need(lineHeight);
    for (const t of toks) {
      const f = t.b ? bold : font;
      const tw = w(t.s, f, size);
      if (t.space) {
        if (!lineHasContent) continue; // skip leading spaces
        cx += tw;
        continue;
      }
      if (cx + tw > maxX && lineHasContent) {
        y -= lineHeight;
        need(lineHeight);
        cx = x0;
        lineHasContent = false;
      }
      text(t.s, cx, y, f, size, color);
      cx += tw;
      lineHasContent = true;
    }
    y -= lineHeight + (opts.lineGap ?? 6);
  }

  function drawBullets(items: Run[][], ordered: boolean, size = 9.5) {
    const indent = 16;
    items.forEach((item, i) => {
      need(size * 1.45);
      const marker = ordered ? `${i + 1}.` : "*";
      text(marker, ML, y, font, size, SLATE);
      drawRuns(item, { size, x: ML + indent, maxX: MR, lineGap: 3 });
    });
    y -= 4;
  }

  function drawTable(t: LetterTable) {
    const cols = t.columns.length;
    // First column takes ~46% of width; remaining columns split the rest, right-aligned.
    const firstW = cols > 1 ? WIDTH * 0.46 : WIDTH;
    const restW = cols > 1 ? (WIDTH - firstW) / (cols - 1) : 0;
    const colRight = (c: number) => (c === 0 ? ML + firstW - 8 : ML + firstW + restW * c - 8);
    const colLeft = ML + 2;
    const rowH = 18;

    if (t.title) {
      need(20);
      text(t.title, ML, y, bold, 10, DARK);
      y -= 16;
    }
    need(rowH + 4);
    // Header row.
    t.columns.forEach((h, c) => {
      if (c === 0) text(h.toUpperCase(), colLeft, y, bold, 7, MUTED);
      else rightText(h.toUpperCase(), colRight(c), y, bold, 7, MUTED);
    });
    y -= 5;
    rule(ML, y, MR, 1.25, DARK);
    y -= rowH - 5;
    // Body rows.
    for (const row of t.rows) {
      need(rowH);
      row.forEach((cell, c) => {
        if (c === 0) text(cell, colLeft, y, font, 9, SLATE);
        else rightText(cell, colRight(c), y, mono, 9, SLATE);
      });
      rule(ML, y - 5, MR, 0.5, FAINT);
      y -= rowH;
    }
    // Total row.
    if (t.total) {
      need(rowH);
      rule(ML, y + rowH - 5, MR, 1.25, DARK);
      t.total.forEach((cell, c) => {
        if (c === 0) text(cell, colLeft, y, bold, 9, DARK);
        else rightText(cell, colRight(c), y, monoBold, 9, DARK);
      });
      y -= rowH;
    }
    y -= 8;
  }

  // ── Preamble: date, ref, to-block, on the first page below the letterhead. ──
  text(content.date, ML, y, font, 9, MUTED);
  y -= 18;
  if (content.ref) { text(content.ref, ML, y, font, 8.5, MUTED); y -= 16; }
  text(content.to.name, ML, y, bold, 9.5, DARK);
  y -= 13;
  for (const ln of content.to.lines ?? []) { text(ln, ML, y, font, 9, SLATE); y -= 12; }
  y -= 10;

  for (const block of content.blocks) {
    switch (block.kind) {
      case "subject":
        need(24);
        text(block.text, ML, y, bold, 10.5, DARK);
        rule(ML, y - 2, ML + w(block.text, bold, 10.5), 0.75, DARK);
        y -= 22;
        break;
      case "para":
        drawRuns(block.runs, { allBold: block.bold, lineGap: 8 });
        break;
      case "bullets":
        drawBullets(block.items, !!block.ordered);
        break;
      case "table":
        drawTable(block.table);
        break;
      case "note":
        need(14);
        drawRuns([block.text], { size: 8, color: MUTED, lineGap: 4 });
        break;
      case "gap":
        y -= block.height;
        break;
      case "pageBreak":
        newPage();
        break;
      case "signature": {
        need(115);
        const sigTop = y; // remember block top so the company stamp can overlay the signature band on the right
        const stampImg = block.stampImage ? await embedLogo(doc, block.stampImage) : null;
        if (block.closing) { text(block.closing, ML, y, font, 10, SLATE); y -= 18; }
        // Employer (1st party) e-signature: the authorized-signatory signature image on file, embedded above
        // the typed name. Falls back to a blank wet-signature gap when none is configured (prior behaviour).
        // Pad above + below the image so a tall / odd-aspect-ratio signature can't overlap the closing or name.
        const sigImg = block.signatureImage ? await embedLogo(doc, block.signatureImage) : null;
        if (sigImg) {
          const maxH = 40, scale = Math.min(maxH / sigImg.height, 220 / sigImg.width);
          const iw = sigImg.width * scale, ih = sigImg.height * scale;
          y -= 6; // top padding above the signature image
          page.drawImage(sigImg, { x: ML, y: y - ih, width: iw, height: ih });
          y -= ih + 10; // image + a little more space below before the name
        } else {
          y -= 26;
        }
        text(block.name, ML, y, bold, 10, DARK);
        y -= 13;
        if (block.title) { text(block.title, ML, y, font, 9, MUTED); y -= 13; }
        // Company stamp/seal: overlaid on the right of the signatory, vertically centred on the
        // signature-to-name band, so it reads like a rubber stamp beside the authorized signatory.
        if (stampImg) {
          const maxS = 92, scale = Math.min(maxS / stampImg.width, maxS / stampImg.height);
          const sw = stampImg.width * scale, sh = stampImg.height * scale;
          const bandMid = (sigTop + y) / 2; // midpoint between block top and the current (post-name) baseline
          page.drawImage(stampImg, { x: ML + 235, y: bandMid - sh / 2, width: sw, height: sh, opacity: 0.9 });
        }
        y -= 8;
        break;
      }
      case "acceptance":
        need(90);
        rule(ML, y, MR, 0.5, FAINT);
        y -= 16;
        drawRuns(["I have read, understand and accept the above and agree to the terms and conditions set forth above:"], { size: 8.5, allBold: true, color: DARK, lineGap: 12 });
        text(`Name: ${block.name}`, ML, y, font, 9, SLATE);
        y -= 34;
        text("Date: ________________", ML, y, font, 9, MUTED);
        rightText("Signature: ________________", MR, y, font, 9, MUTED);
        y -= 16;
        break;
      case "esignature": {
        need(110);
        const SIG_W = 200; // signature line width (left)
        const dateX = MR - 150; // date line left edge (right column), when block.withDate
        let img = null;
        if (block.signature) {
          try { img = await doc.embedPng(block.signature); }
          catch { try { img = await doc.embedJpg(block.signature); } catch { img = null; } }
        }
        // Top padding first, so a tall / odd-aspect-ratio signature never rides up into the text above. The
        // image is then drawn with its TOP at the (padded) baseline and grows DOWNWARD, with a fixed gap left
        // before the ruled line - so its height never overlaps the text above or the line/name below.
        y -= 10;
        if (img) {
          const maxH = 36, scale = Math.min(maxH / img.height, SIG_W / img.width);
          const iw = img.width * scale, ih = img.height * scale;
          page.drawImage(img, { x: ML, y: y - ih, width: iw, height: ih });
          y -= ih + 8;
        } else {
          y -= 30; // empty placeholder space above the signature line
        }
        // The date sits just above its own line, which shares this baseline with the signature line.
        if (block.withDate && block.date) text(block.date, dateX, y + 8, font, 9.5, DARK);
        rule(ML, y, ML + SIG_W, 0.75, HAIR);
        if (block.withDate) rule(dateX, y, MR, 0.75, HAIR);
        // Record where the signature actually landed (the box spanning the line + the image band above it), so
        // an external vendor can be told the real per-document position rather than a static guess.
        signAnchors.push({ page: pageIndex, x1: ML, y1: y + 40, x2: ML + SIG_W, y2: Math.max(0, y - 2) });
        y -= 13;
        text(block.name, ML, y, bold, 9.5, DARK);
        if (block.withDate) text("Date", dateX, y, font, 8.5, MUTED);
        y -= 12;
        // Caption under the signature line. With a dedicated date line the date lives there, so the caption is
        // just the label; otherwise fold the signed date into the caption.
        text(block.withDate ? (block.label || "Signature") : block.date ? `Signed on ${block.date}` : (block.label || "Signature"), ML, y, font, 8.5, MUTED);
        y -= 18; // extra breathing room below the block
        break;
      }
    }
  }

  void firstPage; // (tracked for header variant; no trailing footer needed)
  return { bytes: await doc.save(), signAnchors };
}
