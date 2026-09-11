// Pay components: the catalog of earnings, deductions and employer contributions payroll prices. Statutory
// methods (epf/esi/pt/income_tax/edli/pf_admin) are engine-computed and uniqueness-constrained per side; the
// validators below own those rules, and both the create and the patch check the EFFECTIVE post-write state.
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";
import { payComponentLineCode } from "../domain/payroll";

export type PayComponentInput = {
  display_name?: string;
  kind?: "earning" | "deduction" | "employer_contribution"; // same set the column stores (db/schema.ts)
  method?: "fixed" | "percent_base" | "income_tax" | "epf" | "esi" | "pt" | "edli" | "pf_admin";
  rate?: number | null;
  cap?: number | null;
  regime?: string | null;
  recurring?: boolean;
  in_ctc?: boolean; // employer_contribution only: inside CTC (default) vs paid over and above it
  pf_wages?: boolean; // earning only, and only under the "basic_plus" PF wage basis: counts as PF wages
};

// The PF family: employee/employer share (epf) plus the employer's EDLI and administration charges. All three
// are priced on PF wages with the same ceiling, so they share the cap + percentage rules below.
const PF_METHODS = ["epf", "edli", "pf_admin"] as const;
const isPfMethod = (m?: string) => PF_METHODS.includes(m as (typeof PF_METHODS)[number]);
const CAPPED_METHODS = (m?: string) => isPfMethod(m) || m === "esi";

// Uniqueness errors name the component in the way, so the fix is obvious from the message alone: the collision
// is with an existing row, and it is that row (not the edit) that has to move. Without the name, flipping a
// component's side reads as an unexplained refusal.
const dupHint = (dup: { name: string; disabled: boolean }) =>
  `"${dup.name}" already occupies it${dup.disabled ? " (disabled, but still occupying it)" : ""}; edit or delete that component first`;
const sideLabel = (kind?: string) => (kind === "employer_contribution" ? "employer" : "employee");

// A TDS component is engine-computed: it must be a deduction with a regime and no fixed rate, and there may
// be only one (a second TDS line is meaningless). `effective` is the would-be saved state after this write.
async function validateIncomeTax(deps: Deps, effective: { method?: string; kind?: string; regime?: string | null }, selfId?: string) {
  if (effective.method !== "income_tax") return;
  if (effective.kind !== "deduction") throw invalidArgument("an income-tax (TDS) component must be a deduction");
  if (!effective.regime) throw invalidArgument("an income-tax (TDS) component requires a regime");
  const dup = (await deps.db.select().from(schema.payComponents)).find((c) => c.method === "income_tax" && !c.deleteTime && c.uuid !== selfId);
  if (dup) throw invalidArgument(`only one income-tax (TDS) component may exist - ${dupHint(dup)}`);
}

// Amount hygiene: a rate is never negative, a percentage never exceeds 100, a cap is never negative. Guards a
// mis-config (e.g. a negative-rate deduction that would RAISE net pay, or a percent_base over 100%).
function validateComponentAmounts(method: string, rate: number | null | undefined, cap: number | null | undefined) {
  if (rate != null) {
    if (!Number.isFinite(rate) || rate < 0) throw invalidArgument("rate must be a non-negative number");
    if ((method === "percent_base" || isPfMethod(method) || method === "esi") && rate > 100) throw invalidArgument("a percentage rate cannot exceed 100");
  }
  if (cap != null && (!Number.isFinite(cap) || cap < 0)) throw invalidArgument("cap must be a non-negative number");
}

// EPF (provident fund): the employee share is a deduction; the employer match is an employer_contribution (a
// cost to company, never withheld from pay). Either side uses method "epf" - `rate` is the contribution %
// (defaults to 12) and `cap` the optional wage ceiling on the base. Never an earning. At most one component PER
// side, like ESI: payroll costs every employer_contribution row it finds, so a second employer line would
// silently charge the match twice.
async function validateEpf(deps: Deps, effective: { method?: string; kind?: string }, selfId?: string) {
  if (effective.method !== "epf") return;
  if (effective.kind !== "deduction" && effective.kind !== "employer_contribution")
    throw invalidArgument("an EPF component must be a deduction (employee share) or an employer_contribution (employer match)");
  const dup = (await deps.db.select().from(schema.payComponents)).find((c) => c.method === "epf" && c.kind === effective.kind && !c.deleteTime && c.uuid !== selfId);
  if (dup) throw invalidArgument(`only one EPF component may exist per ${sideLabel(effective.kind)} side - ${dupHint(dup)}`);
}

