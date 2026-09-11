import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { enc } from "../src/lib/winAnsi";
import { stampSignature } from "../src/lib/pdfStamp";
import { renderLetterPdf, type LetterContent } from "../src/lib/letterPdf";
import { renderPayslipPdf, type PayslipData } from "../src/lib/pdf";

// Text that a base PDF font CANNOT encode, and what happens when it reaches one unsanitized.
//
// pdf-lib's standard fonts are WinAnsi, and it encodes to MEASURE as well as to draw
// (StandardFontEmbedder.encodeTextAsGlyphs). So an unencodable character is not a blank glyph or a fallback
// box - it THROWS, out of `widthOfTextAtSize`, before anything is drawn. That makes every unsanitized draw
// path a 500 waiting for one employee whose name is not in Latin-1, on documents (a signed policy, a payslip,
// an offer letter) where the answer to "try again" is that it will never work for that person.
//
// Every renderer therefore puts its text through `enc` (src/lib/winAnsi.ts). These are the cases that broke:
// an employee's `legal_name`, which nothing on the way in restricts to any charset, and the rupee sign, which
// is outside WinAnsi despite being the currency the whole app is priced in.
const HOSTILE = "अंकित शर्मा ₹ 李雷 🙂";

const isPdf = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5)) === "%PDF-";

/** A one-page PDF for the stamper to stamp. */
async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  return doc.save();
}

describe("the WinAnsi sanitizer", () => {
  it("keeps what the base font has and replaces what it does not", () => {
    expect(enc("O'Brien - Ltd")).toBe("O'Brien - Ltd");
    expect(enc("Ünal")).toBe("Ünal"); // Latin-1 survives
    expect(enc("’“”…–—•")).toBe("'\"\"...--*"); // typographic glyphs map to ASCII
    expect(enc("₹1,200")).toBe("INR 1,200");
    expect(enc("अंकित")).toBe("?????");
    expect(enc(undefined)).toBe("");
  });

  it("is what stands between those characters and a thrown render", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    // The failure this whole module exists for - and it is the MEASURE call, not the draw.
    expect(() => font.widthOfTextAtSize("₹", 8)).toThrow(/cannot encode/);
    expect(() => font.widthOfTextAtSize(enc("₹"), 8)).not.toThrow();
  });
});

describe("no renderer throws on a name the base font cannot encode", () => {
  it("the acknowledgement stamp - the attestation is the employee's legal name", async () => {
    // Unsanitized, this was a permanent 500 on `documents/{id}:acknowledge` for that employee: the policy
    // could not be signed, and no retry would change it.
    const out = await stampSignature(await blankPdf(), undefined, { page: 1, x1: 20, y1: 20, x2: 220, y2: 80 }, { name: HOSTILE, date: "13 June 2026" });
    expect(isPdf(out)).toBe(true);
  });

  it("a letter - every free-text field at once", async () => {
    const content: LetterContent = {
      org: { name: HOSTILE, address: `${HOSTILE}\n${HOSTILE}`, legalName: HOSTILE },
      date: "13 June 2026",
      ref: HOSTILE,
      to: { name: HOSTILE, lines: [HOSTILE] },
      blocks: [
        { kind: "subject", text: HOSTILE },
        { kind: "para", runs: [HOSTILE] },
        { kind: "signature", closing: HOSTILE, name: HOSTILE, title: HOSTILE },
      ],
      letterhead: { design: { footer: { show: true, center: `${HOSTILE} {{page}}/{{pages}}`, height: 40 }, watermark: { text: HOSTILE } } },
    };
    const { bytes } = await renderLetterPdf(content);
    expect(isPdf(bytes)).toBe(true);
  });

  it("a payslip - the org, the employee and a pay component's name", async () => {
    const data: PayslipData = {
      org: { name: HOSTILE, address: HOSTILE },
      periodLabel: "June 2026",
      currencyCode: "INR",
      employee: { name: HOSTILE, designation: HOSTILE, empNo: "EMP-0042", department: HOSTILE },
      payment: { mode: "BANK", bankName: HOSTILE, accountMasked: "****1234" },
      lines: [
        { name: HOSTILE, kind: "earning", amount: 50_000 },
        { name: HOSTILE, kind: "deduction", amount: 1_800 },
      ],
      gross: 50_000,
      totalDeductions: 1_800,
      net: 48_200,
    };
    expect(isPdf(await renderPayslipPdf(data))).toBe(true);
  });
});
