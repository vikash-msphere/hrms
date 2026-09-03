// A LETTERHEAD as data: the page a document is printed on - margins, typeface, palette, the header band, the
// footer band, a watermark, and (for an org that already has its stationery drawn) a full-page background
// image. Stored per letterhead row (`letterheads.design_json`) and walked by lib/letterPdf.ts.
//
// Pure - no DB, no pdf-lib - so an untrusted design can be validated at write time and unit-tested without
// rendering, exactly like the payslip design (domain/payslipTemplate.ts). The same reasoning applies to the
// closed vocabulary: letters render inside the Worker with no DOM, so arbitrary markup has nothing to lay it
// out; named bands with typed properties give real design control while page geometry stays in code.
//
// Every property is optional and every omission falls through to STOCK, the look every letter had before the
// page became designable - so `{}` is a valid design that changes nothing.

// A letterhead is TWO INDEPENDENT VERSIONS of a page: the one documents render on, and the one they come out
// of a printer on. Each version owns its own design AND its own images - nothing is shared between them, so
// changing one cannot change the other. A letterhead with no print version prints as it renders.
export const LETTERHEAD_VARIANTS = ["screen", "print"] as const;
export type LetterheadVariant = (typeof LETTERHEAD_VARIANTS)[number];

// Within a version, an image IS its job: the mark is the header logo, the stationery is the sheet drawn under
// the content, the watermark is the wash across the middle. There is no assigning images to jobs - upload one
// to a job and that job draws it; remove it and the job stops. Three slots per version, all meaningful.
export const LETTERHEAD_SLOTS = ["mark", "stationery", "watermark"] as const;
export type LetterheadSlot = (typeof LETTERHEAD_SLOTS)[number];

/** What a header line, a footer cell or a watermark may interpolate with {{token}}. Anything else is literal. */
export const LETTERHEAD_TOKENS = ["org_name", "legal_name", "address", "date", "page", "pages"] as const;
export type LetterheadToken = (typeof LETTERHEAD_TOKENS)[number];

export type LetterheadRule = {
  show?: boolean;
  weight?: number; // points, 0.25..6
  color?: string; // #rrggbb; default the accent
  gap?: number; // points between the band and the rule, 0..40
};

/** A free line of text in the header band. `text` may carry {{token}}s. */
export type LetterheadLine = {
  text: string;
  size?: number; // points, 5..24
  color?: string; // #rrggbb
  align?: "left" | "center" | "right";
  weight?: "regular" | "bold";
};

export type LetterheadDesign = {
  // The sheet itself: how big it is, how much of it the body may use, and the ink it is printed in.
  page?: {
    size?: "a4" | "letter";
    margin?: { top?: number; right?: number; bottom?: number; left?: number }; // points, 18..144
    font?: "serif" | "sans"; // Times (default, formal) or Helvetica
    ink?: string; // primary text
    muted?: string; // secondary text (address, dates, notes)
    hairline?: string; // rules, boxes, table dividers
    accent?: string; // the header/footer rules and heavy borders; defaults to the ink
  };
  // This version's stationery image, drawn under the whole sheet, edge to edge - the pre-printed letterhead
  // case. Drawn whenever this version HAS a stationery image; `show: false` keeps the image but stops drawing
  // it. Independent of the mark and the watermark: all three can run at once, and switching one off leaves
  // the others exactly as they were.
  background?: {
    show?: boolean;
    pages?: "first" | "all"; // cover the first sheet, or every sheet
    opacity?: number; // 0.05..1
  };
  // The printed band above the body.
  header?: {
    show?: boolean;
    name?: { show?: boolean; text?: string; case?: "upper" | "asis"; size?: number; color?: string; weight?: "regular" | "bold" };
    address?: { show?: boolean; text?: string; size?: number; color?: string }; // `text` overrides the org address
    lines?: LetterheadLine[]; // extra lines under the address (GST/CIN, a tagline, a contact strip)
    // This version's mark image, drawn in the band: how tall, which side. `show: false` drops it and leaves
    // the rest of the band alone. A version with no mark image of its own falls back to the organization
    // logo, so a letterhead that uploads nothing still looks like the stock page.
    mark?: { show?: boolean; height?: number; align?: "left" | "right" | "center" };
    rule?: LetterheadRule;
    repeat?: "full" | "slim" | "none"; // what continuation pages get; "slim" = the name + a hairline
    height?: number; // fixed reserve in points; with `show: false` this is the room the stationery's own header needs
  };
  // The printed band below the body, drawn on every page it applies to once the page count is known.
  footer?: {
    show?: boolean;
    left?: string;
    center?: string;
    right?: string;
    size?: number;
    color?: string;
    rule?: LetterheadRule;
    pages?: "all" | "first" | "continuation";
    height?: number; // room reserved above the bottom margin, 0..160
  };
  // Drawn under the content, centred and rotated: a DRAFT/CONFIDENTIAL wash, or one of the letterhead's own
  // images - usually a dedicated `watermark` slot rather than the header mark, since a wash wants different
  // artwork from a masthead.
  watermark?: {
    show?: boolean; // false keeps the settings but stops drawing
    text?: string; // drawn when this version has no watermark IMAGE; the image wins when it has one
    size?: number; // text points 8..200, or image height in points
    opacity?: number; // 0.02..0.5
    angle?: number; // degrees, -90..90
    color?: string;
  };
};

