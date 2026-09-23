import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb, type Color } from "pdf-lib";
import { DARK as INK_STOCK, SLATE as BODY_STOCK, MUTED as MUTED_STOCK, HAIR as HAIR_STOCK, FAINT as FAINT_STOCK, PAGE_W, PAGE_H, enc, embedLogo } from "./pdfPrimitives";
import { hexToRgb01 } from "../domain/brand";
import { STOCK_LETTERHEAD, fillTokens, type LetterheadDesign, type LetterheadSlot, type LetterheadToken } from "../domain/letterhead";

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

// The page the letter is printed on: the chosen letterhead's design plus its artwork as a data URL. Absent =
// the stock page with the organization logo, which is what every document rendered before letterheads carried
// a design. Frozen into a letter's content sidecar alongside the blocks, so a re-render (an in-app e-sign)
// reproduces the very page the recipient saw even if the letterhead is edited afterwards.
export type LetterheadSpec = { design: LetterheadDesign; artwork?: Partial<Record<LetterheadSlot, string>> };

export type LetterContent = {
  org: { name: string; address?: string; logo?: string; legalName?: string };
  date: string; // pre-formatted, e.g. "13 June 2026"
  ref?: string; // optional reference line
  to: { name: string; lines?: string[] };
  blocks: LetterBlock[];
  letterhead?: LetterheadSpec;
  /** `letterheads/<id>` this was rendered on, so a re-render can fetch its artwork and its print page. */
  letterheadRef?: string;
};

// Where an `esignature` placeholder actually landed on the rendered page - captured so a vendor that must be
// told where to stamp the signature (e.g. Cashfree's sign_positions) gets the real per-document box instead of
// a guessed static coordinate. Points, PDF bottom-left origin; (x1,y1) top-left, (x2,y2) bottom-right; page is
// 1-based. Empty when the letter has no e-signature block.
export type SignAnchor = { page: number; x1: number; y1: number; x2: number; y2: number };
export type RenderedLetter = { bytes: Uint8Array; signAnchors: SignAnchor[] };

// US Letter, for a design that asks for it; A4 (pdfPrimitives PAGE_W/PAGE_H) is the default.
const LETTER_W = 612;
const LETTER_H = 792;

