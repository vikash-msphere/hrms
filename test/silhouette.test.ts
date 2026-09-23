import { describe, it, expect } from "vitest";
// Dependency-free on purpose, so the worker test project can reach it - see web/src/lib/silhouette.ts.
import { contourFromAlpha, halfPolygon, hasContour, rasterSize, silhouettePolygon, type Contour } from "../web/src/lib/silhouette";

// Tight and Through wrap text to the artwork's own outline. The tracing needs a canvas, but everything that
// decides WHERE the words land is arithmetic, and that is what is pinned here.

/** RGBA pixels from a picture of `#` (opaque) and `.` (transparent), one string per row. */
function pixels(rows: string[]): { data: Uint8ClampedArray; width: number; height: number } {
  const height = rows.length;
  const width = rows[0]!.length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      data[(y * width + x) * 4 + 3] = c === "#" ? 255 : 0;
    });
  });
  return { data, width, height };
}

const trace = (rows: string[], bands = rows.length) => {
  const { data, width, height } = pixels(rows);
  return contourFromAlpha(data, width, height, bands);
};

// Every coordinate the polygon builders emit, in order, as numbers - so a test can assert on the shape itself
// rather than on string formatting.
const points = (poly: string | null) =>
  (poly ?? "").replace(/^polygon\(|\)$/g, "").split(", ").filter(Boolean).map((p) => p.split(" ").map((n) => parseFloat(n)) as [number, number]);