/** The stock page: what every letter looked like before letterheads carried a design. Also the fallback for a
 *  document whose chosen letterhead has no design of its own, so both paths render identically. */
export const STOCK_LETTERHEAD: Required<Pick<LetterheadDesign, "page" | "background" | "header" | "footer">> = {
  page: { size: "a4", margin: { top: 54, right: 54, bottom: 56, left: 54 }, font: "serif" },
  background: { pages: "first", opacity: 1 }, // no `image`: the stock page has no stationery
  header: {
    show: true,
    name: { show: true, case: "upper", size: 10, weight: "bold" },
    address: { show: true, size: 7.5 },
    mark: { show: true, height: 46, align: "right" },
    rule: { show: true, weight: 2 },
    repeat: "slim",
  },
  footer: { show: false, size: 7.5, rule: { show: true, weight: 0.5 }, pages: "all", height: 26 },
};

class DesignError extends Error {}

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string") throw new DesignError(`${what} must be a string`);
  if (v.length > max) throw new DesignError(`${what} must be at most ${max} characters`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new DesignError(`${what} must be a boolean`);
  return v;
};
const num = (v: unknown, min: number, max: number, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new DesignError(`${what} must be a number in [${min}, ${max}]`);
  return v;
};
const hex = (v: unknown, what: string): string => {
  const s = str(v, 7, what);
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new DesignError(`${what} must be a #rrggbb hex colour`);
  return s.toLowerCase();
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new DesignError(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
};
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new DesignError(`${what} must be an object`);
  return v as Record<string, unknown>;
};
/** Drop a band that ended up with nothing set, so the stored blob stays the design and not a shell of empties. */
const kept = <T extends object>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

const MAX_LINES = 6;
const MAX_TEXT = 300;

function parseRule(v: unknown, what: string): LetterheadRule | undefined {
  const o = obj(v, what);
  return kept({
    ...(o.show != null ? { show: bool(o.show, `${what}.show`) } : {}),
    ...(o.weight != null ? { weight: num(o.weight, 0.25, 6, `${what}.weight`) } : {}),
    ...(o.color != null ? { color: hex(o.color, `${what}.color`) } : {}),
    ...(o.gap != null ? { gap: num(o.gap, 0, 40, `${what}.gap`) } : {}),
  });
}

function parseLines(v: unknown, what: string): LetterheadLine[] | undefined {
  if (!Array.isArray(v)) throw new DesignError(`${what} must be an array`);
  if (v.length > MAX_LINES) throw new DesignError(`${what} must have at most ${MAX_LINES} lines`);
  const lines = v.map((raw, i) => {
    const o = obj(raw, `${what}[${i}]`);
    return {
      text: str(o.text ?? "", MAX_TEXT, `${what}[${i}].text`),
      ...(o.size != null ? { size: num(o.size, 5, 24, `${what}[${i}].size`) } : {}),
      ...(o.color != null ? { color: hex(o.color, `${what}[${i}].color`) } : {}),
      ...(o.align != null ? { align: oneOf(o.align, ["left", "center", "right"] as const, `${what}[${i}].align`) } : {}),
      ...(o.weight != null ? { weight: oneOf(o.weight, ["regular", "bold"] as const, `${what}[${i}].weight`) } : {}),
    };
  });
  return lines.length ? lines : undefined;
}

