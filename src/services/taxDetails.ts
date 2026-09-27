import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta, stateMeta } from "../lib/audit";
import { notify, notifyMany } from "./notifications";
import { holdsForAnyone, roleHolderEmployeeIds } from "./capabilityHolders";
import { notFound, invalidArgument, failedPrecondition } from "../lib/errors";
import { getEmployeeTaxProjection, readDeclarations, readRawTaxDetails, type TaxDeclarations, type TaxProjection } from "./taxProjection";
import type { Wire } from "../http/wire";
import { checkSubEtag, subResourceEtag, updateAtVersion } from "./versionGuard";

// Income-tax (TDS) sub-resource: stores only the employee's manual DECLARATIONS (prior-employer income + TDS
// for mid-year joiners) as an encrypted blob - everything else (the year's tax, the monthly schedule, the
// deducted-to-date) is computed live by taxProjection. Access is gated by the middleware on
// employees/<code>/tax (owner + HR/payroll + super).

/**
 * The DECLARATION fields a per-field access rule can target on `employees/<id>/tax`.
 *
 * This is the read half of field-level control for this sub-resource, and it is the list http/fieldAccess.ts
 * imports - so a key that is not here CANNOT be denied on read: the rule is accepted by the validator, stored,
 * rendered in the ACL surface, and does nothing. Owned here rather than re-typed there for the same reason
 * BANK_FIELDS and PERSONAL_FIELDS are (see the note on FLAT_KEYS).
 *
 * Only the four figures the employee (or HR on their behalf) actually DECLARES. `assessment_year` is a write
 * key too, but the value the view returns under that name is the org's configured year from the tax config,
 * not anything declared, so denying a read of it would hide a published setting rather than someone's money.
 * Everything else in the view is derived (the slab walk, the year's tax, the monthly schedule) and is governed
 * by the whole-sub-resource gate on `employees.<code>.tax`, which the authz middleware applies to the path.
 */
export const TAX_FIELDS = ["prior_employer_income", "prior_employer_tds", "verified_income", "verified_tds"] as const;

// Employee ids of the tax verifiers to notify about a new declaration (excluding the actor, so a payroll admin
// declaring on someone's behalf doesn't ping themselves).
//
// ASKED OF THE GRANT, not of a list of role names. This was
//
//     const TAX_VERIFIER_ROLES = ["hr_admin", "payroll_admin", "super_admin"];
//
// filtered over a full read of `users` - the exact pattern domain/access.ts was written to replace, and wrong
// in both directions without ever erroring: a custom role granted the capability was never told a declaration
// was waiting, and a seeded role that had it revoked in the ACL went on being told. A declaration nobody is
// told about sits unverified, and only VERIFIED figures reduce withholding - so the cost of the silence lands
// on the employee's take-home.
//
// `holdsForAnyone`, not the scope-stripped capability test: `employees.me.tax.**` is in OWN_PII, so every
// employee in the org can write their OWN tax sub-resource and a coarse "holds employees.tax.write" would
// notify the entire company. Verifying is by definition something done to somebody else's record - which the
// not-self guard in setTaxDetails already says about the act, and this says about the audience.
const taxVerifierIds = (deps: Deps, excludeEmployeeId: string | null | undefined): Promise<string[]> =>
  roleHolderEmployeeIds(deps, holdsForAnyone("employees.*.tax", "write"), excludeEmployeeId);

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
    deductions: p.deductions.map((d) => ({ section: d.section, declared: d.declared, allowed: d.allowed, cap: d.cap ?? undefined })),
    // Capped sections with room left, biggest first. Stated as arithmetic and never as advice: "you have
    // declared 60,000 of a 150,000 limit" is a calculation this app is entitled to make, and "you should
    // invest more" is financial advice it is not.
    deduction_headroom: p.deductionHeadroom.map((h) => ({ section: h.section, cap: h.cap, declared: h.declared, remaining: h.remaining })),
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
    // Pay and tax the system before HRMS paid this year: already inside annual_gross and deducted_so_far,
    // stated apart so the page can say how much of each came from before HRMS.
    ...(p.beforeHrms
      ? { before_hrms_gross: p.beforeHrms.taxableGross, before_hrms_tds: p.beforeHrms.tax, before_hrms_paid_through: p.beforeHrms.paidThrough }
      : {}),
  };
}

