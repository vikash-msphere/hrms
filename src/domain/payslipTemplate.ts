// The payslip DESIGN as data: a closed vocabulary of layout blocks stored in the `payslip` settings blob and
// walked by renderPayslipPdf (src/lib/pdf.ts). Pure - no DB, no PDF library - so the shape can be validated at
// write time and unit-tested without rendering.
//
// Why a closed vocabulary rather than HTML: payslips are rendered inside the Worker by pdf-lib (pure JS) from a
// cron-drained job at publish time. There is no DOM and no browser there, so arbitrary markup has nothing to
// lay it out. Blocks give real design control (which sections, in what order, with what labels and wording)
// while every drawing primitive stays in code where page geometry and money formatting are guaranteed.
//
// One active layout org-wide, hence its own settings blob (not a template catalog like letter-templates).
// Editing it only affects FUTURE runs: a published payslip's PDF is already frozen in R2.

/** Values a `kvGrid` field, `note` or `footer` may interpolate with {{token}}. Anything else stays literal. */
export const PAYSLIP_TOKENS = [
  "org_name", "period", "employee_name", "employee_no", "designation", "department",
  "payment_mode", "bank_name", "bank_ifsc", "bank_account",
  "currency", "gross", "deductions", "net",
] as const;
export type PayslipToken = (typeof PAYSLIP_TOKENS)[number];

/** Typography and spacing available on EVERY block. Omitted properties keep the stock design's value, so a
 *  template that sets no style renders exactly like the built-in one. `size`/`color`/`weight` apply to the
 *  block's PRIMARY text (the org name, the period banner, grid values, money rows, the net amount, the note or
 *  footer captions); `align` only applies where a block has a single text column (orgHeader, note). */
export type PayslipBlockStyle = {
  size?: number; // points, 5..36
  color?: string; // #rrggbb
  weight?: "regular" | "bold";
  align?: "left" | "center" | "right";
  spaceBefore?: number; // extra points above the block, 0..120
  spaceAfter?: number; // extra points below, 0..120
};

type Styled = { style?: PayslipBlockStyle };

export type PayslipBlock = Styled &
  (
    // Company band: name + (optional) address block, logo on the opposite side.
    | { kind: "orgHeader"; showLogo?: boolean; showAddress?: boolean; logoHeight?: number; logoAlign?: "left" | "right" }
    // Period banner + employee name (the "who and when" row).
    | { kind: "identity"; caption?: string; showDesignation?: boolean }
    // Label/value grid, 2 or 3 columns, wrapping into rows. Values may be {{token}}s or literal text.
    | {
        kind: "kvGrid";
        columns?: 2 | 3;
        fields: { label: string; value: string }[];
        labelCase?: "upper" | "asis";
        labelSize?: number;
        rowHeight?: number;
      }
    // Boxed attendance strip; `cells` picks which figures appear. Skipped when the run carries no attendance facts.
    | { kind: "attendance"; title?: string; cells?: PayslipAttendanceCell[]; cellHeight?: number }
    // The two money columns with their totals. `split` is the left column's share of the content width.
    | {
        kind: "earningsDeductions";
        earningsTitle?: string;
        deductionsTitle?: string;
        earningsTotalLabel?: string;
        deductionsTotalLabel?: string;
        amountLabel?: string;
        split?: number; // 0.3..0.7, default 0.5
        zebra?: boolean; // shade alternate rows
        rowBorders?: boolean; // hairline under every row
      }
    // Net pay, boxed, with the amount in words.
    | { kind: "netBox"; label?: string; showWords?: boolean; fill?: string; borderWidth?: number }
    | { kind: "note"; text: string; align?: "left" | "center"; emphasis?: boolean }
    | { kind: "rule"; weight?: number; color?: string }
    | { kind: "gap"; height?: number }
    | { kind: "footer"; left?: string; right?: string }
  );

/** The attendance figures a strip may show, in the order they are drawn. */
export const PAYSLIP_ATTENDANCE_CELLS = ["actual", "working", "lop", "payable"] as const;
export type PayslipAttendanceCell = (typeof PAYSLIP_ATTENDANCE_CELLS)[number];

