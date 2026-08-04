// THE PALETTE, server side. This file is the single source of colour for everything the Worker renders
// outside the SPA: outbound emails and the generated PDFs (payslips, HR letters, certificates). Re-skinning
// those surfaces is an edit here and nowhere else.
//
// Ramps come from branding.json (Figma design tokens): a navy Brand Blue anchored at 800 (#15396D), an
// electric Brand Cyan anchored at 400 (#00F6FF), and a cool blue-biased Neutral ramp. The SPA carries the
// same three ramps as CSS custom properties in web/src/index.css - the browser needs HSL triplets so
// Tailwind's `/alpha` modifiers work, which is why the two runtimes each hold the ramp in their own form.
// Keep them in step: the hex comments in index.css are these values.

export const BRAND_BLUE = {
  50: "#F0F5FC",
  100: "#E0ECF8",
  200: "#B8D4F2",
  300: "#82B2E6",
  400: "#4A8CD3",
  500: "#2C6CBD",
  600: "#2056A0",
  700: "#1D4C91", // the identity step - what BRAND.primary resolves to
  800: "#15396D", // Brand Color.Blue - the ramp anchor branding.json declares
  900: "#0E2548",
  950: "#071326",
} as const;

export const BRAND_CYAN = {
  50: "#EAFFFE",
  100: "#CBFFFE",
  200: "#9EFEFF",
  300: "#5BFCFF",
  400: "#00F6FF", // Brand Color.Cyan - the highlight anchor
  500: "#00DAE5",
  600: "#00ADC0",
  700: "#03899B",
  800: "#0D6D7D",
  900: "#105969",
  950: "#033C49",
} as const;

export const BRAND_NEUTRAL = {
  50: "#F7F9FB",
  100: "#ECF0F4",
  200: "#D9E1E8",
  300: "#B7C4D1",
  400: "#8F9FB1",
  500: "#66778B",
  600: "#48586A",
  700: "#313C4A",
  800: "#1E2734",
  900: "#101924",
  950: "#071326",
} as const;

// Semantic roles, so a renderer asks for "ink" or "hairline" rather than picking a ramp step by eye. These
// mirror the semantic tokens in web/src/index.css, restricted to what a print/email surface actually needs.
export const BRAND = {
  /** The interactive/identity colour: links, buttons, header bars, accent rules. Blue 700, matching
   *  --primary in web/src/index.css, so an email button is the same blue as an in-app one. */
  primary: BRAND_BLUE[700],
  /** The signature navy -> cyan gradient, for brand chrome (email header bar). CSS gradient syntax. */
  gradient: `linear-gradient(135deg,${BRAND_BLUE[900]} 0%,${BRAND_BLUE[600]} 50%,${BRAND_CYAN[500]} 100%)`,

  /** Headings and primary text on a light ground. */
  ink: BRAND_NEUTRAL[950],
  /** Body copy. */
  body: BRAND_NEUTRAL[700],
  /** Secondary/supporting text. */
  muted: BRAND_NEUTRAL[600],
  /** Labels, column headers, the quietest text that must still be legible. */
  label: BRAND_NEUTRAL[400],
  /** Rules, boxes and dividers. */
  hairline: BRAND_NEUTRAL[300],
  /** The faintest rule - row separators inside a table. */
  faint: BRAND_NEUTRAL[200],

  /** Page ground behind a card, and the card itself. */
  pageBg: BRAND_NEUTRAL[100],
  cardBg: "#FFFFFF",
  cardBorder: BRAND_NEUTRAL[200],

  /** Dark-scheme counterparts (email clients that honour prefers-color-scheme). */
  dark: {
    pageBg: BRAND_NEUTRAL[950],
    cardBg: BRAND_NEUTRAL[900],
    cardBorder: BRAND_NEUTRAL[800],
    ink: BRAND_NEUTRAL[50],
    body: BRAND_NEUTRAL[300],
    muted: BRAND_NEUTRAL[500],
  },
} as const;

// Corner radii from branding.json (Primitive.Radius). 8 is the control radius (buttons), 16 the card radius.
export const BRAND_RADIUS = { control: 8, card: 16, panel: 24, pill: 32 } as const;

/** "#RRGGBB" -> the 0..1 component triple pdf-lib's rgb() expects. Throws on a malformed hex. */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`brand: expected #rrggbb, got ${JSON.stringify(hex)}`);
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}