/** Where one side of the shape sits at a given height - the segment of the chain that spans that row. */
function edgeAt(chain: [number, number][], y: number): number {
  for (let i = 0; i < chain.length - 1; i++) {
    const [x0, y0] = chain[i]!;
    const [x1, y1] = chain[i + 1]!;
    if (y0 === y1 || y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
    return x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
  }
  throw new Error(`no segment at y=${y}`);
}

// The scan grid has to be the PICTURE's shape. A square one letterboxes any SVG that is not square - the drawing
// lands centred with transparent bands at the ends, the scan reads those bands as part of the picture, and the
// outline pinches them shut over rows the artwork actually occupies. The error is a fraction of the picture, so
// it is invisible on a small sticker and lands words on the drawing on a big one.
describe("rasterSize", () => {
  it("keeps the picture's aspect, so nothing is letterboxed", () => {
    // The real span of the unDraw set: 0.40 to 3.21, median 1.28.
    for (const aspect of [0.4, 0.75, 1, 1.05, 1.28, 1.48, 2, 3.21]) {
      const { width, height } = rasterSize(aspect);
      expect(Math.abs(width / height - aspect) / aspect, `aspect ${aspect}`).toBeLessThan(0.01);
    }
  });
  it("fills the grid on the longer axis and never collapses the shorter one", () => {
    expect(rasterSize(2)).toEqual({ width: 160, height: 80 });
    expect(rasterSize(0.5)).toEqual({ width: 80, height: 160 });
    expect(rasterSize(1)).toEqual({ width: 160, height: 160 });
    expect(rasterSize(1000).height).toBeGreaterThanOrEqual(1);
    expect(rasterSize(0.0001).width).toBeGreaterThanOrEqual(1);
  });
  it("falls back to a square for an aspect it cannot use", () => {
    // naturalWidth / naturalHeight is 0/0 for an image the browser could not size.
    for (const bad of [NaN, 0, -1, Infinity]) expect(rasterSize(bad)).toEqual({ width: 160, height: 160 });
  });

  // End to end on the actual failure: a drawing that fills its picture edge to edge must come back as covering
  // the picture edge to edge. Scanned at the picture's own aspect it does. Squared - which is what letterboxing
  // produces - it comes back inset, and those phantom empty bands are where the words end up on the artwork.
  it("reports a full-bleed drawing as full-bleed, which a squared grid does not", () => {
    /** An opaque rectangle covering `rows` of a `w` x `h` grid, centred - i.e. a letterboxed picture. */
    const filled = (w: number, h: number, rows: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      const top = Math.floor((h - rows) / 2);
      for (let y = top; y < top + rows; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = 255;
      return data;
    };
    const aspect = 1.28; // the median of the illustration set
    const fit = rasterSize(aspect);
    // Drawn at its own aspect there is no letterbox: the picture fills the grid.
    const right = contourFromAlpha(filled(fit.width, fit.height, fit.height), fit.width, fit.height, 12);
    expect(right.every((b) => b?.l === 0 && b?.r === 1)).toBe(true);

    // Squared, the same picture is letterboxed into the middle 78% and the ends scan as empty.
    const side = 160;
    const inset = Math.round(side / aspect);
    const wrong = contourFromAlpha(filled(side, side, inset), side, side, 12);
    expect(wrong.filter((b) => b === null).length).toBeGreaterThan(0);
    // And the outline pinches those bands to a point - an open invitation into the top of the drawing.
    expect(points(silhouettePolygon(wrong))[0]).toEqual([50, 0]);
    expect(points(silhouettePolygon(right))[0]).toEqual([100, 0]);
  });
});

describe("contourFromAlpha", () => {
  it("finds where the drawing starts and ends on each band", () => {
    // A 4-wide picture with the drawing in the middle two columns: 0.25 to 0.75 across.
    expect(trace([".##."])).toEqual([{ l: 0.25, r: 0.75 }]);
  });
  it("measures to the far edge of the last opaque pixel, not its near edge", () => {
    // Fully opaque has to come back as the whole width, or a solid picture would wrap inside its own box.
    expect(trace(["####"])).toEqual([{ l: 0, r: 1 }]);
  });
  it("reports an empty band as empty rather than as a sliver", () => {
    expect(trace(["....", "####"])).toEqual([null, { l: 0, r: 1 }]);
  });
  it("takes the widest extent of any row in a band, so a thin arm is not missed between samples", () => {
    // Two rows, one band: the narrow row must not hide the wide one.
    expect(trace(["#..#", ".##."], 1)).toEqual([{ l: 0, r: 1 }]);
  });
  it("follows a taper down the picture", () => {
    const c = trace(["####", ".##.", ".##."]);
    expect(c[0]).toEqual({ l: 0, r: 1 });
    expect(c[1]).toEqual({ l: 0.25, r: 0.75 });
  });
  it("counts a soft edge as drawing, and a blank picture as nothing", () => {
    const { data, width, height } = pixels(["...."]);
    data[3] = 40; // ~16% alpha: antialiasing, which belongs inside the outline
    expect(contourFromAlpha(data, width, height, 1)).toEqual([{ l: 0, r: 0.25 }]);
    expect(hasContour(trace(["....", "...."]))).toBe(false);
  });
  it("copes with a degenerate picture", () => {
    expect(contourFromAlpha(new Uint8ClampedArray(0), 0, 0)).toEqual([]);
  });
});

describe("silhouettePolygon", () => {
  it("has nothing to trace when the picture is blank", () => {
    expect(silhouettePolygon([null, null])).toBeNull();
  });

  it("runs down the right edge and back up the left", () => {
    const poly = points(silhouettePolygon(trace(["####", ".##.", "####"])));
    const xs = poly.map((p) => p[0]);
    // A step per band, held for that band's full height: down the right side, then back up the left.
    expect(xs).toEqual([100, 100, 75, 75, 100, 100, 0, 0, 25, 25, 0, 0]);
    const ys = poly.map((p) => p[1]);
    expect(ys.slice(0, 6)).toEqual([0, 33.33, 33.33, 66.67, 66.67, 100]);
    expect(ys.slice(6)).toEqual([100, 66.67, 66.67, 33.33, 33.33, 0]);
  });

  it("spans the full height, so the shape reaches the top and bottom of the box", () => {
    const ys = points(silhouettePolygon(trace(["####", "####", "####", "####"]))).map((p) => p[1]);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(100);
  });

  it("pinches an empty band to the middle, so words close in over a picture's empty corners", () => {
    // A figure with nothing at the top: the outline narrows to a point there rather than staying full width.
    const poly = points(silhouettePolygon([null, { l: 0.2, r: 0.8 }, { l: 0, r: 1 }]));
    expect(poly[0]).toEqual([50, 0]); // right side, top band - collapsed
    expect(poly[poly.length - 1]).toEqual([50, 0]); // left side, same band
  });

  it("collapses a straight edge to two points instead of one per band", () => {
    // A plain rectangle is four corners, however many bands it was scanned in - the steps only appear where the
    // drawing actually changes width.
    expect(points(silhouettePolygon(trace(["####", "####", "####", "####"])))).toEqual([
      [100, 0], [100, 100], [0, 100], [0, 0],
    ]);
  });

  // THE property, and the one a midline-joining outline broke: the shape has to CONTAIN the drawing. A diagonal
  // drawn between band midlines cuts whatever bulges between them, and because the error is a fraction of the
  // picture it grows with the sticker - invisible small, words-on-the-artwork large.
  it("holds a band's full width for that band's whole height, so a bulge is never cut across", () => {
    // A diamond: the middle row is wider than the rows above and below it.
    const poly = points(silhouettePolygon(trace(["..#.", ".###", "..#."])));
    // The middle band reaches x=100%, and it does so from the moment the band STARTS (y = 33.33%), not at its
    // midline - so no line of text inside that band can sit where the drawing is.
    const atBandTop = poly.filter(([, y]) => y === 33.33).map(([x]) => x);
    expect(atBandTop).toContain(100);
  });

  it("contains every opaque pixel, at any band count", () => {
    // The property stated on the geometry: at every height, the shape's right edge is at or beyond the drawing's,
    // so no line of text can land on the artwork. Checked strictly INSIDE each band - the step down to the next
    // band happens on the boundary they share, which belongs to neither.
    const art = ["...##...", "..####..", ".######.", "########", ".######.", "..####..", "...##...", "....#..."];
    for (const bands of [2, 3, 5, 8, 16]) {
      const c = trace(art, bands);
      const poly = points(silhouettePolygon(c));
      const right = poly.slice(0, poly.length / 2); // down the right side; the left half comes back up
      c.forEach((band, i) => {
        if (!band) return;
        const mid = ((i + 0.5) / bands) * 100;
        expect(edgeAt(right, mid), `bands=${bands} band=${i}`).toBeGreaterThanOrEqual(band.r * 100 - 0.01);
      });
    }
  });

  it("never leaves the box, whatever the contour says", () => {
    const wild: Contour = [{ l: -0.5, r: 2 }, { l: 0.4, r: 0.6 }];
    for (const [x, y] of points(silhouettePolygon(wild))) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });
});

// A picture standing BETWEEN two columns is not floated - each column holds an invisible float against its own
// half of it. So each of those needs that half of the outline, re-expressed in a box half as wide.
describe("halfPolygon", () => {
  it("doubles the contour into the half-box it belongs to", () => {
    // Drawing from 0.25 to 0.75 of the picture. In the left half-box (0 to 0.5 of the picture, stretched to
    // 0 to 1) its left edge is at 0.5; in the right half-box its right edge is likewise at 0.5.
    const c = trace([".##."]);
    expect(points(halfPolygon(c, "left"))[0]![0]).toBe(50);
    expect(points(halfPolygon(c, "right"))[1]![0]).toBe(50);
  });

  it("closes back along the side the picture is on", () => {
    const c = trace([".##."]);
    // The left column's spacer excludes everything from the drawing rightwards - there is nowhere to put a word
    // behind the picture.
    expect(points(halfPolygon(c, "left")).slice(-2)).toEqual([[100, 100], [100, 0]]);
    expect(points(halfPolygon(c, "right"))[0]).toEqual([0, 0]);
    expect(points(halfPolygon(c, "right")).slice(-1)).toEqual([[0, 100]]);
  });

  it("excludes nothing from a half the drawing never reaches", () => {
    // Drawing entirely in the right half: the left column has a clear run.
    const c = trace(["...#"]);
    expect(points(halfPolygon(c, "left"))[0]![0]).toBe(100); // flush to the spacer's far edge = no exclusion
    expect(points(halfPolygon(c, "right"))[1]![0]).toBe(100); // the whole right half is taken
  });

  it("takes the whole half when the drawing fills the picture", () => {
    const c = trace(["####"]);
    expect(points(halfPolygon(c, "left"))[0]![0]).toBe(0);
    expect(points(halfPolygon(c, "right"))[1]![0]).toBe(100);
  });

  it("steps rather than slopes, so a bulge is contained here too", () => {
    // Same diamond as the full silhouette: the widest band must be at its full extent from where the band starts.
    const half = points(halfPolygon(trace(["..#.", ".###", "..#."]), "right"));
    expect(half.filter(([, y]) => y === 33.33).map(([x]) => x)).toContain(100);
  });

  it("has nothing to trace when the picture is blank", () => {
    expect(halfPolygon([null], "left")).toBeNull();
    expect(halfPolygon([null], "right")).toBeNull();
  });

  it("keeps every point inside the half-box", () => {
    for (const side of ["left", "right"] as const) {
      for (const [x, y] of points(halfPolygon([{ l: -1, r: 3 }, { l: 0.49, r: 0.51 }], side))) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(100);
      }
    }
  });
});
