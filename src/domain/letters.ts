// Letter TEMPLATE model + resolver. There are no built-in letter types here: the templates live in the
// `letter-templates` setting (seeded by scripts/templates.sql, editable at runtime), so HR can add/edit any
// number of letter types without a code change. This module owns only the closed vocabulary the templates
// draw on: the placeholder/derived-clause set, inline `**bold**`, block-level `requires` gating, and the
// named `computed` blocks (CTC annexure, increment table). The renderer (src/lib/letterPdf.ts) turns the
// resolved blocks into a PDF; src/services/letterData.ts assembles the LetterContext from DB + settings.
import type { LetterContent, LetterBlock, LetterTable, LetterheadSpec, Run } from "../lib/letterPdf";
import type { EsignMethod } from "./esign";
import { amountInWords, moneyWhole } from "../lib/pdfPrimitives";

// One CTC annexure row. `aboveCtc` marks a contribution the org puts OVER AND ABOVE CTC (employer PF when
// its component's `in_ctc` is false): stated in the letter, but outside the Cost to Company total. Structurally
// identical to domain/payroll.ts CtcLine, which is what feeds it.
export type CtcLine = { name: string; monthly: number; annual: number; aboveCtc?: boolean };

// Configurable, non-employee-derived values (signatory, contact, working pattern, validity). Sourced from
// the organization settings "letter_defaults" block; every field is optional and degrades gracefully.
export type LetterDefaults = {
  // Company (first-party) authorized signatory - who signs letters ON BEHALF OF the employer.
  signatory_name?: string;
  signatory_title?: string;
  signatory_signature?: string; // authorized-signatory signature image (data URL) - the employer's e-signature
  company_stamp?: string; // company seal/stamp image (data URL) - overlaid beside the signatory on generated letters
  hr_name?: string;
  hr_email?: string;
  hr_phone?: string;
  working_hours?: string;
  working_days?: string;
  work_mode?: string; // on-site | remote | hybrid
  work_location?: string;
  offer_validity_days?: number;
  probation_months?: number;
};

export type LetterContext = {
  org: { name: string; address?: string; logo?: string; legalName?: string };
  /** The page this letter prints on, resolved by services/letterheads. Absent = the stock page. */
  letterhead?: LetterheadSpec;
  /** Which letterhead that was (`letterheads/<id>`), carried into the frozen content for re-renders. */
  letterheadRef?: string;
  defaults: LetterDefaults;
  today: Date;
  employee: {
    fullName: string;
    firstName: string;
    legalName?: string; // full legal name; falls back to fullName when unset
    employeeNumber?: string; // human-facing employee ID
    designation?: string;
    department?: string;
    managerName?: string;
    startDate?: Date | null;
    probationEndDate?: Date | null;
    endDate?: Date | null;
  };
  comp?: { ctcAnnual: number; ctcMonthly: number; lines: CtcLine[] };
  increment?: { oldAnnual: number; newAnnual: number; effectiveDate?: Date | null };
  // The two newest role records (positions history) -> old/new for promotion & transfer letters.
  roleChange?: {
    oldTitle?: string;
    newTitle?: string;
    oldDepartment?: string;
    newDepartment?: string;
    oldLocation?: string;
    newLocation?: string;
    effectiveDate?: Date | null;
    titleChanged: boolean;
    departmentChanged: boolean;
    locationChanged: boolean;
  };
  // The most recent one-off award, for the bonus/incentive letter.
  bonus?: { amount: number; currency?: string; kind?: string; reason?: string; date?: Date | null };
  // The most recent full-and-final settlement snapshot, for the FnF letter.
  settlement?: { lines: { name: string; kind: "earning" | "deduction"; amount: number }[]; net: number; date?: Date | null };
};

