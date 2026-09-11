import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Move, Scaling } from "lucide-react";
import { cn } from "@/lib/utils";
import { ART_DIECUT } from "@/lib/kudosArt";
import { contourFromAlpha, halfPolygon, hasContour, rasterSize, silhouettePolygon, type Contour } from "@/lib/silhouette";
import type { RecipientLayout, StickerLayout, WrapMode } from "@/types";

// Anything a card lets its author place by hand: a post's sticker, a kudos card's art, a kudos card's recipient
// block. All three are the same idea, so all three are the same code.
//
// Geometry is FRACTIONS of the card's own width, never pixels, because the same card is drawn at feed width, in a
// composer preview and inside a scaled-down frame; a pixel offset would mean a different placement in each. Width
// is expressed in `cqw` (1% of the card's width, via the query container CardCanvas declares) so it means the
// same thing in every wrap mode. Position uses the anchor trick: `left: x%` with `translate(-x%)`. At x=0 the
// element's left edge is flush with the card's, at x=1 its right edge is, and in between it is proportionally
// inside - so it cannot hang outside the card at any size, with no clamping arithmetic.
//
// ---- Wrap modes ---------------------------------------------------------------------------------------------
//
// The word-processor vocabulary, because that is the one people already have. What each means here:
//
//   inline      its own column in the card's row, beside the text. (A word processor anchors an inline picture
//               between two characters; a card body has no such anchor, so a column is the honest reading.)
//   square      floated to whichever side x favours; the text flows around its BOX.
//   tight       the same, but the text follows the DRAWING's outline, so it reclaims the corners the box wastes.
//   through     the same outline, with the words allowed much closer to it.
//
//   top-bottom  its own band across the card: text above and below, never beside.
//   behind      floating free at x/y, underneath the words.
//   front       floating free at x/y, on top of the words.
//
// Tight and through get their outline by tracing the artwork's alpha into a `polygon()` - see lib/silhouette.ts
// for how, and why it is done in a canvas rather than handed to `shape-outside: url()`. The polygon is stated
// against `content-box`, so its percentages resolve against the artwork itself: the outline is pinned to the
// drawing at every size, and a margin cannot pull the two out of register. Until a trace resolves - and for
// anything that will not trace - there is simply no shape, so the mode wraps the box like square does.
//
// ---- What x and y mean --------------------------------------------------------------------------------------
//
// They mean different things per family, because the families are genuinely different kinds of layout:
//
//   behind / front       x and y are both free: the anchor point described above, anywhere on the card.
//   square/tight/through x picks WHICH SIDE the text wraps past (a float has no middle - that is what wrapping
//                        is); y is how far DOWN the card it starts, as a share of the card's width.
//   top-bottom           x aligns it left / centre / right; y is again how far down.
//   inline               neither: the card's own row decides, until the element is dragged out of it.
//
// ---- Sitting IN the text, with words down both sides ---------------------------------------------------------
//
// A float cannot do this. A float only ever shortens a line from one edge, and a line box is contiguous - CSS has
// no way to punch a hole in the middle of a line. (CSS Exclusions was that feature; it never shipped anywhere but
// IE.) So the three wrapped modes take one of three positions, and the middle one is built differently:
//
//   left / right   an ordinary float. Text flows past the one side, following the traced outline for
//                  tight/through.
//   middle         the body is SPLIT INTO TWO COLUMNS and the picture stands between them. Words then run down
//                  both sides of it, which is the thing being asked for. Each column carries an invisible float
//                  holding its half of the gap - and its half of the traced outline - so the words stop clear of
//                  the picture, following it, on both sides at once. The honest
//                  cost is reading order - a reader takes the left column, then the right, rather than crossing
//                  the picture line by line. That is what a magazine does, and it is the only arrangement CSS can
//                  produce: a line box is one rectangle, so no single flow can have words on both sides of an
//                  obstacle.
//
// x therefore snaps to one of those three rather than sliding continuously - the positions are genuinely discrete,
// so pretending otherwise in the drag would only mislead.

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const clamp01 = (n: number) => clamp(n, 0, 1);

export const WRAP_LABELS: { value: WrapMode; label: string }[] = [
  { value: "inline", label: "In line with text" },
  { value: "square", label: "Square" },
  { value: "tight", label: "Tight" },
  { value: "through", label: "Through" },
  { value: "top-bottom", label: "Top and bottom" },
  { value: "behind", label: "Behind text" },
  { value: "front", label: "In front of text" },
];

/**
 * What a card means by a picture it has said nothing else about: text flows past it. It is the arrangement that
 * asks least of the reader - the words keep their column and the picture takes the space beside them - so it is
 * where every kind starts, and the other six are departures from it.
 */
