// The app's typeface vocabulary, in one place because two features choose from it: the organization wordmark
// (Settings -> Organization, stored as `organization.name_font`) and the typeface control on a board post
// (web/src/lib/richText.tsx). One list means a post can never offer a face the app has not loaded.
//
// Faces are self-hosted (@fontsource, bundled + served same-origin - no third-party request, no render-
// blocking @import). Only Inter (the UI font) loads up front, from index.css; the decorative faces load
// lazily the first time something resolves their stack (see the loaders below). Each stack falls back to a
// comparable system face, so text renders with the right character while the face streams in. Keep existing
// `value` keys stable - they are persisted, both in settings and inside post bodies.

// Weight range per face matching what the wordmark weight picker offers (Regular..Extra bold; faces that stop
// at 700 stop there, Pacifico is single-weight). Vite turns each import into cached same-origin woff2 chunks.
const FONT_LOADERS: Record<string, () => Promise<unknown>> = {
  geometric: () =>
    Promise.all([
      import("@fontsource/poppins/400.css"),
      import("@fontsource/poppins/500.css"),
      import("@fontsource/poppins/600.css"),
      import("@fontsource/poppins/700.css"),
      import("@fontsource/poppins/800.css"),
    ]),
  modern: () =>
    Promise.all([
      import("@fontsource/montserrat/400.css"),
      import("@fontsource/montserrat/500.css"),
      import("@fontsource/montserrat/600.css"),
      import("@fontsource/montserrat/700.css"),
      import("@fontsource/montserrat/800.css"),
    ]),
  grotesk: () =>
    Promise.all([
      import("@fontsource/space-grotesk/400.css"),
      import("@fontsource/space-grotesk/500.css"),
      import("@fontsource/space-grotesk/600.css"),
      import("@fontsource/space-grotesk/700.css"),
    ]),
  rounded: () =>
    Promise.all([
      import("@fontsource/comfortaa/400.css"),
      import("@fontsource/comfortaa/500.css"),
      import("@fontsource/comfortaa/600.css"),
      import("@fontsource/comfortaa/700.css"),
    ]),
  condensed: () =>
    Promise.all([
      import("@fontsource/oswald/400.css"),
      import("@fontsource/oswald/500.css"),
      import("@fontsource/oswald/600.css"),
      import("@fontsource/oswald/700.css"),
    ]),
  elegant: () =>
    Promise.all([
      import("@fontsource/playfair-display/400.css"),
      import("@fontsource/playfair-display/500.css"),
      import("@fontsource/playfair-display/600.css"),
      import("@fontsource/playfair-display/700.css"),
      import("@fontsource/playfair-display/800.css"),
    ]),
  script: () => import("@fontsource/pacifico/400.css"),
};
const loaded = new Set<string>();

/** Kick off (once) the lazy download of a decorative face. Safe to call during render: idempotent, async,
 *  and the stack's system fallback covers the gap until the face lands. */
export function ensureFontFace(value?: string) {
  if (!value || loaded.has(value) || !FONT_LOADERS[value]) return;
  loaded.add(value);
  void FONT_LOADERS[value]!().catch(() => loaded.delete(value)); // offline: allow a retry on next use
}
export const NAME_FONTS: { value: string; label: string; stack: string }[] = [
  { value: "default", label: "Default", stack: "" },
  { value: "geometric", label: "Geometric", stack: 'Poppins, "Century Gothic", "Avenir Next", system-ui, sans-serif' },
  { value: "modern", label: "Modern", stack: 'Montserrat, "Avenir Next", system-ui, sans-serif' },
  { value: "grotesk", label: "Grotesk", stack: '"Space Grotesk", Inter, system-ui, sans-serif' },
  { value: "rounded", label: "Rounded", stack: 'Comfortaa, "Arial Rounded MT Bold", system-ui, sans-serif' },
  { value: "condensed", label: "Condensed", stack: 'Oswald, "Arial Narrow", "Roboto Condensed", sans-serif' },
  { value: "serif", label: "Serif", stack: 'Georgia, "Times New Roman", serif' },
  { value: "elegant", label: "Elegant serif", stack: '"Playfair Display", Georgia, serif' },
  { value: "script", label: "Script", stack: 'Pacifico, "Snell Roundhand", "Brush Script MT", cursive' },
  { value: "mono", label: "Monospace", stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
];

/** The CSS font-family for a key, or undefined for "default" / anything unrecognised (inherit the UI font).
 *  Resolving a stack is the one funnel every face-rendering surface goes through (wordmark, board posts),
 *  so it doubles as the lazy-load trigger for the face's files. */
export function orgNameFontStack(font?: string): string | undefined {
  ensureFontFace(font);
  return NAME_FONTS.find((f) => f.value === font)?.stack || undefined;
}