// ── Stored template shape (the JSON in the `letter-templates` setting) ──────────────────────────────────
// A template is an ordered list of blocks. Text fields support {{placeholders}} and inline **bold**. A block
// with `requires` is dropped when that key is absent (see presence()). `computed` blocks reference a fixed
// library of code-built blocks (tables) by name.
export type TemplateBlock =
  | { kind: "subject"; text: string; requires?: string }
  | { kind: "para"; text: string; bold?: boolean; requires?: string }
  | { kind: "bullets"; items: string[]; ordered?: boolean; requires?: string }
  | { kind: "note"; text: string; requires?: string }
  | { kind: "input"; field: string; requires?: string } // renders an HR-provided multiline field as paragraphs
  | { kind: "signature"; closing?: string; requires?: string }
  | { kind: "acceptance"; requires?: string }
  | { kind: "esignature"; label?: string; withDate?: boolean; method?: EsignMethod; requires?: string } // recipient e-signature placeholder (signed in place); `method` = in-app image ("internal", default) or Aadhaar ("cashfree"); withDate adds a date line aligned with the signature
  | { kind: "gap"; height?: number; requires?: string }
  | { kind: "pageBreak"; requires?: string }
  | { kind: "computed"; ref: "ctc_annexure" | "increment_table" | "settlement_table"; requires?: string };

// A field the HR user fills in at generation time (for letters whose content isn't derived from data, e.g.
// the generic "Other" letter). Text fields are usable as {{key}} placeholders; multiline fields are rendered
// by an `input` block as paragraphs.
export type TemplateInput = {
  key: string;
  label: string;
  type?: "text" | "multiline";
  placeholder?: string;
  required?: boolean;
};

export type LetterTemplate = {
  id: string;
  label: string;
  category?: string; // grouping for the editor + generate pickers (e.g. Onboarding, Compensation, Exit)
  // Which letterhead this template is issued on, as a `letterheads/<id>` ref (an org with several legal
  // entities issues each one's letters on its own stationery). Unset - or one since removed - falls back to the
  // org-wide default for letters. Overridable per generation.
  letterhead?: string;

  filename?: string; // download filename template (without extension); supports placeholders
  inputs?: TemplateInput[]; // fields HR fills in at generation time
  blocks: TemplateBlock[];
};

export type LetterTemplatesConfig = { templates: LetterTemplate[] };

// ── Formatting helpers ──────────────────────────────────────────────────────────────────────────────────
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDate = (d?: Date | null): string => (d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "___________");
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
function monthsBetween(a?: Date | null, b?: Date | null): number | null {
  if (!a || !b) return null;
  return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()));
}
const inr = (n: number) => `INR ${moneyWhole(n)}`;
const inrWords = (n: number) => `INR ${moneyWhole(n)}/- (${amountInWords(Math.round(n))})`;

function hrContactClause(d: LetterDefaults): string {
  if (!d.hr_name && !d.hr_email && !d.hr_phone) return "";
  let s = "";
  if (d.hr_name) s += ` to **${d.hr_name}**`;
  if (d.hr_phone) s += ` at ${d.hr_phone}`;
  if (d.hr_email) s += (d.hr_phone ? " or " : " at ") + `**${d.hr_email}**`;
  return s;
}

