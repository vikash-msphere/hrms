import { describe, expect, it } from "vitest";
import {
  SHEET_FORMATS, allFormats, formatById, slotsPerSheet, scanOrder, slotPos,
  labelChunks, wrapLabelLine, fitLabelLine, fitLabelBlock, labelLineSpecs, labelTextBox, LABEL_LINE_HEIGHT, LINE_MIN_SCALE, MIN_LABEL_MM,
  orgPrefix, resolveTagConfig, formatTag,
  buildScanPayload, parseScanPayload, cleanScannedSerial, type TagConfig,
} from "../web/src/lib/assetTags";
import {
  DEFAULT_ASSET_TAG_CONFIG, FALLBACK_TAG_CODE, deriveTagCode, formatAssetTag, normalizeTagConfig, nextSeq, seqOf,
  orgPrefix as serverOrgPrefix, type AssetTagConfig,
} from "../src/domain/assetTag";

const cfg = (over: Partial<AssetTagConfig> = {}): AssetTagConfig => ({ prefix: "MS", separator: "-", digits: 3, ...over });

describe("sheet formats", () => {
  it("every preset's grid fits inside A4 with symmetric margins", () => {
    for (const f of SHEET_FORMATS) {
      const width = 2 * f.marginX + f.cols * f.w + (f.cols - 1) * f.gapX;
      const height = 2 * f.marginY + f.rows * f.h + (f.rows - 1) * f.gapY;
      expect(width, `${f.id} width`).toBeCloseTo(210, 0);
      expect(height, `${f.id} height`).toBeCloseTo(297, 0);
    }
  });

  it("formatById falls back to the settings default, then the first preset", () => {
    expect(formatById("nope").id).toBe(SHEET_FORMATS[0]!.id);
    expect(formatById(undefined).id).toBe(SHEET_FORMATS[0]!.id);
    expect(formatById("a4-24").id).toBe("a4-24");
    expect(formatById("nope", { default_format: "a4-40" }).id).toBe("a4-40");
  });

  it("custom formats are offered and win over a preset with the same id", () => {
    const custom = { id: "a4-65", label: "re-measured", cols: 5, rows: 13, w: 38, h: 21.1, marginX: 5, marginY: 11, gapX: 2.5, gapY: 0.1 };
    const s = { custom_formats: [custom] };
    expect(allFormats(s).filter((f) => f.id === "a4-65")).toEqual([custom]);
    expect(formatById("a4-65", s).label).toBe("re-measured");
    const fresh = { id: "roll-1", label: "roll", cols: 1, rows: 10, w: 50, h: 25, marginX: 5, marginY: 5, gapX: 0, gapY: 3 };
    expect(allFormats({ custom_formats: [fresh] })).toHaveLength(SHEET_FORMATS.length + 1);
    expect(formatById("roll-1", { custom_formats: [fresh] }).id).toBe("roll-1");
  });

  it("ignores half-filled custom rows with a blank id (editor scaffolding)", () => {
    const blank = { id: "  ", label: "", cols: 3, rows: 8, w: 63.5, h: 33.9, marginX: 7.25, marginY: 12.9, gapX: 2.5, gapY: 0 };
    expect(allFormats({ custom_formats: [blank] })).toEqual(SHEET_FORMATS);
  });

  it("slotPos places the A4-65 grid at the known reference coordinates", () => {
    const f = formatById("a4-65");
    expect(slotPos(f, 0, 0, 0)).toEqual({ left: 4.75, top: 10.7 });
    expect(slotPos(f, 1, 0, 0).left).toBeCloseTo(4.75 + 38.1 + 2.5);
    expect(slotPos(f, 5, 0, 0).top).toBeCloseTo(10.7 + 21.2); // second row
    expect(slotPos(f, 0, 1.5, -0.5)).toEqual({ left: 6.25, top: 10.2 }); // offsets applied
  });
});

