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
// Import the latin/latin-ext SUBSET entrypoints, never the bare `<weight>.css`: that one declares a @font-face
// per subset Google ships (cyrillic, greek, vietnamese, devanagari...) and Vite emits a file for every one of
// them - a decorative face nobody picks would still cost megabytes in the deployed bundle. Same rule as the
// Inter imports in index.css; widen the subset list in both places together.
const FONT_LOADERS: Record<string, () => Promise<unknown>> = {
  geometric: () =>
    Promise.all([
      import("@fontsource/poppins/latin-400.css"),
      import("@fontsource/poppins/latin-ext-400.css"),
      import("@fontsource/poppins/latin-500.css"),
      import("@fontsource/poppins/latin-ext-500.css"),
      import("@fontsource/poppins/latin-600.css"),
      import("@fontsource/poppins/latin-ext-600.css"),
      import("@fontsource/poppins/latin-700.css"),
      import("@fontsource/poppins/latin-ext-700.css"),
      import("@fontsource/poppins/latin-800.css"),
      import("@fontsource/poppins/latin-ext-800.css"),
    ]),
  modern: () =>
    Promise.all([
      import("@fontsource/montserrat/latin-400.css"),
      import("@fontsource/montserrat/latin-ext-400.css"),
      import("@fontsource/montserrat/latin-500.css"),
      import("@fontsource/montserrat/latin-ext-500.css"),
      import("@fontsource/montserrat/latin-600.css"),
      import("@fontsource/montserrat/latin-ext-600.css"),
      import("@fontsource/montserrat/latin-700.css"),
      import("@fontsource/montserrat/latin-ext-700.css"),
      import("@fontsource/montserrat/latin-800.css"),
      import("@fontsource/montserrat/latin-ext-800.css"),
    ]),
  grotesk: () =>
    Promise.all([
      import("@fontsource/space-grotesk/latin-400.css"),
      import("@fontsource/space-grotesk/latin-ext-400.css"),
      import("@fontsource/space-grotesk/latin-500.css"),
      import("@fontsource/space-grotesk/latin-ext-500.css"),
      import("@fontsource/space-grotesk/latin-600.css"),
      import("@fontsource/space-grotesk/latin-ext-600.css"),
      import("@fontsource/space-grotesk/latin-700.css"),
      import("@fontsource/space-grotesk/latin-ext-700.css"),
    ]),
  rounded: () =>
    Promise.all([
      import("@fontsource/comfortaa/latin-400.css"),
      import("@fontsource/comfortaa/latin-ext-400.css"),
      import("@fontsource/comfortaa/latin-500.css"),
      import("@fontsource/comfortaa/latin-ext-500.css"),
      import("@fontsource/comfortaa/latin-600.css"),
      import("@fontsource/comfortaa/latin-ext-600.css"),
      import("@fontsource/comfortaa/latin-700.css"),
      import("@fontsource/comfortaa/latin-ext-700.css"),
    ]),
  condensed: () =>
    Promise.all([
      import("@fontsource/oswald/latin-400.css"),
      import("@fontsource/oswald/latin-ext-400.css"),
      import("@fontsource/oswald/latin-500.css"),
      import("@fontsource/oswald/latin-ext-500.css"),
      import("@fontsource/oswald/latin-600.css"),
      import("@fontsource/oswald/latin-ext-600.css"),
      import("@fontsource/oswald/latin-700.css"),
      import("@fontsource/oswald/latin-ext-700.css"),
    ]),
  elegant: () =>
    Promise.all([
      import("@fontsource/playfair-display/latin-400.css"),
      import("@fontsource/playfair-display/latin-ext-400.css"),
      import("@fontsource/playfair-display/latin-500.css"),
      import("@fontsource/playfair-display/latin-ext-500.css"),
      import("@fontsource/playfair-display/latin-600.css"),
      import("@fontsource/playfair-display/latin-ext-600.css"),
      import("@fontsource/playfair-display/latin-700.css"),
      import("@fontsource/playfair-display/latin-ext-700.css"),
      import("@fontsource/playfair-display/latin-800.css"),
      import("@fontsource/playfair-display/latin-ext-800.css"),
    ]),
  script: () =>
    Promise.all([
      import("@fontsource/pacifico/latin-400.css"),
      import("@fontsource/pacifico/latin-ext-400.css"),
    ]),
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