// The placeholder/derived-clause map + a presence test. Derived "clauses" carry their own conditional
// inclusion and inline bold, so the editable template text stays simple while the tricky bits stay correct.
function buildContext(ctx: LetterContext, input: Record<string, string> = {}, declared?: ReadonlySet<string>): { v: Record<string, string>; present: (key: string) => boolean } {
  const e = ctx.employee;
  const d = ctx.defaults;
  const probMonths = monthsBetween(e.startDate, e.probationEndDate) ?? d.probation_months ?? null;
  const endDate = fmtDate(e.endDate ?? ctx.today);
  const v: Record<string, string> = {
    company: ctx.org.name || "",
    date: fmtDate(ctx.today),
    employee_name: e.fullName,
    legal_name: e.legalName || e.fullName,
    employee_number: e.employeeNumber || "",
    first_name: e.firstName,
    // Recipient (second-party) identity - the employee/candidate who receives the letter and, on binding
    // documents, signs it. Mirrors the company (first-party) signatory keys below, so a template can name
    // both sides unambiguously.
    recipient_name: e.fullName,
    recipient_legal_name: e.legalName || e.fullName,
    recipient_first_name: e.firstName,
    designation: e.designation || "___________",
    department: e.department || "",
    manager: e.managerName || "",
    joining_date: fmtDate(e.startDate),
    end_date: endDate,
    work_mode: (d.work_mode || "full-time").replace(/_/g, " "),
    working_hours: d.working_hours || "",
    working_days: d.working_days || "",
    work_location: d.work_location || "",
    working_pattern: [d.working_hours, d.working_days].filter(Boolean).join(", "),
    // Company (first-party) sign-off identity: the authorized signatory who signs on behalf of the employer.
    company_signatory_name: d.signatory_name || "Authorised Signatory",
    company_signatory_title: d.signatory_title || "Human Resources",
    hr_name: d.hr_name || "",
    hr_email: d.hr_email || "",
    hr_phone: d.hr_phone || "",
    validity_date: d.offer_validity_days && d.offer_validity_days > 0 ? fmtDate(addDays(ctx.today, d.offer_validity_days)) : "",
    probation_months: probMonths !== null ? String(probMonths) : "",
    // Derived clauses (conditional + inline bold baked in).
    department_clause: e.department ? ` in the **${e.department}** department` : "",
    reporting_to_clause: e.managerName ? `, initially reporting to **${e.managerName}**` : "",
    probation_clause: probMonths !== null ? ` You will be on probation for **${probMonths} months**.` : "",
    work_location_suffix: d.work_location ? `, based at ${d.work_location}` : "",
    hr_contact_clause: hrContactClause(d),
    appraisal_role_clause: e.designation ? `as ${e.designation}${e.department ? ` in the ${e.department} department` : ""}` : "in your role",
    exp_designation_clause: e.designation ? ` as ${e.designation}` : "",
    exp_department_clause: e.department ? ` in the ${e.department} department` : "",
    rel_role_clause: e.designation ? `, who was employed with us as ${e.designation}` : ", who was employed with us",
    tenure_clause: e.startDate ? ` from ${fmtDate(e.startDate)} to ${endDate}` : ` until ${endDate}`,
    employment_period: e.startDate ? `from ${fmtDate(e.startDate)} to ${endDate}` : `until ${endDate}`,
  };
  if (ctx.comp) {
    v.ctc_annual = inr(ctx.comp.ctcAnnual);
    v.ctc_monthly = inr(ctx.comp.ctcMonthly);
    v.ctc_in_words = inrWords(ctx.comp.ctcAnnual);
  }
  if (ctx.increment) {
    v.inc_old_annual = inr(ctx.increment.oldAnnual);
    v.inc_new_annual = inr(ctx.increment.newAnnual);
    v.inc_new_annual_words = inrWords(ctx.increment.newAnnual);
    v.inc_increase = inr(ctx.increment.newAnnual - ctx.increment.oldAnnual);
    v.inc_effective_date = fmtDate(ctx.increment.effectiveDate ?? ctx.today);
  }
  const rc = ctx.roleChange;
  if (rc) {
    v.old_designation = rc.oldTitle ?? "";
    v.new_designation = rc.newTitle ?? "";
    v.old_department = rc.oldDepartment ?? "";
    v.new_department = rc.newDepartment ?? "";
    v.old_location = rc.oldLocation ?? "";
    v.new_location = rc.newLocation ?? "";
    v.role_effective_date = fmtDate(rc.effectiveDate ?? ctx.today);
    // Auto clause describing what the transfer changes (department and/or location).
    const tparts: string[] = [];
    if (rc.departmentChanged && rc.newDepartment) tparts.push(`to the **${rc.newDepartment}** department`);
    if (rc.locationChanged && rc.newLocation) tparts.push(`to **${rc.newLocation}**`);
    v.transfer_clause = tparts.join(" and ");
  }
  if (ctx.bonus) {
    v.bonus_kind = ctx.bonus.kind || "Bonus";
    v.bonus_amount = inr(ctx.bonus.amount);
    v.bonus_amount_words = inrWords(ctx.bonus.amount);
    v.bonus_date = fmtDate(ctx.bonus.date ?? ctx.today);
    v.bonus_reason_clause = ctx.bonus.reason ? ` This award is in recognition of ${ctx.bonus.reason}.` : "";
  }
  if (ctx.settlement) {
    v.settlement_net = inr(ctx.settlement.net);
    v.settlement_net_words = inrWords(ctx.settlement.net);
    v.settlement_date = fmtDate(ctx.settlement.date ?? ctx.today);
  }
  // HR-provided inputs (for custom letters) become placeholders too; single-line values are usable as {{key}}.
  //
  // FILTERED TO THE KEYS THE TEMPLATE DECLARES, because this spread is the LAST assignment into `v` and the
  // route accepts arbitrary keys (`input: z.record(z.string(), z.string().max(20_000))`, up to 200 of them).
  // Unfiltered, last-write-wins let the caller overwrite any DERIVED placeholder - `{{ctc_annual}}`,
  // `{{settlement_net}}`, `{{inc_new_annual}}`, `{{employee_name}}`, `{{company_signatory_name}}` - on a letter that is
  // then rendered, filed as the employee's `personal-documents` row, frozen for re-render, and optionally sent
  // for Aadhaar e-signature.
  //
  // That defeated a control routes/letterGenerate.ts states explicitly: the caller rides along "so the CTC
  // blocks are dropped for anyone without a compensation grant - the letter still generates, it just cannot
  // state a figure its author may not read". The seeded `hr_admin` grant deliberately holds no `compensation`
  // entry, so `ctx.comp` is undefined for HR and a `requires: ctc` block is dropped - but an inline
  // `{{ctc_annual}}` in ordinary body text resolved from `v`, and `v.ctc_annual` was whatever `input` said. Not
  // a read bypass (the author still cannot learn the real CTC); an integrity one in the other direction, where
  // that same author authors an official CTC, increment or settlement letter stating any figure they choose.
  //
  // `template.inputs` already exists to name the fields HR fills in, so declaring is the model the file
  // carries - and filtering here also turns a typo'd input key into a visible no-op rather than a silent
  // override of something else. `declared` absent means no filter, for the internal callers that build their
  // own map rather than taking one off the wire.
  for (const [k, val] of Object.entries(input)) {
    if (typeof val !== "string") continue;
    if (declared && !declared.has(k)) continue;
    v[k] = val;
  }
  const present = (key: string): boolean => {
    if (key === "ctc") return !!ctx.comp;
    if (key === "increment") return !!ctx.increment;
    if (key === "ctc_no_increment") return !!ctx.comp && !ctx.increment;
    if (key === "promotion") return !!rc && rc.titleChanged;
    if (key === "transfer") return !!rc && (rc.departmentChanged || rc.locationChanged);
    if (key === "bonus") return !!ctx.bonus;
    if (key === "settlement") return !!ctx.settlement;
    return (v[key] ?? "").trim() !== "";
  };
  return { v, present };
}

