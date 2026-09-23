import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  DEFAULT_PAYSLIP_TEMPLATE, MAX_BLOCKS, parsePayslipTemplate, payslipTemplateOrDefault, substTokens,
} from "../src/domain/payslipTemplate";
import { renderPayslipPdf, type PayslipData } from "../src/lib/pdf";

// The payslip DESIGN is data (the `payslip` settings blob). These cover the two halves of that: the validator
// that guards what may be stored, and the renderer that walks whatever survived.
const DATA: PayslipData = {
  org: { name: "Acme Industries", address: "1 Example Road\nExample City" },
  periodLabel: "June 2026",
  currencyCode: "INR",
  employee: { name: "Test Employee", designation: "Engineer", empNo: "EMP-0007", department: "Engineering" },
  payment: { mode: "Bank Transfer", bankName: "Sample Bank", ifsc: "SMPL0000123", accountMasked: "•••• 4242" },
  attendance: { actualDays: 21, workingDays: 22, lopDays: 1, daysPayable: 21 },
  lines: [
    { name: "Basic", kind: "earning", amount: 40000 },
    { name: "HRA", kind: "earning", amount: 16000 },
    { name: "Employee PF", kind: "deduction", amount: 1800 },
  ],
  gross: 56000,
  totalDeductions: 1800,
  net: 54200,
  decimals: 0,
};
const isPdf = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5)) === "%PDF-";

