import { PDFDocument, PDFImage, rgb } from "pdf-lib";
import { BRAND, BRAND_NEUTRAL, hexToRgb01 } from "../domain/brand";

// Shared primitives for the server-side PDF renderers (payslip + HR letters). pdf-lib is pure JS and runs
// in Workers; the base fonts are WinAnsi-encoded (no ₹, no smart quotes), so all text passes through enc().
// Nothing here is hardcoded business data - these are font/encoding/number-formatting utilities.

// Palette: the brand Neutral ramp (src/domain/brand.ts), converted to pdf-lib's 0..1 components. No colour
// value is written here - change the ramp in brand.ts and every generated PDF follows.
const ink = (hex: string) => rgb(...hexToRgb01(hex));
export const DARK = ink(BRAND.ink); // headings, totals, the heavy rules
export const SLATE = ink(BRAND_NEUTRAL[800]); // body copy
export const MUTED = ink(BRAND.muted); // secondary text
export const LABEL = ink(BRAND.label); // column headers, the quietest legible text
export const HAIR = ink(BRAND.hairline); // rules, boxes, dividers
export const FAINT = ink(BRAND.faint); // row separators

export const PAGE_W = 595.28; // A4 at 72dpi
export const PAGE_H = 841.89;

// Coerce a string to characters the base (WinAnsi) font can encode, so an unusual glyph never crashes a
// render job. Common typographic glyphs map to ASCII; anything else outside Latin-1 becomes "?".
const GLYPHS: Record<string, string> = {
  "₹": "INR ", "–": "-", "—": "-", "−": "-", "•": "*",
  "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...",
};
export function enc(s: string | number | undefined | null): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (GLYPHS[ch]) { out += GLYPHS[ch]; continue; }
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += ch;
    else if (c === 0x09) out += " ";
    else out += "?";
  }
  return out;
}

// Indian-grouped amount at `decimals` places (default 2; e.g. 1234567.5 -> "12,34,567.50", or "12,34,568"
// with decimals 0). Avoids Intl, which is not reliable in the Workers runtime. `decimals` comes from the
// currency's configured precision (decimalsFor) so payslips/letters show the same digits as the rest of the app.
export function money(n: number, decimals = 2): string {
  const dp = Math.min(4, Math.max(0, Math.trunc(decimals)));
  const neg = n < 0;
  const [intPart = "0", frac] = Math.abs(n).toFixed(dp).split(".");
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : "") + last3;
  return (neg ? "-" : "") + grouped + (dp > 0 ? "." + frac : "");
}

// Indian-grouped whole amount, no decimals (e.g. 1234567 -> "12,34,567"). Used for CTC figures in letters.
export function moneyWhole(n: number): string {
  return money(Math.round(n), 0);
}

// Indian-system number to words. Includes the paise clause only when the currency shows decimals
// (`withPaise`); a whole-rupee currency (INR at 0dp) reads "... only" with no paise.
export function amountInWords(n: number, withPaise = true): string {
  if (n === 0) return "Zero only";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (num: number): string => (num < 20 ? ones[num]! : tens[Math.floor(num / 10)]! + (num % 10 ? " " + ones[num % 10]! : ""));
  const three = (num: number): string => (num >= 100 ? ones[Math.floor(num / 100)]! + " Hundred" + (num % 100 ? " " + two(num % 100) : "") : two(num));
  const neg = n < 0;
  let rupees = withPaise ? Math.floor(Math.abs(n)) : Math.round(Math.abs(n));
  const paise = withPaise ? Math.round((Math.abs(n) - Math.floor(Math.abs(n))) * 100) : 0;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(three(crore) + " Crore");
  if (lakh) parts.push(two(lakh) + " Lakh");
  if (thousand) parts.push(two(thousand) + " Thousand");
  if (rupees) parts.push(three(rupees));
  let words = parts.join(" ");
  if (paise) words += (words ? " and " : "") + two(paise) + " Paise";
  return (neg ? "Minus " : "") + (words || "Zero") + " only";
}

// Long-form date "22 June 2026" (day month year) - the convention used across the letters/certificates, not
// ISO YYYY-MM-DD. UTC, matching the letter body's fmtDate so a signed date reads the same as the letter date.
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function formatLongDate(d: Date): string {
  return `${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export async function embedLogo(doc: PDFDocument, dataUrl?: string): Promise<PDFImage | null> {
  if (!dataUrl) return null;
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return null; // SVG / other formats can't be embedded by pdf-lib; fall back to the name only
  try {
    const bytes = Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0));
    return /png/i.test(m[1]!) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null;
  }
}
