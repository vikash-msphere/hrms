import { allocOwnedCode } from "./codeAlloc";
import { has } from "./crud";
import { and, eq, isNull, isNotNull, inArray, sql, type SQL } from "drizzle-orm";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import { applyStructure, ctcLines, splitCtc, pfWagesOf, employerCostLines, ONE_OFF_EARNING_CODES, DEFAULT_CTC_CONFIG, type CtcConfig } from "../domain/payroll";
import { esiEmployeeContribution, professionalTax, DEFAULT_PT_CONFIG, type PtConfig } from "../domain/statutory";
import { round2 } from "../domain/money";
import { structureLinesById } from "./salaryStructures";
import { monthlyRecurringGross } from "./taxProjection";
import { getSettingValue, orgCurrency } from "./settings";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditMany, diffMeta } from "../lib/audit";
import { runBatch, runBatchChecked, byIdChunks, type BatchStmt } from "../lib/dbBatch";
import { genId } from "../lib/idCodec";
import { etagOf } from "../http/serialize";
import { invalidArgument, notFound, failedPrecondition, aborted, isOpenTimelineCollision } from "../lib/errors";
import { notify } from "./notifications";
import { refPayComponents, refPayPeriods, refPayGrades, refSalaryStructures } from "../lib/refData";

// Effective-dated base pay. A salary revision (increment/appraisal) is a NEW row effective from a chosen date;
// the previously-current row is closed (effective_to set). Payroll prices each period at the row effective
// during it (period-effective), and a backdated raise's delta for already-published periods is paid as arrears.
//
// The timeline is the model, and it is EDITABLE: a revision can be added at any date (including into the
// middle of the history, not only after the current row), corrected in place, or removed. History is not
// preserved by refusing to write - it is preserved by the audit log, which records the before/after of every
// one of those writes. A salary entered wrong is a mistake, and a mistake you cannot correct is a worse
// record than a corrected one.
//
// Every write goes through the same three-step shape, and nothing else may touch `effective_from`/`effective_to`:
//   1. read the employee's LIVE timeline (oldest first; rows are contiguous half-open intervals),
//   2. locate the row's slot in it (`prev` = the revision it supersedes, `next` = the one that supersedes it),
//   3. write the row, then re-point exactly one neighbour's `effective_to` so the chain stays contiguous.
// `prev` is also what prices the retro arrears: it is the rate the already-published periods were paid at.

// One-off payments a run carries alongside the regular monthly wage. They are not part of the recurring rate a
// raise moves, so they never count toward how much of a month was paid at the old rate.
// Moved to domain/payroll.ts: services/lopAdjustments.ts asks the same question of the same lines, and the
// copy there had already gained `LOPADJ` while this one had not.

// How many MONTH-EQUIVALENTS of regular wage this employee was ALREADY PAID at the old rate inside
// [fromMs, toMs). Drives backdated-increment arrears: only PUBLISHED periods are immutable and priced at the
// old rate, so only they are owed the delta - unpublished/future periods get the new rate from period-effective
// pricing and must NOT be counted (that would double-pay the raise).
//
// This is a weight, not a count. Counting whole periods over-paid the delta three ways: a mid-period joiner or
// leaver was paid a fraction of the month but credited a full month of arrears, a month with loss of pay was
// credited as if fully worked, and a raise effective mid-period was back-paid from the period start. Each
// period therefore contributes:
//   (regular wage actually paid that period / the old full monthly rate) x (the share of the period on or after
//   the effective date)
// The first factor comes from the run's own stored lines - the regular earnings including the negative
// loss-of-pay line - so it reflects exactly what the payslip paid, whatever prorated or docked it.
/** One already-published period a backdated raise owes a delta for. `months` is the month-EQUIVALENT credited
 *  for it, which is a fraction wherever the period was part-worked, docked or only partly inside the backdated
 *  window - so the employee can see that a half month is being paid as half a month rather than wonder. */
export type ArrearsPeriod = { label: string; months: number };

async function publishedRegularMonthsPaid(deps: Deps, employeeId: string, fromMs: number, toMs: number, oldMonthlyGross: number): Promise<{ months: number; periods: ArrearsPeriod[] }> {
  const none = { months: 0, periods: [] as ArrearsPeriod[] };
  if (!(oldMonthlyGross > 0)) return none;
  const items = await deps.db.select().from(schema.payrollRunItems).where(eq(schema.payrollRunItems.employeeId, employeeId));
  if (!items.length) return none;
  const itemByRun = new Map(items.map((it) => [it.runId, it]));
  const periods = new Map((await refPayPeriods(deps)).map((p) => [p.uuid, p]));
  let months = 0;
  // The per-period detail, which this loop already computes and used to discard. An employee shown one arrears
  // figure has no way to check it; shown the months it covers, they can. Collected here because this is the
  // only place that knows which published periods were in the window and what share of each was credited.
  const periods_: ArrearsPeriod[] = [];
  // Only the runs this employee actually has an item in: every other run is skipped below anyway, so reading
  // the whole table grew this query with the org's payroll history for nothing.
  //
  // Chunked, because the list is one id per run this person has ever been paid by - it grows a row a month for
  // as long as they stay, so it crosses D1's hundred-parameter cap after eight years and then stays broken.
  const runs = await byIdChunks([...itemByRun.keys()], (group) =>
    deps.db.select().from(schema.payrollRuns).where(inArray(schema.payrollRuns.uuid, group)),
  );
  for (const r of runs) {
    const it = itemByRun.get(r.uuid);
    if (r.state !== "PUBLISHED" || !it) continue;
    const p = periods.get(r.payPeriodId);
    if (!p) continue;
    const ps = +new Date(p.periodStart);
    const pe = +new Date(p.periodEnd);
    if (pe < fromMs || ps >= toMs) continue; // wholly outside the backdated window
    let regular = 0;
    let sawEarning = false;
    try {
      for (const l of JSON.parse(it.linesJson) as { code?: string; kind?: string; amount?: number }[]) {
        if (l.kind !== "earning" || ONE_OFF_EARNING_CODES.has(l.code ?? "")) continue;
        sawEarning = true;
        regular += l.amount ?? 0; // the loss-of-pay line is a NEGATIVE earning, so docking nets out here
      }
    } catch {
      continue; // an unreadable item states nothing about what was paid; crediting a full month would over-pay
    }
    // An item with no earning lines at all carries no breakdown to read (a hand-written row, or one stored
    // before lines were). Its own gross is then the only statement of what the period paid - a docked or
    // prorated month still shows up in it, so it is a sound fallback where the lines are simply absent.
    if (!sawEarning) regular = it.gross;
    const paidShare = Math.max(0, Math.min(1, regular / oldMonthlyGross));
    // The share of the period on or after the effective date: a raise effective mid-period is owed only the
    // remainder of that period, not the whole of it.
    const periodDays = Math.max(1, Math.round((pe - ps) / 86_400_000) + 1);
    const coveredFrom = Math.max(ps, fromMs);
    const coveredDays = Math.max(0, Math.round((Math.min(pe, toMs - 1) - coveredFrom) / 86_400_000) + 1);
    const credited = paidShare * Math.min(1, coveredDays / periodDays);
    months += credited;
    if (credited > 0) periods_.push({ label: p.label, months: round2(credited) });
  }
  // Oldest first, so the list reads as a history rather than in whatever order the runs came back.
  periods_.sort((a, b) => a.label.localeCompare(b.label));
  return { months: round2(months), periods: periods_ };
}
export type CompensationInput = {
  employee?: string | null;
  annual_ctc?: number; // the authoritative figure; the server derives the monthly basic + Special Allowance
  // Target variable pay for a full year at 100% attainment. Separate from CTC on purpose: CTC is committed
  // pay, and a figure that has to be earned is not committed. Feeds review-cycles:variablePay.
  variable_pay_target?: number | null;
  currency_code?: string;
  pay_grade?: string | null;
  salary_structure?: string | null;
  effective_from?: string; // YYYY-MM-DD
};
/** PATCH body: correcting a revision that was entered wrong. Every field is optional; absent = leave alone. */
export type CompensationPatch = Omit<CompensationInput, "employee">;
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s ? Date.parse(s + "T00:00:00Z") : NaN);
const ymd = (d: Date | number) => new Date(d).toISOString().slice(0, 10);

