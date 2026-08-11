import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notify, notifyMany } from "./notifications";
import { notFound, invalidArgument, failedPrecondition } from "../lib/errors";
import { getEmployeeTaxProjection, readDeclarations, readRawTaxDetails, type TaxDeclarations, type TaxProjection } from "./taxProjection";
import type { Wire } from "../http/wire";

// Income-tax (TDS) sub-resource: stores only the employee's manual DECLARATIONS (prior-employer income + TDS
// for mid-year joiners) as an encrypted blob - everything else (the year's tax, the monthly schedule, the
// deducted-to-date) is computed live by taxProjection. Access is gated by the middleware on
// employees/<code>/tax (owner + HR/payroll + super).

// Roles that may verify prior-employer figures (hold the employees.tax capability). Notification-only routing;
// the actual verify is still authorized in the middleware + the not-self check in setTaxDetails.
const TAX_VERIFIER_ROLES = ["hr_admin", "payroll_admin", "super_admin"];

// Employee ids of the tax verifiers to notify about a new declaration (excluding the actor, so a payroll admin
// declaring on someone's behalf doesn't ping themselves).
async function taxVerifierIds(deps: Deps, excludeEmployeeId: string | null | undefined): Promise<string[]> {
  const users = await deps.db.select({ employeeId: schema.users.employeeId, role: schema.users.role }).from(schema.users);
  return users
    .filter((u) => u.employeeId && u.employeeId !== excludeEmployeeId && TAX_VERIFIER_ROLES.includes(u.role))
    .map((u) => u.employeeId as string);
}