// The page's drawing operators, inflated out of the PDF. Used to assert WHERE things are drawn (byte length is
// no good: pdf-lib's deflated metadata carries a timestamp, so it jitters, and small coordinate shifts don't
// change it at all).
async function inflate(raw: Uint8Array): Promise<string | null> {
  // DecompressionStream is strict about trailing bytes, and a PDF stream ends with an EOL before `endstream`,
  // so trim a couple of bytes off the tail until it takes (or give up - the stream may not be deflated at all).
  for (let trim = 0; trim <= 2; trim++) {
    try {
      const slice = raw.slice(0, raw.length - trim);
      const stream = new Blob([slice.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new TextDecoder("latin1").decode(new Uint8Array(await new Response(stream).arrayBuffer()));
    } catch {
      /* try a shorter slice */
    }
  }
  return null;
}
async function drawingOps(pdf: Uint8Array): Promise<string> {
  const text = new TextDecoder("latin1").decode(pdf);
  let best = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = text.indexOf("endstream", m.index);
    if (end < 0) continue;
    const raw = pdf.subarray(m.index + m[0].length, end);
    const out = (await inflate(raw)) ?? new TextDecoder("latin1").decode(raw);
    if ((out.includes(" Tj") || out.includes(" re")) && out.length > best.length) best = out;
  }
  return best;
}

describe("payslip template validation", () => {
  it("accepts the stock design unchanged (round-trip stable)", () => {
    expect(parsePayslipTemplate(DEFAULT_PAYSLIP_TEMPLATE)).toEqual(DEFAULT_PAYSLIP_TEMPLATE);
  });
  it("rejects an unknown block kind, naming it", () => {
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "script" }] })).toThrow(/block 0: unknown kind "script"/);
  });
  it("rejects a wrongly-typed property, naming the block and field", () => {
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "netBox", label: 12 }] })).toThrow(/block 0 \(netBox\)\.label must be a string/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "kvGrid", columns: 5, fields: [] }] })).toThrow(/columns must be a number in \[2, 3\]/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "gap", height: 999 }] })).toThrow(/height must be a number in \[0, 120\]/);
  });
  it("rejects a non-hex accent and a bad font", () => {
    expect(() => parsePayslipTemplate({ options: { accent: "red" }, blocks: [] })).toThrow(/#rrggbb/);
    expect(() => parsePayslipTemplate({ options: { font: "comic" }, blocks: [] })).toThrow(/serif.*sans/);
  });
  it("bounds the page-level knobs", () => {
    expect(() => parsePayslipTemplate({ options: { pageSize: "a3" }, blocks: [] })).toThrow(/a4, letter/);
    expect(() => parsePayslipTemplate({ options: { margin: 8 }, blocks: [] })).toThrow(/margin must be a number in \[24, 96\]/);
    expect(() => parsePayslipTemplate({ options: { scale: 3 }, blocks: [] })).toThrow(/scale must be a number in \[0\.8, 1\.25\]/);
    expect(() => parsePayslipTemplate({ options: { ink: "black" }, blocks: [] })).toThrow(/#rrggbb/);
  });
  it("validates the shared block style and the per-kind knobs", () => {
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "note", text: "x", style: { size: 99 } }] })).toThrow(/style\.size must be a number in \[5, 36\]/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "note", text: "x", style: { weight: "heavy" } }] })).toThrow(/style\.weight must be one of regular, bold/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "note", text: "x", style: { spaceBefore: -5 } }] })).toThrow(/spaceBefore/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "earningsDeductions", split: 0.9 }] })).toThrow(/split must be a number in \[0\.3, 0\.7\]/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "attendance", cells: [] }] })).toThrow(/at least one figure/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "attendance", cells: ["overtime"] }] })).toThrow(/cells\[0\] must be one of actual, working, lop, payable/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "orgHeader", logoAlign: "middle" }] })).toThrow(/logoAlign must be one of left, right/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "netBox", fill: "#ffff" }] })).toThrow(/fill must be a #rrggbb/);
    expect(() => parsePayslipTemplate({ blocks: [{ kind: "employerCost", showTotals: "yes" }] })).toThrow(/showTotals must be a boolean/);
    expect(parsePayslipTemplate({ blocks: [{ kind: "employerCost", title: "Employer cost", aboveCtcSuffix: "(outside CTC)", showTotals: false }] }).blocks[0])
      .toEqual({ kind: "employerCost", title: "Employer cost", aboveCtcSuffix: "(outside CTC)", showTotals: false });
  });
  it("keeps style alongside the block's own properties on the way through", () => {
    const t = parsePayslipTemplate({ blocks: [{ kind: "netBox", label: "Take home", style: { size: 20, color: "#AABBCC" } }] });
    expect(t.blocks[0]).toEqual({ kind: "netBox", label: "Take home", style: { size: 20, color: "#aabbcc" } });
  });
  it("caps the block count", () => {
    const blocks = Array.from({ length: MAX_BLOCKS + 1 }, () => ({ kind: "rule" }));
    expect(() => parsePayslipTemplate({ blocks })).toThrow(new RegExp(`at most ${MAX_BLOCKS} blocks`));
  });
  it("drops unknown properties instead of storing them", () => {
    const t = parsePayslipTemplate({ blocks: [{ kind: "rule", weight: 1, sneaky: "x" }] });
    expect(t.blocks[0]).toEqual({ kind: "rule", weight: 1 });
  });
  it("falls back to the stock design for a missing or invalid stored blob (payroll must not break)", () => {
    expect(payslipTemplateOrDefault(null)).toEqual(DEFAULT_PAYSLIP_TEMPLATE);
    expect(payslipTemplateOrDefault({ blocks: [] })).toEqual(DEFAULT_PAYSLIP_TEMPLATE);
    expect(payslipTemplateOrDefault({ blocks: [{ kind: "nope" }] })).toEqual(DEFAULT_PAYSLIP_TEMPLATE);
  });
  it("substitutes known tokens and blanks unknown ones (never leaks {{foo}})", () => {
    expect(substTokens("Paid {{net}} to {{employee_name}}", { net: "54,200", employee_name: "Test" })).toBe("Paid 54,200 to Test");
    expect(substTokens("Hi {{nope}}!", {})).toBe("Hi !");
  });
});

