import { describe, it, expect } from "vitest";
import { resolveLetter, type LetterContext, type LetterTemplate } from "../src/domain/letters";
import { DEFAULT_LETTER_TEMPLATES } from "../scripts/genTemplatesSeed";

// The template resolver: placeholder + derived-clause substitution, **bold** -> runs, requires-gating, and
// the named computed blocks. Uses the shipped default templates as the fixtures.
const byId = (id: string): LetterTemplate => DEFAULT_LETTER_TEMPLATES.find((t) => t.id === id)!;

const baseCtx = (over: Partial<LetterContext> = {}): LetterContext => ({
  org: { name: "Acme Corp", address: "1 Road" },
  defaults: { signatory_name: "Sam Signatory", signatory_title: "HR Manager", working_hours: "10-7", working_days: "Mon-Fri", work_mode: "on-site", work_location: "HQ", offer_validity_days: 7 },
  today: new Date(Date.UTC(2026, 5, 13)),
  employee: { fullName: "Aarav Sharma", firstName: "Aarav", designation: "Engineer", department: "Eng", managerName: "Mara", startDate: new Date(Date.UTC(2026, 6, 1)), probationEndDate: new Date(Date.UTC(2026, 9, 1)), endDate: null },
  comp: { ctcAnnual: 1800000, ctcMonthly: 150000, lines: [{ name: "Basic", monthly: 90000, annual: 1080000 }, { name: "HRA", monthly: 60000, annual: 720000 }] },
  increment: { oldAnnual: 1500000, newAnnual: 1800000, effectiveDate: new Date(Date.UTC(2026, 3, 1)) },
  ...over,
});

// Flatten a resolved letter's text for assertions.
const flat = (blocks: ReturnType<typeof resolveLetter>["content"]["blocks"]) =>
  blocks.flatMap((b) => {
    if (b.kind === "para") return b.runs.map((r) => (typeof r === "string" ? r : r.b)).join("");
    if (b.kind === "subject" || b.kind === "note") return b.text;
    if (b.kind === "bullets") return b.items.flat().map((r) => (typeof r === "string" ? r : r.b));
    return [];
  }).join(" | ");

