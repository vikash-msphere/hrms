// The kudos sticker set: PNG artwork in web/public/assets/kudos. Picking a category in the composer seeds the
// card's `illustration` with one of that category's stickers, which the giver can then swap or clear. Each
// sticker has its slogan drawn into the image ("Good Job!", "Out Of The Box"), so which category it suits is a
// judgement about the wording - not something derivable from the file name. That pairing therefore lives in the
// `settings/kudos` category config (`art`), editable in Settings, and this module only lists what is on disk so
// the editor can offer it.
//
// Adding a sticker: drop the file in web/public/assets/kudos and add its name here, spelled exactly as on disk -
// KudosArtPicker filters a saved set through this list, so a typo drops that sticker from the category instead
// of just showing a broken thumbnail.

export const KUDOS_ART_FILES = [
  "brain-storming.png",
  "coffee-time.png",
  "creative-buddy.png",
  "creative-mind.png",
  "drawing.png",
  "embrace-your-perfection.png",
  "explore-new-world.png",
  "focus-time.png",
  "good-job.png",
  "hard-work.png",
  "i-heart-design.png",
  "imagination.png",
  "open-mind.png",
  "out-of-the-box.png",
  "ready-set-go.png",
  "relax-time.png",
  "think-about.png",
  "thinking-out-loud.png",
  "tidy-up.png",
  "you-did-it.png",
] as const;

export type KudosArtFile = (typeof KUDOS_ART_FILES)[number];

// URL for a sticker file name. Anything unrecognised still resolves - a file removed from disk but left in the
// config just fails the <img> load, and every caller hides the image on error rather than validating up front.
export function kudosArtUrl(file: string): string {
  return `/assets/kudos/${file}`;
}

// Die-cut backing for dark mode, for BOTH art sets. The kudos stickers letter their slogans in dark navy, and
// the unDraw illustrations paint hair/trousers/shoes/outlines in near-black Blue 950 (see
// web/public/assets/illustrations/README.md) - either one disappears against a dark card, so all card art gets a
// solid white silhouette behind it - the printed-sticker look - rather than a rectangular plate.
//
// Four chained zero-blur opaque drop-shadows do it. A drop-shadow paints the ALPHA SILHOUETTE behind the element,
// and each filter in a chain applies to the previous one's output, so the horizontal pair spreads the silhouette
// +-Npx and the vertical pair then spreads that union, filling the corners: a square-kernel dilation, solid
// because the shadow colour is opaque. It follows every glyph too, since each letter is its own island on
// transparency - which is the point, that is where the legibility comes from. A `background` cannot do this; it
// would fill the element's box.
//
// 2px on the card is where the slogans read clearly while adjacent letters stay separate (at 4px they merge into
// a blob); thumbnails take 1px so the outline stays proportional. Light mode gets none of this.
//
// Spelled out in full rather than built from a radius, because Tailwind only emits classes it can see literally
// in the source - a composed string would leave these rules out of the stylesheet entirely.

/** Solid white die-cut silhouette behind full-size card art, dark mode only. */
export const ART_DIECUT =
  "dark:[filter:drop-shadow(2px_0_0_#fff)_drop-shadow(-2px_0_0_#fff)_drop-shadow(0_2px_0_#fff)_drop-shadow(0_-2px_0_#fff)]";

/** Same, one pixel thinner, for previews and picker thumbnails. */
export const ART_DIECUT_SM =
  "dark:[filter:drop-shadow(1px_0_0_#fff)_drop-shadow(-1px_0_0_#fff)_drop-shadow(0_1px_0_#fff)_drop-shadow(0_-1px_0_#fff)]";

// "good-job.png" -> "Good job". For labelling the choices in the editor.
export function kudosArtLabel(file: string): string {
  return file
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/-/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

// A kudos card's `illustration` holds one of two things: a `<file>.png` brand sticker from this set, or a
// `<category>/<slug>` illustration from the unDraw set. The suffix tells them apart - see normalizeIllustration
// in src/services/announcements.ts, which is what pins the two shapes.
export function isKudosSticker(value?: string | null): boolean {
  return !!value && value.toLowerCase().endsWith(".png");
}

// URL for whichever of the two a card carries. A value naming no file just fails the <img> load, and every caller
// hides the image on error, so there is nothing to validate here.
export function kudosCardArtUrl(value: string): string {
  return isKudosSticker(value) ? kudosArtUrl(value) : `/assets/illustrations/${value}.svg`;
}

// A category's sticker set. Tolerates a bare string because `settings/kudos` is a free-form blob an admin can
// hand-edit, and a single sticker is the obvious thing to type.
export function kudosArtFiles(art?: string | string[] | null): string[] {
  if (Array.isArray(art)) return art.filter((f) => typeof f === "string" && f.trim().length > 0);
  return typeof art === "string" && art.trim() ? [art] : [];
}
