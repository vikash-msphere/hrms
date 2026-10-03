// Pay and tax already paid this financial year before HRMS ran payroll (db/schema.ts `payrollOpenings`).
//
// Somebody whose April-August salary was paid by the system before HRMS has a year's TDS that depends on it:
// the tax is worked out on the WHOLE year's income and spread over the months left, less what was already
// deducted. HRMS only sees its own finalized runs, so without this the first HRMS payroll either spreads the
// whole year's tax over the remaining months (TDS roughly doubles) or leaves those months' income out, and the
// PT annual cap, the ESI rule, the settlement's TDS and Form 16 read the same gap. An opening is those figures,
// one row per person per financial year, folded into the year by services/taxProjection.ts#finalizedTotals.
//
// The one rule that keeps it honest: an opening covers months HRMS has NOT paid. `paid_through` must end
// before the first month a finalized HRMS run paid this person in that year, or the same salary and tax would
// be counted twice.
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { deleteStateFilter } from "./softDelete";
import { CODE_WIDTH, allocOwnedCode, allocOwnedCodeRuns, withFreshCode } from "./codeAlloc";
import { orgToday } from "./orgDay";
import { finalizedRunTotals, fyWindow, monthKey } from "./taxProjection";
import { audit, auditMany, auditUpdate, createdMeta, diffMeta, type AuditEntry } from "../lib/audit";
import { byIdChunks, chunk, runBatchChecked, type CheckedStmt } from "../lib/dbBatch";
import { aborted, alreadyExists, invalidArgument, isPayrollOpeningDuplicate, notFound } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { MAX_MONEY } from "../http/moneyField";
import { round2 } from "../domain/money";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

/** Rows per import call. The client sends a file in slices of this many (web/src/lib/openingImport.ts). */
export const PAYROLL_OPENING_BATCH_MAX = 100;
/** Statements per D1 batch when applying. */
const APPLY_CHUNK = 50;

type Row = typeof schema.payrollOpenings.$inferSelect;

export type PayrollOpeningInput = {
  employee?: string;
  financial_year?: string;
  paid_through?: string;
  gross?: number;
  taxable_gross?: number;
  tds?: number;
  pt?: number;
  esi_contributing?: boolean;
  note?: string | null;
};

type Figures = {
  financialYear: string;
  paidThrough: string;
  gross: number;
  taxableGross: number;
  tds: number;
  pt: number;
  esiContributing: boolean;
  note: string | null;
};

export async function listPayrollOpenings(
  deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string,
  employee?: string, financialYear?: string, showDeleted = false, deletedOnly = false,
) {
  const conds = [applyScope(scope, schema.payrollOpenings.code, schema.payrollOpenings.employeeId)];
  const emp = idFromPath(employee);
  if (emp) conds.push(eq(schema.payrollOpenings.employeeId, emp));
  if (financialYear) conds.push(eq(schema.payrollOpenings.financialYear, financialYear));
  conds.push(deleteStateFilter(schema.payrollOpenings.deleteTime, showDeleted, deletedOnly));
  return keysetPage<Row>(deps, schema.payrollOpenings, "payroll-openings", and(...(conds.filter(Boolean) as SQL[])), { max: maxPageSize, pageToken });
}

/** The financial year a label like "2026-27" names, or null when it is not one. */
export function fyOfLabel(label: string): ReturnType<typeof fyWindow> | null {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) return null;
  const sy = Number(m[1]);
  if ((sy + 1) % 100 !== Number(m[2])) return null;
  return fyWindow(new Date(Date.UTC(sy, 5, 1)));
}

/**
 * What is wrong with a set of figures, in words, or null when nothing is. Pure: the checks that need the
 * database (the person, HRMS's own runs) are made by the callers.
 */
export function checkFigures(f: Figures, currentMonth: string): string | null {
  const fy = fyOfLabel(f.financialYear);
  if (!fy) return 'financial_year must look like "2026-27"';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.paidThrough)) return "paid_through must be a month, like 2026-08";
  const first = monthKey(fy.start);
  const last = monthKey(fy.end);
  if (f.paidThrough < first || f.paidThrough > last) return `paid_through must be a month in ${f.financialYear} (${first} to ${last})`;
  if (f.paidThrough > currentMonth) return "paid_through can't be a month that hasn't started yet";
  for (const [name, v] of [["gross", f.gross], ["taxable_gross", f.taxableGross], ["tds", f.tds], ["pt", f.pt]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > MAX_MONEY) return `${name} must be an amount from 0 to ${MAX_MONEY}`;
  }
  if (f.tds > f.taxableGross) return "tds can't be more than the taxable pay it was deducted from";
  if (f.note && f.note.length > 500) return "keep the note under 500 characters";
  return null;
}