// The HR/payroll verification queue: every employee whose prior-employer declaration is DECLARED (awaiting a
// decision). The plaintext `taxVerificationStatus` column picks the queue out in SQL, so only the rows that
// ARE awaiting a decision get decrypted (the figures live in the blob and the verifier decides on them
// inline). This is the rows endpoint - the badge counts the same predicate without reading the blobs at all.
// `etag` is the employee row's version AS THE QUEUE READ IT, and it is the point of the card: the figures
// below are what the reviewer is being asked to approve, and setTaxDetails stamps VERIFIED on whatever is
// stored at the moment it runs. Without a version to send back, an employee re-declaring between the queue
// being drawn and Verify being pressed gets their new figure verified by somebody who never saw it.
export type PendingTaxVerification = { employee: string; employee_name: string; prior_employer_income: number; prior_employer_tds: number; etag: string };
export async function listPendingTaxVerifications(deps: Deps): Promise<PendingTaxVerification[]> {
  const emps = await deps.db.select().from(schema.employees).where(eq(schema.employees.taxVerificationStatus, "DECLARED"));
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
      etag: subResourceEtag(e.taxDetailsEnc),
    });
  }
  return out.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
}

export async function getTaxDetails(deps: Deps, _actor: AppUser, employeeId: string) {
  const emp = await loadEmployee(deps, employeeId);
  const raw = await readRawTaxDetails(deps, emp.taxDetailsEnc); // declared + verification state, for the view
  const effective = await readDeclarations(deps, emp.taxDetailsEnc); // verified-only, for the projection
  // The version rides the view, because the guard in setTaxDetails below is load-bearing and inert without it:
  // a reviewer can only send an If-Match if a read handed them one.
  return { ...toView(await getEmployeeTaxProjection(deps, emp, effective), raw), etag: subResourceEtag(emp.taxDetailsEnc) };
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
export async function setTaxDetails(deps: Deps, actor: AppUser, employeeId: string, input: Record<string, unknown>, ifMatch?: string) {
  const emp = await loadEmployee(deps, employeeId);
  // VERSION-GUARDED, and here that is load-bearing rather than merely correct.
  //
  // Maker-checker says WHO decides; it said nothing about WHAT is being decided. Re-declaring is the subject
  // employee's own action, takes no state precondition and resets the record, so HR could open the queue,
  // read 50,000, click Verify - and stamp VERIFIED on the 5,00,000 the employee declared in between, because
  // `raw` is re-read inside this function and `?? raw.priorEmployerIncome` takes whatever it now says. Only
  // VERIFIED figures feed withholding, so the amount nobody reviewed is the amount that cuts the tax
  // deducted. And the whole declaration is ONE ENCRYPTED BLOB rewritten from a read, so a declare landing
  // between the read and the write was not just decided unseen - it was overwritten and gone. Same fix as
  // `tax-declarations:verify` on the other declaration surface. The guard applies whether or not a header was
  // sent (services/versionGuard.ts).
  checkSubEtag(emp.taxDetailsEnc, ifMatch);
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
  // The plaintext status rides the same write as the blob (see schema.employees.taxVerificationStatus): it is
  // what makes the verification queue countable without decrypting anything. A declaration with no figures on
  // it isn't in any queue, so it clears the column rather than parking it in DECLARED forever.
  const declared = next.priorEmployerIncome != null || next.priorEmployerTds != null;
  await updateAtVersion(deps, schema.employees, "employee", emp, {
    taxDetailsEnc: enc,
    taxVerificationStatus: declared ? next.status ?? "DECLARED" : null,
    updatedAt: new Date(),
  });
  // The STATUS is the auditable fact (it decides withholding); the declared figures stay off the trail.
  await audit(deps, actor, `employee.tax_details.${event}`, "employees", emp.uuid, stateMeta(emp.taxVerificationStatus, declared ? next.status ?? "DECLARED" : null, fieldsMeta(next)), emp);
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
  return { ...toView(await getEmployeeTaxProjection(deps, emp, effective), next), etag: subResourceEtag(enc) };
}
