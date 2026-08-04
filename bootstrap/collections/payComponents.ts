// Pay components. Base pay (Basic) is NOT a component - it comes from each employee's compensation record.
// Components are the EXTRA earnings stacked on the base, plus the statutory deductions. method:
//   fixed         - flat monthly amount (`rate` = the amount)
//   percent_base  - `rate`% of base pay
//   epf           - employee PF: `rate`% (12) of min(base, `cap`=15000 wage ceiling)
//   esi           - employee ESI: `rate`% (0.75) of gross while gross <= `cap`=21000 ceiling
//   pt            - professional tax: state slab from the "professional-tax" setting
//   income_tax    - TDS: engine-computed from the `regime` slab block ("new")
// employer_contribution rows are the employer's on-top cost (PF/ESI/gratuity): CTC-only, never on the payslip.
// Which ones exist and at what rate is pure data - add/remove a row here, no code changes. epf/esi rows gate
// the same way as the employee side (PF on opt-in, ESI while within the ceiling); gratuity is % of basic.
// Returns the SQL block AND a key->uuid map so salary structures can reference the earning components.
import { type Ctx, T0, q, n, code2, rows } from "../lib";

type PayComponentSeed = {
  key: string;
  name: string;
  kind: "earning" | "deduction" | "employer_contribution";
  method: "fixed" | "percent_base" | "epf" | "esi" | "pt" | "income_tax";
  rate?: number | null;
  cap?: number | null;
  regime?: string | null;
};

const PAY_COMPONENTS: PayComponentSeed[] = [
  { key: "hra", name: "House Rent Allowance", kind: "earning", method: "percent_base", rate: 40 },
  { key: "conveyance", name: "Conveyance Allowance", kind: "earning", method: "fixed", rate: 1600 },
  { key: "medical", name: "Medical Allowance", kind: "earning", method: "fixed", rate: 1250 },
  { key: "special", name: "Special Allowance", kind: "earning", method: "fixed", rate: 0 },
  { key: "epf", name: "Provident Fund", kind: "deduction", method: "epf", rate: 12, cap: 15000 },
  { key: "esi", name: "Employee State Insurance", kind: "deduction", method: "esi", rate: 0.75, cap: 21000 },
  { key: "pt", name: "Professional Tax", kind: "deduction", method: "pt" },
  { key: "tds", name: "Income Tax (TDS)", kind: "deduction", method: "income_tax", regime: "new" },
  // Employer contributions (cost to company, on top of gross):
  { key: "er_epf", name: "Employer PF", kind: "employer_contribution", method: "epf", rate: 12, cap: 15000 },
  { key: "er_esi", name: "Employer ESI", kind: "employer_contribution", method: "esi", rate: 3.25, cap: 21000 },
  { key: "gratuity", name: "Gratuity", kind: "employer_contribution", method: "percent_base", rate: 4.81 },
];

export function payComponents(ctx: Ctx): { sql: string; uuidByKey: Map<string, string> } {
  const uuidByKey = new Map<string, string>();
  const sql = rows(
    "INSERT INTO pay_components (uuid,code,name,kind,method,rate,cap,regime,recurring,created_at,updated_at) VALUES",
    PAY_COMPONENTS.map((c, i) => {
      const uuid = ctx.nid();
      uuidByKey.set(c.key, uuid);
      return ` (${q(uuid)},${q(code2(i + 1))},${q(c.name)},${q(c.kind)},${q(c.method)},${n(c.rate)},${n(c.cap)},${q(c.regime ?? null)},1,${T0},${T0})`;
    }),
  );
  return { sql, uuidByKey };
}