async function loadEmployee(deps: Deps, employeeId: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

// `decl` is the RAW blob (declared figures + verification state); `p` is the projection, whose prior-employer
// figures already reflect the VERIFIED-only gate. So the view shows what was declared, what was verified, and
// the status - and every downstream number (annual_gross/tax) uses verified-only.
// The wire shape comes from the contract (openapi.yaml `tax`), so this projection view is checked against it
// the same way the serializers are - there is no to*Resource for it to go through.
// `path` is stamped by the route (it owns the employee id), so the view is everything else.
function toView(p: TaxProjection, decl: TaxDeclarations): Omit<Wire<"tax">, "path"> {
  const b = p.breakdown;
  const declared = decl.priorEmployerIncome != null || decl.priorEmployerTds != null;
  return {
    on_file: declared,
    regime: p.regime,
    regime_label: p.regimeLabel,
    assessment_year: p.assessmentYear,
    financial_year: p.financialYear,
    tds_configured: p.tdsConfigured,
    prior_employer_income: decl.priorEmployerIncome ?? 0, // declared
    prior_employer_tds: decl.priorEmployerTds ?? 0, // declared
    verification_status: declared ? decl.status ?? "DECLARED" : null,
    verified_income: decl.verifiedIncome ?? null,
    verified_tds: decl.verifiedTds ?? null,
    prior_employer_income_effective: p.priorEmployerIncome, // verified-only, as used by the projection
    prior_employer_tds_effective: p.priorEmployerTds,
    annual_gross: p.annualGross,
    standard_deduction: b.standardDeduction,
    chapter_via: b.chapterVIA,
    deductions: p.deductions.map((d) => ({ section: d.section, declared: d.declared, allowed: d.allowed })),
    taxable_income: b.taxableIncome,
    slabs: b.slabRows.map((r) => ({ from: r.from, to: r.to, rate: r.rate, amount: r.amount })),
    income_tax: b.incomeTax,
    rebate: b.rebate,
    income_tax_after_rebate: b.incomeTaxAfterRebate,
    surcharge: b.surcharge,
    cess: b.cess,
    total_tax: b.totalTax,
    deducted_so_far: p.deductedToDate,
    remaining_months: p.remainingMonths,
    employed_months: p.employedMonths,
    monthly_tds: p.monthlyTds,
  };
}

// The HR/payroll verification queue: every employee whose prior-employer declaration is DECLARED (awaiting a
// decision). Scans employees and decrypts each tax blob - HR-gated + not a hot path (the Approvals inbox loads
// it), so no denormalized status column is needed. Returns the declared figures so a verifier can decide inline.
export type PendingTaxVerification = { employee: string; employee_name: string; prior_employer_income: number; prior_employer_tds: number };
export async function listPendingTaxVerifications(deps: Deps): Promise<PendingTaxVerification[]> {
  const emps = await deps.db.select().from(schema.employees);
  const out: PendingTaxVerification[] = [];
  for (const e of emps) {
    if (e.deleteTime || !e.taxDetailsEnc) continue;
    const raw = await readRawTaxDetails(deps, e.taxDetailsEnc);
    if (raw.status !== "DECLARED") continue;
    out.push({
      employee: `employees/${e.uuid}`,
      employee_name: `${e.firstName} ${e.lastName}`,
      prior_employer_income: raw.priorEmployerIncome ?? 0,
      prior_employer_tds: raw.priorEmployerTds ?? 0,
    });
  }
  return out.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

export async function getTaxDetails(deps: Deps, _actor: AppUser, employeeId: string) {
  const emp = await loadEmployee(deps, employeeId);
  const raw = await readRawTaxDetails(deps, emp.taxDetailsEnc); // declared + verification state, for the view
  const effective = await readDeclarations(deps, emp.taxDetailsEnc); // verified-only, for the projection
  return toView(await getEmployeeTaxProjection(deps, emp, effective), raw);
}

const num = (v: unknown): number | undefined => {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw invalidArgument("amounts must be non-negative numbers");
  return Math.round(n);
};

// Employee DECLARES prior-employer income/TDS (owner, or HR/payroll on their behalf); HR/payroll then VERIFY or
// REJECT. Maker-checker is structural: verify/reject require the actor NOT be the subject employee (so an HR
// user can't rubber-stamp their OWN prior-employer figures - another reviewer must). Only VERIFIED figures feed
// withholding (the readDeclarations gate). `action` ("verify"/"reject") rides in the values body; absent = declare.
export async function setTaxDetails(deps: Deps, actor: AppUser, employeeId: string, input: Record<string, unknown>) {
  const emp = await loadEmployee(deps, employeeId);
  const raw = await readRawTaxDetails(deps, emp.taxDetailsEnc);
  const isSelf = actor.employeeId === employeeId;
  const action = typeof input.action === "string" ? input.action : undefined;

  let next: TaxDeclarations;
  let event: "update" | "verify" | "reject" = "update";
  if (action === "verify" || action === "reject") {
    if (isSelf) throw failedPrecondition("previous employer details must be verified by another HR/payroll user, not the subject employee");
    if (raw.priorEmployerIncome == null && raw.priorEmployerTds == null) throw failedPrecondition("nothing has been declared to verify");
    if (action === "reject") {
      next = { ...raw, status: "REJECTED", verifiedIncome: undefined, verifiedTds: undefined, decidedBy: actor.uuid, decidedAt: new Date().toISOString() };
      event = "reject";
    } else {
      // Accept the declared figures, or an explicit override; stamp VERIFIED. Amounts are non-negative (num()).
      next = {
        ...raw,
        status: "VERIFIED",
        verifiedIncome: num(input.verified_income) ?? raw.priorEmployerIncome ?? 0,
        verifiedTds: num(input.verified_tds) ?? raw.priorEmployerTds ?? 0,
        decidedBy: actor.uuid,
        decidedAt: new Date().toISOString(),
      };
      event = "verify";
    }
  } else {
    // (Re)declare: reset the declared figures and drop any prior verification (a changed declaration must be
    // re-verified before it affects withholding again).
    next = {
      assessmentYear: typeof input.assessment_year === "string" ? input.assessment_year : raw.assessmentYear,
      priorEmployerIncome: num(input.prior_employer_income),
      priorEmployerTds: num(input.prior_employer_tds),
      status: "DECLARED",
    };
  }
  const enc = await deps.encryptor.encrypt(JSON.stringify(next));
  await deps.db.update(schema.employees).set({ taxDetailsEnc: enc, updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid));
  await audit(deps, actor, `employee.tax_details.${event}`, "employees", emp.uuid);
  // Tell the subject employee when HR/payroll acts on their declaration (verify makes it apply to withholding;
  // reject asks them to re-declare). Not on a plain (re)declaration - that's the employee's own action.
  if (event === "verify") {
    await notify(deps, { recipient: employeeId, type: "tax.verified", title: "Previous employer details verified", body: "Your declared income and TDS from a previous employer were verified and now apply to your tax projection.", link: "profile" });
  } else if (event === "reject") {
    await notify(deps, { recipient: employeeId, type: "tax.rejected", title: "Previous employer declaration rejected", body: "Your previous employer declaration was not accepted. Please review and re-declare.", link: "profile" });
  } else if (next.priorEmployerIncome != null || next.priorEmployerTds != null) {
    // A new/changed declaration needs HR/payroll verification before it affects withholding: alert the
    // verifiers (the roles that hold the tax capability) so it doesn't sit unseen. Deep-links to the profile.
    await notifyMany(deps, await taxVerifierIds(deps, actor.employeeId), {
      type: "tax.declared",
      title: "Previous employer details to verify",
      body: `${emp.firstName} ${emp.lastName} declared income and TDS from a previous employer, awaiting verification.`,
      link: `employees/${emp.uuid}`,
    });
  }
  const effective = await readDeclarations(deps, enc); // verified-only, for the projection
  return toView(await getEmployeeTaxProjection(deps, emp, effective), next);
}