export const DEFAULT_WRAP: WrapMode = "square";

// ---- Tracing the artwork -------------------------------------------------------------------------------------
//
// Tight and Through wrap to the drawing's own silhouette, which means reading its alpha. The geometry is in
// lib/silhouette.ts; what is here is the part that needs a browser - rasterise the picture once, scan it, and
// hand the contour to everything that wants a shape from it.

/**
 * How much air each wrapped mode holds the words off the picture, in rem.
 *
 * One number per mode, used as BOTH the float's margin and its `shape-margin`, because those have to agree: a
 * shape is clipped to the margin box, so air asked for beyond it is simply lost. Square wraps the box and so only
 * ever uses the margin; the difference between tight and through is nothing but this number - how close the words
 * are allowed to come to the outline they are following.
 */
const WRAP_AIR: { square: number } & Partial<Record<WrapMode, number>> = { square: 1.25, tight: 1, through: 0.45 };

const traced = new Map<string, Contour | null>(); // resolved, including failures - a null is not retried
const tracing = new Map<string, Promise<Contour | null>>(); // in flight, so N cards on a feed rasterise once

/**
 * Rewrite an SVG so it rasterises the way a PNG does: at a known size, and filling whatever rectangle it is drawn
 * into.
 *
 * Two edits, both about the scan and neither visible on the card - this copy is painted into a buffer and thrown
 * away, never laid out.
 *
 * `width`/`height` from the viewBox, because the unDraw set carries a viewBox alone and browsers disagree about
 * an image with no intrinsic size. `preserveAspectRatio="none"` because the default LETTERBOXES: the drawing
 * would sit centred in the destination rectangle with transparent bands at the ends, and the scan would read
 * those bands as part of the picture. Stretching instead is harmless here - the scan measures in fractions per
 * axis, and the polygon resolves them per axis too, so the distortion cancels exactly.
 */
function svgForScanning(text: string): string | null {
  const found = /<svg\b[^>]*>/i.exec(text);
  if (!found) return null;
  const original = found[0];
  let tag = original;
  const box = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(tag);
  if (box && !/\swidth\s*=/i.test(tag)) tag = tag.replace(/<svg\b/i, `<svg width="${box[1]}" height="${box[2]}"`);
  tag = /preserveAspectRatio\s*=/i.test(tag)
    ? tag.replace(/preserveAspectRatio\s*=\s*["'][^"']*["']/i, 'preserveAspectRatio="none"')
    : tag.replace(/<svg\b/i, '<svg preserveAspectRatio="none"');
  return tag === original ? null : text.replace(original, tag);
}

/** Rasterise a same-origin picture and scan it. */
async function traceArt(url: string): Promise<Contour | null> {
  let revoke: string | null = null;
  try {
    let src = url;
    if (/\.svg($|\?)/i.test(url)) {
      const rewritten = svgForScanning(await (await fetch(url)).text());
      if (rewritten) {
        revoke = URL.createObjectURL(new Blob([rewritten], { type: "image/svg+xml" }));
        src = revoke;
      }
    }
    const img = new Image();
    img.decoding = "async";
    const loaded = new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("load"));
    });
    img.src = src;
    await loaded;
    // The grid takes the picture's own shape. A square one would letterbox anything that is not square, and the
    // scan would then place the drawing inside bands of nothing that the outline pinches shut - words into the
    // top and bottom of the artwork. See rasterSize.
    const { width, height } = rasterSize(img.naturalWidth / img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const contour = contourFromAlpha(data, width, height);
    return hasContour(contour) ? contour : null;
  } catch {
    // A picture that will not load or a canvas the browser refuses to read: no shape, so the mode falls back to
    // wrapping the box. Worth nothing more than that - it is decoration.
    return null;
  } finally {
    if (revoke) URL.revokeObjectURL(revoke);
  }
}

