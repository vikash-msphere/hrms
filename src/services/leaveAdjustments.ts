// The leave balance ledger (db/schema.ts `leaveAdjustments`): the two ways a balance moves that no accrual,
// request or encashment explains.
//
// OPENING BALANCES. Somebody who joined before the org used HRMS arrives with a balance earned - and partly
// spent - somewhere else. The nightly accrual cannot know it: the first night after go-live credited every
// month since their start date, with nothing deducted for leave taken in those years. An opening replaces that
// reading with the figure from the system before: it takes off exactly what HRMS credited for the periods
// before their records start (`domain/leave.ts creditedBeforeFloor`, `removed_days` on the row) and puts on
// the balance HR entered. Everything that happened IN HRMS since - accrual after go-live, leave filed (pending
// or approved, since a request takes its days when it is filed), an encashment - stays exactly where it is,
// which is why an opening is a CHANGE to the balance rather than a new value for it, and why it can be entered
// days after go-live without anybody reconstructing those movements.
//
// THE SHEET'S DATE (`as_of`). The old system's sheet is a balance on the day it was made, which need not be the
// day records start. Accrual is split at that day: periods that start before it are the sheet's, periods from
// it on are HRMS's (the same rule as the records start, domain/leave.ts floorMs). A sheet made AFTER the
// records start already holds the accrual HRMS credited in between, so that comes off too, and the accrual
// marker moves past it so the walk never credits it again. A sheet made BEFORE them is missing the policy's
// entitlement in between, which the opening puts on, and the leave taken in between, which arrives as history
// (services/leaveHistoryImport.ts) moving no balance - so the opening takes that off. Either way the result is
// the sheet's figure, plus HRMS accrual since its date, less the leave HRMS holds.
//
// Every opening of a balance is measured from the same place - the balance as HRMS alone would have it - so a
// re-import moves it by the difference between what the new opening and all earlier ones put on.
//
// CORRECTIONS. HR moving a balance by hand, with a reason.
//
// THE WRITE. The ledger row goes in first and the balance moves by the row's own days, in SQL, in the same
// batch - one atomic transaction, so the two can never disagree. For an opening, the row is also the LOCK:
// `ladj_opening_idx` is unique on (employee, type, sequence), so two imports of the same opening racing each
// other make the second fail and roll back instead of both landing (docs/architecture-decisions.md, "A checked
// batch is not an atomic one"). The balance update is relative, so it composes with a leave request reserving
// days or the nightly accrual in the same instant.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { allocOwnedCodeRuns } from "./codeAlloc";
import { getSettingValue } from "./settings";
import { notifyMany } from "./notifications";
import { orgToday } from "./orgDay";
import { refLeaveTypes } from "../lib/refData";
import { auditMany, createdMeta } from "../lib/audit";
import { byIdChunks, chunk, runBatch, type BatchStmt } from "../lib/dbBatch";
import { invalidArgument, failedPrecondition, notFound } from "../lib/errors";
import { round2 } from "../domain/money";
import { utcDay } from "../domain/attendance";
import { creditedBeforeFloor, entitlementBefore, floorMarker, openingMarker, type AccrualInputs } from "../domain/leave";
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

export type OpeningItem = { employee?: string; leave_type?: string; opening_days?: number; encashed_days?: number | null; as_of?: string | null };
export type OpeningOutcome = "applied" | "unchanged" | "error";
export type OpeningResult = {
  employee: string;
  leave_type: string;
  /** The day the sheet's balance is as of: the item's `as_of`, or the records start when it has none. */
  as_of?: string;
  /** The day HRMS records start for the employee. */
  records_from?: string;
  /** The balance now. */
  current?: number;
  /** The last opening entered for this balance, on a re-import. */
  previous_opening?: number;
  opening?: number;
  /** HRMS accrual for the periods from `as_of` on, up to the last one credited. */
  earned?: number;
  /** Leave HRMS holds against the balance: requests filed here (and booked leave brought in), by state. */
  leave_pending?: number;
  leave_approved?: number;
  /** Leave brought in as history that started on or after `as_of` - after the sheet, so not in it. */
  leave_history?: number;
  /** Every other movement since: corrections, encashments, the year-end carry-forward. */
  other?: number;
  /** The signed change to the balance. */
  change?: number;
  /** The balance after: opening + earned - leave_pending - leave_approved - leave_history + other. */
  result?: number;
  outcome: OpeningOutcome;
  error?: string;
};