export type PayslipTemplateOptions = {
  font?: "serif" | "sans"; // Times (statement-like, default) or Helvetica
  accent?: string; // #rrggbb for the header rule, totals and net-pay box; default is the near-black ink
  pageSize?: "a4" | "letter";
  margin?: number; // page margin in points, 24..96 (default 48)
  scale?: number; // multiplies every DEFAULT font size, 0.8..1.25; an explicit block size wins over it
  ink?: string; // primary text colour (default near-black)
  muted?: string; // secondary text + small caps labels
  hairline?: string; // rules, boxes and dividers
};

export type PayslipTemplate = { options?: PayslipTemplateOptions; blocks: PayslipBlock[] };

/** The stock design: what every payslip looked like before the layout became configurable. */
export const DEFAULT_PAYSLIP_TEMPLATE: PayslipTemplate = {
  blocks: [
    { kind: "orgHeader", showLogo: true, showAddress: true },
    { kind: "rule", weight: 2 },
    { kind: "identity", caption: "Payslip", showDesignation: true },
    { kind: "rule" },
    {
      kind: "kvGrid",
      columns: 3,
      fields: [
        { label: "Employee No.", value: "{{employee_no}}" },
        { label: "Department", value: "{{department}}" },
        { label: "Payment Mode", value: "{{payment_mode}}" },
        { label: "Bank", value: "{{bank_name}}" },
        { label: "Bank IFSC", value: "{{bank_ifsc}}" },
        { label: "Bank Account", value: "{{bank_account}}" },
      ],
    },
    { kind: "rule" },
    { kind: "gap", height: 4 },
    { kind: "attendance", title: "Attendance" },
    {
      kind: "earningsDeductions",
      earningsTitle: "Earnings",
      deductionsTitle: "Deductions",
      earningsTotalLabel: "Total Earnings (A)",
      deductionsTotalLabel: "Total Deductions (B)",
      amountLabel: "Amount",
    },
    { kind: "netBox", label: "Net Salary Payable (A - B)", showWords: true },
    { kind: "footer", left: "This is a system-generated payslip and does not require a signature.", right: "All amounts in {{currency}}." },
  ],
};

const KINDS = new Set<string>([
  "orgHeader", "identity", "kvGrid", "attendance", "earningsDeductions", "netBox", "note", "rule", "gap", "footer",
]);

export const MAX_BLOCKS = 40;
const MAX_FIELDS = 12;
const MAX_LABEL = 60;
const MAX_TEXT = 500;