describe("resolveLetter", () => {
  it("substitutes placeholders + derived clauses and bolds inline", () => {
    const { content, title, fileName } = resolveLetter(byId("offer"), baseCtx());
    const text = flat(content.blocks);
    expect(text).toContain("Dear Aarav,");
    expect(text).toContain("position as Engineer in the Eng department, initially reporting to Mara");
    expect(text).toContain("1 July 2026");
    expect(text).toContain("on probation for 3 months");
    expect(text).toContain("INR 18,00,000/- (Eighteen Lakh only)");
    expect(title).toBe("Offer Letter - Aarav Sharma");
    expect(fileName).toBe("Aarav Sharma - Offer Letter.pdf");
    // a bold run is produced for the company name
    const para = content.blocks.find((b) => b.kind === "para" && b.runs.some((r) => typeof r === "object" && r.b === "Acme Corp"));
    expect(para).toBeTruthy();
  });

  it("drops blocks whose `requires` is absent (no comp -> no annexure; no validity -> no validity para)", () => {
    const { content } = resolveLetter(byId("offer"), baseCtx({ comp: undefined, increment: undefined, defaults: { signatory_name: "Sam Signatory" } }));
    const kinds = content.blocks.map((b) => b.kind);
    expect(kinds).not.toContain("table"); // ctc_annexure dropped
    expect(kinds.filter((k) => k === "pageBreak")).toHaveLength(0); // annexure page break dropped
    expect(flat(content.blocks)).not.toContain("This offer is valid until");
    expect(flat(content.blocks)).not.toContain("working hours"); // working_pattern absent
  });

  it("expands the computed CTC annexure table from comp data", () => {
    const { content } = resolveLetter(byId("offer"), baseCtx());
    const table = content.blocks.find((b) => b.kind === "table");
    expect(table).toBeTruthy();
    if (table && table.kind === "table") {
      expect(table.table.columns).toEqual(["Particulars", "Monthly", "Annually"]);
      expect(table.table.rows[0]).toEqual(["Basic", "INR 90,000", "INR 10,80,000"]);
      expect(table.table.total).toEqual(["Total Cost to Company", "INR 1,50,000", "INR 18,00,000"]);
    }
  });

  it("keeps an over-and-above-CTC contribution out of the annexure total and states it separately", () => {
    const ctx = baseCtx({
      comp: {
        ctcAnnual: 1800000, ctcMonthly: 150000,
        lines: [
          { name: "Basic", monthly: 90000, annual: 1080000 },
          { name: "HRA", monthly: 60000, annual: 720000 },
          { name: "Employer PF", monthly: 1800, annual: 21600, aboveCtc: true },
        ],
      },
    });
    const { content } = resolveLetter(byId("offer"), ctx);
    const table = content.blocks.find((b) => b.kind === "table");
    // The tabled rows are exactly the in-CTC lines, so they add up to the stated Cost to Company.
    expect(table && table.kind === "table" && table.table.rows.map((r) => r[0])).toEqual(["Basic", "HRA"]);
    expect(table && table.kind === "table" && table.table.total).toEqual(["Total Cost to Company", "INR 1,50,000", "INR 18,00,000"]);
    // PF is stated as what the company pays IN ADDITION - the wording a "CTC + PF" structure needs.
    expect(flat(content.blocks)).toContain("In addition, the Company contributes Employer PF of INR 1,800 per month (INR 21,600 annually), over and above the Cost to Company stated above.");
  });
  it("increment: shows the old->new table when two comp rows exist", () => {
    const { content } = resolveLetter(byId("increment"), baseCtx());
    const table = content.blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.table.total).toEqual(["Increase", "INR 3,00,000"]);
    // the ctc_no_increment fallback para is dropped when an increment exists
    expect(flat(content.blocks)).not.toContain("Your annual CTC is");
  });

  it("increment fallback: uses the no-increment para when only one comp row exists", () => {
    const { content } = resolveLetter(byId("increment"), baseCtx({ increment: undefined }));
    expect(content.blocks.some((b) => b.kind === "table")).toBe(false);
    expect(flat(content.blocks)).toContain("Your annual CTC is");
  });

  it("promotion: shows old -> new designation when the title changed", () => {
    const ctx = baseCtx({ roleChange: { oldTitle: "Engineer", newTitle: "Senior Engineer", effectiveDate: new Date(Date.UTC(2026, 5, 1)), titleChanged: true, departmentChanged: false, locationChanged: false } });
    const { content } = resolveLetter(byId("promotion"), ctx);
    expect(flat(content.blocks)).toContain("promoted from Engineer to Senior Engineer, effective 1 June 2026");
  });

  it("promotion: drops the promotion line when the title didn't change", () => {
    const ctx = baseCtx({ roleChange: { oldTitle: "Engineer", newTitle: "Engineer", effectiveDate: new Date(Date.UTC(2026, 5, 1)), titleChanged: false, departmentChanged: true, locationChanged: false } });
    const { content } = resolveLetter(byId("promotion"), ctx);
    expect(flat(content.blocks)).not.toContain("promoted from");
  });

  it("transfer: builds the transfer clause from department and location changes", () => {
    const ctx = baseCtx({ roleChange: { newDepartment: "Sales", newLocation: "Example City", effectiveDate: new Date(Date.UTC(2026, 5, 1)), titleChanged: false, departmentChanged: true, locationChanged: true } });
    const { content } = resolveLetter(byId("transfer"), ctx);
    expect(flat(content.blocks)).toContain("transferred to the Sales department and to Example City, effective 1 June 2026");
  });

  it("bonus: cites the award kind, amount in words and reason", () => {
    const ctx = baseCtx({ bonus: { amount: 100000, kind: "Performance Bonus", reason: "exceptional delivery", date: new Date(Date.UTC(2026, 5, 1)) } });
    const { content, title } = resolveLetter(byId("bonus"), ctx);
    const text = flat(content.blocks);
    expect(text).toContain("awarded a Performance Bonus of INR 1,00,000/- (One Lakh only)");
    expect(text).toContain("with effect from 1 June 2026");
    expect(text).toContain("in recognition of exceptional delivery");
    expect(title).toBe("Bonus / Incentive Letter - Aarav Sharma");
  });

  it("settlement (FnF): renders the line items, negative deductions and net in words", () => {
    const ctx = baseCtx({ settlement: { net: 94000, date: new Date(Date.UTC(2026, 5, 30)), lines: [
      { name: "Salary for 15 day(s)", kind: "earning", amount: 75000 },
      { name: "Leave encashment (10 day(s))", kind: "earning", amount: 30000 },
      { name: "Notice period recovery (5 day(s))", kind: "deduction", amount: 15000 },
    ] } });
    const { content } = resolveLetter(byId("settlement"), ctx);
    const table = content.blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.table.rows).toContainEqual(["Less: Notice period recovery (5 day(s))", "-INR 15,000"]);
    expect(table && table.kind === "table" && table.table.total).toEqual(["Net settlement payable", "INR 94,000"]);
    expect(flat(content.blocks)).toContain("net amount payable to you is INR 94,000/- (Ninety Four Thousand only)");
  });

  it("other: fills the subject placeholder and renders the HR body as paragraphs", () => {
    const { content, title, fileName } = resolveLetter(byId("other"), baseCtx(), {
      subject: "Confirmation of Address",
      body: "This confirms the address of **{{employee_name}}**.\nIssued on request.",
    });
    const text = flat(content.blocks);
    expect(text).toContain("Subject: Confirmation of Address");
    expect(text).toContain("This confirms the address of Aarav Sharma."); // {{employee_name}} + **bold**
    expect(text).toContain("Issued on request."); // second line -> second paragraph
    expect(title).toBe("Other Letter - Aarav Sharma");
    expect(fileName).toBe("Aarav Sharma - Confirmation of Address.pdf"); // {{subject}} in the filename
  });

  it("experience: falls back to today when no end date is set", () => {
    const { content } = resolveLetter(byId("experience"), baseCtx({ employee: { ...baseCtx().employee, endDate: null } }));
    expect(flat(content.blocks)).toContain("from 1 July 2026 to 13 June 2026");
  });

  it("offer: ends with a company (1st-party) sign-off and a binding employee (2nd-party) e-signature", () => {
    const { content } = resolveLetter(byId("offer"), baseCtx());
    const sig = content.blocks.find((b) => b.kind === "signature");
    expect(sig && sig.kind === "signature" && sig.closing).toBe("For and on behalf of Acme Corp,");
    expect(sig && sig.kind === "signature" && sig.name).toBe("Sam Signatory"); // company_signatory_name from defaults
    const esig = content.blocks.find((b) => b.kind === "esignature");
    expect(esig).toMatchObject({ kind: "esignature", name: "Aarav Sharma", label: "Employee Signature", withDate: true });
    expect(flat(content.blocks)).toContain("I, Aarav Sharma, have read and understood this offer");
  });

  it("appointment: carries binding terms, a company sign-off and an employee e-signature", () => {
    const { content } = resolveLetter(byId("appointment"), baseCtx());
    const text = flat(content.blocks);
    expect(text).toContain("exclusive jurisdiction");
    expect(text).toContain("Non-solicitation and conflict of interest");
    expect(content.blocks.some((b) => b.kind === "esignature")).toBe(true);
    const sig = content.blocks.find((b) => b.kind === "signature");
    expect(sig && sig.kind === "signature" && sig.closing).toBe("For and on behalf of Acme Corp,");
  });

  it("nda: a company-signed confidentiality & IP agreement that the employee e-signs", () => {
    const { content, title } = resolveLetter(byId("nda"), baseCtx());
    const text = flat(content.blocks);
    expect(text).toContain("Assignment of Intellectual Property");
    expect(text).toContain("irrevocably assigns");
    expect(content.blocks.some((b) => b.kind === "signature")).toBe(true); // company (1st party)
    expect(content.blocks.some((b) => b.kind === "esignature")).toBe(true); // recipient (2nd party)
    expect(title).toBe("Confidentiality & IP Assignment Agreement - Aarav Sharma");
  });

  it("settlement: appends an employee acknowledgement e-signature and a full-discharge clause", () => {
    const ctx = baseCtx({ settlement: { net: 94000, date: new Date(Date.UTC(2026, 5, 30)), lines: [{ name: "Salary", kind: "earning", amount: 94000 }] } });
    const { content } = resolveLetter(byId("settlement"), ctx);
    expect(content.blocks.some((b) => b.kind === "esignature")).toBe(true);
    expect(flat(content.blocks)).toContain("complete and final discharge of all dues");
  });

  it("emits an e-signature placeholder block (recipient name set, no signature image until signed)", () => {
    const tmpl: LetterTemplate = { id: "nda", label: "NDA", blocks: [{ kind: "esignature", label: "Employee signature" }] };
    const block = resolveLetter(tmpl, baseCtx()).content.blocks.find((b) => b.kind === "esignature");
    expect(block).toMatchObject({ kind: "esignature", name: "Aarav Sharma", label: "Employee signature" });
    expect((block as { signature?: unknown }).signature).toBeUndefined(); // filled only at :sign time
  });
});