type CompRow = typeof schema.compensation.$inferSelect;

/**
 * One employee's LIVE revisions, oldest first - the timeline every write below reasons about. Soft-deleted
 * rows are excluded here and nowhere else matters: a removed revision is out of the chain, so it must not be
 * a `prev` that prices arrears, a `next` that bounds a date, or the row payroll finds effective for a period.
 */
async function timelineOf(deps: Deps, employeeId: string): Promise<CompRow[]> {
  const rows = await deps.db
    .select()
    .from(schema.compensation)
    .where(and(eq(schema.compensation.employeeId, employeeId), isNull(schema.compensation.deleteTime)));
  return rows.sort((a, b) => +new Date(a.effectiveFrom) - +new Date(b.effectiveFrom) || a.uuid.localeCompare(b.uuid));
}

/** The slot a revision effective at `fromMs` occupies in `timeline` (which must not contain the row itself). */
function slotAt(timeline: CompRow[], fromMs: number) {
  const prev = [...timeline].reverse().find((r) => +new Date(r.effectiveFrom) < fromMs);
  const next = timeline.find((r) => +new Date(r.effectiveFrom) > fromMs);
  return { prev, next };
}

/**
 * The split this CTC resolves to, and the retro arrears the revision owes.
 *
 * Arrears are the rise in MONTHLY RECURRING GROSS (basic + recurring earnings + the Special Allowance plug)
 * over the periods this employee was ALREADY PAID at `prev`'s rate inside the revision's own window
 * `[fromMs, untilMs)`. `untilMs` is where the revision stops governing - the NEXT revision's start, or now:
 * a correction inserted into the middle of the history owes the delta only up to the revision that superseded
 * it, because everything after that was paid at the later rate. Only published periods need arrears (payroll
 * prices an unpublished one at the row effective then), and only positive deltas: a backdated cut is not
 * auto-recovered. No `prev` = no rate to owe a delta against, so no arrears.
 */
async function priceRevision(
  deps: Deps,
  employeeId: string,
  epfEnrolled: boolean,
  annualCtc: number,
  structureId: string | null,
  fromMs: number,
  untilMs: number,
  prev: CompRow | undefined,
) {
  // Derive the monthly basic + Special Allowance plug from the authoritative annual CTC: pin basic at
  // ctc.basic_pct% of the monthly CTC and solve the plug that makes this employee's full CTC (structure
  // earnings + employer PF/ESI/gratuity) land on the target - the same math letters and the comp tab render,
  // so the figures never drift. getSettingValue merges over DEFAULT_CTC_CONFIG, so a stored ctc setting
  // predating basic_pct still resolves to a full config.
  const cfg = await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG);
  const components = (await refPayComponents(deps)).filter((c) => !c.disabled && !c.deleteTime);
  const effective = applyStructure(components, await structureLinesById(deps, structureId));
  const split = splitCtc(annualCtc / 12, effective, epfEnrolled, cfg);
  if (!split) throw invalidArgument("annual_ctc is too low for this structure: basic + fixed components already exceed it. Raise the CTC, lower ctc.basic_pct, or trim component rates.");
  const { basePay, specialAllowance } = split;
  const prevEffective = prev ? applyStructure(components, await structureLinesById(deps, prev.structureId)) : [];
  const oldGross = prev ? monthlyRecurringGross(prev.basePay, prevEffective, prev.specialAllowance) : 0;
  const newGross = monthlyRecurringGross(basePay, effective, specialAllowance);
  // Month-EQUIVALENTS already paid at the old rate, not a period count: a part-month or docked period owes only
  // the delta on the wage it actually paid.
  const paid = prev ? await publishedRegularMonthsPaid(deps, employeeId, fromMs, untilMs, oldGross) : { months: 0, periods: [] };
  const paidMonths = paid.months;
  // The PF-wage slice of those arrears: the rise in BASIC (plus, under the "basic_plus" wage basis, the same
  // allowances PF counts) over the same months. PF is due on arrears of basic wages while ESI is due on the whole
  // amount, so the run needs the two figures apart - deriving it later from a single lump is guesswork.
  const pfBasis = cfg.pf_wage_basis ?? "basic";
  const oldPfWages = prev ? pfWagesOf(prev.basePay, prev.specialAllowance, prevEffective, pfBasis) : 0;
  const newPfWages = pfWagesOf(basePay, specialAllowance, effective, pfBasis);
  return {
    basePay,
    specialAllowance,
    arrearsAmount: paidMonths > 0 ? Math.max(0, round2((newGross - oldGross) * paidMonths)) : 0,
    arrearsBaseAmount: paidMonths > 0 ? Math.max(0, round2((newPfWages - oldPfWages) * paidMonths)) : 0,
    // The same figure, broken out by the period each part of it is owed for. Priced at the SAME monthly delta
    // the total uses, so the parts sum to the total by construction rather than by a second calculation that
    // could disagree with it. Frozen here with the amount: `paidMonths` is a statement about which periods were
    // published at the moment of the revision, and recomputing it later - once more runs have published - would
    // silently restate what an already-paid arrear covered.
    arrearsPeriods: paidMonths > 0 && newGross > oldGross
      ? paid.periods.map((pr) => ({ label: pr.label, months: pr.months, amount: round2((newGross - oldGross) * pr.months) }))
      : [],
  };
}

/** Resolve + validate the two optional catalog references a revision may carry. */
async function refsOf(deps: Deps, input: { pay_grade?: string | null; salary_structure?: string | null }) {
  const payGradeId = idFromPath(input.pay_grade) ?? null;
  if (payGradeId) {
    const grade = (await deps.db.select().from(schema.payGrades).where(eq(schema.payGrades.uuid, payGradeId)).limit(1))[0];
    if (!grade || grade.deleteTime) throw notFound("pay grade not found");
  }
  const structureId = idFromPath(input.salary_structure) ?? null;
  if (structureId) {
    const st = (await deps.db.select().from(schema.salaryStructures).where(eq(schema.salaryStructures.uuid, structureId)).limit(1))[0];
    if (!st || st.deleteTime) throw notFound("salary structure not found");
  }
  return { payGradeId, structureId };
}