// A payslip prints on one of two pages, and HR picks which in the payslip designer: its OWN sheet (the
// default, laid out entirely by these blocks) or the LETTERHEAD chosen for payslips. The figures are the same
// either way - only the sheet around them changes.
describe("payslip on a letterhead", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("takes the letterhead's page geometry, not the payslip design's", async () => {
    const own = await renderPayslipPdf(DATA, { options: { pageSize: "letter" }, blocks: DEFAULT_PAYSLIP_TEMPLATE.blocks });
    const onHead = await renderPayslipPdf(DATA, { options: { pageSize: "letter" }, blocks: DEFAULT_PAYSLIP_TEMPLATE.blocks }, { design: { page: { size: "a4" } } });
    const ownDoc = await PDFDocument.load(own);
    const headDoc = await PDFDocument.load(onHead);
    expect(Math.round(ownDoc.getPage(0).getSize().width)).toBe(612); // the design asked for US Letter
    expect(Math.round(headDoc.getPage(0).getSize().width)).toBe(595); // the LETTERHEAD asked for A4, and wins
  });

  it("draws the letterhead's stationery behind the figures", async () => {
    const bare = await renderPayslipPdf(DATA, DEFAULT_PAYSLIP_TEMPLATE, { design: {} });
    const withSheet = await renderPayslipPdf(DATA, DEFAULT_PAYSLIP_TEMPLATE, { design: {}, artwork: { stationery: PNG } });
    expect(withSheet.length).toBeGreaterThan(bare.length);
  });

  it("starts the figures BELOW the letterhead's header band, not at the payslip page's own top", async () => {
    // The payslip's own page puts its first baseline at the top margin (the geometry tripwire below pins
    // 791.89). On a letterhead the body starts under the band instead - so that baseline must be gone, which
    // is also the proof that the orgHeader block is not drawing a second masthead over the letterhead's.
    const own = await drawingOps(await renderPayslipPdf(DATA));
    expect(own).toContain("1 0 0 1 48 791.89 Tm");
    const onHead = await drawingOps(await renderPayslipPdf(DATA, DEFAULT_PAYSLIP_TEMPLATE, { design: {} }));
    expect(onHead).not.toContain("1 0 0 1 48 791.89 Tm");
  });

  it("leaves the payslip's own page untouched when no letterhead is passed", async () => {
    // The default path must be byte-identical to what it always was - this is the whole install's payslips.
    expect((await renderPayslipPdf(DATA)).length).toBe((await renderPayslipPdf(DATA, DEFAULT_PAYSLIP_TEMPLATE)).length);
  });
});

