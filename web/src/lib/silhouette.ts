// Turning a picture's alpha channel into a CSS `polygon()` the text can wrap around, so Tight and Through follow
// the artwork's real outline rather than a stand-in shape.
//
// Why a polygon we compute, and not `shape-outside: url(art)` - which reads alpha natively? Because that path
// cannot be made to hold here. The unDraw illustrations carry only a viewBox, and an image with no intrinsic size
// gives the property nothing to size the shape from; supplying a size then changes how the image is laid out, so
// the silhouette lands at a different scale from the drawing it is supposed to trace. Rasterising it ourselves has
// neither problem: percentages in a polygon are resolved against the reference box, so the outline is pinned to
// the picture at every size the card is ever drawn at, and the geometry below is ordinary arithmetic that can be
// tested without a browser.
//
// Everything here is dependency-free on purpose (no React, no DOM), so the worker test project can import it -
// same reason as web/src/lib/splitSource.ts. The one part that needs a canvas lives in CardSticker.tsx.

/**
 * The traced outline: for each horizontal band of the picture, where the drawing starts and ends across it, as
 * fractions of the picture's width. An empty band (nothing opaque in it) is `null`.
 */
export type Contour = ({ l: number; r: number } | null)[];

/** How many bands to cut the picture into. Enough to follow a figure's shoulders; few enough to stay a cheap shape. */
export const CONTOUR_BANDS = 36;

/** Alpha at or above this counts as drawing. Low, so soft edges and antialiasing are inside the outline. */
export const ALPHA_THRESHOLD = 0.08;

/** Longest edge of the scan grid. Only sets how fine the outline is - the contour comes out in fractions. */
export const RASTER_MAX = 160;

/**
 * The grid to rasterise a picture into: the picture's OWN aspect, never a square.
 *
 * This matters more than it looks. Scanning into a square would be harmless if the picture stretched to fill it,
 * which is what a PNG does - but an SVG honours `preserveAspectRatio` and LETTERBOXES instead, sitting centred
 * with transparent bands above and below. The scan then reports the drawing inset from the top and bottom of the
 * picture when it is not, and reports the bands as empty - which the outline pinches to a point, inviting the
 * words into exactly the rows the drawing occupies. The unDraw set has a median aspect of 1.28, so that is a band
 * of 11% of the picture's height at each end; as a FRACTION it grows with the sticker, which is what makes the
 * overlap appear only once the picture is big enough for 11% to be worth several lines of text.
 *
 * Matching the grid to the picture removes the letterbox, so the fractions the scan produces are fractions of the
 * artwork itself - which is what the polygon's percentages are resolved against.
 */
export function rasterSize(aspect: number, max = RASTER_MAX): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return a >= 1
    ? { width: max, height: Math.max(1, Math.round(max / a)) }
    : { width: Math.max(1, Math.round(max * a)), height: max };
}

/**
 * Scan RGBA pixels into a contour.
 *
 * Each band takes the widest extent of any row inside it, so a thin arm crossing one scanline is not lost between
 * two samples. The scan is per-axis and the result is fractions, which is what makes the raster size arbitrary:
 * the picture can be rasterised into any grid, square or not, and the percentages still land in the right place.
 */
export function contourFromAlpha(
  data: ArrayLike<number>, // RGBA, four bytes per pixel, row-major
  width: number,
  height: number,
  bands = CONTOUR_BANDS,
  threshold = ALPHA_THRESHOLD,
): Contour {
  const out: Contour = [];
  if (width <= 0 || height <= 0 || bands <= 0) return out;
  const cut = Math.round(threshold * 255);
  for (let b = 0; b < bands; b++) {
    const from = Math.floor((b * height) / bands);
    const to = Math.max(from + 1, Math.floor(((b + 1) * height) / bands));
    let lo = width;
    let hi = -1;
    for (let y = from; y < to && y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < lo; x++) if (data[row + x * 4 + 3]! >= cut) { lo = x; break; }
      for (let x = width - 1; x > hi; x--) if (data[row + x * 4 + 3]! >= cut) { hi = x; break; }
    }
    // `hi + 1` because the extent runs to the far edge of the last opaque pixel, not to its near edge.
    out.push(hi < 0 ? null : { l: lo / width, r: (hi + 1) / width });
  }
  return out;
}