// Decorate compensation rows with their pay grade (name + band, for compa-ratio/in-band) and salary-structure
// name, so the serializer can render them.
//
// Both catalogs come from lib/refData, NOT from a select here. They are read whole either way - resolving a
// handful of stored foreign keys to names is what they are for, and an `inArray` of the ids on a full page
// would spend most of the D1 parameter cap to read the same small table - so the question is only whether the
// read is memoized for the request. It was not, and these were the only two reference tables in the app that
// were not: this function runs on every compensation list, get, create and update, a `batch:run` shares one
// Deps across its sub-requests, and the custom grid's `comp` source needs the same two maps. So a batch
// carrying several compensation reads paid both catalogs once per sub-request, on the one surface that reads
// them most. Now it pays them once, like every other catalog the money path touches.
async function withGrades<T extends { payGradeId: string | null; structureId: string | null }>(deps: Deps, rows: T[]) {
  const gradeIds = new Set(rows.map((r) => r.payGradeId).filter(Boolean) as string[]);
  const structIds = new Set(rows.map((r) => r.structureId).filter(Boolean) as string[]);
  if (!gradeIds.size && !structIds.size) return rows;
  const grades = gradeIds.size ? new Map((await refPayGrades(deps)).filter((g) => gradeIds.has(g.uuid)).map((g) => [g.uuid, g])) : new Map();
  const structs = structIds.size ? new Map((await refSalaryStructures(deps)).filter((s) => structIds.has(s.uuid)).map((s) => [s.uuid, s])) : new Map();
  return rows.map((r) => ({
    ...r,
    ...(r.payGradeId ? { grade: grades.get(r.payGradeId) } : {}),
    ...(r.structureId ? { structure: structs.get(r.structureId) } : {}),
  }));
}

// Self-service shaping + the CTC build-up, on the one path every compensation answer passes through (the
// factory's `decorate`, so an item read and a list are shaped identically).
//
// A caller whose breadth is `own` is reading their OWN pay (My Profile). They see the CTC, its build-up and
// their revision history - but NOT the pay grade, band or compa-ratio: where a salary sits against the ladder
// is HR's comparative guardrail, not a fact about this employee's pay.
//
// The build-up comes from the domain `ctcLines`, the same pricing the CTC letter and the payroll run use, so
// nothing re-derives the split client-side. It needs the pay-component catalog, the org's PF wage basis and
// this row's salary structure - none of which an employee may read - so the server prices it. Only a
// single-employee read pays for those lookups; an org-wide list would otherwise spend them per employee.
export async function decorateCompensation(deps: Deps, _actor: AppUser, rows: any[], scope: ListScope | undefined) {
  const self = scope?.breadth === "own"; // the middleware's verdict, bound here - nothing is decided in this file
  const shaped = self ? rows.map((r) => ({ ...r, payGradeId: null, structureId: null, grade: undefined, structure: undefined })) : rows;
  const current = rows.find((r) => !r.effectiveTo);
  if (new Set(rows.map((r) => r.employeeId)).size !== 1 || !current) return shaped;
  const emp = (await deps.db.select({ epfEnrolled: schema.employees.epfEnrolled }).from(schema.employees).where(eq(schema.employees.uuid, current.employeeId)).limit(1))[0];
  const components = await refPayComponents(deps);
  const pfBasis = (await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG)).pf_wage_basis ?? "basic";
  const ctc = ctcLines(
    current.basePay,
    applyStructure(components, await structureLinesById(deps, current.structureId)),
    !!emp?.epfEnrolled,
    current.specialAllowance,
    pfBasis,
  );
  return shaped.map((r, i) => (rows[i] === current ? { ...r, ctc } : r));
}

// One employee's salary history (newest first), or - unfiltered - everything the caller may see. Removed
// revisions are out of the timeline, so they are excluded unless the caller asked for the trash (`?show_deleted`
// / `?deleted_only`) - the same three states the generic list offers.
// PAGED IN SQL, on `effective_from`, exactly like its twin `positions` (same page, same key, same
// employee-history shape). One employee's timeline is short by nature, but the UNFILTERED list is org-wide and
// grows with headcount x every increment, correction and CTC re-split the org ever records - each row then
// widened by `withGrades` and the CTC build-up - and it used to return all of it with
// `nextPageToken: undefined`, so the client was told it held everything while the only thing truncating the
// answer was the Worker's memory. compensation is the bigger and wider of the two; positions was converted for
// this and settlements and bonuses say the same thing in their own words.
export async function listCompensation(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employeeId?: string, showDeleted = false, deletedOnly = false) {
  const conds = [applyScope(scope, schema.compensation.code, schema.compensation.employeeId)];
  if (employeeId) conds.push(eq(schema.compensation.employeeId, employeeId));
  if (deletedOnly) conds.push(isNotNull(schema.compensation.deleteTime));
  else if (!showDeleted) conds.push(isNull(schema.compensation.deleteTime));
  const where = conds.filter(Boolean).length ? and(...(conds.filter(Boolean) as SQL[])) : undefined;
  const page = await keysetPage<typeof schema.compensation.$inferSelect>(deps, schema.compensation, "compensation", where, {
    max: maxPageSize,
    pageToken,
    order: { expr: sql`${schema.compensation.effectiveFrom}`, value: (r) => +new Date(r.effectiveFrom) },
  });
  // The grade/structure decoration is applied to the PAGE, not to the whole table - which is the other half of
  // what this cost: it reads pay grades and salary structures per row's references.
  return { items: await withGrades(deps, page.items), nextPageToken: page.nextPageToken };
}

export async function getCompensation(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.uuid, id)).limit(1))[0];
  if (!row) throw notFound("compensation record not found");
  return (await withGrades(deps, [row]))[0]!;
}

/**
 * Add a revision to the timeline at `effective_from`, wherever that falls.
 *
 * The usual case is the next increment - a date after the current row, which closes it and opens a new
 * current one. But a salary that was never entered, or entered a year late, belongs in the MIDDLE of the
 * history: that inserts between two existing revisions, closes the one before it at the new date, and ends at
 * the one after it (which keeps governing from its own date on, untouched). Both are the same operation on
 * the same chain; only which neighbour exists differs.
 */
// ---- Revision preview (item 32) --------------------------------------------------------------------------

/** One side of a revision comparison: what the employee's REGULAR month looks like at that CTC. */
export type RevisionSide = {
  annualCtc: number;
  monthlyGross: number;
  basePay: number;
  specialAllowance: number;
  pfWages: number;
  employeePf: number;
  employeeEsi: number;
  professionalTax: number;
  employerCost: number;      // employer contributions counted INSIDE CTC
  aboveCtcCost: number;      // employer contributions the org pays over and above CTC
  lines: { name: string; monthly: number; aboveCtc?: boolean }[];
};

export type RevisionPreview = {
  current: RevisionSide | null;  // null for an employee with no compensation row yet
  proposed: RevisionSide;
  /** Arrears this revision would owe if saved now, and the periods they cover - the same pricing the save
   *  performs, so the preview cannot promise a different figure from the one that lands. */
  arrears: { amount: number; periods: ArrearsPeriod[] };
  /** Statutory boundaries this revision crosses. These produce the counter-intuitive outcomes - a raise that
   *  moves take-home the wrong way - and they are the reason a preview is worth having at all. */
  crossings: string[];
};

