import { invalidArgument } from "../lib/errors";

// Card art on a board post - the picture itself and where it sits. Pure validation, no I/O, so both the write
// path (services/announcements) and the read path (http/serialize) can use it without importing each other.

// Art on a board card - any kind, not only kudos: an announcement, a post and a poll all carry the same optional
// sticker, in one of exactly two shapes:
//   `<category>/<slug>`  an illustration in web/public/assets/illustrations (the unDraw set)
//   `<file>.png`         a brand sticker in web/public/assets/kudos (the same set HR assigns per category)
// Both are held in one column because they answer one question - what picture goes on this card - and the two are
// told apart by the `.png` suffix, which the web resolves to the right directory.
//
// The web app interpolates this straight into an <img src>, so the shape is pinned here and not merely at the
// edge: no scheme, no host, no `..`, no leading slash, and a sticker may not contain a slash at all. Otherwise a
// post would be a way to point the card at an arbitrary URL. A value that passes but names no file just fails to
// load, and the card simply shows no art - on every kind alike, a kudos included.
const ILLUSTRATION_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STICKER_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.png$/;

export function normalizeIllustration(v?: string | null): string | null {
  const s = v?.trim();
  if (!s) return null;
  if (!ILLUSTRATION_RE.test(s) && !STICKER_RE.test(s)) {
    throw invalidArgument("illustration must be a <category>/<slug> path or a <file>.png sticker name");
  }
  return s;
}

// Where the sticker sits on the card, once an author has moved/resized/faded it. Everything is a FRACTION, never
// a pixel: `x`/`y` are the anchor point in the card body (0 = flush left/top, 1 = flush right/bottom, the element
// translated by the same proportion so it can never hang outside), `size` is the width as a share of the card's
// width, and `opacity` speaks for itself. Fractions are the only thing that survives the same card being drawn at
// feed width, at dashboard width and in a composer preview.
//
// Stored as a JSON string in one column rather than four, because it is one decision - the placement - and
// nothing queries it. Null (or an omitted layout) means the default inline flow, which is why every field is
// required here: a half-specified placement has no sensible reading.
// How the card's words behave around a placed element, borrowed wholesale from a word processor because that is
// the vocabulary people already have for it. What each one means in a card is spelled out in
// web/src/components/common/CardSticker.tsx, next to the CSS that implements it.
export const WRAP_MODES = ["inline", "square", "tight", "through", "top-bottom", "behind", "front"] as const;
export type WrapMode = (typeof WRAP_MODES)[number];
const isWrap = (v: unknown): v is WrapMode => typeof v === "string" && (WRAP_MODES as readonly string[]).includes(v);

export type IllustrationLayout = { x: number; y: number; size: number; opacity: number; wrap?: WrapMode };

const LAYOUT_BOUNDS = { x: [0, 1], y: [0, 1], size: [0.05, 1], opacity: [0.05, 1] } as const;

export function normalizeIllustrationLayout(v?: IllustrationLayout | null): string | null {
  if (v === null || v === undefined) return null;
  const out = {} as IllustrationLayout;
  for (const [key, bounds] of Object.entries(LAYOUT_BOUNDS) as ["x" | "y" | "size" | "opacity", readonly [number, number]][]) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n)) throw invalidArgument(`illustration_layout.${key} must be a number`);
    // Clamped rather than rejected: a drag that ends a pixel past the edge is the author saying "flush against
    // it", not a malformed request.
    out[key] = Math.min(bounds[1], Math.max(bounds[0], Math.round(n * 1000) / 1000));
  }
  if (v.wrap !== undefined && v.wrap !== null) {
    if (!isWrap(v.wrap)) throw invalidArgument(`illustration_layout.wrap must be one of ${WRAP_MODES.join(", ")}`);
    out.wrap = v.wrap;
  }
  return JSON.stringify(out);
}

// A kudos card's recipient block (the avatar and the name) is placeable exactly like the art: moved and resized,
// in the same fractions of the card's width, with the same anchor semantics (0 = flush left/top, 1 = flush
// right/bottom). It carries no opacity - a half-transparent photo of the person being recognized is not a look
// anyone needs, and an absent dial is one fewer way to make the card worse.
export type RecipientLayout = { x: number; y: number; size: number; wrap?: WrapMode };

const RECIPIENT_BOUNDS = { x: [0, 1], y: [0, 1], size: [0.05, 1] } as const;

export function normalizeRecipientLayout(v?: RecipientLayout | null): string | null {
  if (v === null || v === undefined) return null;
  const out = {} as RecipientLayout;
  for (const [key, bounds] of Object.entries(RECIPIENT_BOUNDS) as ["x" | "y" | "size", readonly [number, number]][]) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n)) throw invalidArgument(`recipient_layout.${key} must be a number`);
    out[key] = Math.min(bounds[1], Math.max(bounds[0], Math.round(n * 1000) / 1000));
  }
  if (v.wrap !== undefined && v.wrap !== null) {
    if (!isWrap(v.wrap)) throw invalidArgument(`recipient_layout.wrap must be one of ${WRAP_MODES.join(", ")}`);
    out.wrap = v.wrap;
  }
  return JSON.stringify(out);
}

export function parseRecipientLayout(v?: string | null): RecipientLayout | undefined {
  if (!v) return undefined;
  try {
    const o = JSON.parse(v) as RecipientLayout;
    if (typeof o?.x !== "number" || typeof o?.y !== "number" || typeof o?.size !== "number") return undefined;
    return { x: o.x, y: o.y, size: o.size, ...(isWrap(o.wrap) ? { wrap: o.wrap } : null) };
  } catch {
    return undefined;
  }
}

// The stored JSON back out for the wire. Unparseable (a hand-edited row, an older shape) reads as no placement
// rather than breaking the whole board.
export function parseIllustrationLayout(v?: string | null): IllustrationLayout | undefined {
  if (!v) return undefined;
  try {
    const o = JSON.parse(v) as IllustrationLayout;
    if (typeof o?.x !== "number" || typeof o?.y !== "number" || typeof o?.size !== "number" || typeof o?.opacity !== "number") return undefined;
    return isWrap(o.wrap) ? o : { x: o.x, y: o.y, size: o.size, opacity: o.opacity };
  } catch {
    return undefined;
  }
}