/** True once the contour has enough drawing in it to be worth wrapping to. */
export function hasContour(c: Contour): boolean {
  return c.some(Boolean);
}

const pct = (n: number) => `${(Math.min(1, Math.max(0, n)) * 100).toFixed(2)}%`;

type Point = [number, number];

/**
 * The edge of one side of the shape, as a STAIRCASE: each band contributes a step held at its own extent for that
 * band's full height, rather than a single point at its midline.
 *
 * This is the difference between a shape that contains the drawing and one that merely passes through it. A band's
 * extent is the widest the drawing gets anywhere inside it, so a step spanning the band's whole height encloses
 * every pixel in it. Joining midlines instead draws a diagonal across each band, which cuts the corner wherever
 * the drawing bulges between two samples - and that error is a FRACTION of the picture, so it grows with the
 * sticker. Small, it is invisible; big enough, it is words sitting on the artwork. A staircase cannot do that: it
 * only ever errs outwards, into empty space.
 */
function staircase(c: Contour, edge: (band: { l: number; r: number } | null) => number): Point[] {
  const n = c.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const x = edge(c[i] ?? null);
    out.push([x, i / n], [x, (i + 1) / n]);
  }
  return simplify(out);
}

/** Drop repeated points and the middle of any straight vertical run - same shape, far fewer vertices. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const prev = out[out.length - 2];
    if (last && prev && prev[0] === last[0] && last[0] === p[0]) out.pop(); // collinear on x
    out.push(p);
  }
  return out;
}

const ring = (points: Point[]) => `polygon(${points.map(([x, y]) => `${pct(x)} ${pct(y)}`).join(", ")})`;

/**
 * A `polygon()` for the whole silhouette: down the right edge of the drawing, back up the left.
 *
 * Bands with nothing in them pinch to the middle rather than staying at full width, so the words close in over a
 * picture's empty top corners - which is the entire point of wrapping tight to a figure.
 */
export function silhouettePolygon(c: Contour): string | null {
  if (!hasContour(c)) return null;
  const right = staircase(c, (b) => (b ? b.r : 0.5));
  const left = staircase(c, (b) => (b ? b.l : 0.5));
  return ring([...right, ...left.reverse()]);
}

/**
 * A `polygon()` for the invisible float one COLUMN puts against a picture standing between two of them.
 *
 * That spacer covers half the picture, so its own box is half as wide and the contour has to be re-expressed in
 * it: for the left column, x runs across the picture's left half, and the exclusion is everything from the
 * drawing's left edge to the spacer's far side. The right column is the mirror. A band whose drawing does not
 * reach into this half excludes nothing at all.
 */
export function halfPolygon(c: Contour, side: "left" | "right"): string | null {
  if (!hasContour(c)) return null;
  // A staircase here for the same reason as the full silhouette: it contains the drawing at any size, where a
  // line between midlines would slice through whatever bulges between them.
  const edge = staircase(c, (band) =>
    side === "left"
      ? // Nothing in this half -> the exclusion collapses against the spacer's right edge (x = 1).
        band ? Math.min(1, Math.max(0, band.l) * 2) : 1
      : band ? Math.max(0, (Math.min(1, band.r) - 0.5) * 2) : 0,
  );
  // Closed back along the side the picture is on: the words are held off the drawing, and everything behind it is
  // excluded too - there is nowhere to put a word there anyway.
  return side === "left"
    ? ring([...edge, [1, 1], [1, 0]])
    : ring([[0, 0], ...edge, [0, 1]]);
}
