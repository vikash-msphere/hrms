import { describe, expect, it } from "vitest";
import {
  SHEET_FORMATS, DEFAULT_CATEGORY_CODES, allFormats, formatById, slotsPerSheet, scanOrder, slotPos,
  categoryCode, orgPrefix, resolveTagConfig, formatTag, nextTag, duplicateTags,
  buildScanPayload, parseScanPayload, type TagConfig,
} from "../web/src/lib/assetTags";

const cfg = (over: Partial<TagConfig> = {}): TagConfig => ({ prefix: "MS", separator: "-", digits: 3, categoryCodes: DEFAULT_CATEGORY_CODES, ...over });

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

describe("categoryCode", () => {
  it("uses the configured map, uppercased", () => {
    expect(categoryCode(DEFAULT_CATEGORY_CODES, "Laptop")).toBe("LAP");
    expect(categoryCode({ ...DEFAULT_CATEGORY_CODES, Laptop: "lt" }, "Laptop")).toBe("LT");
    expect(categoryCode({ Tablet: "TB" }, "Tablet")).toBe("TB");
  });
  it("derives a code from unmapped categories and falls back to AST", () => {
    expect(categoryCode(DEFAULT_CATEGORY_CODES, "Tablet")).toBe("TAB");
    expect(categoryCode(DEFAULT_CATEGORY_CODES, "3D Printer")).toBe("3DP");
    expect(categoryCode(DEFAULT_CATEGORY_CODES, "")).toBe("AST");
    expect(categoryCode(DEFAULT_CATEGORY_CODES, undefined)).toBe("AST");
    expect(categoryCode(DEFAULT_CATEGORY_CODES, "---")).toBe("AST");
  });
});

describe("orgPrefix", () => {
  it("takes initials, capped at four", () => {
    expect(orgPrefix("Meridian Systems")).toBe("MS");
    expect(orgPrefix("one two three four five")).toBe("OTTF");
  });
  it("falls back to AST when nothing usable", () => {
    expect(orgPrefix("")).toBe("AST");
    expect(orgPrefix("---")).toBe("AST");
  });
});

describe("resolveTagConfig", () => {
  it("defaults: org-initials prefix, dash separator, 3 digits, built-in codes", () => {
    expect(resolveTagConfig("Meridian Systems")).toEqual({ prefix: "MS", separator: "-", digits: 3, categoryCodes: DEFAULT_CATEGORY_CODES });
  });
  it("settings override each part; category codes merge over the built-ins", () => {
    const c = resolveTagConfig("Meridian Systems", { prefix: "MSP", separator: ".", digits: 4, category_codes: { Laptop: "NB", Tablet: "TAB" } });
    expect(c.prefix).toBe("MSP");
    expect(c.separator).toBe(".");
    expect(c.digits).toBe(4);
    expect(c.categoryCodes.Laptop).toBe("NB");
    expect(c.categoryCodes.Tablet).toBe("TAB");
    expect(c.categoryCodes.Phone).toBe("PHN"); // built-in survives the merge
  });
  it("rejects out-of-range digits and blank prefix back to defaults", () => {
    expect(resolveTagConfig("Meridian Systems", { digits: 0 }).digits).toBe(3);
    expect(resolveTagConfig("Meridian Systems", { digits: 9 }).digits).toBe(3);
    expect(resolveTagConfig("Meridian Systems", { prefix: "  " }).prefix).toBe("MS");
  });
});

describe("formatTag / nextTag", () => {
  it("starts at 001 and continues past the highest existing number", () => {
    expect(nextTag(cfg(), "Laptop", [])).toBe("MS-LAP-001");
    expect(nextTag(cfg(), "Laptop", ["MS-LAP-001", "MS-LAP-007", null, undefined])).toBe("MS-LAP-008");
  });
  it("sequences are independent per category and prefix", () => {
    expect(nextTag(cfg(), "Phone", ["MS-LAP-009"])).toBe("MS-PHN-001");
    expect(nextTag(cfg(), "Laptop", ["OTHER-LAP-009"])).toBe("MS-LAP-001");
  });
  it("honours a custom separator, digit width and empty prefix", () => {
    const c = cfg({ separator: ".", digits: 5 });
    expect(nextTag(c, "Laptop", ["MS.LAP.00009"])).toBe("MS.LAP.00010");
    const noPrefix = cfg({ prefix: "" });
    expect(nextTag(noPrefix, "Laptop", ["LAP-004"])).toBe("LAP-005");
    expect(formatTag(noPrefix, "Laptop", 5)).toBe("LAP-005");
  });
  it("ignores tags in other shapes and survives regex chars in prefix/separator", () => {
    expect(nextTag(cfg(), "Laptop", ["MS-LAP-x", "freeform", "MS-LAP-0021"])).toBe("MS-LAP-022");
    expect(nextTag(cfg({ prefix: "A+B" }), "Laptop", ["A+B-LAP-002"])).toBe("A+B-LAP-003");
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
});

describe("duplicateTags", () => {
  it("reports only tags seen more than once, ignoring blanks", () => {
    expect(duplicateTags(["A", "B", "A", null, undefined, "", "C", "B"])).toEqual(new Set(["A", "B"]));
    expect(duplicateTags(["A", "B"]).size).toBe(0);
  });
});