describe("label text fitting", () => {
  // Stand-in for the real font metrics: every glyph one size-unit wide, so widths are readable by eye.
  const measure = (t: string, size: number) => t.length * size;
  const blockHeight = (b: { lines: { size: number }[] }) => b.lines.reduce((h, l) => h + l.size * LABEL_LINE_HEIGHT, 0);
  // What the sticker still says, ignoring where the lines broke - the point of the layout is that this
  // never loses a character.
  const said = (b: { lines: { text: string }[] }) => b.lines.map((l) => l.text).join("").replace(/\s+/g, "");

  it("gives the text column what the code leaves behind", () => {
    const f = formatById("a4-65"); // 38.1 x 21.2mm, pad 0.848mm
    const qr = labelTextBox(f, "qr");
    expect(qr.width).toBeCloseTo(38.1 - 0.848 * 2 - 21.2 * 0.78 - 21.2 * 0.05);
    expect(qr.height).toBeCloseTo(21.2 - 0.848 * 2);
    const bar = labelTextBox(f, "code128");
    expect(bar.width).toBeCloseTo(38.1 - 0.848 * 2); // no code beside the text
    expect(bar.height).toBeCloseTo(21.2 - 0.848 * 2 - 21.2 * 0.34); // barcode below it
  });

  it("wraps on word boundaries, and inside a word on its separators", () => {
    expect(wrapLabelLine("MacBook Pro 14", 8, 1, false, measure)).toEqual(["MacBook", "Pro 14"]);
    expect(wrapLabelLine("  Dell   XPS  ", 100, 1, false, measure)).toEqual(["Dell XPS"]);
    expect(wrapLabelLine("   ", 10, 1, false, measure)).toEqual([]);
    // A tag breaks after a hyphen, which stays on the line it ends - never mid-run.
    expect(wrapLabelLine("YCPL-AST-001-23424242", 14, 1, false, measure)).toEqual(["YCPL-AST-001-", "23424242"]);
    expect(labelChunks("YCPL-AST-001-23424242").map((c) => c.text)).toEqual(["YCPL-", "AST-", "001-", "23424242"]);
    // Only a run that cannot fit at all is broken by character.
    expect(wrapLabelLine("MS-LAPTOP-0001", 6, 1, false, measure)).toEqual(["MS-", "LAPTOP", "-0001"]);
  });

  it("prints a separated tag at full size on two lines rather than shrinking it", () => {
    // Helvetica-ish widths for this one, since the point is what a real tag does on a real sheet.
    const helvetica = (t: string, size: number, bold?: boolean) => t.length * size * (bold ? 0.55 : 0.52);
    const f = formatById("a4-65");
    const box = labelTextBox(f, "qr"); // 18.8mm column, tag base 2.54mm
    const fit = fitLabelLine("YCPL-AST-001-23424242", box.width, f.h * 0.12, true, helvetica);
    expect(fit.size).toBeCloseTo(f.h * 0.12); // full size: the hyphens gave it somewhere to break
    expect(fit.lines).toEqual(["YCPL-AST-001-", "23424242"]);
    for (const l of fit.lines) expect(helvetica(l, fit.size, true)).toBeLessThanOrEqual(box.width);
  });

  it("wraps at full size rather than shrinking a line that has somewhere to break", () => {
    // 14 glyphs at size 2 want 28 of width. Both boxes are too narrow, and both keep the full size:
    // the words themselves fit, so a second line costs nothing.
    expect(fitLabelLine("MacBook Pro 14", 24, 2, false, measure)).toEqual({ lines: ["MacBook Pro", "14"], size: 2 });
    const wrapped = fitLabelLine("MacBook Pro 14", 16, 2, false, measure);
    expect(wrapped.size).toBe(2);
    expect(wrapped.lines).toEqual(["MacBook", "Pro 14"]);
    for (const l of wrapped.lines) expect(measure(l, wrapped.size)).toBeLessThanOrEqual(16);
  });

  it("never clamps a line below the physical floor", () => {
    const fit = fitLabelLine("MacBook Pro", 6, MIN_LABEL_MM, false, measure);
    expect(fit.size).toBe(MIN_LABEL_MM); // already at the floor: wrap, do not shrink
    expect(fit.lines.length).toBeGreaterThan(1);
  });

  it("shrinks only far enough to keep the longest word whole", () => {
    // "Latitude7440" (12 glyphs, wants 24) is what does not fit 20; the line shrinks to its measure,
    // not to whatever the whole string would need, and the shorter words come along at that size.
    const fit = fitLabelLine("Dell Latitude7440 laptop", 20, 2, false, measure);
    expect(fit.size).toBeCloseTo(20 / 12);
    expect(fit.lines.join(" ")).toBe("Dell Latitude7440 laptop"); // wrapped on spaces, no word broken
  });

  it("shrinks an unbreakable token rather than breaking it mid-way", () => {
    // A serial has no space to wrap at, so the clamp is the only decent move.
    const clamped = fitLabelLine("C02XL0ZTJGH5", 20, 2, false, measure); // 12 glyphs want 24
    expect(clamped.lines).toEqual(["C02XL0ZTJGH5"]);
    expect(clamped.size).toBeCloseTo(20 / 12);
    // Past the clamp it does break, but at the floor size, so it breaks as few times as possible.
    const broken = fitLabelLine("C02XL0ZTJGH5", 10, 2, false, measure);
    expect(broken.size).toBeCloseTo(2 * LINE_MIN_SCALE);
    expect(broken.lines.join("")).toBe("C02XL0ZTJGH5");
  });

  it("keeps a block that already fits at full size", () => {
    const specs = labelLineSpecs({ org: "Meridian", tag: "MS-LAP-001", name: "MacBook", serial: "C02X" });
    const block = fitLabelBlock(specs, { width: 40, height: 20 }, 20, measure);
    expect(block.scale).toBe(1);
    expect(block.lines.map((l) => l.text)).toEqual(["Meridian", "MS-LAP-001", "MacBook", "SN C02X"]);
    expect(block.lines[1]!.bold).toBe(true);
  });

  it("drops blank lines and keeps each line's colour index", () => {
    const specs = labelLineSpecs({ org: "", tag: "MS-LAP-001", name: "", serial: "C02X", footer: "" });
    const block = fitLabelBlock(specs, { width: 40, height: 20 }, 20, measure);
    expect(block.lines.map((l) => l.spec)).toEqual([1, 3]); // tag, serial - never renumbered
  });

  it("wraps a long name instead of cutting it, and never emits an ellipsis", () => {
    const specs = labelLineSpecs({ tag: "MS-LAP-001", name: "Dell Latitude 7440 docking station" });
    const block = fitLabelBlock(specs, { width: 12, height: 24 }, 20, measure);
    expect(said(block)).toBe("MS-LAP-001DellLatitude7440dockingstation");
    expect(said(block)).not.toContain("…");
    expect(blockHeight(block)).toBeLessThanOrEqual(24);
    for (const l of block.lines) expect(measure(l.text, l.size)).toBeLessThanOrEqual(12);
  });

  it("scales the whole block as one, so the hierarchy survives", () => {
    const specs = labelLineSpecs({ org: "Meridian Systems", tag: "MS-LAP-001", name: "Dell Latitude 7440", serial: "C02XL0ZTJGH5", footer: "If found: hr@meridian.example" });
    // Wide enough that no single line needs clamping, short enough that the block must scale.
    const block = fitLabelBlock(specs, { width: 60, height: 8 }, 20, measure);
    expect(block.scale).toBeLessThan(1);
    expect(block.lines).toHaveLength(5); // still one line each
    const tag = block.lines.find((l) => l.spec === 1)!;
    const name = block.lines.find((l) => l.spec === 2)!;
    const footer = block.lines.find((l) => l.spec === 4)!;
    expect(tag.size / name.size).toBeCloseTo(0.12 / 0.08); // same ratios as at full size
    expect(tag.size / footer.size).toBeCloseTo(0.12 / 0.065);
  });

  it("stops shrinking at the physical floor rather than printing a smear", () => {
    const specs = labelLineSpecs({ tag: "MS-LAP-001", name: "Dell Latitude 7440 docking station with power supply" });
    const block = fitLabelBlock(specs, { width: 8, height: 1 }, 20, measure);
    expect(Math.min(...block.lines.map((l) => l.size))).toBeGreaterThanOrEqual(MIN_LABEL_MM - 1e-9);
    expect(said(block)).toContain("powersupply"); // still all there, the box just clips it
  });

  it("counts the logo against the height budget", () => {
    const specs = labelLineSpecs({ tag: "MS-LAP-001", name: "Dell Latitude 7440" });
    const box = { width: 20, height: 8 };
    const bare = fitLabelBlock(specs, box, 20, measure);
    const withLogo = fitLabelBlock(specs, box, 20, measure, 4);
    expect(withLogo.scale).toBeLessThan(bare.scale);
    expect(blockHeight(withLogo)).toBeLessThanOrEqual(8 - 4);
  });

  it("fits a real long name on the smallest sheet format", () => {
    const f = formatById("a4-65");
    const box = labelTextBox(f, "qr");
    const specs = labelLineSpecs({ org: "Meridian Systems Pvt Ltd", tag: "MS-LAP-001", name: 'Dell Latitude 7440 14" laptop', serial: "C02XL0ZTJGH5" });
    const block = fitLabelBlock(specs, box, f.h, measure);
    expect(said(block)).toContain("Latitude");
    expect(blockHeight(block)).toBeLessThanOrEqual(box.height);
  });
});

