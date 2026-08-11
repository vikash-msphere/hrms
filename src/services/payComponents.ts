import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { assertNotLocked } from "./lifecycle";

export type PayComponentInput = {
  display_name?: string;
  kind?: "earning" | "deduction" | "employer_contribution"; // same set the column stores (db/schema.ts)
  method?: "fixed" | "percent_base" | "rate_qty" | "income_tax" | "epf" | "esi" | "pt" | "edli" | "pf_admin";
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

export async function listPayComponents(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.payComponents), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getPayComponent(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.payComponents).where(eq(schema.payComponents.uuid, id)).limit(1))[0];
  if (!row) throw notFound("pay component not found");
  return row;
}

export async function createPayComponent(deps: Deps, actor: AppUser, input: PayComponentInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  if (!input.kind) throw invalidArgument("kind is required");
  const method = input.method ?? "fixed";
  await validateIncomeTax(deps, { method, kind: input.kind, regime: input.regime });
  await validateEpf(deps, { method, kind: input.kind });
  await validateEsi(deps, { method, kind: input.kind });
  await validatePfCharges(deps, { method, kind: input.kind });
  await validatePt(deps, { method, kind: input.kind });
  validateComponentAmounts(
    method,
    method === "income_tax" || method === "pt" ? null : input.rate ?? null,
    CAPPED_METHODS(method) ? input.cap ?? null : null,
  );
  const row = (await deps.db
    .insert(schema.payComponents)
    .values({
      ...(id ? { id } : {}),
      code: await allocFlatCode(deps, schema.payComponents),
      name: input.display_name,
      kind: input.kind,
      method,
      // TDS + Professional Tax are engine-computed (no rate); PT slabs live in settings.
      rate: method === "income_tax" || method === "pt" ? null : input.rate ?? null,
      cap: CAPPED_METHODS(method) ? input.cap ?? null : null, // wage ceiling: PF wage cap / ESI eligibility
      regime: method === "income_tax" ? input.regime ?? null : null,
      recurring: input.recurring ?? true,
      // The CTC side is only a question for the employer's own contributions; everything else is inside CTC by
      // construction, so it is pinned true rather than left to say something meaningless.
      inCtc: input.kind === "employer_contribution" ? input.in_ctc ?? true : true,
      // Counting an allowance as PF wages is only meaningful for an EARNING (see pfWagesOf); pinned false
      // elsewhere so no row carries a flag its kind ignores.
      pfWages: input.kind === "earning" ? input.pf_wages ?? false : false,
    })
    .returning())[0]!;
  await audit(deps, actor, "pay_component.create", "pay-components", row.uuid, undefined, row);
  return row;
}

export async function updatePayComponent(deps: Deps, actor: AppUser, id: string, patch: PayComponentInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.payComponents).where(eq(schema.payComponents.uuid, id)).limit(1))[0];
  if (!row) throw notFound("pay component not found");
  assertNotLocked(row);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof PayComponentInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("kind")) set.kind = patch.kind;
  if (has("method")) set.method = patch.method;
  if (has("rate")) set.rate = patch.rate ?? null;
  if (has("cap")) set.cap = patch.cap ?? null;
  if (has("regime")) set.regime = patch.regime ?? null;
  if (has("recurring")) set.recurring = patch.recurring;
  // Validate the effective post-write state for TDS (method/kind/regime) and EPF (method/kind).
  const eff = {
    method: (has("method") ? patch.method : row.method) ?? row.method,
    kind: (has("kind") ? patch.kind : row.kind) ?? row.kind,
    regime: has("regime") ? patch.regime ?? null : row.regime,
  };
  await validateIncomeTax(deps, eff, id);
  await validateEpf(deps, eff, id);
  await validateEsi(deps, eff, id);
  await validatePfCharges(deps, eff, id);
  await validatePt(deps, eff, id);
  const effRate = has("rate") ? patch.rate ?? null : row.rate;
  const effCap = has("cap") ? patch.cap ?? null : row.cap;
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
  if (eff.kind === "employer_contribution") { if (has("in_ctc")) set.inCtc = patch.in_ctc ?? true; }
  else if (has("in_ctc") || (has("kind") && row.kind === "employer_contribution")) set.inCtc = true;
  // PF-wage flag: settable only while the component IS an earning; flipping the kind clears it.
  if (eff.kind === "earning") { if (has("pf_wages")) set.pfWages = patch.pf_wages ?? false; }
  else if (has("pf_wages") || (has("kind") && row.kind === "earning")) set.pfWages = false;
  const updated = (await deps.db.update(schema.payComponents).set(set).where(eq(schema.payComponents.uuid, id)).returning())[0]!;
  await audit(deps, actor, "pay_component.update", "pay-components", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deletePayComponent(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.payComponents, "pay_component", "pay-components", id, ifMatch);
}

export async function restorePayComponent(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.payComponents, "pay_component", "pay-components", id);
}

export async function purgePayComponent(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.payComponents, "pay_component", "pay-components", id, ifMatch);
}
