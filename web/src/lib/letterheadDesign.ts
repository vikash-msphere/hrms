// The letterhead page design, as the editor types it. The AUTHORITY is src/domain/letterhead.ts on the server:
// it validates every write and names the offending property, and the renderer reads the same shape. This is
// the client-side mirror, kept deliberately small - the wire carries the design as free-form JSON (the OpenAPI
// schema is `additionalProperties: true`), so without this the editor would be writing `any` into a Record.
//
// Every property is optional. An omission means "the stock page", which is what a letter looked like before
// letterheads carried a design - so an empty object is a valid design that changes nothing.

// A version of a letterhead holds three images, and each image IS its job - there is nothing to assign.
// Upload one and that job draws it; remove it and the job stops. Mirrors LETTERHEAD_SLOTS on the server.
export const LETTERHEAD_SLOTS = [
  { slot: "mark", label: "Header mark", hint: "A logo in the header band, beside the name." },
  { slot: "stationery", label: "Stationery", hint: "A full sheet drawn under the content, edge to edge." },
  { slot: "watermark", label: "Watermark", hint: "A wash across the middle of every page." },
] as const;
export type LetterheadSlot = (typeof LETTERHEAD_SLOTS)[number]["slot"];

export type LetterheadRule = { show?: boolean; weight?: number; color?: string; gap?: number };
export type LetterheadLine = { text: string; size?: number; color?: string; align?: "left" | "center" | "right"; weight?: "regular" | "bold" };

export type LetterheadDesign = {
  page?: {
    size?: "a4" | "letter";
    margin?: { top?: number; right?: number; bottom?: number; left?: number };
    font?: "serif" | "sans";
    ink?: string;
    muted?: string;
    hairline?: string;
    accent?: string;
  };
  // This version's stationery, under the whole sheet. Independent of the mark and the watermark - a page can
  // carry all three at once, and turning one off leaves the others alone.
  background?: { show?: boolean; pages?: "first" | "all"; opacity?: number };
  header?: {
    show?: boolean;
    name?: { show?: boolean; text?: string; case?: "upper" | "asis"; size?: number; color?: string; weight?: "regular" | "bold" };
    address?: { show?: boolean; text?: string; size?: number; color?: string };
    lines?: LetterheadLine[];
    /** The logo in the band: its own image, height and side. `show: false` drops it and leaves the band. */
    mark?: { show?: boolean; height?: number; align?: "left" | "right" | "center" };
    rule?: LetterheadRule;
    repeat?: "full" | "slim" | "none";
    height?: number;
  };
  footer?: {
    show?: boolean;
    left?: string;
    center?: string;
    right?: string;
    size?: number;
    color?: string;
    rule?: LetterheadRule;
    pages?: "all" | "first" | "continuation";
    height?: number;
  };
  watermark?: { show?: boolean; text?: string; size?: number; opacity?: number; angle?: number; color?: string };
};

/** What each unset control shows as its placeholder: the stock page's own value, so the editor never implies a
 *  blank field means "nothing" when it actually means "the default". Mirrors STOCK_LETTERHEAD on the server. */
export const STOCK = {
  margin: { top: 54, right: 54, bottom: 56, left: 54 },
  nameSize: 10,
  addressSize: 7.5,
  lineSize: 7.5,
  markHeight: 46,
  headerRuleWeight: 2,
  footerSize: 7.5,
  footerHeight: 26,
  footerRuleWeight: 0.5,
  watermarkSize: 72,
  watermarkOpacity: 0.08,
  watermarkAngle: 45,
} as const;

/** The tokens a header line, a footer cell or the watermark may interpolate, for the editor's own hint text. */
export const LETTERHEAD_TOKENS = ["org_name", "legal_name", "address", "date", "page", "pages"] as const;

// A letterhead is a PAIR of pages. `screen` is what documents render on and what everyone sees; `print` is the
// same letterhead as it should come out of a printer - usually without the flooded background, or with the
// header band off because the paper is already pre-printed stationery. A letterhead with no print page prints
// exactly as it renders, which is what most of them want.
export type LetterheadMedia = "screen" | "print";
/** The same two, named as what they are: the letterhead's two independent versions. */
export type LetterheadVariant = LetterheadMedia;