describe("scanOrder", () => {
  it("row order counts straight through", () => {
    expect(scanOrder({ cols: 3, rows: 2 }, "row")).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("column order fills down each column first", () => {
    expect(scanOrder({ cols: 3, rows: 2 }, "col")).toEqual([0, 3, 1, 4, 2, 5]);
  });
  it("both orders are permutations of every slot", () => {
    for (const f of SHEET_FORMATS) {
      for (const fill of ["row", "col"] as const) {
        expect([...scanOrder(f, fill)].sort((a, b) => a - b)).toEqual(Array.from({ length: slotsPerSheet(f) }, (_, i) => i));
      }
    }
  });
});

describe("deriveTagCode", () => {
  it("takes the first three letters of the category name, uppercased", () => {
    expect(deriveTagCode("Laptop")).toBe("LAP");
    expect(deriveTagCode("3D Printer")).toBe("3DP");
    expect(deriveTagCode("Ab")).toBe("AB");
  });
  it("falls back to AST when the name has nothing usable", () => {
    expect(deriveTagCode("")).toBe(FALLBACK_TAG_CODE);
    expect(deriveTagCode("---")).toBe(FALLBACK_TAG_CODE);
  });
});

describe("orgPrefix", () => {
  it("takes initials, capped at four", () => {
    expect(serverOrgPrefix("Meridian Systems")).toBe("MS");
    expect(serverOrgPrefix("one two three four five")).toBe("OTTF");
  });
  it("falls back to AST when nothing usable", () => {
    expect(serverOrgPrefix("")).toBe("AST");
    expect(serverOrgPrefix("---")).toBe("AST");
    expect(serverOrgPrefix(null)).toBe("AST");
  });
});

describe("normalizeTagConfig", () => {
  it("defaults: org-initials prefix, dash separator, 3 digits", () => {
    expect(normalizeTagConfig({}, "Meridian Systems")).toEqual({ prefix: "MS", separator: "-", digits: 3 });
    expect(normalizeTagConfig(null, "Meridian Systems").separator).toBe(DEFAULT_ASSET_TAG_CONFIG.separator);
  });
  it("settings override each part", () => {
    const c = normalizeTagConfig({ prefix: "MSP", separator: ".", digits: 4 }, "Meridian Systems");
    expect(c).toEqual({ prefix: "MSP", separator: ".", digits: 4 });
  });
  it("rejects out-of-range digits and a blank prefix back to the defaults", () => {
    expect(normalizeTagConfig({ digits: 0 }, "Meridian Systems").digits).toBe(3);
    expect(normalizeTagConfig({ digits: 9 }, "Meridian Systems").digits).toBe(3);
    expect(normalizeTagConfig({ digits: 2.5 }, "Meridian Systems").digits).toBe(3);
    expect(normalizeTagConfig({ prefix: "  " }, "Meridian Systems").prefix).toBe("MS");
  });
});

// The allocator the server runs on create: formatAssetTag composes, nextSeq decides the number.
describe("formatAssetTag / nextSeq", () => {
  const next = (c: AssetTagConfig, code: string | null, existing: (string | null | undefined)[]) => formatAssetTag(c, code, nextSeq(c, code, existing));

  it("starts at 001 and continues past the highest existing number", () => {
    expect(next(cfg(), "LAP", [])).toBe("MS-LAP-001");
    expect(next(cfg(), "LAP", ["MS-LAP-001", "MS-LAP-007", null, undefined])).toBe("MS-LAP-008");
  });
  it("sequences are independent per category code and prefix", () => {
    expect(next(cfg(), "PHN", ["MS-LAP-009"])).toBe("MS-PHN-001");
    expect(next(cfg(), "LAP", ["OTHER-LAP-009"])).toBe("MS-LAP-001");
  });
  it("an uncategorised asset uses the fallback code and its own run", () => {
    expect(next(cfg(), null, ["MS-LAP-009"])).toBe("MS-AST-001");
    expect(next(cfg(), null, ["MS-AST-004"])).toBe("MS-AST-005");
  });
  it("honours a custom separator, digit width and empty prefix", () => {
    expect(next(cfg({ separator: ".", digits: 5 }), "LAP", ["MS.LAP.00009"])).toBe("MS.LAP.00010");
    const noPrefix = cfg({ prefix: "" });
    expect(next(noPrefix, "LAP", ["LAP-004"])).toBe("LAP-005");
    expect(formatAssetTag(noPrefix, "LAP", 5)).toBe("LAP-005");
  });
  it("ignores tags in other shapes and survives regex chars in prefix/separator", () => {
    expect(next(cfg(), "LAP", ["MS-LAP-x", "freeform", "LOANER-3", "MS-LAP-0021"])).toBe("MS-LAP-022");
    expect(next(cfg({ prefix: "A+B" }), "LAP", ["A+B-LAP-002"])).toBe("A+B-LAP-003");
  });
  it("seqOf reads a sequence only out of a tag that follows this pattern", () => {
    expect(seqOf(cfg(), "LAP", "MS-LAP-014")).toBe(14);
    expect(seqOf(cfg(), "LAP", "ms-lap-014")).toBe(14); // a hand-typed override in the right shape still counts
    expect(seqOf(cfg(), "LAP", "MS-PHN-014")).toBeNull();
    expect(seqOf(cfg(), "LAP", "LOANER-3")).toBeNull();
    expect(seqOf(cfg(), "LAP", null)).toBeNull();
  });
});

// The web copy exists only to preview the pattern in Settings; it has to agree with the server's composer.
describe("the settings preview mirrors the server", () => {
  it("resolves the same prefix/separator/digits", () => {
    const web: TagConfig = resolveTagConfig("Meridian Systems", { prefix: "MSP", separator: ".", digits: 4 });
    expect(web).toEqual(normalizeTagConfig({ prefix: "MSP", separator: ".", digits: 4 }, "Meridian Systems"));
    expect(resolveTagConfig("Meridian Systems")).toEqual(normalizeTagConfig({}, "Meridian Systems"));
    expect(orgPrefix("Meridian Systems")).toBe(serverOrgPrefix("Meridian Systems"));
  });
  it("composes the same tag", () => {
    for (const code of ["LAP", "MON", null]) {
      expect(formatTag(resolveTagConfig("Meridian Systems"), code, 7)).toBe(formatAssetTag(normalizeTagConfig({}, "Meridian Systems"), code, 7));
    }
  });
});

describe("scan payloads", () => {
  const a = { id: "abc123", tag: "MS-LAP-004", serial: "SN99" };
  const origin = "https://hrms.example.com";

  it("builds each mode", () => {
    expect(buildScanPayload("link", a, origin)).toBe("https://hrms.example.com/#/assets/abc123");
    expect(buildScanPayload("found", a, origin)).toBe("https://hrms.example.com/found/abc123");
    expect(buildScanPayload("tag", a, origin)).toBe("MS-LAP-004");
    expect(buildScanPayload("tag_serial", a, origin)).toBe("MS-LAP-004 | SN:SN99");
    expect(buildScanPayload("tag_serial", { ...a, serial: null }, origin)).toBe("MS-LAP-004");
  });

  it("tag modes fall back to the deep link when the asset has no tag yet", () => {
    expect(buildScanPayload("tag", { id: "x", tag: null }, origin)).toBe(`${origin}/#/assets/x`);
  });

  it("parse inverts every build mode", () => {
    expect(parseScanPayload(buildScanPayload("link", a, origin))).toEqual({ id: "abc123" });
    expect(parseScanPayload(buildScanPayload("found", a, origin))).toEqual({ id: "abc123" });
    expect(parseScanPayload(buildScanPayload("tag", a, origin))).toEqual({ tag: "MS-LAP-004" });
    expect(parseScanPayload(buildScanPayload("tag_serial", a, origin))).toEqual({ tag: "MS-LAP-004" });
  });

  it("handles hand-typed tags, junk and foreign URLs", () => {
    expect(parseScanPayload("  ms-lap-004  ")).toEqual({ tag: "ms-lap-004" });
    expect(parseScanPayload("")).toBeNull();
    expect(parseScanPayload("https://example.com/other")).toBeNull();
  });

  // The secret is what turns a scan into proof of possession, so it has to survive the round trip - and an
  // older sticker printed before secrets existed still has to resolve to its asset.
  it("carries the tag secret through the deep link and back", () => {
    const withSecret = { ...a, secret: "7KQ3NBX2WD" };
    expect(buildScanPayload("link", withSecret, origin)).toBe("https://hrms.example.com/#/assets/abc123?s=7KQ3NBX2WD");
    expect(parseScanPayload(buildScanPayload("link", withSecret, origin))).toEqual({ id: "abc123", secret: "7KQ3NBX2WD" });
    expect(parseScanPayload(buildScanPayload("link", a, origin))).toEqual({ id: "abc123" });
    expect(parseScanPayload(`${origin}/found/abc123?s=7KQ3NBX2WD`)).toEqual({ id: "abc123", secret: "7KQ3NBX2WD" });
  });
});

// The manufacturer's own barcode, on its way into the serial field of the asset form. We do not control these
// labels, so the job is to strip the packaging vendors put around the serial without ever mangling the serial.
describe("cleanScannedSerial", () => {
  it("keeps a plain serial exactly as printed", () => {
    expect(cleanScannedSerial("C02XK1TZJGH5")).toBe("C02XK1TZJGH5");
    expect(cleanScannedSerial("  5CD9251ABC \n")).toBe("5CD9251ABC");
  });

  it("drops the label text and delimiters encoders leave around it", () => {
    expect(cleanScannedSerial("S/N: C02XK1TZJGH5")).toBe("C02XK1TZJGH5");
    expect(cleanScannedSerial("SN 5CD9251ABC")).toBe("5CD9251ABC");
    expect(cleanScannedSerial("Serial No. ABC-123")).toBe("ABC-123");
    expect(cleanScannedSerial("*C02XK1TZJGH5*")).toBe("C02XK1TZJGH5"); // Code 39 start/stop
  });

  it("takes the serial element out of a GS1-128 label", () => {
    expect(cleanScannedSerial("(01)09501101020917(21)C02XK1TZJGH5")).toBe("C02XK1TZJGH5");
    expect(cleanScannedSerial("010950110102091721C02XK1TZJGH5")).toBe("C02XK1TZJGH5");
  });

  it("reads the serial straight off our own tag+serial sticker", () => {
    expect(cleanScannedSerial(buildScanPayload("tag_serial", { id: "abc123", tag: "MS-LAP-004", serial: "SN99" }, "https://hrms.example.com"))).toBe("SN99");
  });

  it("leaves anything it does not recognise alone", () => {
    // A serial that merely STARTS with the letters "sn" is not a prefixed one, and a hyphenated vendor code
    // must not lose its head: a wrong cleanup is worse than a prefix left on.
    expect(cleanScannedSerial("SNXW7781")).toBe("SNXW7781");
    expect(cleanScannedSerial("21-4477-A")).toBe("21-4477-A");
    expect(cleanScannedSerial("")).toBe("");
  });
});