class TemplateError extends Error {}

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string") throw new TemplateError(`${what} must be a string`);
  if (v.length > max) throw new TemplateError(`${what} must be at most ${max} characters`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new TemplateError(`${what} must be a boolean`);
  return v;
};
const num = (v: unknown, min: number, max: number, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new TemplateError(`${what} must be a number in [${min}, ${max}]`);
  return v;
};
const hex = (v: unknown, what: string): string => {
  const s = str(v, 7, what);
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new TemplateError(`${what} must be a #rrggbb hex colour`);
  return s.toLowerCase();
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new TemplateError(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
};

/** The style block every kind shares. Absent properties fall through to the stock design at render time. */
function parseStyle(v: unknown, what: string): PayslipBlockStyle | undefined {
  if (v == null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new TemplateError(`${what} must be an object`);
  const o = v as Record<string, unknown>;
  const s: PayslipBlockStyle = {
    ...(o.size != null ? { size: num(o.size, 5, 36, `${what}.size`) } : {}),
    ...(o.color != null ? { color: hex(o.color, `${what}.color`) } : {}),
    ...(o.weight != null ? { weight: oneOf(o.weight, ["regular", "bold"] as const, `${what}.weight`) } : {}),
    ...(o.align != null ? { align: oneOf(o.align, ["left", "center", "right"] as const, `${what}.align`) } : {}),
    ...(o.spaceBefore != null ? { spaceBefore: num(o.spaceBefore, 0, 120, `${what}.spaceBefore`) } : {}),
    ...(o.spaceAfter != null ? { spaceAfter: num(o.spaceAfter, 0, 120, `${what}.spaceAfter`) } : {}),
  };
  return Object.keys(s).length ? s : undefined;
}

/** Validate + normalize an untrusted template (a settings PATCH body, or a preview's inline draft). Throws a
 *  TemplateError naming the offending block, so the API can answer with a usable message instead of rendering
 *  something surprising. Unknown keys are dropped rather than carried, keeping the stored blob canonical. */
export function parsePayslipTemplate(input: unknown): PayslipTemplate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TemplateError("template must be an object");
  const raw = input as { options?: unknown; blocks?: unknown };
  const options: PayslipTemplateOptions = {};
  if (raw.options != null) {
    if (typeof raw.options !== "object" || Array.isArray(raw.options)) throw new TemplateError("options must be an object");
    const o = raw.options as Record<string, unknown>;
    if (o.font != null) options.font = oneOf(o.font, ["serif", "sans"] as const, "options.font");
    if (o.accent != null) options.accent = hex(o.accent, "options.accent");
    if (o.pageSize != null) options.pageSize = oneOf(o.pageSize, ["a4", "letter"] as const, "options.pageSize");
    if (o.margin != null) options.margin = num(o.margin, 24, 96, "options.margin");
    if (o.scale != null) options.scale = num(o.scale, 0.8, 1.25, "options.scale");
    if (o.ink != null) options.ink = hex(o.ink, "options.ink");
    if (o.muted != null) options.muted = hex(o.muted, "options.muted");
    if (o.hairline != null) options.hairline = hex(o.hairline, "options.hairline");
  }
  if (!Array.isArray(raw.blocks)) throw new TemplateError("blocks must be an array");
  if (raw.blocks.length > MAX_BLOCKS) throw new TemplateError(`at most ${MAX_BLOCKS} blocks`);

  const blocks = raw.blocks.map((b, i): PayslipBlock => {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new TemplateError(`block ${i} must be an object`);
    const o = b as Record<string, unknown>;
    const kind = o.kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) throw new TemplateError(`block ${i}: unknown kind ${JSON.stringify(kind)}`);
    const at = (k: string) => `block ${i} (${kind}).${k}`;
    const style = parseStyle(o.style, at("style"));
    const styled = style ? { style } : {};
    switch (kind) {
      case "orgHeader":
        return {
          kind,
          ...styled,
          ...(o.showLogo != null ? { showLogo: bool(o.showLogo, at("showLogo")) } : {}),
          ...(o.showAddress != null ? { showAddress: bool(o.showAddress, at("showAddress")) } : {}),
          ...(o.logoHeight != null ? { logoHeight: num(o.logoHeight, 16, 96, at("logoHeight")) } : {}),
          ...(o.logoAlign != null ? { logoAlign: oneOf(o.logoAlign, ["left", "right"] as const, at("logoAlign")) } : {}),
        };
      case "identity":
        return {
          kind,
          ...styled,
          ...(o.caption != null ? { caption: str(o.caption, MAX_LABEL, at("caption")) } : {}),
          ...(o.showDesignation != null ? { showDesignation: bool(o.showDesignation, at("showDesignation")) } : {}),
        };
      case "kvGrid": {
        if (!Array.isArray(o.fields)) throw new TemplateError(at("fields") + " must be an array");
        if (o.fields.length > MAX_FIELDS) throw new TemplateError(at("fields") + ` may hold at most ${MAX_FIELDS} entries`);
        const columns = o.columns == null ? 3 : (num(o.columns, 2, 3, at("columns")) as 2 | 3);
        if (columns !== 2 && columns !== 3) throw new TemplateError(at("columns") + " must be 2 or 3");
        return {
          kind,
          ...styled,
          columns,
          ...(o.labelCase != null ? { labelCase: oneOf(o.labelCase, ["upper", "asis"] as const, at("labelCase")) } : {}),
          ...(o.labelSize != null ? { labelSize: num(o.labelSize, 5, 24, at("labelSize")) } : {}),
          ...(o.rowHeight != null ? { rowHeight: num(o.rowHeight, 18, 72, at("rowHeight")) } : {}),
          fields: o.fields.map((f, j) => {
            if (!f || typeof f !== "object") throw new TemplateError(at(`fields[${j}]`) + " must be an object");
            const g = f as { label?: unknown; value?: unknown };
            return { label: str(g.label, MAX_LABEL, at(`fields[${j}].label`)), value: str(g.value ?? "", MAX_TEXT, at(`fields[${j}].value`)) };
          }),
        };
      }
      case "attendance": {
        let cells: PayslipAttendanceCell[] | undefined;
        if (o.cells != null) {
          if (!Array.isArray(o.cells)) throw new TemplateError(at("cells") + " must be an array");
          if (!o.cells.length) throw new TemplateError(at("cells") + " must name at least one figure");
          cells = o.cells.map((c, j) => oneOf(c, PAYSLIP_ATTENDANCE_CELLS, at(`cells[${j}]`)));
        }
        return {
          kind,
          ...styled,
          ...(o.title != null ? { title: str(o.title, MAX_LABEL, at("title")) } : {}),
          ...(cells ? { cells } : {}),
          ...(o.cellHeight != null ? { cellHeight: num(o.cellHeight, 24, 80, at("cellHeight")) } : {}),
        };
      }
      case "earningsDeductions":
        return {
          kind,
          ...styled,
          ...(o.earningsTitle != null ? { earningsTitle: str(o.earningsTitle, MAX_LABEL, at("earningsTitle")) } : {}),
          ...(o.deductionsTitle != null ? { deductionsTitle: str(o.deductionsTitle, MAX_LABEL, at("deductionsTitle")) } : {}),
          ...(o.earningsTotalLabel != null ? { earningsTotalLabel: str(o.earningsTotalLabel, MAX_LABEL, at("earningsTotalLabel")) } : {}),
          ...(o.deductionsTotalLabel != null ? { deductionsTotalLabel: str(o.deductionsTotalLabel, MAX_LABEL, at("deductionsTotalLabel")) } : {}),
          ...(o.amountLabel != null ? { amountLabel: str(o.amountLabel, MAX_LABEL, at("amountLabel")) } : {}),
          ...(o.split != null ? { split: num(o.split, 0.3, 0.7, at("split")) } : {}),
          ...(o.zebra != null ? { zebra: bool(o.zebra, at("zebra")) } : {}),
          ...(o.rowBorders != null ? { rowBorders: bool(o.rowBorders, at("rowBorders")) } : {}),
        };
      case "netBox":
        return {
          kind,
          ...styled,
          ...(o.label != null ? { label: str(o.label, MAX_LABEL, at("label")) } : {}),
          ...(o.showWords != null ? { showWords: bool(o.showWords, at("showWords")) } : {}),
          ...(o.fill != null ? { fill: hex(o.fill, at("fill")) } : {}),
          ...(o.borderWidth != null ? { borderWidth: num(o.borderWidth, 0, 4, at("borderWidth")) } : {}),
        };
      case "note": {
        const align = o.align == null ? undefined : o.align;
        if (align != null && align !== "left" && align !== "center") throw new TemplateError(at("align") + ' must be "left" or "center"');
        return {
          kind,
          ...styled,
          text: str(o.text ?? "", MAX_TEXT, at("text")),
          ...(align ? { align } : {}),
          ...(o.emphasis != null ? { emphasis: bool(o.emphasis, at("emphasis")) } : {}),
        };
      }
      case "rule":
        return {
          kind,
          ...styled,
          ...(o.weight != null ? { weight: num(o.weight, 0.25, 4, at("weight")) } : {}),
          ...(o.color != null ? { color: hex(o.color, at("color")) } : {}),
        };
      case "gap":
        return { kind, height: o.height == null ? 8 : num(o.height, 0, 120, at("height")) };
      case "footer":
        return {
          kind,
          ...styled,
          ...(o.left != null ? { left: str(o.left, MAX_TEXT, at("left")) } : {}),
          ...(o.right != null ? { right: str(o.right, MAX_TEXT, at("right")) } : {}),
        };
      default:
        throw new TemplateError(`block ${i}: unknown kind ${JSON.stringify(kind)}`);
    }
  });

  return { ...(Object.keys(options).length ? { options } : {}), blocks };
}

/** Read side: a stored blob that fails validation must never break payroll, so fall back to the stock design
 *  (mirrors getSettingValue's malformed-JSON behaviour). Returns the default when there is nothing stored. */
export function payslipTemplateOrDefault(stored: unknown): PayslipTemplate {
  if (stored == null) return DEFAULT_PAYSLIP_TEMPLATE;
  try {
    const t = parsePayslipTemplate(stored);
    return t.blocks.length ? t : DEFAULT_PAYSLIP_TEMPLATE;
  } catch (e) {
    console.error("settings/payslip holds an invalid template; using the default design", (e as Error).message);
    return DEFAULT_PAYSLIP_TEMPLATE;
  }
}

/** Replace {{token}} with its value; unknown tokens render empty so a typo can't leak "{{foo}}" onto a payslip. */
export function substTokens(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k: string) => values[k.toLowerCase()] ?? "");
}