describe("payslip renderer walks the template", () => {
  it("renders the stock design", async () => {
    expect(isPdf(await renderPayslipPdf(DATA))).toBe(true);
  });
  it("pins the stock design's geometry (tripwire for accidental layout drift)", async () => {
    // Styling and theming knobs must leave an UNSTYLED template drawing exactly where it always did. These are
    // real coordinates from the page content stream: the content box (48 → 547), the first baseline, the header
    // rule, and the net-pay box. A stray point of padding or a changed default size moves them. If you change
    // the stock design deliberately, update these and look at the PDF - don't nudge them to go green.
    const ops = await drawingOps(await renderPayslipPdf(DATA));
    expect(ops).toContain("1 0 0 1 48 791.89 Tm"); // org name: left margin 48, top baseline 791.89
    expect(ops).toMatch(/\n547 \d+\.\d+ l\n/);     // full-width rules reach the content box's right edge, 547
    expect(ops).toMatch(/0 40 l\n499 40 l/);       // attendance strip: 499pt wide (547-48), 40pt tall
    expect(ops).toMatch(/0 50 l\n499 50 l/);       // net-pay box: 50pt tall
    expect(ops).toMatch(/ 16 Tf/);                 // period banner at its 16pt default
    expect(ops).toMatch(/ 6\.5 Tf/);               // small-caps labels at 6.5pt
    expect(ops).toMatch(/2 w\n/);                  // the 2pt accent rule under the header
  });
  it("renders a customised design (reordered, renamed, sans + accent, extra note)", async () => {
    const custom = parsePayslipTemplate({
      options: { font: "sans", accent: "#1d4ed8" },
      blocks: [
        { kind: "orgHeader", showLogo: false, showAddress: false },
        { kind: "identity", caption: "Salary statement", showDesignation: false },
        { kind: "note", text: "Employee {{employee_no}} - {{period}}", align: "center", emphasis: true },
        { kind: "earningsDeductions", earningsTitle: "Pay", deductionsTitle: "Withheld" },
        { kind: "kvGrid", columns: 2, fields: [{ label: "Bank", value: "{{bank_name}} {{bank_account}}" }] },
        { kind: "netBox", label: "Take home", showWords: false },
        { kind: "footer", right: "Amounts in {{currency}}." },
      ],
    });
    expect(isPdf(await renderPayslipPdf(DATA, custom))).toBe(true);
  });
  it("omits the attendance strip when the run carries no attendance facts", async () => {
    const { attendance, ...noAtt } = DATA;
    const withStrip = await renderPayslipPdf(DATA);
    const without = await renderPayslipPdf(noAtt as PayslipData);
    expect(isPdf(without)).toBe(true);
    expect(without.byteLength).toBeLessThan(withStrip.byteLength); // the strip's drawing ops are gone
  });
  // The employer-contribution block is the payslip's side of the CTC-inclusion policy: contributions counted
  // inside CTC total to Cost to Company; one the org keeps outside it is listed after that total, suffixed, with
  // an all-in total below. With no contributions on the run the block draws nothing at all.
  it("draws employer contributions, the CTC total and the all-in total; skips the block when there are none", async () => {
    const only = { blocks: [{ kind: "employerCost" as const }] };
    const withEmployer = await renderPayslipPdf({
      ...DATA,
      employerLines: [{ name: "Gratuity", amount: 1924 }, { name: "Employer PF", amount: 1800, aboveCtc: true }],
    }, only);
    // pdf-lib writes standard-font text as an UPPERCASE hex string, so assert on the hex of each caption.
    const hexOf = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
    const ops = await drawingOps(withEmployer);
    expect(ops).toContain(hexOf("Gratuity"));
    expect(ops).toContain(hexOf("Employer PF (over & above CTC)"));
    expect(ops).toContain(hexOf("Cost to Company (CTC)"));
    expect(ops).toContain(hexOf("57,924")); // gross 56000 + in-CTC gratuity 1924
    expect(ops).toContain(hexOf("Total Company Cost"));
    expect(ops).toContain(hexOf("59,724")); // + employer PF 1800, which sits outside CTC
    // No employer contributions on the run -> no block, no totals.
    expect(await drawingOps(await renderPayslipPdf(DATA, only))).not.toContain(hexOf("Cost to Company"));
  });
  it("applies per-block style without disturbing an unstyled template", async () => {
    const plain = await renderPayslipPdf(DATA);
    const styled = await renderPayslipPdf(DATA, parsePayslipTemplate({
      blocks: [
        { kind: "orgHeader", logoAlign: "left", logoHeight: 60, style: { size: 22, color: "#1d4ed8", align: "center", spaceAfter: 20 } },
        { kind: "kvGrid", columns: 2, labelCase: "asis", labelSize: 9, rowHeight: 44, fields: [{ label: "Bank", value: "{{bank_name}}" }], style: { size: 12, weight: "bold" } },
        { kind: "earningsDeductions", split: 0.6, zebra: true, rowBorders: true, style: { size: 11 } },
        { kind: "netBox", fill: "#eef2ff", borderWidth: 3, style: { size: 24 } },
        { kind: "attendance", cells: ["working", "payable"], cellHeight: 60 },
        { kind: "footer", left: "x", style: { size: 10, spaceBefore: 24 } },
      ],
    }));
    expect(isPdf(styled)).toBe(true);
    expect(styled.byteLength).not.toBe(plain.byteLength); // the knobs actually reach the page
  });
  it("honours page size, margin, scale and palette overrides", async () => {
    const letter = await renderPayslipPdf(DATA, parsePayslipTemplate({
      options: { pageSize: "letter", margin: 72, scale: 1.2, ink: "#111827", muted: "#6b7280", hairline: "#d1d5db" },
      blocks: DEFAULT_PAYSLIP_TEMPLATE.blocks,
    }));
    const doc = await PDFDocument.load(letter);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([612, 792]); // US Letter, not A4
  });
  it("A4 at the default margin keeps the historical 48/547 content box", async () => {
    const doc = await PDFDocument.load(await renderPayslipPdf(DATA));
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
  });
  it("flows a long template onto a second page instead of drawing off the bottom", async () => {
    // 24 grid rows at ~40pt each overrun one A4 page, so the renderer must break.
    const tall = parsePayslipTemplate({
      blocks: Array.from({ length: 24 }, () => ({ kind: "kvGrid", columns: 3, fields: [{ label: "Row", value: "{{department}}" }] })),
    });
    const bytes = await renderPayslipPdf(DATA, tall);
    expect(isPdf(bytes)).toBe(true);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    // The stock design still fits on exactly one page.
    expect((await PDFDocument.load(await renderPayslipPdf(DATA))).getPageCount()).toBe(1);
  });
});