function figuresFrom(input: PayrollOpeningInput, base?: Figures): Figures {
  const num = (v: number | undefined, fallback: number | undefined) => round2(v ?? fallback ?? 0);
  return {
    financialYear: (input.financial_year ?? base?.financialYear ?? "").trim(),
    paidThrough: (input.paid_through ?? base?.paidThrough ?? "").trim(),
    gross: num(input.gross, base?.gross),
    taxableGross: num(input.taxable_gross ?? (base ? undefined : input.gross), base?.taxableGross),
    tds: num(input.tds, base?.tds),
    pt: num(input.pt, base?.pt),
    esiContributing: input.esi_contributing ?? base?.esiContributing ?? false,
    note: input.note !== undefined ? input.note?.trim() || null : base?.note ?? null,
  };
}

const currentOrgMonth = async (deps: Deps) => (await orgToday(deps)).slice(0, 7);

/**
 * The first month a finalized HRMS run paid each of these people in a financial year: an opening has to stop
 * before it. Keyed on the month whose salary the run priced (its period), which is what `paid_through` names.
 */
async function firstHrmsMonths(deps: Deps, financialYear: string, employeeId?: string): Promise<Map<string, string>> {
  const fy = fyOfLabel(financialYear);
  if (!fy) return new Map();
  const out = new Map<string, string>();
  for (const [emp, t] of await finalizedRunTotals(deps, fy, undefined, employeeId)) {
    const first = [...t.earnedMonths].sort()[0];
    if (first) out.set(emp, first);
  }
  return out;
}

const overlapError = (first: string) =>
  `HRMS payroll already paid this person for ${first}, so the pay from before HRMS must end before it (paid_through ${first} or earlier is counted twice)`;

// ---- The collection's own create and update ------------------------------------------------------------------

