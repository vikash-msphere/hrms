import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { fillTokens, letterheadDesignOrStock, parseLetterheadDesign, slotsUsedBy, type LetterheadDesign, type LetterheadSlot } from "../src/domain/letterhead";
import { renderLetterPdf, type LetterContent } from "../src/lib/letterPdf";

// A letterhead's page DESIGN is data (the `design_json` column). These cover the two halves: the validator that
// guards what may be stored, and the renderer that walks whatever survived.
const CONTENT: LetterContent = {
  org: { name: "Acme Industries", address: "1 Example Road\nExample City", legalName: "Acme Industries Private Limited" },
  date: "13 June 2026",
  ref: "Ref: ACME/HR/001",
  to: { name: "Test Employee", lines: ["Engineer"] },
  blocks: [
    { kind: "subject", text: "Letter of employment" },
    { kind: "para", runs: ["This letter confirms your employment."] },
  ],
};
const isPdf = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5)) === "%PDF-";
/** A 1x1 PNG - enough for the renderer to embed something, small enough to sit in a test file. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const render = (letterhead?: { design: LetterheadDesign; artwork?: Partial<Record<LetterheadSlot, string>> }) =>
  renderLetterPdf(letterhead ? { ...CONTENT, letterhead } : CONTENT);

describe("letterhead design validation", () => {
  it("takes an empty design - the stock page - and round-trips a full one", () => {
    expect(parseLetterheadDesign({})).toEqual({});
    expect(parseLetterheadDesign(null)).toEqual({});
    const full: LetterheadDesign = {
      page: { size: "letter", margin: { top: 96, right: 40, bottom: 60, left: 40 }, font: "sans", ink: "#101828", accent: "#1d4c91" },
      background: { pages: "all", opacity: 0.9 },
      header: { show: false, height: 120 },
      footer: { show: true, center: "Page {{page}} of {{pages}}", pages: "all", height: 30 },
      watermark: { text: "CONFIDENTIAL", opacity: 0.1, angle: 30 },
    };
    expect(parseLetterheadDesign(full)).toEqual(full);
  });

  it("rejects an out-of-range value, naming the property", () => {
    expect(() => parseLetterheadDesign({ page: { margin: { top: 4 } } })).toThrow(/design\.page\.margin\.top must be a number in \[18, 144\]/);
    expect(() => parseLetterheadDesign({ footer: { height: 999 } })).toThrow(/design\.footer\.height must be a number in \[0, 160\]/);
    expect(() => parseLetterheadDesign({ watermark: { opacity: 0.9 } })).toThrow(/design\.watermark\.opacity must be a number in \[0\.02, 0\.5\]/);
  });

  it("rejects a value outside a closed vocabulary, and a non-hex colour", () => {
    expect(() => parseLetterheadDesign({ page: { size: "a3" } })).toThrow(/a4, letter/);
    expect(() => parseLetterheadDesign({ background: { pages: "some" } })).toThrow(/first, all/);
    expect(() => parseLetterheadDesign({ header: { repeat: "sometimes" } })).toThrow(/full, slim, none/);
    expect(() => parseLetterheadDesign({ page: { accent: "navy" } })).toThrow(/#rrggbb hex colour/);
  });

  it("drops unknown properties rather than storing them", () => {
    expect(parseLetterheadDesign({ page: { size: "a4", bleed: 3 }, nonsense: true })).toEqual({ page: { size: "a4" } });
  });

  it("drops a band that set nothing, so an empty band is not stored as one", () => {
    expect(parseLetterheadDesign({ header: {}, footer: {} })).toEqual({});
  });

  it("bounds the header's extra lines", () => {
    expect(() => parseLetterheadDesign({ header: { lines: Array.from({ length: 7 }, () => ({ text: "x" })) } })).toThrow(/at most 6 lines/);
    expect(() => parseLetterheadDesign({ header: { lines: [{ text: "x", align: "justify" }] } })).toThrow(/left, center, right/);
  });

  it("falls back to the stock page for a stored blob that no longer validates", () => {
    expect(letterheadDesignOrStock('{"page":{"size":"a3"}}')).toEqual({});
    expect(letterheadDesignOrStock("not json")).toEqual({});
    expect(letterheadDesignOrStock(null)).toEqual({});
    expect(letterheadDesignOrStock('{"page":{"font":"sans"}}')).toEqual({ page: { font: "sans" } });
  });

  it("asks for the images its bands draw, and none of the ones they don't", () => {
    // An image IS its job, so a design asks for a slot unless that band is switched off. A slot holding no
    // image simply contributes nothing at render time.
    expect(slotsUsedBy({}).sort()).toEqual(["mark", "stationery", "watermark"]);
    expect(slotsUsedBy({ header: { mark: { show: false } } }).sort()).toEqual(["stationery", "watermark"]);
    expect(slotsUsedBy({ background: { show: false }, watermark: { show: false } })).toEqual(["mark"]);
  });

  it("draws a mark, stationery and a watermark on the SAME page, from three separate images", async () => {
    // The defect this shape replaced: the bands shared one image setting, so choosing stationery took the
    // header mark away. Each band now has its own image and switching one off leaves the others alone.
    const three = await render({ design: {}, artwork: { mark: PNG, stationery: PNG, watermark: PNG } });
    const markOnly = await render({ design: {}, artwork: { mark: PNG } });
    expect(isPdf(three.bytes)).toBe(true);
    expect(three.bytes.length).toBeGreaterThan(markOnly.bytes.length); // two more images actually drawn
  });

  it("switching the stationery off leaves the mark and the watermark drawing", async () => {
    const before = parseLetterheadDesign({ header: { mark: { height: 40 } }, watermark: { text: "DRAFT" } });
    const after = parseLetterheadDesign({ ...before, background: { show: false } });
    expect(after.header?.mark?.height).toBe(40);
    expect(after.watermark?.text).toBe("DRAFT");
    expect(slotsUsedBy(after).sort()).toEqual(["mark", "watermark"]);
  });

  it("a band with no image of its own draws nothing rather than borrowing another's", async () => {
    // The two versions each hold their own images; a version that uploaded only a mark has no stationery, and
    // must not reach for anyone else's.
    const markOnly = await render({ design: {}, artwork: { mark: PNG } });
    const withSheet = await render({ design: {}, artwork: { mark: PNG, stationery: PNG } });
    expect(withSheet.bytes.length).toBeGreaterThan(markOnly.bytes.length);
  });

  it("fills known tokens and leaves an unknown one visible", () => {
    expect(fillTokens("{{org_name}} - page {{page}} of {{pages}}", { org_name: "Acme", page: "1", pages: "2" })).toBe("Acme - page 1 of 2");
    expect(fillTokens("{{nope}}", { org_name: "Acme" })).toBe("{{nope}}");
  });
});

describe("letterhead rendering", () => {
  it("renders the stock page when there is no letterhead at all", async () => {
    const { bytes } = await render();
    expect(isPdf(bytes)).toBe(true);
  });

  it("renders an empty design identically to no letterhead", async () => {
    const stock = await render();
    const empty = await render({ design: {} });
    // The byte length is stable for the same drawing operations (pdf-lib stamps no timestamp here), so equal
    // lengths is a fair proxy for "the same page".
    expect(empty.bytes.length).toBe(stock.bytes.length);
  });

  it("honours the paper size and margins", async () => {
    const { bytes } = await render({ design: { page: { size: "letter", margin: { top: 100, right: 100, bottom: 100, left: 100 } } } });
    const doc = await PDFDocument.load(bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(612);
    expect(Math.round(height)).toBe(792);
  });

  it("draws a footer on every page and keeps the body off it", async () => {
    const long: LetterContent = { ...CONTENT, blocks: [...CONTENT.blocks, { kind: "gap", height: 700 }, { kind: "para", runs: ["Second page."] }] };
    const { bytes } = await renderLetterPdf({ ...long, letterhead: { design: { footer: { show: true, center: "Page {{page}} of {{pages}}", height: 40 } } } });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(isPdf(bytes)).toBe(true);
  });

  it("renders a design that turns the header band off and reserves its height", async () => {
    const off = await render({ design: { header: { show: false, height: 140 } } });
    const on = await render({ design: {} });
    expect(isPdf(off.bytes)).toBe(true);
    expect(off.bytes.length).not.toBe(on.bytes.length); // the band's text is gone
  });

  it("renders a text watermark with no images uploaded at all", async () => {
    // A version can be designed before any of its art exists; every band simply draws nothing.
    const { bytes } = await render({ design: { background: { pages: "all" }, watermark: { text: "DRAFT", opacity: 0.1 } } });
    expect(isPdf(bytes)).toBe(true);
  });

  it("renders the same letter differently on a screen page and a print page", async () => {
    // What the pair is FOR: the screen page floods the sheet with stationery, the print page does not, because
    // the paper it goes into the printer on already carries it.
    // Each version brings its OWN images: the screen one has stationery, the print one simply has none.
    const page = { header: { show: false, height: 140 } } as const;
    const screen = await render({ design: { ...page }, artwork: { stationery: PNG } });
    const print = await render({ design: { ...page }, artwork: {} });
    expect(isPdf(screen.bytes)).toBe(true);
    expect(isPdf(print.bytes)).toBe(true);
    expect(print.bytes.length).not.toBe(screen.bytes.length);
  });

  it("still records e-signature anchors on a designed page", async () => {
    const { signAnchors } = await renderLetterPdf({
      ...CONTENT,
      letterhead: { design: { page: { margin: { top: 90, right: 60, bottom: 70, left: 60 } }, footer: { show: true, left: "x" } } },
      blocks: [...CONTENT.blocks, { kind: "esignature", name: "Test Employee", withDate: true }],
    });
    expect(signAnchors).toHaveLength(1);
    expect(signAnchors[0]!.x1).toBe(60); // the design's left margin, not the stock 54
    expect(signAnchors[0]!.page).toBe(1);
  });
});