/**
 * The statutory boundaries a revision crosses, in plain words.
 *
 * These are the whole reason a preview earns its place. Most of a raise is arithmetic anybody can do in their
 * head; the surprises live at the thresholds, where a rise in CTC can LOWER take-home - crossing the ESI
 * ceiling removes the employee's contribution but also the employer's, so the CTC the raise bought is not the
 * pay the employee sees, and someone has to be able to explain that in the conversation rather than after the
 * payslip.
 *
 * Sentences rather than flags, because every one of them needs saying out loud to a person. A caller that
 * wanted to branch on them would be making a decision this file has no business encoding.
 */
function crossingsBetween(current: RevisionSide | null, proposed: RevisionSide): string[] {
  if (!current) return [];
  const out: string[] = [];
  if (current.employeeEsi > 0 && proposed.employeeEsi === 0) {
    out.push("This takes the employee above the ESI wage ceiling: their ESI contribution stops, and so does the employer's, so cover ends with it.");
  }
  if (current.employeeEsi === 0 && proposed.employeeEsi > 0) {
    out.push("This brings the employee under the ESI wage ceiling, so ESI starts being deducted.");
  }
  // PF wages capped at the ceiling means a rise in basic stops adding to PF once it is past - the raise is
  // real, the retirement saving it buys is not.
  if (proposed.pfWages > current.pfWages && proposed.employeePf === current.employeePf && current.employeePf > 0) {
    out.push("PF wages are already at the ceiling, so this raise adds nothing to the PF contribution on either side.");
  }
  if (proposed.professionalTax !== current.professionalTax) {
    out.push(`Professional tax moves from ${current.professionalTax} to ${proposed.professionalTax} a month (the slab before any annual cap).`);
  }
  // The headline sanity check, and the one nobody expects to fire.
  const currentTakeHome = round2(current.monthlyGross - current.employeePf - current.employeeEsi - current.professionalTax);
  const proposedTakeHome = round2(proposed.monthlyGross - proposed.employeePf - proposed.employeeEsi - proposed.professionalTax);
  if (proposed.annualCtc > current.annualCtc && proposedTakeHome < currentTakeHome) {
    out.push(`CTC goes up but regular monthly take-home goes DOWN, from ${currentTakeHome} to ${proposedTakeHome}, before tax.`);
  }
  return out;
}

/**
 * What a proposed revision would do, priced but not written.
 *
 * Runs the SAME `priceRevision` the save runs, so the arrears figure and the split cannot differ between what
 * somebody is shown and what they then commit. Everything else is assembled from the same domain helpers the
 * payroll run and the CTC letter use (`splitCtc`, `ctcLines`, `pfWagesOf`, `esiEmployeeContribution`,
 * `professionalTax`), which is what keeps this from becoming a second, drifting definition of what a salary is.
 *
 * WHAT THIS DELIBERATELY DOES NOT SHOW, because a number that will not match the payslip is worse than no
 * number on a conversation about somebody's pay:
 *
 *   TDS. Withholding depends on the employee's verified declarations and on what the year has already
 *   collected, so a projection against a hypothetical salary would differ from what the run actually withholds
 *   - and it would differ by more for the people whose declarations are still unverified.
 *
 *   PERIOD EFFECTS. Loss of pay, one-offs, loan recovery and the annual PT cap are facts about a MONTH, not
 *   about a salary. This prices a full regular month at the new rate, which is the question a revision is
 *   actually asking. The professional tax shown is the monthly slab for the new wage BEFORE any annual cap.
 */
export async function previewRevision(deps: Deps, input: CompensationInput): Promise<RevisionPreview> {
  const employeeId = idFromPath(input.employee);
  const from = dayMs(input.effective_from);
  if (!employeeId) throw invalidArgument("employee is required");
  const annualCtc = input.annual_ctc;
  if (typeof annualCtc !== "number" || annualCtc <= 0) throw invalidArgument("annual_ctc must be greater than 0");
  if (Number.isNaN(from)) throw invalidArgument("effective_from is required");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");
  const { structureId } = await refsOf(deps, input);

  const timeline = await timelineOf(deps, employeeId);
  const { prev, next } = slotAt(timeline, from);
  const nowMs = +deps.clock.now();
  const until = Math.min(nowMs, next ? +new Date(next.effectiveFrom) : nowMs);
  const priced = await priceRevision(deps, employeeId, emp.epfEnrolled, annualCtc, structureId, from, until, prev);

  const cfg = await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG);
  const components = (await refPayComponents(deps)).filter((c) => !c.disabled && !c.deleteTime);
  const pfBasis = cfg.pf_wage_basis ?? "basic";
  // PT lives in its own blob, not in `ctc` - the same one services/payroll.ts reads, so the slab shown here is
  // the slab the run will charge.
  const ptCfg = await getSettingValue<PtConfig>(deps, "professional-tax", DEFAULT_PT_CONFIG);
  const side = async (basePay: number, specialAllowance: number, ctc: number, sId: string | null): Promise<RevisionSide> => {
    const effective = applyStructure(components, await structureLinesById(deps, sId));
    const { lines } = ctcLines(basePay, effective, emp.epfEnrolled, specialAllowance, pfBasis);
    const monthlyGross = monthlyRecurringGross(basePay, effective, specialAllowance);
    const pfWages = pfWagesOf(basePay, specialAllowance, effective, pfBasis);
    const employerCosts = employerCostLines(basePay, round2(monthlyGross), effective, emp.epfEnrolled, undefined, pfWages);
    const epfComp = effective.find((c) => c.method === "epf" && c.kind === "deduction");
    const esiComp = effective.find((c) => c.method === "esi" && c.kind === "deduction");
    const ptComp = effective.find((c) => c.method === "pt");
    const esiCeiling = esiComp?.cap ?? 21000;
    return {
      annualCtc: ctc,
      monthlyGross: round2(monthlyGross),
      basePay: round2(basePay),
      specialAllowance: round2(specialAllowance),
      pfWages: round2(pfWages),
      // The employee's own PF, at the component's configured rate on PF wages capped at its ceiling - the same
      // shape services/payroll.ts prices it with.
      employeePf: epfComp ? round2(Math.min(pfWages, epfComp.cap ?? Infinity) * ((epfComp.rate ?? 12) / 100)) : 0,
      // ESI only while the wage is within the ceiling. The run's stickiness rule (already contributing earlier
      // in the contribution period keeps you in until it ends) is a fact about a PERIOD, not about a salary, so
      // a preview that applied it would be answering a different question.
      employeeEsi: esiComp && monthlyGross > 0 && monthlyGross <= esiCeiling
        ? esiEmployeeContribution(monthlyGross, esiComp.rate ?? 0.75, Infinity) : 0,
      // The monthly slab for this wage, BEFORE the annual cap - the cap depends on what the year has already
      // collected, which is a period fact and not a property of the salary.
      professionalTax: ptComp ? round2(professionalTax(monthlyGross, ptCfg)) : 0,
      // Split by which side of CTC each contribution sits on, from the same helper the run and the letter use.
      employerCost: round2(employerCosts.filter((ec) => !ec.aboveCtc).reduce((sum, ec) => sum + ec.monthly, 0)),
      aboveCtcCost: round2(employerCosts.filter((ec) => ec.aboveCtc).reduce((sum, ec) => sum + ec.monthly, 0)),
      lines: lines.map((l) => ({ name: l.name, monthly: l.monthly, ...(l.aboveCtc ? { aboveCtc: true } : {}) })),
    };
  };

  const proposed = await side(priced.basePay, priced.specialAllowance, annualCtc, structureId);
  const current = prev ? await side(prev.basePay, prev.specialAllowance, prev.ctcAnnual, prev.structureId) : null;

  return { current, proposed, arrears: { amount: priced.arrearsAmount, periods: priced.arrearsPeriods }, crossings: crossingsBetween(current, proposed) };
}