/**
 * Validate + normalize an untrusted design (a letterhead write body, or the editor's unsaved draft), throwing
 * a message that names the offending property. Unknown keys are dropped rather than stored, so the blob stays
 * canonical and a typo'd property fails loudly at write time instead of silently doing nothing at render time.
 */
export function parseLetterheadDesign(input: unknown): LetterheadDesign {
  if (input == null) return {};
  const raw = obj(input, "design");
  const design: LetterheadDesign = {};

  if (raw.page != null) {
    const p = obj(raw.page, "design.page");
    const margin = p.margin != null ? obj(p.margin, "design.page.margin") : null;
    design.page = kept({
      ...(p.size != null ? { size: oneOf(p.size, ["a4", "letter"] as const, "design.page.size") } : {}),
      ...(margin
        ? {
            margin: {
              ...(margin.top != null ? { top: num(margin.top, 18, 144, "design.page.margin.top") } : {}),
              ...(margin.right != null ? { right: num(margin.right, 18, 144, "design.page.margin.right") } : {}),
              ...(margin.bottom != null ? { bottom: num(margin.bottom, 18, 144, "design.page.margin.bottom") } : {}),
              ...(margin.left != null ? { left: num(margin.left, 18, 144, "design.page.margin.left") } : {}),
            },
          }
        : {}),
      ...(p.font != null ? { font: oneOf(p.font, ["serif", "sans"] as const, "design.page.font") } : {}),
      ...(p.ink != null ? { ink: hex(p.ink, "design.page.ink") } : {}),
      ...(p.muted != null ? { muted: hex(p.muted, "design.page.muted") } : {}),
      ...(p.hairline != null ? { hairline: hex(p.hairline, "design.page.hairline") } : {}),
      ...(p.accent != null ? { accent: hex(p.accent, "design.page.accent") } : {}),
    });
  }

  if (raw.background != null) {
    const bg = obj(raw.background, "design.background");
    design.background = kept({
      ...(bg.show != null ? { show: bool(bg.show, "design.background.show") } : {}),
      ...(bg.pages != null ? { pages: oneOf(bg.pages, ["first", "all"] as const, "design.background.pages") } : {}),
      ...(bg.opacity != null ? { opacity: num(bg.opacity, 0.05, 1, "design.background.opacity") } : {}),
    });
  }

  if (raw.header != null) {
    const h = obj(raw.header, "design.header");
    const name = h.name != null ? obj(h.name, "design.header.name") : null;
    const address = h.address != null ? obj(h.address, "design.header.address") : null;
    design.header = kept({
      ...(h.show != null ? { show: bool(h.show, "design.header.show") } : {}),
      ...(name
        ? {
            name: {
              ...(name.show != null ? { show: bool(name.show, "design.header.name.show") } : {}),
              ...(name.text != null ? { text: str(name.text, MAX_TEXT, "design.header.name.text") } : {}),
              ...(name.case != null ? { case: oneOf(name.case, ["upper", "asis"] as const, "design.header.name.case") } : {}),
              ...(name.size != null ? { size: num(name.size, 5, 36, "design.header.name.size") } : {}),
              ...(name.color != null ? { color: hex(name.color, "design.header.name.color") } : {}),
              ...(name.weight != null ? { weight: oneOf(name.weight, ["regular", "bold"] as const, "design.header.name.weight") } : {}),
            },
          }
        : {}),
      ...(address
        ? {
            address: {
              ...(address.show != null ? { show: bool(address.show, "design.header.address.show") } : {}),
              ...(address.text != null ? { text: str(address.text, MAX_TEXT * 2, "design.header.address.text") } : {}),
              ...(address.size != null ? { size: num(address.size, 5, 24, "design.header.address.size") } : {}),
              ...(address.color != null ? { color: hex(address.color, "design.header.address.color") } : {}),
            },
          }
        : {}),
      ...(h.lines != null ? { lines: parseLines(h.lines, "design.header.lines") } : {}),
      ...(h.mark != null
        ? {
            mark: (() => {
              const m = obj(h.mark, "design.header.mark");
              return kept({
                ...(m.show != null ? { show: bool(m.show, "design.header.mark.show") } : {}),
                ...(m.height != null ? { height: num(m.height, 12, 140, "design.header.mark.height") } : {}),
                ...(m.align != null ? { align: oneOf(m.align, ["left", "right", "center"] as const, "design.header.mark.align") } : {}),
              });
            })(),
          }
        : {}),
      ...(h.rule != null ? { rule: parseRule(h.rule, "design.header.rule") } : {}),
      ...(h.repeat != null ? { repeat: oneOf(h.repeat, ["full", "slim", "none"] as const, "design.header.repeat") } : {}),
      ...(h.height != null ? { height: num(h.height, 0, 400, "design.header.height") } : {}),
    });
  }

  if (raw.footer != null) {
    const f = obj(raw.footer, "design.footer");
    design.footer = kept({
      ...(f.show != null ? { show: bool(f.show, "design.footer.show") } : {}),
      ...(f.left != null ? { left: str(f.left, MAX_TEXT, "design.footer.left") } : {}),
      ...(f.center != null ? { center: str(f.center, MAX_TEXT, "design.footer.center") } : {}),
      ...(f.right != null ? { right: str(f.right, MAX_TEXT, "design.footer.right") } : {}),
      ...(f.size != null ? { size: num(f.size, 5, 18, "design.footer.size") } : {}),
      ...(f.color != null ? { color: hex(f.color, "design.footer.color") } : {}),
      ...(f.rule != null ? { rule: parseRule(f.rule, "design.footer.rule") } : {}),
      ...(f.pages != null ? { pages: oneOf(f.pages, ["all", "first", "continuation"] as const, "design.footer.pages") } : {}),
      ...(f.height != null ? { height: num(f.height, 0, 160, "design.footer.height") } : {}),
    });
  }

  if (raw.watermark != null) {
    const w = obj(raw.watermark, "design.watermark");
    design.watermark = kept({
      ...(w.show != null ? { show: bool(w.show, "design.watermark.show") } : {}),
      ...(w.text != null ? { text: str(w.text, 60, "design.watermark.text") } : {}),
      ...(w.size != null ? { size: num(w.size, 8, 400, "design.watermark.size") } : {}),
      ...(w.opacity != null ? { opacity: num(w.opacity, 0.02, 0.5, "design.watermark.opacity") } : {}),
      ...(w.angle != null ? { angle: num(w.angle, -90, 90, "design.watermark.angle") } : {}),
      ...(w.color != null ? { color: hex(w.color, "design.watermark.color") } : {}),
    });
  }

  return design;
}

/** Parse a stored `design_json` string. A blob that no longer validates renders as the stock page rather than
 *  failing the document - a letter must still go out if a design was saved by an older shape of this code. */
export function letterheadDesignOrStock(raw: string | null | undefined): LetterheadDesign {
  if (!raw) return {};
  try {
    return parseLetterheadDesign(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Which of THIS VERSION's images the design would draw. Only these are fetched and embedded, so a version
 * holding three images puts into the PDF only the ones its bands actually draw. A slot that holds no image
 * simply contributes nothing - the band draws none, which is why uploading an image is all it takes to make a
 * band appear and removing it is all it takes to make it stop.
 */
export function slotsUsedBy(design: LetterheadDesign): LetterheadSlot[] {
  const slots: LetterheadSlot[] = [];
  if (design.header?.mark?.show !== false) slots.push("mark");
  if (design.background?.show !== false) slots.push("stationery");
  if (design.watermark?.show !== false) slots.push("watermark");
  return slots;
}

/** Fill {{token}}s. Unknown tokens are left as written so a typo shows up on the page instead of vanishing. */
export function fillTokens(text: string, values: Partial<Record<LetterheadToken, string>>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => values[key as LetterheadToken] ?? whole);
}