// EDLI + PF administration charges: employer-only heads (0.5% of PF wages each by default), never withheld from
// pay, and at most one component each - payroll costs every employer_contribution row it finds, so a second line
// would silently charge the levy twice.
async function validatePfCharges(deps: Deps, effective: { method?: string; kind?: string }, selfId?: string) {
  if (effective.method !== "edli" && effective.method !== "pf_admin") return;
  const label = effective.method === "edli" ? "an EDLI" : "a PF administration charges";
  if (effective.kind !== "employer_contribution")
    throw invalidArgument(`${label} component must be an employer_contribution (it is an employer levy, never withheld from pay)`);
  const dup = (await deps.db.select().from(schema.payComponents)).find((c) => c.method === effective.method && !c.deleteTime && c.uuid !== selfId);
  if (dup) throw invalidArgument(`only one ${effective.method === "edli" ? "EDLI" : "PF administration charges"} component may exist - ${dupHint(dup)}`);
}

// ESI (Employees' State Insurance): the employee share is a deduction, the employer share an
// employer_contribution (both % of gross up to a wage ceiling). At most one component PER side may exist (a
// second line on the same side is meaningless); the two sides coexist.
async function validateEsi(deps: Deps, effective: { method?: string; kind?: string }, selfId?: string) {
  if (effective.method !== "esi") return;
  if (effective.kind !== "deduction" && effective.kind !== "employer_contribution")
    throw invalidArgument("an ESI component must be a deduction (employee share) or an employer_contribution (employer share)");
  const dup = (await deps.db.select().from(schema.payComponents)).find((c) => c.method === "esi" && c.kind === effective.kind && !c.deleteTime && c.uuid !== selfId);
  if (dup) throw invalidArgument(`only one ESI component may exist per ${sideLabel(effective.kind)} side - ${dupHint(dup)}`);
}

// Professional Tax: an engine-computed employee deduction (a monthly slab on gross). Must be a deduction, and
// only one may exist. Slabs live in settings/professional-tax, so the component carries no rate.
async function validatePt(deps: Deps, effective: { method?: string; kind?: string }, selfId?: string) {
  if (effective.method !== "pt") return;
  if (effective.kind !== "deduction") throw invalidArgument("a Professional Tax component must be a deduction");
  const dup = (await deps.db.select().from(schema.payComponents)).find((c) => c.method === "pt" && !c.deleteTime && c.uuid !== selfId);
  if (dup) throw invalidArgument(`only one Professional Tax component may exist - ${dupHint(dup)}`);
}

// Two components must not reduce to the same payslip LINE CODE.
//
// Every line a run writes is matched downstream by its exact code - the statutory register, the PF ECR, the
// loss-of-pay normalisation, the payout rounding line, the payslip template's block lookups - and an ordinary
// component's code is the slug of its NAME: upper-cased, with every run of non-alphanumerics collapsed to a
// single '_' (domain/payroll.ts componentLineCode). So names that differ only in punctuation or case -
// "Travel Allowance" and "Travel-Allowance", "Fuel" and "fuel " - are ONE code for TWO heads. The run prices
// both and writes both, and anything reading a head by code then gets whichever of them came last; the two
// amounts also read as one line on the payslip. Nothing downstream can notice, because by then there is only
// one code to notice with. The catalog is the only place both names are visible, so it is where this is
// refused. Employer contributions are checked the same way - their codes are namespaced (`ER_…`) but still
// slugged from the name, so they collide among themselves on exactly the same rule.
async function validateLineCode(deps: Deps, effective: { kind?: string; method?: string; name?: string }, selfId?: string) {
  const { kind, method, name } = effective;
  if (!kind || !method || !name) return;
  const code = payComponentLineCode({ kind, method, name });
  const dup = (await deps.db.select().from(schema.payComponents)).find(
    (c) => !c.deleteTime && c.uuid !== selfId && payComponentLineCode(c) === code,
  );
  if (dup) {
    throw invalidArgument(
      `"${name}" reduces to the payslip line code "${code}", which "${dup.name}" already uses${dup.disabled ? " (disabled, but still using it)" : ""} - rename one of them`,
    );
  }
}