// ---- The increment cycle (item 33) -----------------------------------------------------------------------

/**
 * How many people one increment batch may carry.
 *
 * NOT a taste judgement. `previewRevision` costs a handful of D1 reads per person - the timeline, the
 * published run items the arrears are priced off, the structure lines - and a Worker invocation has a
 * subrequest ceiling. An unbounded batch would work for a team and fail for a department, which is the worst
 * shape a limit can have: it passes every test somebody writes and breaks on the day it is used for real.
 * Twenty-five covers a team, which is the unit an increment round is actually decided in; a whole-org round
 * is several batches, and the caller is told so rather than being given a truncated answer.
 */
export const MAX_INCREMENT_BATCH = 25;

/** One proposed increment. The same fields a single revision takes, per person. */
export type IncrementLine = {
  employee?: string | null;
  annual_ctc?: number;
  effective_from?: string;
  pay_grade?: string | null;
  salary_structure?: string | null;
};

export type IncrementPreviewRow = {
  employee: string;
  /** Null when this line could not be priced - the reason is in `error`, and the rest of the batch is
   *  unaffected. One bad row must not cost the reviewer the other twenty-four. */
  preview: RevisionPreview | null;
  error: string | null;
};

export type IncrementPreview = {
  rows: IncrementPreviewRow[];
  /** What the round costs, summed over the rows that priced. Annual CTC is the figure a budget is set in;
   *  monthly gross is what the next run actually pays. */
  totals: { people: number; priced: number; annualCtcDelta: number; monthlyGrossDelta: number; arrears: number; crossings: number };
};

/**
 * Price a whole increment round without writing any of it.
 *
 * This is the surface that replaces the spreadsheet: the per-person figures, what the round costs in total,
 * and every statutory boundary it crosses, before anybody commits. Each row goes through the SAME
 * `previewRevision` a single raise uses, so nothing here can disagree with what one person's preview says.
 *
 * A row that cannot be priced - no employee, a CTC too low for the structure, a revision already on that date
 * - reports its reason and leaves the others alone. A batch that failed wholesale because one person's
 * structure does not fit would be useless for the job it exists for.
 */
export async function previewIncrementBatch(deps: Deps, lines: readonly IncrementLine[]): Promise<IncrementPreview> {
  if (!lines.length) throw invalidArgument("no increments to price");
  if (lines.length > MAX_INCREMENT_BATCH) {
    throw invalidArgument(`an increment batch carries at most ${MAX_INCREMENT_BATCH} people; split the round and run it again`);
  }
  const rows: IncrementPreviewRow[] = [];
  for (const line of lines) {
    const employee = line.employee ?? "";
    try {
      rows.push({ employee, preview: await previewRevision(deps, line), error: null });
    } catch (e) {
      rows.push({ employee, preview: null, error: (e as Error).message });
    }
  }
  const priced = rows.filter((r) => r.preview);
  const totals = {
    people: rows.length,
    priced: priced.length,
    // Against the CURRENT figure where there is one. A first compensation row has no delta to take - the whole
    // of it is new cost, which is what comparing against zero says.
    annualCtcDelta: round2(priced.reduce((sum, r) => sum + (r.preview!.proposed.annualCtc - (r.preview!.current?.annualCtc ?? 0)), 0)),
    monthlyGrossDelta: round2(priced.reduce((sum, r) => sum + (r.preview!.proposed.monthlyGross - (r.preview!.current?.monthlyGross ?? 0)), 0)),
    arrears: round2(priced.reduce((sum, r) => sum + r.preview!.arrears.amount, 0)),
    crossings: priced.reduce((sum, r) => sum + r.preview!.crossings.length, 0),
  };
  return { rows, totals };
}

export type IncrementResult = { employee: string; applied: boolean; error: string | null };

/**
 * Apply an increment round, one revision at a time.
 *
 * DELIBERATELY NOT ATOMIC ACROSS PEOPLE, and saying so is the honest part. Each `reviseCompensation` is its
 * own guarded, checked batch - closing the predecessor and opening the successor together - but there is no
 * transaction spanning twenty-five of them in D1, and pretending otherwise would be a lie told in a function
 * signature. So this reports PER PERSON: what applied, what did not, and why.
 *
 * That is recoverable in a way a silent partial failure is not. Every applied row is an ordinary revision,
 * visible in that employee's timeline and correctable through the ordinary correction path; the caller
 * re-runs the batch with the rows that failed. The alternative - refusing the whole round because one
 * person's structure does not fit their new CTC - makes the feature useless at the moment it matters.
 */
export async function applyIncrementBatch(deps: Deps, actor: AppUser, lines: readonly IncrementLine[]): Promise<{ results: IncrementResult[]; applied: number }> {
  if (!lines.length) throw invalidArgument("no increments to apply");
  if (lines.length > MAX_INCREMENT_BATCH) {
    throw invalidArgument(`an increment batch carries at most ${MAX_INCREMENT_BATCH} people; split the round and run it again`);
  }
  const results: IncrementResult[] = [];
  for (const line of lines) {
    const employee = line.employee ?? "";
    try {
      await reviseCompensation(deps, actor, line);
      results.push({ employee, applied: true, error: null });
    } catch (e) {
      results.push({ employee, applied: false, error: (e as Error).message });
    }
  }
  return { results, applied: results.filter((r) => r.applied).length };
}

