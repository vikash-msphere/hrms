import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type Color } from "pdf-lib";
import { DARK, SLATE, MUTED, LABEL, HAIR, FAINT, PAGE_W, PAGE_H, enc, money, amountInWords, embedLogo } from "./pdfPrimitives";
import {
  DEFAULT_PAYSLIP_TEMPLATE, PAYSLIP_ATTENDANCE_CELLS, substTokens,
  type PayslipAttendanceCell, type PayslipBlock, type PayslipBlockStyle, type PayslipTemplate,
} from "../domain/payslipTemplate";

// A4 payslip renderer. The LAYOUT is data: the caller passes a PayslipTemplate (the `payslip` settings blob,
// see src/domain/payslipTemplate.ts) and this walks its blocks top to bottom, drawing each with pdf-lib. The
// stock template reproduces the original fixed design - company header band, period + employee identity row,
// key/value detail grid, attendance strip, two-column earnings/deductions, net-pay box with amount in words.
// pdf-lib is pure JS and runs in Workers; nothing here is hardcoded business data - every value comes from the
// caller (org settings, the employee, the run item). Shared font/encoding/number-formatting helpers live in
// pdfPrimitives.ts (reused by the letter renderer).

export type PayslipLine = { name: string; kind: "earning" | "deduction"; amount: number };

export type PayslipData = {
  org: { name: string; address?: string; logo?: string };
  periodLabel: string; // banner, e.g. "June 2026"
  currencyCode: string; // ISO code shown as the money marker (font-safe; ₹ etc. are not in the base font)
  employee: { name: string; designation?: string; empNo?: string; department?: string };
  payment: { mode?: string; bankName?: string; ifsc?: string; accountMasked?: string };
  attendance?: { actualDays: number; workingDays: number; lopDays: number; daysPayable: number };
  lines: PayslipLine[];
  gross: number;
  totalDeductions: number;
  net: number;
  decimals?: number; // currency display precision (decimalsFor); default 2. INR configured to 0 = whole rupees.
};

const DEFAULT_MARGIN = 48; // page margin (left/right); TOP sits a little below it
const LETTER_W = 612, LETTER_H = 792; // US Letter at 72dpi (A4 comes from pdfPrimitives)