/** The traced outline of a picture, once it is ready. Null until then, and null for anything untraceable. */
function useSilhouette(url: string | undefined, enabled: boolean): Contour | null {
  const [, bump] = useState(0);
  const key = enabled && url ? url : "";
  useEffect(() => {
    if (!key || traced.has(key)) return;
    let live = true;
    const job = tracing.get(key) ?? traceArt(key).then((c) => {
      traced.set(key, c);
      tracing.delete(key);
      return c;
    });
    tracing.set(key, job);
    void job.then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [key]);
  return key ? traced.get(key) ?? null : null;
}

export type BodyValign = "top" | "middle" | "bottom";
export const VALIGN_LABELS: { value: BodyValign; label: string }[] = [
  { value: "top", label: "Text at top" },
  { value: "middle", label: "Text centred" },
  { value: "bottom", label: "Text at bottom" },
];
// Where the words ride when nobody has said: the middle. A card is a poster, not a document - it is as tall as
// its tallest element, and words pinned to the top of the space that leaves read as a mistake rather than as a
// decision. Everything placed on a card starts centred for the same reason (see PlacedElement).
export const DEFAULT_VALIGN: BodyValign = "middle";

/**
 * Slide a block of text down the room its card has to spare.
 *
 * Not `justify-content`, and not `align-self`: the picture is a FLOAT inside the same block as the words, so that
 * block already contains it and is therefore already as tall as the card. There is no slack for flexbox to hand
 * out - which is why aligning the container did nothing at all. The room is the difference between where the text
 * ends and where the CARD ends, so that is what gets measured.
 *
 * The offset is a `transform`, deliberately: it moves the words without changing layout, so nothing it was measured
 * from shifts underneath it. Which is also why the room has a FLOOR that is not always the card: anything that
 * follows in the flow (a poll's options) keeps the place it was laid out in, so measuring past it would slide the
 * words straight over the top of it. The room ends wherever the next thing begins - see `flowFloor`.
 *
 * Both edges are read with getBoundingClientRect, which is the whole trick. `offsetTop` is relative to whichever
 * ancestor happens to be positioned, while the card's height is the card's own - mixing the two silently loses
 * however far down the card the text starts, so the words moved a fraction of the distance they should have. Rects
 * share one origin, so subtracting them cannot be wrong. The offset already applied is taken back out to recover
 * the untranslated position, and the card's on-screen scale is divided out because the composer previews a card
 * inside a scaled frame - a translation there is in the card's own pixels, not the screen's.
 */
/**
 * The lowest a block may be slid to: the top of whatever comes NEXT below it, or the card's own bottom when
 * nothing does.
 *
 * "Next" is not just the element's own sibling - the thing that follows it may be a sibling of an ancestor (a
 * poll's options sit outside the text block but inside the card), so the walk climbs to the card box looking for
 * the first one. Two kinds of neighbour are not floors:
 *
 *   Out of flow. A floated or absolutely positioned sticker was placed on the card deliberately, and letting the
 *   words pass it is the whole point of wrapping it.
 *
 *   Beside rather than below. A kudos card's recipient column is the next sibling of the remark's column, but it
 *   sits alongside it in a flex row - clamping to its top would pin the remark to the top of the card. So a
 *   neighbour only counts once it actually starts at or below where this block ends.
 */
function flowFloor(el: HTMLElement, box: HTMLElement, naturalBottom: number): number {
  for (let node: HTMLElement | null = el; node && node !== box; node = node.parentElement) {
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const cs = getComputedStyle(sib);
      if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed" || cs.float !== "none") continue;
      const top = sib.getBoundingClientRect().top;
      if (top >= naturalBottom - 1) return top;
    }
  }
  return box.getBoundingClientRect().bottom;
}