const subst = (text: string, v: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? "");

// Parse `**bold**` segments of an already-substituted string into renderer runs.
function parseRuns(text: string): Run[] {
  const out: Run[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ b: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [""];
}

// The two named computed blocks: tables built from data, not hand-authored.
// CTC annexure. Only the lines that COUNT INSIDE CTC are tabled, so the rows add up to the stated Cost to
// Company. A contribution whose component is set to sit over and above CTC (`in_ctc` false) is
// not part of that figure, so it is stated after the table as what the company pays IN ADDITION - the wording an
// offer/increment letter needs for a "CTC + PF" structure.
function ctcAnnexureBlocks(comp: NonNullable<LetterContext["comp"]>): LetterBlock[] {
  const above = comp.lines.filter((l) => l.aboveCtc);
  const table: LetterTable = {
    columns: ["Particulars", "Monthly", "Annually"],
    rows: comp.lines.filter((l) => !l.aboveCtc).map((l) => [l.name, inr(l.monthly), inr(l.annual)]),
    total: ["Total Cost to Company", inr(comp.ctcMonthly), inr(comp.ctcAnnual)],
  };
  const blocks: LetterBlock[] = [{ kind: "table", table }];
  for (const l of above) {
    blocks.push({
      kind: "note",
      text: `In addition, the Company contributes ${l.name} of ${inr(l.monthly)} per month (${inr(l.annual)} annually), over and above the Cost to Company stated above.`,
    });
  }
  return blocks;
}
function incrementTableBlock(inc: NonNullable<LetterContext["increment"]>): LetterBlock {
  const table: LetterTable = {
    columns: ["Particulars", "Annually"],
    rows: [["Previous CTC", inr(inc.oldAnnual)], ["Revised CTC", inr(inc.newAnnual)]],
    total: ["Increase", inr(inc.newAnnual - inc.oldAnnual)],
  };
  return { kind: "table", table };
}
// Settlement statement: earnings as positive, deductions as negative (with a "Less: " label), net total.
function settlementTableBlock(s: NonNullable<LetterContext["settlement"]>): LetterBlock {
  const table: LetterTable = {
    columns: ["Particulars", "Amount"],
    rows: s.lines.map((l) => (l.kind === "deduction" ? [`Less: ${l.name}`, `-${inr(l.amount)}`] : [l.name, inr(l.amount)])),
    total: ["Net settlement payable", inr(s.net)],
  };
  return { kind: "table", table };
}

export type ResolvedLetter = { content: LetterContent; title: string; fileName: string };

// Resolve a stored template against a context (+ optional HR input) into renderable content + a title + a
// download filename.
export function resolveLetter(template: LetterTemplate, ctx: LetterContext, input: Record<string, string> = {}): ResolvedLetter {
  const { v, present } = buildContext(ctx, input, new Set((template.inputs ?? []).map((i) => i.key)));
  const blocks: LetterBlock[] = [];
  for (const b of template.blocks) {
    if (b.requires && !present(b.requires)) continue;
    switch (b.kind) {
      case "subject":
        blocks.push({ kind: "subject", text: subst(b.text, v) });
        break;
      case "para":
        blocks.push({ kind: "para", runs: parseRuns(subst(b.text, v)), bold: b.bold });
        break;
      case "input":
        // Render the HR-provided multiline field: one paragraph per non-empty line (placeholders + **bold** apply).
        for (const line of (input[b.field] ?? "").split(/\r?\n/)) {
          if (line.trim()) blocks.push({ kind: "para", runs: parseRuns(subst(line, v)) });
        }
        break;
      case "bullets":
        blocks.push({ kind: "bullets", items: (b.items ?? []).map((i) => parseRuns(subst(i, v))), ordered: b.ordered });
        break;
      case "note":
        blocks.push({ kind: "note", text: subst(b.text, v) });
        break;
      case "gap":
        blocks.push({ kind: "gap", height: b.height ?? 8 });
        break;
      case "pageBreak":
        blocks.push({ kind: "pageBreak" });
        break;
      case "signature":
        // Company (first-party) sign-off: the authorized signatory + the employer's e-signature image on file.
        blocks.push({ kind: "signature", closing: b.closing ? subst(b.closing, v) : undefined, name: v.company_signatory_name!, title: v.company_signatory_title, signatureImage: ctx.defaults.signatory_signature, stampImage: ctx.defaults.company_stamp });
        break;
      case "acceptance":
        // Recipient (second-party) wet-ink acceptance line; carries the LEGAL name (the name on official
        // records), not the display name.
        blocks.push({ kind: "acceptance", name: v.recipient_legal_name! });
        break;
      case "esignature":
        // Recipient (second-party) digital signature: a placeholder at generation; the :sign verb later fills
        // in the owner's signature image + date in place. Distinct from the company signature block above.
        blocks.push({ kind: "esignature", name: v.recipient_legal_name!, label: b.label, withDate: b.withDate, method: b.method });
        break;
      case "computed":
        if (b.ref === "ctc_annexure" && ctx.comp) blocks.push(...ctcAnnexureBlocks(ctx.comp));
        else if (b.ref === "increment_table" && ctx.increment) blocks.push(incrementTableBlock(ctx.increment));
        else if (b.ref === "settlement_table" && ctx.settlement) blocks.push(settlementTableBlock(ctx.settlement));
        break;
    }
  }
  const content: LetterContent = {
    org: ctx.org,
    ...(ctx.letterhead ? { letterhead: ctx.letterhead } : {}),
    ...(ctx.letterheadRef ? { letterheadRef: ctx.letterheadRef } : {}),
    date: v.date!,
    to: { name: ctx.employee.fullName, lines: ctx.employee.designation ? [ctx.employee.designation] : [] },
    blocks,
  };
  const title = `${template.label} - ${ctx.employee.fullName}`;
  const fileName = subst(template.filename || `{{employee_name}} - ${template.label}`, v).replace(/[/\\]/g, "-") + ".pdf";
  return { content, title, fileName };
}
