import { Hono } from "hono";
import { z } from "zod";
import { positiveMoney } from "../http/moneyField";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { previewRevision, type RevisionSide } from "../services/compensation";
import { invalidArgument } from "../lib/errors";

// Collection-level custom method `compensation:preview` (mounted at the full path in index.ts, for the same
// Hono reason `compensation:reapplySplit` is). Prices a PROPOSED revision through the same path the save runs
// and writes nothing.
//
// A POST that changes no state, which is how this API spells a custom method with a body - the request carries
// a salary somebody is considering, and a salary does not belong in a query string where it lands in logs and
// browser history. Gated on the custom key `compensation.preview`, granted alongside the write: the answer
// restates an employee's current pay beside a proposed one, so anyone who may see it may already read the
// compensation row it is derived from.
const previewSchema = z
  .object({
    employee: z.string(),
    // Bounded, like every other money input (http/moneyField.ts): a bare `.positive()` admits 1e308, and
    // the preview prices it straight into `splitCtc` and the arrears sum. This one is not even stored,
    // which makes it easier to forget and no less able to hand back Infinity as somebody's new salary.
    annual_ctc: positiveMoney(),
    effective_from: z.string(),
    pay_grade: z.string().nullable().optional(),
    salary_structure: z.string().nullable().optional(),
  })
  .strict();

/** The domain answers in the app's internal spelling; the wire is snake_case. Mapped here rather than in the
 *  service, which has no business knowing what HTTP looks like - the same split the reconciliation read makes. */
const toSide = (s: RevisionSide) => ({
  annual_ctc: s.annualCtc,
  monthly_gross: s.monthlyGross,
  base_pay: s.basePay,
  special_allowance: s.specialAllowance,
  pf_wages: s.pfWages,
  employee_pf: s.employeePf,
  employee_esi: s.employeeEsi,
  professional_tax: s.professionalTax,
  employer_cost: s.employerCost,
  above_ctc_cost: s.aboveCtcCost,
  lines: s.lines.map((l) => ({ name: l.name, monthly: l.monthly, ...(l.aboveCtc ? { above_ctc: true } : {}) })),
});

export const compensationPreview = new Hono<AppEnv>().post("/", async (c) => {
  const parsed = previewSchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw invalidArgument("employee, annual_ctc and effective_from are required");
  const p = await previewRevision(c.get("deps"), parsed.data);
  return c.json({
    current: p.current ? toSide(p.current) : null,
    proposed: toSide(p.proposed),
    arrears: p.arrears,
    crossings: p.crossings,
  });
});