export const payComponentSpec: CrudSpec<PayComponentInput, typeof schema.payComponents> = {
  table: schema.payComponents,
  collection: "pay-components",
  auditName: "pay_component",
  notFound: "pay component not found",
  insert: async (input, deps) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    if (!input.kind) throw invalidArgument("kind is required");
    const method = input.method ?? "fixed";
    await validateIncomeTax(deps, { method, kind: input.kind, regime: input.regime });
    await validateEpf(deps, { method, kind: input.kind });
    await validateEsi(deps, { method, kind: input.kind });
    await validatePfCharges(deps, { method, kind: input.kind });
    await validatePt(deps, { method, kind: input.kind });
    await validateLineCode(deps, { kind: input.kind, method, name: input.display_name });
    validateComponentAmounts(
      method,
      method === "income_tax" || method === "pt" ? null : input.rate ?? null,
      CAPPED_METHODS(method) ? input.cap ?? null : null,
    );
    return {
      name: input.display_name,
      kind: input.kind,
      method,
      // TDS + Professional Tax are engine-computed (no rate); PT slabs live in settings.
      rate: method === "income_tax" || method === "pt" ? null : input.rate ?? null,
      cap: CAPPED_METHODS(method) ? input.cap ?? null : null, // wage ceiling: PF wage cap / ESI eligibility
      regime: method === "income_tax" ? input.regime?.trim() || null : null,
      recurring: input.recurring ?? true,
      // The CTC side is only a question for the employer's own contributions; everything else is inside CTC by
      // construction, so it is pinned true rather than left to say something meaningless.
      inCtc: input.kind === "employer_contribution" ? input.in_ctc ?? true : true,
      // Counting an allowance as PF wages is only meaningful for an EARNING (see pfWagesOf); pinned false
      // elsewhere so no row carries a flag its kind ignores.
      pfWages: input.kind === "earning" ? input.pf_wages ?? false : false,
    };
  },
  patch: async (patch, row, deps) => {
    const set: SetOf<typeof schema.payComponents> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "kind")) set.kind = patch.kind;
    if (has(patch, "method")) set.method = patch.method;
    if (has(patch, "rate")) set.rate = patch.rate ?? null;
    if (has(patch, "cap")) set.cap = patch.cap ?? null;
    if (has(patch, "regime")) set.regime = patch.regime?.trim() || null;
    if (has(patch, "recurring")) set.recurring = patch.recurring;
    // Validate the effective post-write state for TDS (method/kind/regime) and EPF (method/kind).
    const eff = {
      method: (has(patch, "method") ? patch.method : row.method) ?? row.method,
      kind: (has(patch, "kind") ? patch.kind : row.kind) ?? row.kind,
      regime: has(patch, "regime") ? patch.regime?.trim() || null : row.regime,
      // The NAME is part of the effective state too, because it is what the line code is slugged from: a
      // rename is exactly how a collision gets introduced into a catalog that had none.
      name: (has(patch, "display_name") ? patch.display_name : row.name) ?? row.name,
    };
    await validateIncomeTax(deps, eff, row.uuid);
    await validateEpf(deps, eff, row.uuid);
    await validateEsi(deps, eff, row.uuid);
    await validatePfCharges(deps, eff, row.uuid);
    await validatePt(deps, eff, row.uuid);
    await validateLineCode(deps, eff, row.uuid);
    const effRate = has(patch, "rate") ? patch.rate ?? null : row.rate;
    const effCap = has(patch, "cap") ? patch.cap ?? null : row.cap;
    validateComponentAmounts(
      eff.method,
      eff.method === "income_tax" || eff.method === "pt" ? null : effRate,
      CAPPED_METHODS(eff.method) ? effCap : null,
    );
    if (eff.method === "income_tax") { set.rate = null; set.regime = eff.regime; } // TDS: engine-computed, regime-driven
    if (eff.method === "pt") set.rate = null; // Professional Tax is slab-computed (settings), never a rate
    if (!CAPPED_METHODS(eff.method)) set.cap = null; // cap = PF wage ceiling / ESI eligibility ceiling
    // CTC side: settable only while the component IS an employer contribution. Flipping a contribution to an
    // earning/deduction resets it to "inside CTC", so a row can never carry an outside-CTC flag its kind ignores.
    if (eff.kind === "employer_contribution") { if (has(patch, "in_ctc")) set.inCtc = patch.in_ctc ?? true; }
    else if (has(patch, "in_ctc") || (has(patch, "kind") && row.kind === "employer_contribution")) set.inCtc = true;
    // PF-wage flag: settable only while the component IS an earning; flipping the kind clears it.
    if (eff.kind === "earning") { if (has(patch, "pf_wages")) set.pfWages = patch.pf_wages ?? false; }
    else if (has(patch, "pf_wages") || (has(patch, "kind") && row.kind === "earning")) set.pfWages = false;
    return set;
  },
};

export const {
  create: createPayComponent,
  update: updatePayComponent,
} = crudService(payComponentSpec);
