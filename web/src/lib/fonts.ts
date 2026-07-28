// The app's typeface vocabulary, in one place because two features choose from it: the organization wordmark
// (Settings -> Organization, stored as `organization.name_font`) and the typeface control on a board post
// (web/src/lib/richText.tsx). One list means a post can never offer a face the app has not loaded.
//
// The web faces are pulled in by the single @import at the top of index.css; each falls back to a comparable
// system face, so a blocked or slow font request degrades to something of the right character rather than to
// Inter again. Keep existing `value` keys stable - they are persisted, both in settings and inside post bodies.
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

/** The CSS font-family for a key, or undefined for "default" / anything unrecognised (inherit the UI font). */
export function orgNameFontStack(font?: string): string | undefined {
  return NAME_FONTS.find((f) => f.value === font)?.stack || undefined;
}