export function ValignBlock({ valign, className, children }: { valign?: BodyValign; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const applied = useRef(0); // what the transform is currently worth, so a measurement can undo it
  // Absent means centred, not top - see DEFAULT_VALIGN. Only "top" is a no-op, and it has to be stored to be had.
  const mode = valign ?? DEFAULT_VALIGN;
  const active = mode !== "top";
  applied.current = active ? offset : 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) {
      setOffset(0);
      return;
    }
    const box = el.closest("[data-card-box]") as HTMLElement | null;
    if (!box) return;
    const measure = () => {
      const boxRect = box.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const scale = box.offsetHeight > 0 ? boxRect.height / box.offsetHeight : 1;
      if (!scale) return;
      // Where the text's bottom edge would sit with no offset at all, and how much room is left underneath it
      // before the next thing in the flow (or the card's own floor).
      const naturalBottom = elRect.bottom - applied.current * scale;
      const room = (flowFloor(el, box, naturalBottom) - naturalBottom) / scale;
      const next = Math.max(0, Math.round(room * (mode === "middle" ? 0.5 : 1)));
      setOffset((cur) => (cur === next ? cur : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, mode]);

  return (
    <div ref={ref} className={className} style={offset ? { transform: `translateY(${offset}px)` } : undefined}>
      {children}
    </div>
  );
}

export function inTextFlow(wrap: WrapMode): boolean {
  return wrap === "square" || wrap === "tight" || wrap === "through" || wrap === "top-bottom";
}
export const isLayer = (wrap: WrapMode) => wrap === "behind" || wrap === "front";
export const isWrapped = (wrap: WrapMode) => wrap === "square" || wrap === "tight" || wrap === "through";

/** Which of the three positions a wrapped element is in. Snapped, because they are discrete. */
export function wrapSide(x: number): "left" | "middle" | "right" {
  return x <= 0.25 ? "left" : x >= 0.75 ? "right" : "middle";
}

/**
 * Whether this placement needs its text block split into two columns - the only way to get words down both sides
 * of a picture. The card asks, because it owns the text block; see the note at the top of this file.
 */
export function needsColumns(at: Placement | null | undefined, fallback: Placement): boolean {
  const eff = at ?? fallback;
  return isWrapped(eff.wrap ?? DEFAULT_WRAP) && wrapSide(eff.x) === "middle";
}

/**
 * How tall the card body has to be, in cqw, to actually CONTAIN this element.
 *
 * It matters because a card clips what overflows it, and two of the families sit outside the normal flow: a float
 * adds nothing to its parent's height, and an absolutely positioned one adds nothing either. Push either one down
 * and, without this, it slides out of the card and simply vanishes. So the card grows to follow it - which is also
 * the honest WYSIWYG behaviour, since that is what the posted card will do.
 *
 * The two in-flow families need nothing: a column and a band are laid out by the card and size it themselves.
 */
export function reserveFor(at: Placement | null | undefined, fallback: Placement, aspect = 1): number {
  const eff = at ?? fallback;
  const wrap = eff.wrap ?? DEFAULT_WRAP;
  const height = (eff.size * 100) / Math.max(0.01, aspect);
  // A floating element's anchor already keeps it inside the box, so it only has to be tall enough for it.
  if (isLayer(wrap)) return height;
  // Every wrapped mode is pushed down by its own offset, and a float adds no height to its parent - so the card
  // has to be told. The 2cqw is for the heading above it, which the offset is not measured from.
  if (isWrapped(wrap)) return Math.max(0, eff.y) * 100 + height + 2;
  return 0;
}

/**
 * The invisible float a column puts against the picture standing between it and the other column: half the
 * picture's width, floated towards it, so the words in that column stop at the artwork instead of running under
 * it.
 *
 * Square holds them off the whole half-box. Tight and through trace the drawing here too, each column taking its
 * own half of the outline, so the words close in on the figure from both sides at once.
 */
export function HalfSpacer({
  at,
  fallback,
  aspect,
  side,
  artUrl,
}: {
  at: Placement | null | undefined;
  fallback: Placement;
  aspect: number;
  side: "left" | "right"; // which side of the picture this column is on
  artUrl?: string; // the picture in the gutter, when it is one - the recipient block is a DOM box with no outline
}) {
  const eff = at ?? fallback;
  const wrap = eff.wrap ?? DEFAULT_WRAP;
  const wantsOutline = wrap === "tight" || wrap === "through";
  const contour = useSilhouette(artUrl, wantsOutline);
  // The spacer stands for the half of the picture on its side of the gutter, so it takes that half of the outline.
  // Its own left/right is the mirror of the column's: the column on the LEFT of the picture holds the picture's
  // left contour.
  const outline = contour && wantsOutline ? halfPolygon(contour, side) : null;
  // The same air as a float of this mode, and it goes in the PADDING either way. Without a shape the padding is
  // what holds the words off. With one the padding is what makes room for `shape-margin` to be honoured, since a
  // shape is clipped to the margin box - so zero padding here would clip the air away to nothing.
  //
  // `content-box` keeps it from eating into the half-picture the spacer stands for: the box grows around it, and
  // the polygon's percentages still resolve against the half-picture itself.
  const air = WRAP_AIR[wrap] ?? WRAP_AIR.square;
  return (
    <div
      aria-hidden
      style={{
        // The column on the LEFT of the picture floats its spacer right, against it, and vice versa.
        float: side === "left" ? "right" : "left",
        boxSizing: "content-box",
        padding: `${air}rem`,
        width: `${((eff.size * 100) / 2).toFixed(2)}cqw`,
        height: `${((eff.size * 100) / Math.max(0.01, aspect)).toFixed(2)}cqw`,
        marginTop: `${(Math.max(0, eff.y) * 100).toFixed(2)}cqw`,
        ...(outline ? { shapeOutside: `content-box ${outline}`, shapeMargin: `${air}rem` } : null),
      }}
    />
  );
}

// Where each thing starts: beside the words, wrapped, on its own side of the card - the post's sticker to the
// right, a kudos card's art to the left and its recipient to the right. `y: 0` is the placement these carry once
// someone picks them up FROM the top; until then nobody has, and an untouched element is centred in the card's
// height by measurement (see PlacedElement), because how far down "the middle" is depends on the card.
export const POST_STICKER_LAYOUT: StickerLayout = { x: 1, y: 0, size: 0.28, opacity: 1, wrap: DEFAULT_WRAP };
export const KUDOS_STICKER_LAYOUT: StickerLayout = { x: 0, y: 0, size: 0.22, opacity: 1, wrap: DEFAULT_WRAP };
export const KUDOS_RECIPIENT_LAYOUT: RecipientLayout = { x: 1, y: 0, size: 0.13, wrap: DEFAULT_WRAP };

export const MIN_STICKER_SIZE = 0.06;
export const MAX_STICKER_SIZE = 1;

/** Anything placeable: a point, a width, a wrap mode, and (for art) an opacity. */
export type Placement = { x: number; y: number; size: number; opacity?: number; wrap?: WrapMode };

const familyOf = (wrap: WrapMode) => (isLayer(wrap) ? "layer" : inTextFlow(wrap) ? "flow" : "inline");

/**
 * Switch an element's wrap mode, resetting y when it crosses into a family that reads y differently. Without
 * this, a card default anchored halfway down (y = 0.5) would become a half-a-card-wide top margin the instant it
 * was set to Square.
 */
export function withWrap<T extends Placement>(at: T, wrap: WrapMode): T {
  const from = familyOf(at.wrap ?? DEFAULT_WRAP);
  const to = familyOf(wrap);
  if (from === to) return { ...at, wrap };
  return { ...at, wrap, y: to === "flow" ? 0 : 0.5 };
}

/**
 * Something the author can drag and resize on a card.
 *
 * It has two states and one DOM node. Untouched (`at` is null) it renders exactly as the card's own design says -
 * usually a column in the card's row. The first drag or resize MEASURES where it currently sits, turns that into
 * fractions, and switches the same element to its placed form mid-gesture. Because the node never unmounts, the
 * pointer capture survives and the drag continues without a stutter: no mode to arm, no button to press, you just
 * pick the thing up.
 *
 * Dragging something that is in the text means "I'll position this myself", so it becomes a floating element -
 * the same thing a word processor does. Dragging something that is already wrapped (square/tight/…) only chooses
 * which side of the text it takes; dragging a floating one moves it freely.
 */
export function PlacedElement<T extends Placement>({
  at,
  template,
  onChange,
  aspect = 1,
  label,
  artUrl,
  className,
  flowClassName,
  children,
}: {
  at: T | null | undefined; // null = still exactly as the card's design has it
  template: T; // the card's default, including the wrap mode it starts in
  onChange?: (next: T) => void; // set = the composer preview, where it can be dragged
  aspect?: number; // width / height, so a resize can keep the top-left corner pinned
  label?: string; // what the handles' tooltips call it
  artUrl?: string; // a picture, whose silhouette tight and through wrap to. A DOM block has none, and keeps its box.
  className?: string;
  flowClassName?: string; // what it looks like before anyone has touched it
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const editable = !!onChange;
  const eff = at ?? template;
  const wrap = eff.wrap ?? DEFAULT_WRAP;

  // Untouched, a wrapped element rides in the MIDDLE of the card's height rather than at its top - the same
  // decision ValignBlock makes for the words, for the same reason: the card is as tall as its tallest element,
  // and everything else hugging the ceiling of the space that leaves looks like a bug.
  //
  // It is measured rather than authored because a float's `y` is a top MARGIN in card-widths, and centring
  // depends on the card's height, which nothing here knows in advance. Measured, so the offset is dropped the
  // moment the author places the element themselves (`at` set) - and the handover is seamless, because the drag
  // converts this exact offset into the `y` it stands for.
  //
  // Unlike a ValignBlock's transform, this offset is LAYOUT: pushing a float down can push the content that
  // avoids it (a poll's options) down too, which makes the card taller, which would leave more room to centre in,
  // which would push it further - a loop that never settles. So the geometry is always read with the offset
  // momentarily removed. The result is then a pure function of the un-offset layout: measuring again returns the
  // same number and the loop stops on its first pass.
  const centred = !at && isWrapped(wrap);
  const [centreOffset, setCentreOffset] = useState(0);
  const appliedCentre = useRef(0); // what the margin is currently worth, so a drag can turn it into a `y`
  appliedCentre.current = centred ? centreOffset : 0;
  // Which property carries it: the gutter placement is absolutely positioned, everything else floats.
  const centreProp: "top" | "marginTop" = isWrapped(wrap) && wrapSide(eff.x) === "middle" ? "top" : "marginTop";
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !centred) {
      setCentreOffset(0);
      return;
    }
    const box = el.closest("[data-card-box]") as HTMLElement | null;
    if (!box) return;
    const measure = () => {
      // Read the card as it would be with this element at the top of it, then put the offset back. Both writes
      // land inside one callback, so the observer sees no net change and does not re-fire.
      const restore = el.style[centreProp];
      el.style[centreProp] = "0px";
      const boxRect = box.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      el.style[centreProp] = restore;
      // The composer previews a card inside a scaled frame; the offset is in the card's own pixels.
      const scale = box.offsetHeight > 0 ? boxRect.height / box.offsetHeight : 1;
      if (!scale) return;
      const room = (boxRect.bottom - elRect.bottom) / scale;
      const next = Math.max(0, Math.round(room / 2));
      setCentreOffset((cur) => (cur === next ? cur : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(el);
    return () => ro.disconnect();
  }, [centred, wrap, centreProp]);
  // Only the two modes that ask for it pay for a trace, and only when the picture is actually floated beside the
  // words - a band or a free-floating one displaces nothing.
  const wantsOutline = (wrap === "tight" || wrap === "through") && wrapSide(eff.x) !== "middle";
  const contour = useSilhouette(artUrl, wantsOutline);
  const outline = contour && wantsOutline ? silhouettePolygon(contour) : null;
  const air = WRAP_AIR[wrap] ?? WRAP_AIR.square;

  function startGesture(e: React.PointerEvent, mode: "move" | "resize") {
    const el = ref.current;
    // For a floated or in-column element the offsetParent is whatever positioned ancestor encloses it; for a
    // placed one it is the box it is positioned against. Both are the card's body, which is what x/y mean.
    const box = el?.offsetParent as HTMLElement | null;
    if (!editable || !el || !box) return;
    e.preventDefault();
    e.stopPropagation();
    const start = el.getBoundingClientRect();
    const parent0 = box.getBoundingClientRect();
    // Untouched: convert where it IS into a placement, so the first drag picks it up from exactly where the
    // author sees it rather than jumping to a default corner.
    const measured: T = at ?? {
      ...template,
      size: parent0.width > 0 ? start.width / parent0.width : template.size,
      x: parent0.width - start.width > 1 ? clamp01((start.left - parent0.left) / (parent0.width - start.width)) : 0,
      // y means two different things, so it is measured two different ways. In the flow it is a top MARGIN in
      // card-widths - and an untouched element's margin is exactly the centring offset it is sitting on, so
      // picking it up leaves it where it looks. Out of the flow it is a fraction of the free space instead.
      // `offsetWidth` rather than the rect: the offset was measured in the card's own pixels, and the composer
      // previews the card inside a scaled frame, so the rect would divide by the wrong width.
      y: isWrapped(wrap)
        ? (box.offsetWidth > 0 ? clamp(appliedCentre.current / box.offsetWidth, 0, 1) : 0)
        : parent0.height - start.height > 1 ? clamp01((start.top - parent0.top) / (parent0.height - start.height)) : 0,
    };
    // Dragging the element out of the card's own column means "I'll position this myself", so it becomes a
    // floating one - unless the card's default is already floating (a post's sticker lives behind the words), in
    // which case it stays where it is. A wrap the author CHOSE is never overridden: dragging a square/tight/
    // through/top-bottom element only moves it along its one axis, which is which side of the text it takes.
    const detach = mode === "move" && (measured.wrap ?? DEFAULT_WRAP) === "inline";
    const base: T = detach ? { ...measured, wrap: isLayer(template.wrap ?? DEFAULT_WRAP) ? template.wrap : "front" } : measured;
    const startWrap = base.wrap ?? DEFAULT_WRAP;

    const grabX = e.clientX - start.left;
    const grabY = e.clientY - start.top;
    // Where this element would sit with no offset at all. In the flow, y is a top margin rather than an anchor,
    // so the drag has to know the zero point to measure against. Content above a float does not move when its
    // margin grows, which is what makes this stable for the length of the gesture.
    const naturalTop = start.top - (inTextFlow(startWrap) ? Math.max(0, base.y) * parent0.width : 0);
    const offX = start.left - parent0.left;
    const offY = start.top - parent0.top;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    if (base !== at) onChange!(base); // commit immediately, so the rest of the gesture drags the placed form

    const onMove = (ev: PointerEvent) => {
      const parent = box.getBoundingClientRect();
      if (mode === "move") {
        if (!isLayer(startWrap)) {
          // Horizontally a wrapped element chooses a side (or, for top-and-bottom, an alignment) - a float has no
          // middle. Vertically it is free: the pointer sets how far down the card it starts.
          const raw = clamp01((ev.clientX - parent.left) / Math.max(1, parent.width));
          onChange!({
            ...base,
            // Left, middle or right - the three arrangements that exist. Snapped rather than continuous, because
            // anything in between would render as one of these anyway.
            x: isWrapped(startWrap) ? (wrapSide(raw) === "left" ? 0 : wrapSide(raw) === "right" ? 1 : 0.5) : raw,
            // A band's y says WHICH GAP between paragraphs it belongs in, so it tracks down the card's height. A
            // float's y is a top offset instead, measured in card-widths like every other length here.
            y:
              startWrap === "top-bottom"
                ? clamp01((ev.clientY - parent.top) / Math.max(1, parent.height))
                : clamp((ev.clientY - grabY - naturalTop) / Math.max(1, parent.width), 0, 1),
          });
          return;
        }
        const freeW = parent.width - start.width;
        const freeH = parent.height - start.height;
        onChange!({
          ...base,
          x: freeW > 1 ? clamp01((ev.clientX - parent.left - grabX) / freeW) : 0,
          y: freeH > 1 ? clamp01((ev.clientY - parent.top - grabY) / freeH) : 0,
        });
        return;
      }
      // Resize from the bottom-right. For a floating element x/y are re-derived so the top-left corner stays put
      // instead of it sliding as it grows; a wrapped one has no x/y to keep.
      const w = clamp((ev.clientX - parent.left - offX) / parent.width, MIN_STICKER_SIZE, MAX_STICKER_SIZE);
      if (!isLayer(startWrap)) {
        onChange!({ ...base, size: w });
        return;
      }
      const wPx = w * parent.width;
      const hPx = wPx / aspect;
      onChange!({
        ...base,
        size: w,
        x: parent.width - wPx > 1 ? clamp01(offX / (parent.width - wPx)) : 0,
        y: parent.height - hPx > 1 ? clamp01(offY / (parent.height - hPx)) : 0,
      });
    };
    const onUp = () => {
      setDragging(false);
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  const side = eff.x < 0.5 ? "left" : "right";
  // The width always follows the placement in force. The one exception is an element nobody has touched yet whose
  // card sizes it itself (the kudos art column is a flat 200px) - there the card's class wins until the first
  // edit, and because that first edit MEASURES the element, the handover is seamless rather than a jump.
  const sizedByCard = !at && !!flowClassName;
  const style: CSSProperties = {
    width: sizedByCard ? undefined : `${(eff.size * 100).toFixed(2)}cqw`,
    // Opacity is part of the placement in every mode; a sticker faded in its column stays faded when floated.
    ...(eff.opacity !== undefined ? { opacity: eff.opacity } : null),
  };

  if (isLayer(wrap)) {
    Object.assign(style, {
      left: `${eff.x * 100}%`,
      top: `${eff.y * 100}%`,
      transform: `translate(${eff.x * -100}%, ${eff.y * -100}%)`,
    });
  } else if (isWrapped(wrap) && wrapSide(eff.x) === "middle") {
    // Centred in the two-column gutter its card has opened up for it. Absolute rather than floated, because a
    // float would be pulled back to an edge - and absolute positioning from this same parent means a drag from
    // one position to the other never moves the DOM node.
    Object.assign(style, {
      position: "absolute",
      left: "50%",
      transform: "translateX(-50%)",
      top: centred ? `${centreOffset}px` : `${(Math.max(0, eff.y) * 100).toFixed(2)}cqw`,
    });
  } else if (isWrapped(wrap)) {
    Object.assign(style, {
      float: side,
      // Square has no shape, so its standoff is simply the margin. Tight and through replace the margin box with
      // their outline, so for them the air comes from `shape-margin` instead - and the margin has to be at least
      // as wide as that air, because a shape is CLIPPED to the float's margin box. A 1rem shape-margin behind a
      // 0.5rem margin is half a rem of air and half a rem thrown away.
      //
      // Naming `content-box` on the polygon is what keeps this safe: its percentages resolve against the artwork,
      // so growing the margin cannot slide the outline out of register with the drawing it traces.
      [side === "left" ? "marginRight" : "marginLeft"]: `${air}rem`,
      marginBottom: `${air}rem`,
      // Untouched, the measured centring offset; placed, the author's own top margin. Both are "how far down the
      // card this starts", which is why the first drag can convert one into the other without it moving.
      marginTop: centred ? `${centreOffset}px` : `${(Math.max(0, eff.y) * 100).toFixed(2)}cqw`,
      // No outline yet (still tracing, or nothing traceable) means no shape, and the mode wraps the box - which is
      // exactly what square does, so the picture reads right at every moment rather than jumping when it resolves.
      ...(outline ? { shapeOutside: `content-box ${outline}`, shapeMargin: `${air}rem` } : null),
    });
  } else if (wrap === "top-bottom") {
    Object.assign(style, {
      display: "block",
      // No top margin: a band sits BETWEEN two paragraphs (the card hands it to RichText at the gap y picks), and
      // a margin here would shove the whole body down instead of moving the band through it.
      marginTop: "0.75rem",
      marginBottom: "0.75rem",
      marginLeft: eff.x < 0.34 ? "0" : "auto",
      marginRight: eff.x > 0.66 ? "0" : "auto",
    });
  }

  // The outline and the handles are editing chrome, not part of the card: they surface when the card is hovered
  // (and stay put for the length of a drag) so the preview reads as the finished post the rest of the time.
  const chrome = dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100";
  const handle =
    "absolute z-20 flex items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-md transition-all hover:scale-110";

  return (
    <div
      ref={ref}
      onPointerDown={editable ? (e) => startGesture(e, "move") : undefined}
      style={style}
      className={cn(
        "select-none",
        // Floating elements come out of the flow; everything else stays in it and only needs to be positioned
        // enough for its own handles to hang off the corners.
        isLayer(wrap) || (isWrapped(wrap) && wrapSide(eff.x) === "middle") ? "absolute" : "relative",
        // -z-10 stays inside the canvas (which isolates), so "behind" means behind the words, not behind the card.
        wrap === "behind" ? "-z-10" : wrap === "front" ? "z-20" : undefined,
        editable
          ? cn(
              // pointer-events-auto because the content layer around it may be switched off during placement.
              "pointer-events-auto cursor-grab touch-none rounded ring-primary ring-offset-2 ring-offset-card transition-shadow active:cursor-grabbing",
              dragging ? "ring-2" : "group-hover:ring-2",
            )
          : "pointer-events-none",
        !at && flowClassName,
        className,
      )}
    >
      {children}
      {editable && (
        <>
          {/* Both handles stay in place rather than appearing only on the element itself: how you move and resize
              something should never be a thing you have to discover. */}
          <span
            aria-hidden
            title={`Drag to move${label ? ` the ${label}` : ""}`}
            onPointerDown={(e) => startGesture(e, "move")}
            className={cn(handle, chrome, "-left-2.5 -top-2.5 h-6 w-6 cursor-grab touch-none active:cursor-grabbing")}
          >
            <Move className="h-3 w-3" />
          </span>
          <span
            aria-hidden
            title={`Drag to resize${label ? ` the ${label}` : ""}`}
            onPointerDown={(e) => startGesture(e, "resize")}
            className={cn(handle, chrome, "-bottom-2.5 -right-2.5 h-6 w-6 cursor-nwse-resize touch-none")}
          >
            <Scaling className="h-3 w-3" />
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The frame a card's content and its placed elements share.
 *
 * It declares the query container every width is measured against, and the one positioned box that every placed
 * element anchors to - in every wrap mode, so a mode change never changes what x and y mean. `isolate` is what
 * makes "behind" behave: it gives the box its own stacking context, so a `-z-10` element sits under the words but
 * still over the card's background instead of vanishing beneath it.
 *
 * `reserve` keeps room for an element floating clear of the text, in cqw - the same unit as everything else,
 * because a card is only ever as wide as it is.
 *
 * `data-card-box` marks the box as the height a ValignBlock inside measures itself against.
 */
export function CardCanvas({ reserve, children, className }: { reserve?: number; children: ReactNode; className?: string }) {
  return (
    // `cqw` resolves against an ANCESTOR container, so this wrapper and the box below it cannot be the same
    // element. `group` drives the hover chrome of every placed element inside.
    <div className={cn("[container-type:inline-size]", className)}>
      <div data-card-box className="group relative isolate" style={reserve ? { minHeight: `${reserve.toFixed(2)}cqw` } : undefined}>
        {children}
      </div>
    </div>
  );
}

/** The artwork itself, sized by whatever placement holds it. */
export function StickerImage({ url, onAspect }: { url: string; onAspect?: (a: number) => void }) {
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("h-auto w-full select-none object-contain", ART_DIECUT)}
      onLoad={(e) => {
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
        if (w > 0 && h > 0) onAspect?.(w / h);
      }}
      onError={(e) => { e.currentTarget.style.display = "none"; }}
    />
  );
}
