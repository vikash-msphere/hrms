// Mirror of src/domain/payslipTemplate.ts (the block vocabulary + the stock design) for the payslip-design
// editor. The web bundle can't import from src/, so the constants are duplicated and pinned by
// test/payslipTemplateDrift.test.ts - the same arrangement as components/access/customMethods.ts.
// The server re-validates every save and every preview; this copy only drives the editor UI.

export type PayslipBlockKind =
  | "orgHeader" | "identity" | "kvGrid" | "attendance" | "earningsDeductions" | "netBox" | "note" | "rule" | "gap" | "footer";

/** Typography + spacing available on every block; unset means "keep the stock design's value". */
export type PayslipBlockStyle = {
  size?: number;
  color?: string;
  weight?: "regular" | "bold";
  align?: "left" | "center" | "right";
  spaceBefore?: number;
  spaceAfter?: number;
};

export const PAYSLIP_ATTENDANCE_CELLS = ["actual", "working", "lop", "payable"] as const;
export type PayslipAttendanceCell = (typeof PAYSLIP_ATTENDANCE_CELLS)[number];

/** Editor labels for the attendance figures a strip can show. */
export const ATTENDANCE_CELL_LABELS: Record<PayslipAttendanceCell, string> = {
  actual: "Actual days", working: "Working days", lop: "Loss of pay", payable: "Days payable",
};

export type PayslipBlock = {
  kind: PayslipBlockKind;
  style?: PayslipBlockStyle;
  // orgHeader
  showLogo?: boolean;
  showAddress?: boolean;
  logoHeight?: number;
  logoAlign?: "left" | "right";
  // identity
  caption?: string;
  showDesignation?: boolean;
  // kvGrid
  columns?: 2 | 3;
  fields?: { label: string; value: string }[];
  labelCase?: "upper" | "asis";
  labelSize?: number;
  rowHeight?: number;
  // attendance
  title?: string;
  cells?: PayslipAttendanceCell[];
  cellHeight?: number;
  // earningsDeductions
  earningsTitle?: string;
  deductionsTitle?: string;
  earningsTotalLabel?: string;
  deductionsTotalLabel?: string;
  amountLabel?: string;
  split?: number;
  zebra?: boolean;
  rowBorders?: boolean;
  // netBox
  label?: string;
  showWords?: boolean;
  fill?: string;
  borderWidth?: number;
  // note
  text?: string;
  align?: "left" | "center";
  emphasis?: boolean;
  // rule / gap
  weight?: number;
  color?: string;
  height?: number;
  // footer
  left?: string;
  right?: string;
};

export type PayslipTemplateOptions = {
  font?: "serif" | "sans";
  accent?: string;
  pageSize?: "a4" | "letter";
  margin?: number;
  scale?: number;
  ink?: string;
  muted?: string;
  hairline?: string;
};

export type PayslipTemplate = {
  options?: PayslipTemplateOptions;
  blocks: PayslipBlock[];
};

/** Stock values the renderer falls back to, shown as placeholders so an empty field reads as "unchanged".
 *  The three colours mirror DARK / MUTED / HAIR in src/lib/pdfPrimitives.ts, i.e. the brand Neutral ramp at
 *  950 / 600 / 300 (src/domain/brand.ts) - keep them in step or the placeholders lie about what the PDF does. */
export const STOCK_DEFAULTS = { ink: "#071326", muted: "#48586A", hairline: "#B7C4D1", margin: 48, scale: 1 } as const;

/** Which blocks honour `style.align` (the rest are two-sided layouts where alignment has no meaning). */
export const ALIGNABLE_KINDS: PayslipBlockKind[] = ["orgHeader", "note"];

/** {{tokens}} a kvGrid value, note or footer caption may interpolate. */
export const PAYSLIP_TOKENS = [
  "org_name", "period", "employee_name", "employee_no", "designation", "department",
  "payment_mode", "bank_name", "bank_ifsc", "bank_account",
  "currency", "gross", "deductions", "net",
] as const;

export const MAX_PAYSLIP_BLOCKS = 40;

/** What each block does, in the editor's words. */
export const PAYSLIP_BLOCK_META: Record<PayslipBlockKind, { title: string; desc: string }> = {
  orgHeader: { title: "Company header", desc: "Company name, address and logo." },
  identity: { title: "Period & employee", desc: "The pay period banner and who the payslip is for." },
  kvGrid: { title: "Detail grid", desc: "Label/value pairs - employee no., department, bank details." },
  attendance: { title: "Attendance strip", desc: "Working / payable / loss-of-pay days. Hidden when the run has no attendance data." },
  earningsDeductions: { title: "Earnings & deductions", desc: "The two money columns with their totals." },
  netBox: { title: "Net pay box", desc: "Net payable, boxed, with the amount in words." },
  note: { title: "Note", desc: "A line of your own text." },
  rule: { title: "Divider", desc: "A horizontal line." },
  gap: { title: "Spacer", desc: "Vertical whitespace." },
  footer: { title: "Footer", desc: "Fine print at the bottom, left and right." },
};

/** The stock design - identical to DEFAULT_PAYSLIP_TEMPLATE on the server. */
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

/** A fresh block of `kind`, with the defaults the renderer would apply anyway (so the editor shows real values). */
export function newPayslipBlock(kind: PayslipBlockKind): PayslipBlock {
  switch (kind) {
    case "orgHeader": return { kind, showLogo: true, showAddress: true };
    case "identity": return { kind, caption: "Payslip", showDesignation: true };
    case "kvGrid": return { kind, columns: 3, fields: [{ label: "Employee No.", value: "{{employee_no}}" }] };
    case "attendance": return { kind, title: "Attendance" };
    case "earningsDeductions": return { kind, earningsTitle: "Earnings", deductionsTitle: "Deductions", earningsTotalLabel: "Total Earnings (A)", deductionsTotalLabel: "Total Deductions (B)", amountLabel: "Amount" };
    case "netBox": return { kind, label: "Net Salary Payable (A - B)", showWords: true };
    case "note": return { kind, text: "", align: "left" };
    case "rule": return { kind, weight: 0.5 };
    case "gap": return { kind, height: 8 };
    case "footer": return { kind, left: "", right: "" };
  }
}