export async function createPayrollOpening(deps: Deps, actor: AppUser, input: PayrollOpeningInput): Promise<Row> {
  const employeeId = idFromPath(input.employee);
  if (!employeeId) throw invalidArgument("employee is required");
  const emp = (await deps.db.select({ uuid: schema.employees.uuid, deleteTime: schema.employees.deleteTime }).from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");
  const f = figuresFrom(input);
  const problem = checkFigures(f, await currentOrgMonth(deps));
  if (problem) throw invalidArgument(problem);
  const first = (await firstHrmsMonths(deps, f.financialYear, employeeId)).get(employeeId);
  if (first && f.paidThrough >= first) throw invalidArgument(overlapError(first));
  const existing = await liveOpening(deps, employeeId, f.financialYear);
  if (existing) throw alreadyExists(`this employee already has pay before HRMS for ${f.financialYear}; edit that entry instead`);

  const row = await withFreshCode(async (attempt) => {
    const code = await allocOwnedCode(deps, schema.payrollOpenings, schema.payrollOpenings.employeeId, employeeId, CODE_WIDTH.owned, attempt > 1);
    try {
      return (await deps.db.insert(schema.payrollOpenings).values({ ...f, code, employeeId, createdBy: actor.uuid ?? null }).returning())[0]!;
    } catch (e) {
      if (isPayrollOpeningDuplicate(e)) throw alreadyExists(`this employee already has pay before HRMS for ${f.financialYear}; edit that entry instead`);
      throw e;
    }
  });
  await audit(deps, actor, "payroll_opening.create", "payroll-openings", row.uuid, createdMeta(row, "payroll-openings"), row);
  return row;
}

export async function updatePayrollOpening(deps: Deps, actor: AppUser, id: string, patch: PayrollOpeningInput, ifMatch?: string): Promise<Row> {
  const row = (await deps.db.select().from(schema.payrollOpenings).where(eq(schema.payrollOpenings.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("payroll opening not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const newEmployee = idFromPath(patch.employee);
  if (newEmployee && newEmployee !== row.employeeId) throw invalidArgument("an entry can't move to another person; delete it and add one for them");
  const f = figuresFrom(patch, row);
  const problem = checkFigures(f, await currentOrgMonth(deps));
  if (problem) throw invalidArgument(problem);
  const first = (await firstHrmsMonths(deps, f.financialYear, row.employeeId)).get(row.employeeId);
  if (first && f.paidThrough >= first) throw invalidArgument(overlapError(first));
  if (f.financialYear !== row.financialYear && (await liveOpening(deps, row.employeeId, f.financialYear))) {
    throw alreadyExists(`this employee already has pay before HRMS for ${f.financialYear}; edit that entry instead`);
  }
  const set = { ...f, updatedAt: new Date() };
  let updated: Row | undefined;
  try {
    updated = (await deps.db
      .update(schema.payrollOpenings)
      .set(set)
      .where(and(eq(schema.payrollOpenings.uuid, id), eq(schema.payrollOpenings.updatedAt, new Date(row.updatedAt))))
      .returning())[0];
  } catch (e) {
    if (isPayrollOpeningDuplicate(e)) throw alreadyExists(`this employee already has pay before HRMS for ${f.financialYear}; edit that entry instead`);
    throw e;
  }
  if (!updated) throw aborted("the record changed since it was read; re-read it and try again");
  await auditUpdate(deps, actor, "payroll_opening.update", "payroll-openings", id, diffMeta(row, updated, set, "payroll-openings"), updated);
  return updated;
}

async function liveOpening(deps: Deps, employeeId: string, financialYear: string): Promise<Row | undefined> {
  return (await deps.db
    .select()
    .from(schema.payrollOpenings)
    .where(and(eq(schema.payrollOpenings.employeeId, employeeId), eq(schema.payrollOpenings.financialYear, financialYear), isNull(schema.payrollOpenings.deleteTime)))
    .limit(1))[0];
}

// ---- The import ----------------------------------------------------------------------------------------------

export type PayrollOpeningOutcome = "created" | "updated" | "unchanged" | "error";
export type PayrollOpeningResult = {
  employee: string;
  financial_year: string;
  paid_through?: string;
  gross?: number;
  taxable_gross?: number;
  tds?: number;
  pt?: number;
  esi_contributing?: boolean;
  /** The figures this replaces, on an update. */
  previous?: { paid_through: string; gross: number; taxable_gross: number; tds: number; pt: number; esi_contributing: boolean };
  outcome: PayrollOpeningOutcome;
  error?: string;
};

/**
 * Preview (dry run) or apply pay and tax from before HRMS, one item per employee and financial year. An item
 * for a person who already has an entry for that year REPLACES its figures, so applying the same file twice
 * changes nothing. Items are independent: one that cannot be applied is reported with its reason and the rest
 * go ahead.
 */
export async function importPayrollOpenings(deps: Deps, actor: AppUser, items: PayrollOpeningInput[], dryRun: boolean) {
  if (items.length > PAYROLL_OPENING_BATCH_MAX) throw invalidArgument(`send at most ${PAYROLL_OPENING_BATCH_MAX} rows per call`);
  const empIds = [...new Set(items.map((i) => idFromPath(i.employee)).filter((x): x is string => !!x))];
  const employees = await byIdChunks(empIds, (ids) =>
    deps.db
      .select({ uuid: schema.employees.uuid, code: schema.employees.code, deleteTime: schema.employees.deleteTime })
      .from(schema.employees)
      .where(inArray(schema.employees.uuid, ids)),
  );
  const empById = new Map(employees.map((e) => [e.uuid, e]));
  const existing = await byIdChunks(empIds, (ids) =>
    deps.db.select().from(schema.payrollOpenings).where(and(inArray(schema.payrollOpenings.employeeId, ids), isNull(schema.payrollOpenings.deleteTime))),
  );
  const existingByKey = new Map(existing.map((r) => [`${r.employeeId}|${r.financialYear}`, r]));
  const currentMonth = await currentOrgMonth(deps);
  const firstByFy = new Map<string, Map<string, string>>();
  for (const fyLabel of new Set(items.map((i) => (i.financial_year ?? "").trim()))) {
    if (fyOfLabel(fyLabel)) firstByFy.set(fyLabel, await firstHrmsMonths(deps, fyLabel));
  }

  const results: PayrollOpeningResult[] = [];
  const plans: { index: number; employeeId: string; employeeCode: string | null; f: Figures; prior?: Row }[] = [];
  const seen = new Set<string>();
  items.forEach((item) => {
    const employee = item.employee ?? "";
    const financial_year = (item.financial_year ?? "").trim();
    const fail = (error: string) => results.push({ employee, financial_year, outcome: "error", error });
    const employeeId = idFromPath(item.employee);
    const emp = employeeId ? empById.get(employeeId) : undefined;
    if (!emp || emp.deleteTime) return fail("no such employee");
    const f = figuresFrom(item);
    const problem = checkFigures(f, currentMonth);
    if (problem) return fail(problem);
    const key = `${emp.uuid}|${f.financialYear}`;
    if (seen.has(key)) return fail("this employee and financial year appear more than once");
    seen.add(key);
    const first = firstByFy.get(f.financialYear)?.get(emp.uuid);
    if (first && f.paidThrough >= first) return fail(overlapError(first));
    const prior = existingByKey.get(key);
    const base: PayrollOpeningResult = {
      employee, financial_year, paid_through: f.paidThrough, gross: f.gross, taxable_gross: f.taxableGross, tds: f.tds, pt: f.pt,
      esi_contributing: f.esiContributing,
      ...(prior ? { previous: { paid_through: prior.paidThrough, gross: prior.gross, taxable_gross: prior.taxableGross, tds: prior.tds, pt: prior.pt, esi_contributing: prior.esiContributing } } : {}),
      outcome: prior ? "updated" : "created",
    };
    const same = prior
      && prior.paidThrough === f.paidThrough && prior.gross === f.gross && prior.taxableGross === f.taxableGross
      && prior.tds === f.tds && prior.pt === f.pt && prior.esiContributing === f.esiContributing
      && (item.note === undefined || (prior.note ?? null) === f.note);
    if (same) {
      results.push({ ...base, outcome: "unchanged" });
      return;
    }
    // A note the file does not carry keeps the one on the entry.
    if (prior && item.note === undefined) f.note = prior.note ?? null;
    results.push(base);
    plans.push({ index: results.length - 1, employeeId: emp.uuid, employeeCode: emp.code, f, prior });
  });

  if (!dryRun && plans.length) {
    for (const group of chunk(plans, APPLY_CHUNK)) {
      try {
        await writeOpenings(deps, actor, group, results);
      } catch (e) {
        // Two imports racing: the unique (employee, year) index refused a second live entry and the whole slice
        // rolled back, so none of it landed.
        const raced = isPayrollOpeningDuplicate(e);
        if (!raced) console.error("payroll opening import: slice not applied", e);
        const lost = raced ? "another import added pay for this person while this one ran - preview again" : "not applied - try again";
        for (const p of group) results[p.index] = { ...results[p.index]!, outcome: "error", error: lost };
      }
    }
  }

  const counts: Record<PayrollOpeningOutcome, number> = { created: 0, updated: 0, unchanged: 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  return { dry_run: dryRun, counts, results };
}

/**
 * One slice of an import, in ONE batch: inserts for new entries, and updates guarded on the version the preview
 * read - an entry somebody changed since is left alone and reported, rather than overwritten with figures
 * computed against what it used to say.
 */
async function writeOpenings(
  deps: Deps,
  actor: AppUser,
  group: { index: number; employeeId: string; employeeCode: string | null; f: Figures; prior?: Row }[],
  results: PayrollOpeningResult[],
) {
  const inserts = group.filter((p) => !p.prior);
  const codes = inserts.length
    ? await allocOwnedCodeRuns(
        deps, schema.payrollOpenings, schema.payrollOpenings.employeeId,
        new Map(inserts.map((p) => [p.employeeId, 1])), undefined, new Map(inserts.map((p) => [p.employeeId, p.employeeCode])),
      )
    : new Map<string, string[]>();
  const now = new Date();
  const stmts: CheckedStmt[] = group.map((p) => {
    if (p.prior) {
      return {
        stmt: deps.db
          .update(schema.payrollOpenings)
          .set({ ...p.f, updatedAt: now })
          .where(and(eq(schema.payrollOpenings.uuid, p.prior.uuid), eq(schema.payrollOpenings.updatedAt, new Date(p.prior.updatedAt))))
          .returning(),
        expect: 1,
        label: String(p.index),
      };
    }
    const code = codes.get(p.employeeId)?.[0];
    if (!code) throw new Error("could not allocate a record code");
    return {
      stmt: deps.db.insert(schema.payrollOpenings).values({ ...p.f, code, employeeId: p.employeeId, createdBy: actor.uuid ?? null }).returning(),
      expect: 1,
      label: String(p.index),
    };
  });
  const lost = new Set(await runBatchChecked(deps.db, stmts));
  for (const p of group) {
    if (lost.has(String(p.index))) results[p.index] = { ...results[p.index]!, outcome: "error", error: "this entry changed since the preview - preview again" };
  }
  // Read back what landed, for the trail.
  const landed = group.filter((p) => !lost.has(String(p.index)));
  const written = await byIdChunks([...new Set(landed.map((p) => p.employeeId))], (ids) =>
    deps.db.select().from(schema.payrollOpenings).where(and(inArray(schema.payrollOpenings.employeeId, ids), isNull(schema.payrollOpenings.deleteTime))),
  );
  const byKey = new Map(written.map((r) => [`${r.employeeId}|${r.financialYear}`, r]));
  await auditMany(
    deps,
    actor,
    landed.flatMap((p): AuditEntry[] => {
      const row = byKey.get(`${p.employeeId}|${p.f.financialYear}`);
      if (!row) return [];
      if (!p.prior) return [{ action: "payroll_opening.create", entity: "payroll-openings", entityId: row.uuid, meta: createdMeta(row, "payroll-openings"), snapshot: row }];
      // A re-import of the same figures changed nothing, so it gets no entry (the same rule as auditUpdate).
      const meta = diffMeta(p.prior, row, p.f, "payroll-openings");
      return meta ? [{ action: "payroll_opening.update", entity: "payroll-openings", entityId: row.uuid, meta, snapshot: row }] : [];
    }),
  );
}