export async function reviseCompensation(deps: Deps, actor: AppUser, input: CompensationInput) {
  const employeeId = idFromPath(input.employee);
  const from = dayMs(input.effective_from);
  if (!employeeId) throw invalidArgument("employee is required");
  const annualCtc = input.annual_ctc;
  if (typeof annualCtc !== "number" || annualCtc <= 0) throw invalidArgument("annual_ctc must be greater than 0");
  if (Number.isNaN(from)) throw invalidArgument("effective_from is required");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");
  const { payGradeId, structureId } = await refsOf(deps, input);

  const timeline = await timelineOf(deps, employeeId);
  // Two revisions starting the same day is a zero-length interval, i.e. a salary that was never paid. The
  // caller meant to correct the one already there, and PATCH is how that is said.
  if (timeline.some((r) => +new Date(r.effectiveFrom) === from))
    throw failedPrecondition(`a revision already takes effect on ${ymd(from)} - edit that one rather than adding a second`);
  const { prev, next } = slotAt(timeline, from);
  const nowMs = +deps.clock.now();
  // The window this revision governs, which is also the window its arrears cover: up to the revision that
  // supersedes it, or to now for the latest one.
  const until = Math.min(nowMs, next ? +new Date(next.effectiveFrom) : nowMs);
  const priced = await priceRevision(deps, employeeId, emp.epfEnrolled, annualCtc, structureId, from, until, prev);

  // Everything the write needs, resolved BEFORE the batch: the code allocation and the currency lookup are
  // reads of their own, and the row id is minted here so the successor can be read back by it. Past this line
  // nothing may fail for a reason other than the writes themselves - which is what makes the batch below the
  // whole of the operation.
  const code = await allocOwnedCode(deps, schema.compensation, schema.compensation.employeeId, employeeId);
  // The org's own currency, never a literal: the app is single-currency and payroll rejects a payable that is
  // not in it, so a first compensation row minted as "INR" in a non-INR org blocks every run.
  const currency = input.currency_code?.trim() || prev?.currency || next?.currency || (await orgCurrency(deps));
  const uuid = genId();
  const now = new Date();

  // Half-open intervals: the prior row ends where the new one begins.
  //
  // ONE ATOMIC BATCH (D1 runs a batch as a single implicit transaction - see lib/dbBatch.ts). Closing the
  // predecessor and opening the successor are two halves of one move, and they were two separate statements
  // with a code allocation awaited between them: a failure in the gap (an exhausted allocation retry, a D1
  // blip, the invocation's CPU ceiling) committed the close and never landed the insert, leaving the employee
  // with EVERY compensation row closed. `compAsOf` then answers undefined, and services/payroll.ts skips an
  // employee it cannot price - so the visible symptom is not an error, it is someone quietly not being paid.
  //
  // The close stays GUARDED, and the guard is now a checked row count rather than a returned row: two
  // concurrent revisions both read the same neighbour, and the loser must stop rather than close a row that is
  // already closed and open a second current one - which would leave an ambiguous current salary and pay the
  // arrears delta twice. (`comp_open_idx`, the partial unique index on the open live row, is the DB backstop.)
  const closeStmt = prev
    ? {
        stmt: deps.db
          .update(schema.compensation)
          .set({ effectiveTo: new Date(from), updatedAt: now })
          .where(
            and(
              eq(schema.compensation.uuid, prev.uuid),
              // The OPEN row when this revision becomes the latest; a MIDDLE insert's predecessor is already
              // closed (at `next`'s start) and now ends here instead, so it is guarded on the end date we read.
              next ? eq(schema.compensation.effectiveTo, new Date(prev.effectiveTo!)) : isNull(schema.compensation.effectiveTo),
            ),
          )
          .returning({ uuid: schema.compensation.uuid }),
        expect: 1,
        label: "close the preceding revision",
      }
    : null;
  const short = await runBatchChecked(deps.db, [
    ...(closeStmt ? [closeStmt] : []),
    deps.db.insert(schema.compensation).values({
      uuid,
      code,
      employeeId,
      ctcAnnual: annualCtc,
      basePay: priced.basePay,
      specialAllowance: priced.specialAllowance,
      currency,
      payGradeId,
      structureId,
      variablePayTarget: input.variable_pay_target ?? prev?.variablePayTarget ?? null,
      effectiveFrom: new Date(from),
      // Open only when nothing supersedes it; a middle insert ends where the next revision starts.
      effectiveTo: next ? new Date(next.effectiveFrom) : null,
      arrearsAmount: priced.arrearsAmount,
      arrearsBaseAmount: priced.arrearsBaseAmount,
      arrearsPeriodsJson: priced.arrearsPeriods.length ? JSON.stringify(priced.arrearsPeriods) : null,
    }),
  ]).catch((e: unknown) => {
    // The other ordering of the same race: our close matched nothing and the insert then collided on
    // `comp_open_idx`, so D1 rolled the whole batch back. Same answer as the short count below.
    if (isOpenTimelineCollision(e)) throw aborted("this employee's compensation was revised concurrently; reload and try again");
    throw e;
  });
  if (short.length) throw aborted("this employee's compensation was revised concurrently; reload and try again");

  const row = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.uuid, uuid)).limit(1))[0]!;
  // What the salary WAS and what it now IS - a revision is a from->to by nature, and the feed renders
  // `meta.diff` as exactly that. Without it the trail says only "revised", which is the one thing the reader
  // could already see. `prev` is the revision this one supersedes, so on a first-ever row the "from" is empty.
  await audit(deps, actor, "compensation.revise", "compensation", row.uuid, {
    employee: `employees/${employeeId}`,
    date: ymd(from),
    diff: {
      ctcAnnual: { from: prev?.ctcAnnual ?? null, to: annualCtc },
      basePay: { from: prev?.basePay ?? null, to: priced.basePay },
    },
    ...(priced.arrearsAmount > 0 ? { reason: `backdated: ${priced.arrearsAmount} owed as retro arrears` } : {}),
  }, row);
  // Let the employee know their pay was revised (details on their profile). Skip a self-initiated change.
  if (employeeId !== actor.employeeId)
    await notify(deps, { recipient: employeeId, type: "compensation.revised", title: "Your compensation was revised", body: `Effective ${input.effective_from ?? "your next cycle"}${priced.arrearsAmount > 0 ? ` (with arrears).` : "."}`, link: "profile", subject: `compensation/${row.uuid}`, actorId: actor.employeeId });
  return (await withGrades(deps, [row]))[0]!;
}

/**
 * Correct a revision in place: the CTC, the catalog references, the currency, or the effective date.
 *
 * The date may move only WITHIN this revision's slot - after the revision before it and before the one after
 * it. Dragging a row past a neighbour would silently re-order which revision supersedes which while leaving
 * every amount where it was, and there is no honest reading of what the caller meant by that; the error names
 * the window, and a row that belongs somewhere else entirely is removed and re-added.
 *
 * The split and the arrears are re-solved from the corrected figures, EXCEPT when the arrears have already
 * been disbursed (a payroll run paid them, or a settlement released them): that money left the building at the
 * amount stored here, so the stored amount stays what it was. The difference is settled the way any other
 * over/under payment is - a bonus or a recovery on the next run - not by rewriting the record of what was paid.
 */