/** Far enough ahead to be after every period the walk could have credited, as a floor for "all of them". */
const FAR_FLOOR = Date.UTC(9999, 0, 1);
const dayMs = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN);

/**
 * Preview (dry run) or apply opening balances. Each item is one employee x leave type: the balance on the day
 * the old system's sheet was made (`as_of`; the records start when absent), and optionally the days already
 * encashed that leave year before HRMS (so the annual encashment cap counts them). Items are independent - one
 * that cannot be applied is reported with its reason and the rest go ahead - except that an apply is atomic per
 * slice of `APPLY_CHUNK` items: a slice that loses a race to a concurrent import rolls back whole and is
 * reported as such, to be previewed again.
 */
export async function importOpenings(deps: Deps, actor: AppUser, items: OpeningItem[], dryRun: boolean) {
  if (items.length > OPENING_BATCH_MAX) throw invalidArgument(`send at most ${OPENING_BATCH_MAX} opening balances per call`);
  const empIds = [...new Set(items.map((i) => idFromPath(i.employee)).filter((x): x is string => !!x))];
  const today = await orgToday(deps);
  const yearStart = `${today.slice(0, 4)}-01-01`;

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
  // Per balance: the latest opening (what "unchanged" compares against), the first (whose `removedDays` is
  // what HRMS credited before the records start), and what all of them have put on so far.
  const priorByKey = new Map<string, Row>();
  const firstByKey = new Map<string, Row>();
  const appliedByKey = new Map<string, number>();
  for (const p of priors) {
    const k = `${p.employeeId}|${p.leaveTypeId}`;
    const cur = priorByKey.get(k);
    if (!cur || (p.openingSeq ?? 0) > (cur.openingSeq ?? 0)) priorByKey.set(k, p);
    const first = firstByKey.get(k);
    if (!first || (p.openingSeq ?? 0) < (first.openingSeq ?? 0)) firstByKey.set(k, p);
    appliedByKey.set(k, round2((appliedByKey.get(k) ?? 0) + p.days));
  }
  // The leave HRMS holds against each balance: every request filed here that is pending or approved (its days
  // came off when it was filed), and booked leave brought in, which is the same kind of row.
  const held = await byIdChunks(empIds, (ids) =>
    deps.db
      .select({ employeeId: schema.leaveRequests.employeeId, leaveTypeId: schema.leaveRequests.leaveTypeId, state: schema.leaveRequests.state, days: schema.leaveRequests.days })
      .from(schema.leaveRequests)
      .where(and(inArray(schema.leaveRequests.employeeId, ids), eq(schema.leaveRequests.source, "app"), inArray(schema.leaveRequests.state, ["PENDING", "APPROVED"]))),
  );
  const heldByKey = new Map<string, { pending: number; approved: number }>();
  for (const r of held) {
    const k = `${r.employeeId}|${r.leaveTypeId}`;
    const cur = heldByKey.get(k) ?? { pending: 0, approved: 0 };
    if (r.state === "PENDING") cur.pending = round2(cur.pending + r.days);
    else cur.approved = round2(cur.approved + r.days);
    heldByKey.set(k, cur);
  }
  // Leave brought in as history this leave year: what started after a sheet dated before the records start
  // is in neither the sheet nor the balance.
  const history = await byIdChunks(empIds, (ids) =>
    deps.db
      .select({ employeeId: schema.leaveRequests.employeeId, leaveTypeId: schema.leaveRequests.leaveTypeId, startDate: schema.leaveRequests.startDate, days: schema.leaveRequests.days })
      .from(schema.leaveRequests)
      .where(and(
        inArray(schema.leaveRequests.employeeId, ids),
        eq(schema.leaveRequests.source, "import"),
        eq(schema.leaveRequests.state, "APPROVED"),
        gte(schema.leaveRequests.startDate, new Date(dayMs(yearStart))),
      )),
  );

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
    if (!emp.trackedFrom) return fail("set when HRMS records start for this person first - HRMS accrual for them counts from that day");
    const opening = typeof item.opening_days === "number" && Number.isFinite(item.opening_days) ? round2(item.opening_days) : NaN;
    if (Number.isNaN(opening) || opening < 0 || opening > MAX_DAYS) return fail(`the opening balance must be a number of days from 0 to ${MAX_DAYS}`);
    const encashed = item.encashed_days == null ? null : Number.isFinite(item.encashed_days) && item.encashed_days >= 0 ? round2(item.encashed_days) : NaN;
    if (encashed !== null && Number.isNaN(encashed)) return fail("encashed days must be zero or more");
    const trackedMs = +new Date(emp.trackedFrom);
    const asOfMs = item.as_of == null || item.as_of === "" ? trackedMs : dayMs(item.as_of);
    if (Number.isNaN(asOfMs)) return fail("the sheet's date must be a date (YYYY-MM-DD)");
    const asOf = utcDay(asOfMs);
    if (asOf > today) return fail(`the sheet's date (${asOf}) is in the future`);
    // A sheet from an earlier leave year predates the year-end carry-forward, which HRMS has already applied
    // to the balance it would be measured against.
    if (asOf < yearStart && asOfMs !== trackedMs) return fail(`the sheet's date (${asOf}) is before this leave year - use a sheet from ${yearStart} on`);
    if (emp.startDate && asOfMs < +new Date(emp.startDate)) return fail(`the sheet's date (${asOf}) is before this person joined`);

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
      floorMs: trackedMs,
    };
    // What HRMS credited before the records start, which the first opening took (or takes) off.
    const removed = prior ? firstByKey.get(key)?.removedDays ?? 0 : bal ? creditedBeforeFloor(inputs) : 0;
    // The accrual between the records start and the sheet's date. Before the records start the walk never
    // credits, so a sheet dated earlier is short the policy's entitlement for those periods; after them the walk
    // has credited what it reached (its marker), and a sheet dated later already holds that.
    const reached = asOfMs > trackedMs ? bal?.lastAccrualYm ?? null : undefined;
    const between = asOfMs === trackedMs ? 0 : round2(entitlementBefore(inputs, trackedMs, reached) - entitlementBefore(inputs, asOfMs, reached));
    // Leave brought in as history that started on or after a sheet dated before the records start.
    const afterSheet = asOfMs < trackedMs
      ? round2(history.filter((h) => h.employeeId === emp.uuid && h.leaveTypeId === lt.uuid && +h.startDate >= asOfMs && +h.startDate < trackedMs).reduce((n, h) => n + h.days, 0))
      : 0;
    // What the opening puts on against the balance HRMS alone would have; earlier openings are already on it.
    const change = round2(opening - removed + between - afterSheet - (appliedByKey.get(key) ?? 0));
    const current = bal?.balanceDays ?? 0;
    const result = round2(current + change);
    // From the opening on, the walk owns only the periods from the later of the two days.
    const markerAt: AccrualInputs = { ...inputs, floorMs: Math.max(asOfMs, trackedMs) };
    const marker = bal?.lastAccrualYm ? openingMarker(markerAt) : asOfMs > trackedMs ? floorMarker(markerAt) : null;
    const lastCredited = [bal?.lastAccrualYm ?? null, floorMarker(markerAt)].filter((m): m is string => !!m).sort().pop() ?? null;
    const earned = round2(entitlementBefore(inputs, FAR_FLOOR, lastCredited) - entitlementBefore(inputs, asOfMs));
    const leave = heldByKey.get(key) ?? { pending: 0, approved: 0 };
    const base: OpeningResult = {
      employee, leave_type, as_of: asOf, records_from: utcDay(trackedMs), current, opening, earned,
      leave_pending: leave.pending, leave_approved: leave.approved, leave_history: afterSheet,
      other: round2(result - (opening + earned - leave.pending - leave.approved - afterSheet)),
      change, result,
      ...(prior ? { previous_opening: prior.openingDays ?? 0 } : {}),
      outcome: "applied",
    };
    if (result < 0) {
      results.push({ ...base, outcome: "error", error: `the balance would end at ${result}: more leave is held in HRMS than this opening allows` });
      return;
    }
    if (prior && change === 0 && (prior.encashedDays ?? null) === encashed && (prior.asOf ? utcDay(+prior.asOf) : null) === asOf) {
      results.push({ ...base, outcome: "unchanged" });
      return;
    }
    results.push(base);
    plans.push({
      index: results.length - 1,
      employeeId: emp.uuid, employeeCode: emp.code, leaveTypeId: lt.uuid, kind: "opening", days: change, balance: bal,
      opening: { openingDays: opening, removedDays: prior ? 0 : removed, encashedDays: encashed, asOf: new Date(asOfMs), seq: (prior?.openingSeq ?? 0) + 1, marker },
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
        deps.db.insert(schema.leaveBalances).values({
          code: next(balCodes, takeBal, p.employeeId), employeeId: p.employeeId, leaveTypeId: p.leaveTypeId, balanceDays: round2(p.days),
          ...(p.opening?.marker ? { lastAccrualYm: p.opening.marker } : {}),
        }),
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
