// The leave balance ledger (db/schema.ts `leaveAdjustments`): the two ways a balance moves that no accrual,
// request or encashment explains.
//
// OPENING BALANCES. Somebody who joined before the org used HRMS arrives with a balance earned - and partly
// spent - somewhere else. The nightly accrual cannot know it: the first night after go-live credited every
// month since their start date, with nothing deducted for leave taken in those years. An opening replaces that
// reading with the figure from the system before: it takes off exactly what HRMS credited for the periods
// before their records start (`domain/leave.ts creditedBeforeFloor`, `removed_days` on the row) and puts on
// the balance HR entered. Everything that happened IN HRMS since - accrual after go-live, leave filed, an
// encashment - stays exactly where it is, which is why an opening is a CHANGE to the balance rather than a new
// value for it, and why it can be entered days after go-live without anybody reconstructing those movements.
// A re-import moves the balance by the difference from the previous opening only.
//
// CORRECTIONS. HR moving a balance by hand, with a reason.
//
// THE WRITE. The ledger row goes in first and the balance moves by the row's own days, in SQL, in the same
// batch - one atomic transaction, so the two can never disagree. For an opening, the row is also the LOCK:
// `ladj_opening_idx` is unique on (employee, type, sequence), so two imports of the same opening racing each
// other make the second fail and roll back instead of both landing (docs/architecture-decisions.md, "A checked
// batch is not an atomic one"). The balance update is relative, so it composes with a leave request reserving
// days or the nightly accrual in the same instant.
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { allocOwnedCodeRuns } from "./codeAlloc";
import { getSettingValue } from "./settings";
import { notifyMany } from "./notifications";
import { refLeaveTypes } from "../lib/refData";
import { auditMany, createdMeta } from "../lib/audit";
import { byIdChunks, chunk, runBatch, type BatchStmt } from "../lib/dbBatch";
import { invalidArgument, failedPrecondition, notFound } from "../lib/errors";
import { round2 } from "../domain/money";
import { utcDay } from "../domain/attendance";
import { creditedBeforeFloor, openingMarker, type AccrualInputs } from "../domain/leave";
import { mergeRestrictions } from "../domain/leaveRestrictions";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

/** The most days one adjustment may move a balance by, either way - a bound on a typo, not a policy. */
const MAX_DAYS = 1000;
/** Rows per import call. The client sends a file in slices of this many (web/src/lib/openingImport.ts). */
export const OPENING_BATCH_MAX = 100;
/** Rows per D1 batch when applying: two statements each, well inside one request. */
const APPLY_CHUNK = 40;

type Row = typeof schema.leaveAdjustments.$inferSelect;