export async function updateCompensation(deps: Deps, actor: AppUser, id: string, patch: CompensationPatch, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("compensation record not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, row.employeeId)).limit(1))[0];
  if (!emp) throw notFound("employee not found");

  const annualCtc = patch.annual_ctc ?? row.ctcAnnual;
  if (!(annualCtc > 0)) throw invalidArgument("annual_ctc must be greater than 0");
  // Absent = leave alone; explicit null = clear. `refsOf` validates only what was sent, so an untouched
  // reference is never re-checked against a catalog row that has since been retired.
  const payGradeId = has(patch, "pay_grade") ? (await refsOf(deps, { pay_grade: patch.pay_grade })).payGradeId : row.payGradeId;
  const structureId = has(patch, "salary_structure") ? (await refsOf(deps, { salary_structure: patch.salary_structure })).structureId : row.structureId;

  const others = (await timelineOf(deps, row.employeeId)).filter((r) => r.uuid !== id);
  const { prev, next } = slotAt(others, +new Date(row.effectiveFrom));
  let from = +new Date(row.effectiveFrom);
  if (patch.effective_from !== undefined) {
    from = dayMs(patch.effective_from);
    if (Number.isNaN(from)) throw invalidArgument("effective_from must be a date (YYYY-MM-DD)");
    const lo = prev ? +new Date(prev.effectiveFrom) : undefined;
    const hi = next ? +new Date(next.effectiveFrom) : undefined;
    if ((lo !== undefined && from <= lo) || (hi !== undefined && from >= hi))
      throw failedPrecondition(
        `effective_from must fall between this employee's neighbouring revisions${lo !== undefined ? ` (after ${ymd(lo)})` : ""}${hi !== undefined ? ` (before ${ymd(hi)})` : ""}. To move it outside that window, remove this revision and add it at the new date.`,
      );
  }
  const nowMs = +deps.clock.now();
  const priced = await priceRevision(deps, row.employeeId, emp.epfEnrolled, annualCtc, structureId, from, Math.min(nowMs, next ? +new Date(next.effectiveFrom) : nowMs), prev);
  // Already disbursed: the figures describe a payment that happened, so they are history, not a derivation.
  const settled = !!row.arrearsPaidRunId || !!row.arrearsPaidAt;

  // Named, so the audit below can diff exactly the columns this write touched - the same `set`-keyed diff the
  // generic crudService patch records, which is what the activity feed renders as "ctc annual: 12,00,000 →
  // 15,00,000". A correction whose trail does not say what it corrected is not much of a trail.
  const set = {
    ctcAnnual: annualCtc,
    basePay: priced.basePay,
    specialAllowance: priced.specialAllowance,
    currency: patch.currency_code?.trim() || row.currency,
    payGradeId,
    structureId,
    // Absent = leave alone; explicit null = clear (this person no longer plays for a variable component).
    ...(has(patch, "variable_pay_target") ? { variablePayTarget: patch.variable_pay_target ?? null } : {}),
    effectiveFrom: new Date(from),
    ...(settled ? {} : {
      arrearsAmount: priced.arrearsAmount,
      arrearsBaseAmount: priced.arrearsBaseAmount,
      // Repriced with the amount, or the breakdown would describe the figure this correction replaced.
      arrearsPeriodsJson: priced.arrearsPeriods.length ? JSON.stringify(priced.arrearsPeriods) : null,
    }),
    updatedAt: new Date(),
  };
  // COMPARE-AND-SWAP on the version the ETag was computed from, exactly as the generic crudService patch does:
  // two callers holding the same ETag must not both write, with the first one's correction silently lost.
  const updated = (await deps.db
    .update(schema.compensation)
    .set(set)
    .where(and(eq(schema.compensation.uuid, id), eq(schema.compensation.updatedAt, new Date(row.updatedAt))))
    .returning())[0];
  if (!updated) {
    const still = (await deps.db.select({ uuid: schema.compensation.uuid }).from(schema.compensation).where(eq(schema.compensation.uuid, id)).limit(1))[0];
    if (!still) throw notFound("compensation record not found");
    throw aborted("the record changed since it was read; re-read it and try again");
  }
  // Keep the chain contiguous: the revision before this one now ends where this one now starts. This row's own
  // `effective_to` is unchanged - the date cannot cross `next`, so what supersedes it did not move.
  if (prev && from !== +new Date(row.effectiveFrom))
    await deps.db.update(schema.compensation).set({ effectiveTo: new Date(from), updatedAt: new Date() }).where(eq(schema.compensation.uuid, prev.uuid));

  await audit(deps, actor, "compensation.update", "compensation", id, {
    employee: `employees/${row.employeeId}`,
    ...(diffMeta(row, updated, set, "compensation") ?? {}),
    ...(settled ? { reason: "retro arrears already paid out, so the stored arrears were left at the amount disbursed" } : {}),
  }, updated);
  // A correction to what someone is paid is news to them, the same as a revision is.
  if (row.employeeId !== actor.employeeId && (annualCtc !== row.ctcAnnual || from !== +new Date(row.effectiveFrom)))
    await notify(deps, { recipient: row.employeeId, type: "compensation.revised", title: "Your compensation was corrected", body: `Effective ${ymd(from)}.`, link: "profile", subject: `compensation/${id}`, actorId: actor.employeeId });
  return (await withGrades(deps, [updated]))[0]!;
}

/**
 * Remove a revision from the timeline (soft): the row is kept and marked, and the revision BEFORE it absorbs
 * its window - reopening as the current salary when the removed row was the current one.
 *
 * Refused once the arrears have been disbursed. A published run's payslip carries the arrears line and points
 * at this row for why; deleting it would leave a payment nothing explains. Reverse the run (or the settlement)
 * first, which releases the arrears, and the revision becomes removable.
 */
export async function deleteCompensation(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.compensation).where(eq(schema.compensation.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("compensation record not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  if (row.arrearsPaidRunId || row.arrearsPaidAt)
    throw failedPrecondition("this revision's retro arrears have already been paid out, so removing it would leave that payment unexplained. Reverse the payroll run (or the settlement) that paid them first.");

  const timeline = await timelineOf(deps, row.employeeId);
  const prev = timeline[timeline.findIndex((r) => r.uuid === id) - 1];
  // Mark it removed FIRST, then heal the chain. `comp_open_idx` counts only live open rows, so taking this row
  // out of the predicate before the predecessor reopens is what keeps the two writes from ever colliding on it.
  const marked = await deps.db
    .update(schema.compensation)
    .set({ deleteTime: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.compensation.uuid, id), eq(schema.compensation.updatedAt, new Date(row.updatedAt))))
    .returning({ uuid: schema.compensation.uuid });
  if (!marked.length) {
    const still = (await deps.db.select({ uuid: schema.compensation.uuid }).from(schema.compensation).where(eq(schema.compensation.uuid, id)).limit(1))[0];
    if (!still) throw notFound("compensation record not found");
    throw aborted("the record changed since it was read; re-read it and try again");
  }
  if (prev)
    await deps.db
      .update(schema.compensation)
      .set({ effectiveTo: row.effectiveTo ? new Date(row.effectiveTo) : null, updatedAt: new Date() })
      .where(eq(schema.compensation.uuid, prev.uuid));
  // The figures that just left the timeline, and the salary the employee falls back to - the two things a
  // reader of the trail needs, and neither is recoverable from "removed a compensation record".
  await audit(deps, actor, "compensation.delete", "compensation", id, {
    employee: `employees/${row.employeeId}`,
    date: ymd(row.effectiveFrom),
    diff: {
      ctcAnnual: { from: row.ctcAnnual, to: prev?.ctcAnnual ?? null },
      basePay: { from: row.basePay, to: prev?.basePay ?? null },
    },
    ...(prev ? {} : { reason: "the employee's only revision; they are left with no compensation on record" }),
  }, row);
}

// Re-solve the split for every CURRENT comp row under the live components + ctc config, holding each row's
// stored annual_ctc (the promise) fixed. Pure planning step (no writes): classifies each row as `stale` (the
// cached basic/special no longer matches what the live catalog derives), `unchanged`, or `skipped` (the CTC no
// longer fits - e.g. committed cost now exceeds it). Shared by the dry-run status check and the actual reapply,
// so the count you preview is exactly what a reapply would change.
// `from` is what the row holds TODAY; `basePay`/`specialAllowance` are what a re-apply would write. Both,
// because a re-apply is a change to somebody's pay and the trail owes the reader the pair, not the result.
type SplitPlanRow = { uuid: string; employeeId: string; basePay: number; specialAllowance: number; from: { basePay: number; specialAllowance: number }; status: "stale" | "unchanged" | "skipped" };
async function splitPlan(deps: Deps): Promise<SplitPlanRow[]> {
  const cfg = await getSettingValue<CtcConfig>(deps, "ctc", DEFAULT_CTC_CONFIG);
  const components = (await refPayComponents(deps)).filter((c) => !c.disabled && !c.deleteTime);
  const rows = await deps.db.select().from(schema.compensation).where(and(isNull(schema.compensation.effectiveTo), isNull(schema.compensation.deleteTime)));
  const emps = await deps.db.select({ uuid: schema.employees.uuid, epfEnrolled: schema.employees.epfEnrolled }).from(schema.employees);
  const epfById = new Map(emps.map((e) => [e.uuid, e.epfEnrolled]));
  const plan: SplitPlanRow[] = [];
  for (const row of rows) {
    const effective = applyStructure(components, await structureLinesById(deps, row.structureId));
    const split = splitCtc(row.ctcAnnual / 12, effective, epfById.get(row.employeeId) ?? true, cfg);
    const from = { basePay: row.basePay, specialAllowance: row.specialAllowance };
    if (!split) { plan.push({ uuid: row.uuid, employeeId: row.employeeId, ...from, from, status: "skipped" }); continue; }
    const changed = split.basePay !== row.basePay || split.specialAllowance !== row.specialAllowance;
    plan.push({ uuid: row.uuid, employeeId: row.employeeId, basePay: split.basePay, specialAllowance: split.specialAllowance, from, status: changed ? "stale" : "unchanged" });
  }
  return plan;
}

// Which of `employeeIds` currently hold a split the live catalog no longer produces. Used by a payroll run to
// warn that it priced a stale split: the run's numbers come from the CACHED basic / Special Allowance on each
// compensation row, so a row solved under an older catalog pays a gross that no longer reconciles to the CTC the
// employee was promised - and neither the build time nor any input's updatedAt reveals it, because the drift
// usually predates the build. Scoped to the run's own people, so an unrelated employee's stale split is not
// reported as this run's problem. `skipped` = no split fits that CTC any more; a re-apply cannot fix those.
export async function splitDriftFor(deps: Deps, employeeIds: string[]): Promise<{ stale: string[]; skipped: string[] }> {
  if (!employeeIds.length) return { stale: [], skipped: [] };
  const wanted = new Set(employeeIds);
  const plan = (await splitPlan(deps)).filter((p) => wanted.has(p.employeeId));
  return {
    stale: plan.filter((p) => p.status === "stale").map((p) => p.employeeId),
    skipped: plan.filter((p) => p.status === "skipped").map((p) => p.employeeId),
  };
}

// Dry run: how many current splits are out of date under the live catalog. Drives the "N employees' splits are
// out of date" banner + the post-mutation prompt after a pay-component change. No writes.
export async function splitStatus(deps: Deps): Promise<{ stale: number; unchanged: number; skipped: number }> {
  const plan = await splitPlan(deps);
  return {
    stale: plan.filter((p) => p.status === "stale").length,
    unchanged: plan.filter((p) => p.status === "unchanged").length,
    skipped: plan.filter((p) => p.status === "skipped").length,
  };
}

// Re-derive the split for every CURRENT compensation row (writes the stale ones). A change to the catalog
// (adding an allowance, enabling/disabling gratuity, editing a rate) propagates here - freed/added cost flows
// into the employee's Special Allowance and the CTC breakdown reconciles again. Deliberately explicit (a
// prompt/button), never automatic, because it shifts take-home org-wide. Rows whose CTC no longer fits are
// left unchanged + reported as skipped.
export async function reapplySplitCurrent(deps: Deps, actor: AppUser): Promise<{ updated: number; unchanged: number; skipped: number }> {
  const plan = await splitPlan(deps);
  const touched: SplitPlanRow[] = [];
  let unchanged = 0, skipped = 0;
  // Batched (one D1 round trip for the whole run, not one per employee): a company past ~50 employees blew
  // the free-plan per-invocation subrequest budget partway through a whole-company re-apply, updating the
  // first 50 rows and then failing the rest with no signal beyond a generic 500 - see dbBatch.ts.
  const stmts: BatchStmt[] = [];
  for (const p of plan) {
    if (p.status === "skipped") { skipped++; continue; }
    if (p.status === "unchanged") { unchanged++; continue; }
    stmts.push(deps.db.update(schema.compensation).set({ basePay: p.basePay, specialAllowance: p.specialAllowance, updatedAt: new Date() }).where(eq(schema.compensation.uuid, p.uuid)));
    touched.push(p);
  }
  await runBatch(deps.db, stmts);
  // ONE ENTRY PER EMPLOYEE, not just the org-wide tally. This re-solves what somebody is paid each month, and
  // a count on a collection-level entry is invisible from the place a person actually looks: their own
  // compensation record. Now that record's trail says "payroll re-applied the split; basic 30,000 -> 33,333".
  //
  // Batched (auditMany is one statement group, not one round trip per row), and bounded by headcount, so the
  // free-plan subrequest budget holds even for a whole-company re-apply.
  await auditMany(deps, actor, touched.map((p) => ({
    action: "compensation.reapplySplit",
    entity: "compensation",
    entityId: p.uuid,
    meta: {
      employee: `employees/${p.employeeId}`,
      diff: {
        basePay: { from: p.from.basePay, to: p.basePay },
        specialAllowance: { from: p.from.specialAllowance, to: p.specialAllowance },
      },
    },
  })));
  // The org-wide tally still gets its own entry: "who re-applied the split, and how much of the company did it
  // move" is a question about the ACTION, and no per-row entry answers it.
  await audit(deps, actor, "compensation.reapplySplit", "compensation", undefined, { updated: touched.length, unchanged, skipped });
  return { updated: touched.length, unchanged, skipped };
}

// Arrears paid-by-run markers (the next payroll run pays a backdated revision's stored arrears as a taxable
// earning, idempotently). Mirrors the bonus/overtime paid-by-run pattern. Both return UNEXECUTED statements
// so the build can batch them (a direct await still executes).
// Guarded on the arrears still being unclaimed, so two runs building concurrently cannot both pay them.
export function markCompArrearsPaidByRun(deps: Deps, ids: string[], runId: string, at: Date) {
  return deps.db
    .update(schema.compensation)
    .set({ arrearsPaidRunId: runId, arrearsPaidAt: at })
    .where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
// Arrears paid by a full-and-final settlement rather than a run (arrearsPaidAt set, no run), and the release
// a recomputed settlement uses. The build treats either marker as paid, so this takes them out of the queue.
// Unexecuted statement, so the FnF commits it in the same atomic batch as the settlement (see reimbursements).
export function markCompArrearsSettledStmt(deps: Deps, ids: string[], at: Date) {
  return deps.db.update(schema.compensation).set({ arrearsPaidAt: at }).where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
export function releaseCompArrearsSettledStmt(deps: Deps, ids: string[]) {
  return deps.db.update(schema.compensation).set({ arrearsPaidAt: null }).where(and(inArray(schema.compensation.uuid, ids), isNull(schema.compensation.arrearsPaidRunId)));
}
export function resetCompArrearsPaidByRun(deps: Deps, runId: string) {
  return deps.db.update(schema.compensation).set({ arrearsPaidRunId: null, arrearsPaidAt: null }).where(eq(schema.compensation.arrearsPaidRunId, runId));
}