// #rrggbb -> pdf-lib Color. Invalid input can't reach here (parsePayslipTemplate validates), but fall back to
// the default ink anyway so a hand-edited DB row can't produce NaN coordinates.
function hexColor(hex: string | undefined, fallback: Color): Color {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export async function renderPayslipPdf(d: PayslipData, template: PayslipTemplate = DEFAULT_PAYSLIP_TEMPLATE): Promise<Uint8Array> {
  const dp = Math.min(4, Math.max(0, Math.trunc(d.decimals ?? 2))); // currency display precision
  const opt = template.options ?? {};
  // Page geometry + palette are document-level config; every value falls back to the stock design, so an
  // unstyled template renders byte-identically to the built-in one.
  const pw = opt.pageSize === "letter" ? LETTER_W : PAGE_W;
  const ph = opt.pageSize === "letter" ? LETTER_H : PAGE_H;
  const margin = opt.margin ?? DEFAULT_MARGIN;
  const ML = margin; // left margin
  const MR = Math.round(pw - margin); // right edge of content (whole points; A4 at the default margin = 547)
  const TOP = ph - margin - 2; // first baseline on a page
  const BOTTOM = Math.max(24, margin + 8); // break to a new page rather than draw below this
  const S = opt.scale ?? 1; // multiplies DEFAULT sizes only - an explicit block size wins
  const ds = (n: number) => n * S;
  const doc = await PDFDocument.create();
  // Serif (Times) reads like a formal statement; sans (Helvetica) is the alternative. Money always uses the
  // monospaced face so columns align like a ledger.
  const serif = template.options?.font !== "sans";
  const font = await doc.embedFont(serif ? StandardFonts.TimesRoman : StandardFonts.Helvetica);
  const bold = await doc.embedFont(serif ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);
  const logo = await embedLogo(doc, d.org.logo);
  // Palette: `ink` recolours primary text, `muted` both secondary tones, `hairline` both line tones - each
  // keeping its own default when unset, so the stock contrast survives a single override.
  const ACCENT = hexColor(opt.accent, DARK);
  const INK = hexColor(opt.ink, DARK);
  const BODY = hexColor(opt.ink, SLATE);
  const SOFT = hexColor(opt.muted, MUTED);
  const CAPS = hexColor(opt.muted, LABEL);
  const LINE = hexColor(opt.hairline, HAIR);
  const LINE_FAINT = hexColor(opt.hairline, FAINT);

  let page: PDFPage = doc.addPage([pw, ph]);
  let y = TOP;

  type Opt = { f?: PDFFont; size?: number; color?: Color };
  const w = (s: string, f: PDFFont, size: number) => f.widthOfTextAtSize(s, size);
  const at = (s: string, x: number, yy: number, o: Opt = {}) => page.drawText(enc(s), { x, y: yy, size: o.size ?? ds(9), font: o.f ?? font, color: o.color ?? BODY });
  const right = (s: string, xr: number, yy: number, o: Opt = {}) => at(s, xr - w(enc(s), o.f ?? font, o.size ?? ds(9)), yy, o);
  const center = (s: string, xc: number, yy: number, o: Opt = {}) => at(s, xc - w(enc(s), o.f ?? font, o.size ?? ds(9)) / 2, yy, o);
  const rule = (x1: number, yy: number, x2: number, thickness = 0.5, color: Color = LINE) => page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });
  // Break to a fresh page when `need` points of vertical space aren't left. Blocks call this before drawing, so
  // a long custom template flows onto page 2 instead of running off the bottom.
  const room = (need: number) => {
    if (y - need >= BOTTOM) return;
    page = doc.addPage([pw, ph]);
    y = TOP;
  };

  // ── Per-block style resolution ────────────────────────────────────────────────────────────────────
  // Each block may override the size, colour and weight of its PRIMARY text; anything unset keeps the stock
  // value (scaled by options.scale). `align` is honoured by the blocks that have a single text column.
  const sizeOf = (st: PayslipBlockStyle | undefined, dflt: number) => st?.size ?? ds(dflt);
  const colorOf = (st: PayslipBlockStyle | undefined, dflt: Color) => (st?.color ? hexColor(st.color, dflt) : dflt);
  const fontOf = (st: PayslipBlockStyle | undefined, dflt: PDFFont) =>
    st?.weight === "bold" ? bold : st?.weight === "regular" ? font : dflt;
  // Draw `s` at the block's alignment within [x0, x1].
  const aligned = (s: string, align: PayslipBlockStyle["align"], x0: number, x1: number, yy: number, o: Opt = {}) => {
    if (align === "center") center(s, (x0 + x1) / 2, yy, o);
    else if (align === "right") right(s, x1, yy, o);
    else at(s, x0, yy, o);
  };

  // The {{token}} values a kvGrid / note / footer may interpolate.
  const tokens: Record<string, string> = {
    org_name: d.org.name || "",
    period: d.periodLabel || "",
    employee_name: d.employee.name || "",
    employee_no: d.employee.empNo || "",
    designation: d.employee.designation || "",
    department: d.employee.department || "",
    payment_mode: d.payment.mode || "",
    bank_name: d.payment.bankName || "",
    bank_ifsc: d.payment.ifsc || "",
    bank_account: d.payment.accountMasked || "",
    currency: d.currencyCode,
    gross: money(d.gross, dp),
    deductions: money(d.totalDeductions, dp),
    net: money(d.net, dp),
  };
  const fill = (s: string | undefined) => substTokens(s ?? "", tokens);

  const colW = (MR - ML) / 3;

  function orgHeader(b: Extract<PayslipBlock, { kind: "orgHeader" }>) {
    const st = b.style;
    const showLogo = b.showLogo !== false && !!logo;
    const LOGO_H = b.logoHeight ?? 36;
    const nameSize = sizeOf(st, 13);
    room(Math.max(70, LOGO_H + 34));
    const logoLeft = b.logoAlign === "left";
    // Text side: the logo takes one side, so the name/address column gets the other. With the logo on the left
    // the text is right-aligned by default (mirror image of the stock header).
    const lw = showLogo && logo ? (LOGO_H / logo.height) * logo.width : 0;
    const tx0 = logoLeft ? ML + lw + 12 : ML;
    const tx1 = logoLeft ? MR : MR - lw - 12;
    const align = st?.align ?? (logoLeft ? "right" : "left");
    aligned(d.org.name || "", align, tx0, tx1, y, { f: fontOf(st, bold), size: nameSize, color: colorOf(st, INK) });
    let ay = y - (nameSize + 1);
    if (b.showAddress !== false) {
      for (const ln of (d.org.address || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        aligned(ln, align, tx0, tx1, ay, { size: ds(8), color: SOFT });
        ay -= ds(11);
      }
    }
    if (showLogo && logo) {
      page.drawImage(logo, { x: logoLeft ? ML : MR - lw, y: y - LOGO_H + 9, width: lw, height: LOGO_H });
    }
    // The header ends below whichever is lower: the address block, or the logo's drawn bottom edge.
    y = Math.min(ay, y - (showLogo ? LOGO_H - 9 : 0)) - 8;
  }

  function identity(b: Extract<PayslipBlock, { kind: "identity" }>) {
    const st = b.style;
    const periodSize = sizeOf(st, 16);
    room(periodSize + 34);
    at(d.periodLabel, ML, y, { f: fontOf(st, bold), size: periodSize, color: colorOf(st, INK) });
    if (b.caption !== "") at(fill(b.caption ?? "Payslip"), ML, y - ds(14), { size: ds(9), color: SOFT });
    right(d.employee.name, MR, y, { f: bold, size: periodSize - ds(2), color: colorOf(st, INK) });
    if (b.showDesignation !== false && d.employee.designation) right(d.employee.designation, MR, y - ds(14), { size: ds(9), color: SOFT });
    y -= periodSize + ds(12);
  }

  function kvGrid(b: Extract<PayslipBlock, { kind: "kvGrid" }>) {
    const st = b.style;
    const cols = b.columns ?? 3;
    const cw = (MR - ML) / cols;
    const rows = Math.ceil(b.fields.length / cols);
    const pitch = b.rowHeight ?? ds(34);
    const labelSize = b.labelSize ?? ds(6.5);
    const valueSize = sizeOf(st, 9);
    room(rows * pitch + 6);
    b.fields.forEach((f, i) => {
      const x = ML + (i % cols) * cw;
      const ry = y - Math.floor(i / cols) * pitch;
      at(b.labelCase === "asis" ? f.label : f.label.toUpperCase(), x, ry, { f: bold, size: labelSize, color: CAPS });
      at(fill(f.value) || "-", x, ry - (labelSize + ds(4.5)), { f: fontOf(st, font), size: valueSize, color: colorOf(st, INK) });
    });
    y -= rows * pitch + 6;
  }

  function attendance(b: Extract<PayslipBlock, { kind: "attendance" }>) {
    if (!d.attendance) return; // the run carried no attendance facts - the strip is simply absent
    const st = b.style;
    const LABELS: Record<PayslipAttendanceCell, string> = {
      actual: "Actual Days", working: "Working Days", lop: "Loss of Pay", payable: "Days Payable",
    };
    const VALUES: Record<PayslipAttendanceCell, number> = {
      actual: d.attendance.actualDays, working: d.attendance.workingDays,
      lop: d.attendance.lopDays, payable: d.attendance.daysPayable,
    };
    const picked = b.cells ?? PAYSLIP_ATTENDANCE_CELLS;
    const h = b.cellHeight ?? ds(40);
    room(h + ds(36));
    at((b.title ?? "Attendance").toUpperCase(), ML, y, { f: bold, size: ds(6.5), color: CAPS });
    y -= ds(14);
    const cw = (MR - ML) / picked.length, top = y;
    page.drawRectangle({ x: ML, y: top - h, width: MR - ML, height: h, borderColor: LINE, borderWidth: 0.75 });
    picked.forEach((key, i) => {
      const cx = ML + i * cw + cw / 2;
      if (i > 0) page.drawLine({ start: { x: ML + i * cw, y: top }, end: { x: ML + i * cw, y: top - h }, thickness: 0.75, color: LINE });
      center(String(VALUES[key]), cx, top - h * 0.45, { f: monoBold, size: sizeOf(st, 12), color: colorOf(st, INK) });
      center(LABELS[key].toUpperCase(), cx, top - h * 0.8, { f: bold, size: ds(6), color: CAPS });
    });
    y = top - h - 22;
  }

  function earningsDeductions(b: Extract<PayslipBlock, { kind: "earningsDeductions" }>) {
    const st = b.style;
    const earnings = d.lines.filter((l) => l.kind === "earning");
    const deductions = d.lines.filter((l) => l.kind === "deduction");
    const rowSize = sizeOf(st, 9);
    const pitch = ds(15);
    // Both columns are drawn from the same top, so the block needs room for the taller of the two.
    room(ds(36) + Math.max(earnings.length, deductions.length) * pitch + ds(24));
    const sp = (MR - ML) * (b.split ?? 0.5); // left column's share of the content width
    const lcL = ML, lcR = ML + sp - 10; // left column
    const rcL = ML + sp + 10, rcR = MR; // right column
    const tableTop = y;
    const amountLabel = (b.amountLabel ?? "Amount").toUpperCase();
    const rowInk = colorOf(st, BODY);

    const table = (xL: number, xR: number, head: string, rows: PayslipLine[], totalLabel: string, total: number): number => {
      let ty = tableTop;
      at(head.toUpperCase(), xL, ty, { f: bold, size: ds(7), color: SOFT });
      right(amountLabel, xR, ty, { f: bold, size: ds(7), color: SOFT });
      ty -= 6;
      rule(xL, ty, xR, 1.5, ACCENT);
      ty -= pitch;
      rows.forEach((r, i) => {
        if (b.zebra && i % 2 === 1) {
          page.drawRectangle({ x: xL - 3, y: ty - 4, width: xR - xL + 6, height: pitch - 1, color: LINE_FAINT });
        }
        at(r.name, xL, ty, { f: fontOf(st, font), size: rowSize, color: rowInk });
        right(money(r.amount, dp), xR, ty, { f: mono, size: rowSize, color: rowInk });
        if (b.rowBorders) rule(xL, ty - 4, xR, 0.4, LINE);
        ty -= pitch;
      });
      ty -= 1;
      rule(xL, ty + 9, xR);
      at(totalLabel, xL, ty - 3, { f: bold, size: rowSize, color: colorOf(st, INK) });
      right(money(total, dp), xR, ty - 3, { f: monoBold, size: rowSize, color: colorOf(st, INK) });
      return ty - 18;
    };

    const leftEnd = table(lcL, lcR, b.earningsTitle ?? "Earnings", earnings, b.earningsTotalLabel ?? "Total Earnings (A)", d.gross);
    const rightEnd = table(rcL, rcR, b.deductionsTitle ?? "Deductions", deductions, b.deductionsTotalLabel ?? "Total Deductions (B)", d.totalDeductions);
    const lo = Math.min(leftEnd, rightEnd);
    // Column divider spanning the taller column.
    page.drawLine({ start: { x: ML + sp, y: tableTop + 4 }, end: { x: ML + sp, y: lo + 10 }, thickness: 0.5, color: LINE_FAINT });
    y = lo - 6;
  }

  function netBox(b: Extract<PayslipBlock, { kind: "netBox" }>) {
    const st = b.style;
    const amountSize = sizeOf(st, 16);
    const boxH = Math.max(ds(50), amountSize + ds(34));
    const border = b.borderWidth ?? 1.5;
    room(boxH + 16);
    page.drawRectangle({
      x: ML, y: y - boxH, width: MR - ML, height: boxH,
      borderColor: ACCENT, borderWidth: border,
      ...(b.fill ? { color: hexColor(b.fill, ACCENT) } : {}),
    });
    at((b.label ?? "Net Salary Payable (A - B)").toUpperCase(), ML + 14, y - ds(18), { f: bold, size: ds(7), color: SOFT });
    if (b.showWords !== false) at(amountInWords(d.net, dp > 0), ML + 14, y - ds(33), { size: ds(8), color: BODY });
    right(`${d.currencyCode} ${money(d.net, dp)}`, MR - 14, y - boxH * 0.56, { f: monoBold, size: amountSize, color: colorOf(st, INK) });
    y -= boxH + 16;
  }

  function note(b: Extract<PayslipBlock, { kind: "note" }>) {
    const st = b.style;
    const text = fill(b.text);
    if (!text) return;
    const size = sizeOf(st, b.emphasis ? 9 : 8);
    room(size + 8);
    const dfltFont = b.emphasis ? bold : font;
    const dfltInk = b.emphasis ? INK : SOFT;
    // The block's own `align` is the historical knob; a style align overrides it (and adds "right").
    aligned(text, st?.align ?? b.align ?? "left", ML, MR, y, { size, f: fontOf(st, dfltFont), color: colorOf(st, dfltInk) });
    y -= size + 8;
  }

  // Closing strip: its own faint hairline (a footer IS the rule plus the fine print), then the two captions.
  function footer(b: Extract<PayslipBlock, { kind: "footer" }>) {
    const st = b.style;
    const size = sizeOf(st, 6.5);
    const ink = colorOf(st, CAPS);
    room(size + 18);
    rule(ML, y, MR, 0.5, LINE_FAINT);
    y -= 12;
    if (b.left) at(fill(b.left), ML, y, { size, color: ink, f: fontOf(st, font) });
    if (b.right) right(fill(b.right), MR, y, { size, color: ink, f: fontOf(st, font) });
    y -= 10;
  }

  for (const b of template.blocks) {
    // Shared spacing: `spaceBefore` is consumed before the block claims room, `spaceAfter` after it draws.
    if (b.kind !== "gap" && b.style?.spaceBefore) y -= b.style.spaceBefore;
    switch (b.kind) {
      case "orgHeader": orgHeader(b); break;
      case "identity": identity(b); break;
      case "kvGrid": kvGrid(b); break;
      case "attendance": attendance(b); break;
      case "earningsDeductions": earningsDeductions(b); break;
      case "netBox": netBox(b); break;
      case "note": note(b); break;
      case "rule": {
        const weight = b.weight ?? 0.5;
        room(6);
        rule(ML, y, MR, weight, b.color ? hexColor(b.color, ACCENT) : weight >= 1 ? ACCENT : LINE);
        y -= weight >= 1 ? 24 : 18;
        break;
      }
      case "gap": y -= b.height ?? 8; break;
      case "footer": footer(b); break;
    }
    if (b.kind !== "gap" && b.style?.spaceAfter) y -= b.style.spaceAfter;
  }

  return await doc.save();
}
