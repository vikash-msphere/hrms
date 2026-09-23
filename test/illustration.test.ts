import { describe, it, expect } from "vitest";
import { normalizeIllustration, normalizeIllustrationLayout, parseIllustrationLayout } from "../src/domain/illustration";

describe("illustration reference", () => {
  it("accepts the two shapes the web can resolve", () => {
    expect(normalizeIllustration("celebration-recognition/high-five")).toBe("celebration-recognition/high-five");
    expect(normalizeIllustration("good-job.png")).toBe("good-job.png");
    expect(normalizeIllustration("  party.png  ")).toBe("party.png");
  });
  it("is null for nothing at all", () => {
    expect(normalizeIllustration(null)).toBeNull();
    expect(normalizeIllustration("")).toBeNull();
    expect(normalizeIllustration("   ")).toBeNull();
  });
  it("refuses anything that could point the card off-site", () => {
    // The value lands in an <img src>, so a scheme, a host, a traversal or a slashed sticker must not pass.
    for (const bad of ["https://evil.example/x.svg", "//evil.example/x", "../../etc/passwd", "/absolute/path", "a/b/c", "deep/dir/good-job.png", "javascript:alert(1)"]) {
      expect(() => normalizeIllustration(bad), bad).toThrow();
    }
  });
});

describe("sticker placement", () => {
  it("stores the four fractions as JSON", () => {
    expect(normalizeIllustrationLayout({ x: 0.25, y: 0.5, size: 0.3, opacity: 0.8 })).toBe('{"x":0.25,"y":0.5,"size":0.3,"opacity":0.8}');
  });
  it("is null when there is no placement (the inline default)", () => {
    expect(normalizeIllustrationLayout(null)).toBeNull();
    expect(normalizeIllustrationLayout(undefined)).toBeNull();
  });
  it("clamps a drag that ran past the edge rather than rejecting it", () => {
    const out = JSON.parse(normalizeIllustrationLayout({ x: 1.4, y: -0.2, size: 3, opacity: 0 })!);
    expect(out).toEqual({ x: 1, y: 0, size: 1, opacity: 0.05 });
  });
  it("rounds to a sane precision", () => {
    const out = JSON.parse(normalizeIllustrationLayout({ x: 0.123456, y: 0.5, size: 0.2, opacity: 1 })!);
    expect(out.x).toBe(0.123);
  });
  it("rejects a half-specified or non-numeric placement", () => {
    expect(() => normalizeIllustrationLayout({ x: 0.5, y: 0.5, size: 0.2 } as never)).toThrow();
    expect(() => normalizeIllustrationLayout({ x: NaN, y: 0, size: 0.2, opacity: 1 })).toThrow();
    expect(() => normalizeIllustrationLayout({ x: "0.5", y: 0, size: 0.2, opacity: 1 } as never)).toThrow();
  });
  it("carries a wrap mode when one is set, and refuses one that isn't real", () => {
    const out = JSON.parse(normalizeIllustrationLayout({ x: 0, y: 0, size: 0.3, opacity: 1, wrap: "tight" })!);
    expect(out.wrap).toBe("tight");
    // Absent is the common case - the card's own default decides.
    expect(JSON.parse(normalizeIllustrationLayout({ x: 0, y: 0, size: 0.3, opacity: 1 })!).wrap).toBeUndefined();
    expect(() => normalizeIllustrationLayout({ x: 0, y: 0, size: 0.3, opacity: 1, wrap: "diagonal" as never })).toThrow();
  });
  it("drops a stored wrap mode that is no longer valid rather than failing the card", () => {
    expect(parseIllustrationLayout('{"x":0,"y":0,"size":0.3,"opacity":1,"wrap":"nonsense"}')).toEqual({ x: 0, y: 0, size: 0.3, opacity: 1 });
  });

  it("reads back what it wrote, and shrugs off junk", () => {
    const layout = { x: 0.2, y: 0.4, size: 0.25, opacity: 0.6 };
    expect(parseIllustrationLayout(normalizeIllustrationLayout(layout))).toEqual(layout);
    expect(parseIllustrationLayout(null)).toBeUndefined();
    expect(parseIllustrationLayout("not json")).toBeUndefined();
    expect(parseIllustrationLayout('{"x":0.2}')).toBeUndefined();
  });
});