export async function listLeaveAdjustments(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, employee?: string, leaveType?: string) {
  const conds = [applyScope(scope, schema.leaveAdjustments.code, schema.leaveAdjustments.employeeId)];
  const emp = idFromPath(employee);
  if (emp) conds.push(eq(schema.leaveAdjustments.employeeId, emp));
  const lt = idFromPath(leaveType);
  if (lt) conds.push(eq(schema.leaveAdjustments.leaveTypeId, lt));
  return keysetPage(deps, schema.leaveAdjustments, "leave-adjustments", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
}

/** Whether any opening has been applied for this employee - once one has, their records-start date is fixed. */
export async function hasOpening(deps: Deps, employeeId: string): Promise<boolean> {
  const rows = await deps.db
    .select({ uuid: schema.leaveAdjustments.uuid })
    .from(schema.leaveAdjustments)
    .where(and(eq(schema.leaveAdjustments.employeeId, employeeId), eq(schema.leaveAdjustments.kind, "opening")))
    .limit(1);
  return rows.length > 0;
}

/**
 * Days encashed BEFORE HRMS in a leave year, per balance (`${employeeId}|${leaveTypeId}`), from the latest
 * opening of each balance whose as-of day falls in that year - so the annual encashment cap
 * (services/leaveEncashments.ts) counts an encashment the old system paid out that year as well as the ones
 * paid here. `as_of` is a date-only column, so its year is the UTC one it is stored at.
 */
export async function openingEncashments(deps: Deps, year: { year: string }, employeeId?: string): Promise<Map<string, number>> {
  const conds = [eq(schema.leaveAdjustments.kind, "opening")];
  if (employeeId) conds.push(eq(schema.leaveAdjustments.employeeId, employeeId));
  const rows = await deps.db
    .select({
      employeeId: schema.leaveAdjustments.employeeId,
      leaveTypeId: schema.leaveAdjustments.leaveTypeId,
      encashedDays: schema.leaveAdjustments.encashedDays,
      openingSeq: schema.leaveAdjustments.openingSeq,
      asOf: schema.leaveAdjustments.asOf,
    })
    .from(schema.leaveAdjustments)
    .where(and(...conds));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.employeeId}|${r.leaveTypeId}`;
    const cur = latest.get(k);
    if (!cur || (r.openingSeq ?? 0) > (cur.openingSeq ?? 0)) latest.set(k, r);
  }
  const out = new Map<string, number>();
  for (const [k, r] of latest) {
    if (!r.encashedDays || !r.asOf || utcDay(+new Date(r.asOf)).slice(0, 4) !== year.year) continue;
    out.set(k, round2(r.encashedDays));
  }
  return out;
}

// ---- A correction --------------------------------------------------------------------------------------------

export type CorrectionInput = { employee?: string; leave_type?: string; days?: number; reason?: string };

export async function createCorrection(deps: Deps, actor: AppUser, input: CorrectionInput): Promise<Row> {
  const employeeId = idFromPath(input.employee);
  const leaveTypeId = idFromPath(input.leave_type);
  if (!employeeId || !leaveTypeId) throw invalidArgument("employee and leave_type are required");
  const days = typeof input.days === "number" && Number.isFinite(input.days) ? round2(input.days) : NaN;
  if (Number.isNaN(days) || days === 0) throw invalidArgument("days must be a non-zero number (negative takes days off)");
  if (Math.abs(days) > MAX_DAYS) throw invalidArgument(`days must be within ${MAX_DAYS} either way`);
  const reason = input.reason?.trim();
  if (!reason) throw invalidArgument("say why the balance is being changed");
  if (reason.length > 500) throw invalidArgument("keep the reason under 500 characters");

  const emp = (await deps.db.select({ uuid: schema.employees.uuid, code: schema.employees.code, deleteTime: schema.employees.deleteTime }).from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!emp || emp.deleteTime) throw notFound("employee not found");
  const lt = (await refLeaveTypes(deps)).find((t) => t.uuid === leaveTypeId);
  if (!lt || lt.deleteTime) throw notFound("leave type not found");
  const bal = (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, employeeId), eq(schema.leaveBalances.leaveTypeId, leaveTypeId))).limit(1))[0];
  const current = bal?.balanceDays ?? 0;
  if (round2(current + days) < 0) throw failedPrecondition(`that would take the ${lt.name} balance below zero (it is ${current})`);

  const [row] = await writeAdjustments(deps, actor, [{
    employeeId, employeeCode: emp.code, leaveTypeId, kind: "correction", days, reason, balance: bal ?? null,
  }]);
  return row!;
}

// ---- Opening balances ----------------------------------------------------------------------------------------

export type OpeningItem = { employee?: string; leave_type?: string; opening_days?: number; encashed_days?: number | null };
export type OpeningOutcome = "applied" | "unchanged" | "error";
export type OpeningResult = {
  employee: string;
  leave_type: string;
  /** The day HRMS records start for the employee, which the opening is as of. */
  as_of?: string;
  /** The balance now. */
  current?: number;
  /** What HRMS credited for the periods before `as_of` - taken off by a first opening, 0 on a re-import. */
  removed?: number;
  /** The last opening entered for this balance, on a re-import. */
  previous_opening?: number;
  opening?: number;
  /** The signed change to the balance. */
  change?: number;
  /** The balance after. */
  result?: number;
  outcome: OpeningOutcome;
  error?: string;
};

/**
 * Preview (dry run) or apply opening balances. Each item is one employee x leave type: the balance they had
 * when their HRMS records started, and optionally the days already encashed that leave year before HRMS (so
 * the annual encashment cap counts them). Items are independent - one that cannot be applied is reported with
 * its reason and the rest go ahead - except that an apply is atomic per slice of `APPLY_CHUNK` items: a slice
 * that loses a race to a concurrent import rolls back whole and is reported as such, to be previewed again.
 */
export async function importOpenings(deps: Deps, actor: AppUser, items: OpeningItem[], dryRun: boolean) {
  if (items.length > OPENING_BATCH_MAX) throw invalidArgument(`send at most ${OPENING_BATCH_MAX} opening balances per call`);
  const empIds = [...new Set(items.map((i) => idFromPath(i.employee)).filter((x): x is string => !!x))];

  const employees = await byIdChunks(empIds, (ids) =>
    deps.db
      .select({
        uuid: schema.employees.uuid, code: schema.employees.code, deleteTime: schema.employees.deleteTime,
        startDate: schema.employees.startDate, endDate: schema.employees.endDate, probationEndDate: schema.employees.probationEndDate,
        trackedFrom: schema.employees.trackedFrom,
      })
      .from(schema.employees)
      .where(inArray(schema.employees.uuid, ids)),
  );
  const empById = new Map(employees.map((e) => [e.uuid, e]));
  const types = new Map((await refLeaveTypes(deps)).map((t) => [t.uuid, t]));
  const orgRestrictions = await getSettingValue<Record<string, unknown>>(deps, "leave_restrictions", {});
  const balances = await byIdChunks(empIds, (ids) => deps.db.select().from(schema.leaveBalances).where(inArray(schema.leaveBalances.employeeId, ids)));
  const balByKey = new Map(balances.map((b) => [`${b.employeeId}|${b.leaveTypeId}`, b]));
  const priors = await byIdChunks(empIds, (ids) =>
    deps.db
      .select()
      .from(schema.leaveAdjustments)
      .where(and(inArray(schema.leaveAdjustments.employeeId, ids), eq(schema.leaveAdjustments.kind, "opening"))),
  );
  // The latest opening per balance: the one a re-import is measured against.
  const priorByKey = new Map<string, Row>();
  for (const p of priors) {
    const k = `${p.employeeId}|${p.leaveTypeId}`;
    const cur = priorByKey.get(k);
    if (!cur || (p.openingSeq ?? 0) > (cur.openingSeq ?? 0)) priorByKey.set(k, p);
  }

  const results: OpeningResult[] = [];
  const plans: (PlannedWrite & { index: number })[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const employee = item.employee ?? "";
    const leave_type = item.leave_type ?? "";
    const fail = (error: string) => results.push({ employee, leave_type, outcome: "error", error });
    const employeeId = idFromPath(item.employee);
    const leaveTypeId = idFromPath(item.leave_type);
    const emp = employeeId ? empById.get(employeeId) : undefined;
    const lt = leaveTypeId ? types.get(leaveTypeId) : undefined;
    if (!emp || emp.deleteTime) return fail("no such employee");
    if (!lt || lt.deleteTime) return fail("no such leave type");
    const key = `${emp.uuid}|${lt.uuid}`;
    if (seen.has(key)) return fail("this employee and leave type appear more than once");
    seen.add(key);
    if (!emp.trackedFrom) return fail("set when HRMS records start for this person first - the opening is as of that day");
    const opening = typeof item.opening_days === "number" && Number.isFinite(item.opening_days) ? round2(item.opening_days) : NaN;
    if (Number.isNaN(opening) || opening < 0 || opening > MAX_DAYS) return fail(`the opening balance must be a number of days from 0 to ${MAX_DAYS}`);
    const encashed = item.encashed_days == null ? null : Number.isFinite(item.encashed_days) && item.encashed_days >= 0 ? round2(item.encashed_days) : NaN;
    if (encashed !== null && Number.isNaN(encashed)) return fail("encashed days must be zero or more");

    const bal = balByKey.get(key) ?? null;
    const prior = priorByKey.get(key);
    const inputs: AccrualInputs = {
      accrualDaysPerYear: lt.accrualDaysPerYear,
      probationAccrualDaysPerYear: lt.probationAccrualDaysPerYear,
      startMs: emp.startDate ? +new Date(emp.startDate) : null,
      endMs: emp.endDate ? +new Date(emp.endDate) : null,
      probationEndMs: emp.probationEndDate ? +new Date(emp.probationEndDate) : null,
      lastAccrualYm: bal?.lastAccrualYm ?? null,
      currentMs: +deps.clock.now(),
      frequency: lt.accrualFrequency === "semi_monthly" ? "semi_monthly" : "monthly",
      joiningRule: mergeRestrictions(orgRestrictions, lt.restrictions).accrual.joining_rule ?? null,
      pricedStartMs: bal?.accrualPricedStart ? +new Date(bal.accrualPricedStart) : null,
      pricedEndMs: bal?.accrualPricedEnd ? +new Date(bal.accrualPricedEnd) : null,
      floorMs: +new Date(emp.trackedFrom),
    };
    // A first opening replaces what HRMS credited before the floor; a re-import replaces the previous opening.
    const removed = prior ? 0 : bal ? creditedBeforeFloor(inputs) : 0;
    const change = round2(opening - (prior ? prior.openingDays ?? 0 : removed));
    const current = bal?.balanceDays ?? 0;
    const result = round2(current + change);
    const base: OpeningResult = {
      employee, leave_type, as_of: utcDay(+new Date(emp.trackedFrom)), current, removed, opening, change, result,
      ...(prior ? { previous_opening: prior.openingDays ?? 0 } : {}),
      outcome: "applied",
    };
    if (result < 0) {
      results.push({ ...base, outcome: "error", error: `the balance would end at ${result}: more was used in HRMS since ${base.as_of} than this opening allows` });
      return;
    }
    if (prior && change === 0 && (prior.encashedDays ?? null) === encashed) {
      results.push({ ...base, outcome: "unchanged" });
      return;
    }
    results.push(base);
    plans.push({
      index: results.length - 1,
      employeeId: emp.uuid, employeeCode: emp.code, leaveTypeId: lt.uuid, kind: "opening", days: change, balance: bal,
      opening: { openingDays: opening, removedDays: removed, encashedDays: encashed, asOf: new Date(emp.trackedFrom), seq: (prior?.openingSeq ?? 0) + 1, marker: openingMarker(inputs) },
    });
  });

  if (!dryRun && plans.length) {
    const touched = new Set<string>();
    for (const group of chunk(plans, APPLY_CHUNK)) {
      try {
        await writeAdjustments(deps, actor, group);
        for (const p of group) touched.add(p.employeeId);
      } catch (e) {
        // A UNIQUE violation is the lock doing its job: somebody else applied an opening for one of these
        // balances since this call read them. The whole slice rolled back, so none of it landed.
        const raced = String((e as Error)?.message ?? e).includes("UNIQUE");
        if (!raced) console.error("leave opening import: slice not applied", e);
        const lost = raced ? "another import changed these balances while this one ran - preview again" : "not applied - try again";
        for (const p of group) results[p.index] = { ...results[p.index]!, outcome: "error", error: lost };
      }
    }
    // One notification per person rather than one per balance: "your leave balances now carry over from before
    // HRMS" is one fact, and a person with four leave types should not get four of it.
    if (touched.size) {
      await notifyMany(deps, [...touched], {
        type: "leave.opening_balance",
        title: "Your leave balances were brought over",
        body: "Your balances now start from what you had before HRMS. The history on each balance shows the change.",
        link: "leave-requests",
        actorId: actor.employeeId,
      }).catch(() => {});
    }
  }

  const counts = { applied: 0, unchanged: 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  return { dry_run: dryRun, counts, results };
}

// ---- The write -----------------------------------------------------------------------------------------------

type PlannedWrite = {
  employeeId: string;
  employeeCode: string | null;
  leaveTypeId: string;
  kind: "opening" | "correction";
  days: number;
  reason?: string;
  /** The balance row as read, or null when the employee has none for this type yet. */
  balance: typeof schema.leaveBalances.$inferSelect | null;
  opening?: { openingDays: number; removedDays: number; encashedDays: number | null; asOf: Date; seq: number; marker: string | null };
};

/**
 * Ledger rows and the balance moves they describe, in ONE atomic batch. The ledger insert comes first in each
 * pair so that, for an opening, its unique sequence is what a racing duplicate trips over - and a trip aborts
 * the whole batch, balance update included. A balance the employee does not have yet is created at the row's
 * days (the unique (employee, type) index makes a concurrent accrual creating it too fail the same way).
 */
async function writeAdjustments(deps: Deps, actor: AppUser, plans: PlannedWrite[]): Promise<Row[]> {
  const perOwner = new Map<string, number>();
  const needBalance = new Map<string, number>();
  for (const p of plans) {
    perOwner.set(p.employeeId, (perOwner.get(p.employeeId) ?? 0) + 1);
    if (!p.balance) needBalance.set(p.employeeId, (needBalance.get(p.employeeId) ?? 0) + 1);
  }
  const ownerCodes = new Map(plans.map((p) => [p.employeeId, p.employeeCode]));
  const adjCodes = await allocOwnedCodeRuns(deps, schema.leaveAdjustments, schema.leaveAdjustments.employeeId, perOwner, undefined, ownerCodes);
  const balCodes = needBalance.size ? await allocOwnedCodeRuns(deps, schema.leaveBalances, schema.leaveBalances.employeeId, needBalance, undefined, ownerCodes) : new Map<string, string[]>();
  const takeAdj = new Map<string, number>();
  const takeBal = new Map<string, number>();
  const next = (codes: Map<string, string[]>, taken: Map<string, number>, owner: string) => {
    const i = taken.get(owner) ?? 0;
    taken.set(owner, i + 1);
    const code = codes.get(owner)?.[i];
    if (!code) throw failedPrecondition("could not allocate a record code - try again");
    return code;
  };

  const now = new Date();
  const stmts: BatchStmt[] = [];
  const rows: (typeof schema.leaveAdjustments.$inferInsert & { uuid?: string })[] = [];
  for (const p of plans) {
    const values = {
      code: next(adjCodes, takeAdj, p.employeeId),
      employeeId: p.employeeId,
      leaveTypeId: p.leaveTypeId,
      kind: p.kind,
      days: p.days,
      openingDays: p.opening?.openingDays ?? null,
      removedDays: p.opening?.removedDays ?? null,
      encashedDays: p.opening?.encashedDays ?? null,
      asOf: p.opening?.asOf ?? null,
      openingSeq: p.opening?.seq ?? null,
      reason: p.reason ?? null,
      createdBy: actor.uuid ?? null,
    };
    rows.push(values);
    stmts.push(deps.db.insert(schema.leaveAdjustments).values(values));
    if (p.balance) {
      stmts.push(
        deps.db
          .update(schema.leaveBalances)
          .set({
            balanceDays: sql`round(${schema.leaveBalances.balanceDays} + ${p.days}, 2)`,
            ...(p.opening?.marker ? { lastAccrualYm: p.opening.marker } : {}),
            updatedAt: now,
          })
          .where(eq(schema.leaveBalances.uuid, p.balance.uuid)),
      );
    } else {
      stmts.push(
        deps.db.insert(schema.leaveBalances).values({ code: next(balCodes, takeBal, p.employeeId), employeeId: p.employeeId, leaveTypeId: p.leaveTypeId, balanceDays: round2(p.days) }),
      );
    }
  }
  await runBatch(deps.db, stmts);
  // Read back what landed, for the response and the trail: by code, which the batch just wrote and nothing else
  // shares (the column is unique).
  const written = await byIdChunks(rows.map((r) => r.code!), (codes) => deps.db.select().from(schema.leaveAdjustments).where(inArray(schema.leaveAdjustments.code, codes)));
  await auditMany(deps, actor, written.map((r) => ({ action: "leave_adjustment.create", entity: "leave-adjustments", entityId: r.uuid, meta: createdMeta(r, "leave-adjustments"), snapshot: r })));
  return written;
}