export async function renderLetterPdf(content: LetterContent): Promise<RenderedLetter> {
  const doc = await PDFDocument.create();

  // ── The page design. Every band falls back to STOCK, so a letter with no letterhead - and a letterhead with
  //    an empty design - renders exactly as this engine always did. ─────────────────────────────────────────
  const design: LetterheadDesign = content.letterhead?.design ?? {};
  const pageOpts = { ...STOCK_LETTERHEAD.page, ...design.page };
  const margin = { ...STOCK_LETTERHEAD.page.margin, ...design.page?.margin } as { top: number; right: number; bottom: number; left: number };
  const bg = { ...STOCK_LETTERHEAD.background, ...design.background };
  const head = { ...STOCK_LETTERHEAD.header, ...design.header };
  const foot = { ...STOCK_LETTERHEAD.footer, ...design.footer };

  const PW = pageOpts.size === "letter" ? LETTER_W : PAGE_W;
  const PH = pageOpts.size === "letter" ? LETTER_H : PAGE_H;
  const paint = (hex: string | undefined, stock: Color): Color => (hex ? rgb(...hexToRgb01(hex)) : stock);
  // Shadowing the stock palette keeps every block below writing DARK/SLATE/... while the design decides what
  // those actually are. FAINT follows the hairline when one is set, so row rules stay in the same family.
  const DARK = paint(pageOpts.ink, INK_STOCK);
  const SLATE = paint(pageOpts.ink, BODY_STOCK);
  const MUTED = paint(pageOpts.muted, MUTED_STOCK);
  const HAIR = paint(pageOpts.hairline, HAIR_STOCK);
  const FAINT = paint(pageOpts.hairline, FAINT_STOCK);
  const ACCENT = paint(pageOpts.accent ?? pageOpts.ink, INK_STOCK);

  const ML = margin.left;
  const MR = PW - margin.right;
  const MT = PH - margin.top;
  const WIDTH = MR - ML;
  const footerOn = (pageNo: number) => (foot.pages === "first" ? pageNo === 1 : foot.pages === "continuation" ? pageNo > 1 : true);
  // Content stops above the footer band, not at the bottom margin, so a long letter can never run into it.
  const MB = margin.bottom + (foot.show ? (foot.height ?? 26) : 0);

  // Serif body for a formal feel (Helvetica when the design asks for sans); monospaced figures so table money
  // columns align like a ledger whichever body face is in use.
  const serif = pageOpts.font !== "sans";
  const font = await doc.embedFont(serif ? StandardFonts.TimesRoman : StandardFonts.Helvetica);
  const bold = await doc.embedFont(serif ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);
  // The artwork is the row's own image when there is one; a letter with no letterhead still gets the
  // organization logo as its mark, which is the behaviour every document had before designs existed.
  // A letterhead holds several images by slot; each band draws the one its design names. Only the slots the
  // design uses were fetched, so anything else is simply absent here.
  // Three INDEPENDENT bands, each naming its own image: the header mark, the stationery under the sheet, and
  // the watermark. Any combination is legal - turning one off leaves the other two exactly as they were.
  // This version's own images, one per job. An image IS its job: the mark is the header logo, the stationery
  // is the sheet, the watermark is the wash. A slot with no image draws nothing, and `show: false` keeps the
  // image but stops drawing it.
  const images = content.letterhead?.artwork ?? {};
  const mark = { ...STOCK_LETTERHEAD.header.mark, ...design.header?.mark };
  const logo = mark.show === false ? null : ((await embedLogo(doc, images.mark)) ?? (await embedLogo(doc, content.org.logo)));
  const pageArt = bg.show === false ? null : await embedLogo(doc, images.stationery);
  const wmImage = design.watermark?.show === false ? null : await embedLogo(doc, images.watermark);

  // Tokens a header line, footer cell or watermark may interpolate. `page`/`pages` are filled per page in the
  // footer pass, where the total is finally known.
  const tokens: Partial<Record<LetterheadToken, string>> = {
    org_name: content.org.name || "",
    legal_name: content.org.legalName || content.org.name || "",
    address: (content.org.address || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(", "),
    date: content.date,
  };

  let page: PDFPage = doc.addPage([PW, PH]);
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

  // Draw a line of header text at its own alignment, and return the height it consumed.
  function headerLine(s: string, size: number, f: PDFFont, color: Color, align: "left" | "center" | "right", yy: number) {
    const filled = fillTokens(s, tokens);
    const x = align === "left" ? ML : align === "right" ? MR - w(filled, f, size) : ML + (WIDTH - w(filled, f, size)) / 2;
    text(filled, x, yy, f, size, color);
  }

  // The header band: company name + address + any extra lines, with the mark on the chosen side and a rule
  // under the lot. Drawn full on page 1; `repeat` decides what continuation pages get, so a multi-page letter
  // still reads as one document. A design that turns the band off (its artwork already draws one) reserves
  // `header.height` of blank instead, which is what keeps the body clear of pre-printed stationery.
  function drawHeader(full: boolean) {
    const variant = full ? "full" : (head.repeat ?? "slim");
    if (head.show === false || variant === "none") {
      y -= head.height ?? 0;
      return;
    }
    if (variant === "slim") {
      const name = head.name?.text || content.org.name || "";
      text(head.name?.case === "asis" ? name : name.toUpperCase(), ML, y, bold, 7.5, MUTED);
      y -= 8;
      if (head.rule?.show !== false) rule(ML, y, MR, 0.75, HAIR);
      y -= 18;
      return;
    }

    const top = y;
    const nameCfg = head.name ?? {};
    let ay = y;
    if (nameCfg.show !== false) {
      const raw = nameCfg.text || content.org.name || "";
      const size = nameCfg.size ?? 10;
      headerLine(nameCfg.case === "asis" ? raw : raw.toUpperCase(), size, nameCfg.weight === "regular" ? font : bold, paint(nameCfg.color, DARK), "left", ay);
      ay -= size + 3;
    }
    const addrCfg = head.address ?? {};
    if (addrCfg.show !== false) {
      const size = addrCfg.size ?? 7.5;
      const lines = (addrCfg.text ?? content.org.address ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const ln of lines) {
        headerLine(ln, size, font, paint(addrCfg.color, MUTED), "left", ay);
        ay -= size + 2.5;
      }
    }
    for (const ln of head.lines ?? []) {
      const size = ln.size ?? 7.5;
      headerLine(ln.text, size, ln.weight === "bold" ? bold : font, paint(ln.color, MUTED), ln.align ?? "left", ay);
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
    // makes a design line up with artwork that was measured in a design tool.
    y = head.height != null ? top - head.height : ay - 8;
    if (head.rule?.show !== false) {
      y -= head.rule?.gap ?? 0;
      rule(ML, y, MR, head.rule?.weight ?? 2, paint(head.rule?.color, ACCENT));
    }
    y -= 24;
  }

  // Full-bleed stationery and the watermark go down before anything else on the sheet, so the body prints on
  // top of them rather than under them.
  function drawPageFurniture(pageNo: number) {
    if (pageArt && (bg.pages === "all" || pageNo === 1)) {
      const scale = Math.max(PW / pageArt.width, PH / pageArt.height); // cover: no bare margin on any edge
      const iw = pageArt.width * scale;
      const ih = pageArt.height * scale;
      page.drawImage(pageArt, { x: (PW - iw) / 2, y: (PH - ih) / 2, width: iw, height: ih, opacity: bg.opacity ?? 1 });
    }
    // An image watermark wins over text; with neither there is nothing to wash across the sheet.
    const wm = design.watermark ?? {};
    if (wm.show === false || (!wm.text && !wmImage)) return;
    const opacity = wm.opacity ?? 0.08;
    const angle = wm.angle ?? 45;
    if (wmImage) {
      const h = wm.size ?? 260;
      const scale = h / wmImage.height;
      const iw = wmImage.width * scale;
      page.drawImage(wmImage, { x: (PW - iw) / 2, y: (PH - h) / 2, width: iw, height: h, opacity, rotate: degrees(angle) });
      return;
    }
    if (!wm.text) return;
    const size = wm.size ?? 72;
    const s = enc(fillTokens(wm.text, tokens));
    const tw = bold.widthOfTextAtSize(s, size);
    const rad = (angle * Math.PI) / 180;
    // Rotation pivots on the anchor, so step back along the rotated baseline to land the string's MIDDLE at
    // the middle of the sheet.
    page.drawText(s, {
      x: PW / 2 - (tw / 2) * Math.cos(rad),
      y: PH / 2 - (tw / 2) * Math.sin(rad) - size * 0.35,
      size,
      font: bold,
      color: paint(wm.color, MUTED),
      opacity,
      rotate: degrees(angle),
    });
  }

  function newPage() {
    page = doc.addPage([PW, PH]);
    y = MT;
    firstPage = false;
    pageIndex++;
    drawPageFurniture(pageIndex);
    drawHeader(false);
  }

  // Reserve vertical space; spill to a new page if it won't fit above the bottom margin.
  function need(h: number) {
    if (y - h < MB) newPage();
  }

  drawPageFurniture(1);
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

  void firstPage; // (tracked for the header variant)

  // ── Footer band, drawn once the page count is known so {{page}} of {{pages}} can be honest. Content already
  //    stopped above this band (MB), so nothing here can land on top of a paragraph. ───────────────────────
  const sheets = doc.getPages();
  if (foot.show === true) {
    const size = foot.size ?? 7.5;
    const height = foot.height ?? 26;
    const color = paint(foot.color, MUTED);
    sheets.forEach((p, i) => {
      const pageNo = i + 1;
      if (!footerOn(pageNo)) return;
      const vals = { ...tokens, page: String(pageNo), pages: String(sheets.length) };
      const ruleY = margin.bottom + height - 6;
      if (foot.rule?.show !== false) {
        p.drawLine({ start: { x: ML, y: ruleY }, end: { x: MR, y: ruleY }, thickness: foot.rule?.weight ?? 0.5, color: paint(foot.rule?.color, HAIR) });
      }
      const baseline = ruleY - size - 5;
      const cell = (raw: string | undefined, align: "left" | "center" | "right") => {
        if (!raw) return;
        const s = enc(fillTokens(raw, vals));
        const tw = font.widthOfTextAtSize(s, size);
        const x = align === "left" ? ML : align === "right" ? MR - tw : ML + (WIDTH - tw) / 2;
        p.drawText(s, { x, y: baseline, size, font, color });
      };
      cell(foot.left, "left");
      cell(foot.center, "center");
      cell(foot.right, "right");
    });
  }

  return { bytes: await doc.save(), signAnchors };
}
