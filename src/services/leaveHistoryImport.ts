// Leave from the system before HRMS, brought in from a sheet (`leave-requests:importHistory`,
// opening-balances-plan.md). Two kinds of row, told apart by the person's records-start day
// (`employees.trackedFrom`):
//
// HISTORY - leave that ended before the records start. The leave policy counts requests: a yearly quota, a
// lifetime limit (maternity), the probation cap, the gap between two leaves. Leave somebody took in March in
// the system before is none of those, so an employee who used their whole quota before go-live could file it
// again the day after. A history row is that leave as an APPROVED request with `source: import`: every rule
// counts it, and nothing else happens - no balance moves (the opening balance already has it taken off,
// services/leaveAdjustments.ts), nobody is notified, no event fires.
//
// BOOKED - leave the system before HRMS had already approved for dates from the records start on (a week in
// October, approved in August). It has to exist here, or those days read as absences and are docked. It lands
// as an ordinary APPROVED request (`source: app`) and takes its days off the balance ONCE, here - which is why
// the opening balance is the figure BEFORE the old system deducted it (docs/opening-balances.md). Nobody is
// notified: it was decided in the other system. After that it is leave like any other, cancellable (and
// refunded) until it starts.
//
// A row that straddles the records-start day is refused: half of it is history and half of it is booked, and
// the two halves move the balance differently, so the sheet has to say which days are which.
import { and, eq, gte, inArray, lte, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { allocOwnedCodeRuns } from "./codeAlloc";
import { getSettingValue } from "./settings";
import { holidaysInRange, effectiveLeaveRules, slotOf, overlapping, arrivedFirst } from "./leaveRequests";
import { restateLopForDay } from "./payroll";
import { refLeaveTypes, refPayPeriods } from "../lib/refData";
import { auditMany, createdMeta } from "../lib/audit";
import { byIdChunks, chunk, runBatchChecked, type BatchStmt, type CheckedStmt } from "../lib/dbBatch";
import { invalidArgument } from "../lib/errors";
import { round2 } from "../domain/money";
import { leaveDays } from "../domain/leave";
import { sandwichOf } from "../domain/leaveRestrictions";
import { DEFAULT_ATTENDANCE, utcDay, type AttendanceConfig } from "../domain/attendance";
import { scheduleCtxWith } from "./workSchedule";

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN);
const DAY = 86_400_000;

/** Rows per import call. The client sends a file in slices of this many. */
export const HISTORY_BATCH_MAX = 100;
/** Rows per D1 batch when applying. */
const APPLY_CHUNK = 40;
/** The longest one imported leave may be, as a bound on a typo in a date rather than a policy. */
const MAX_DAYS = 366;

type LeaveRow = typeof schema.leaveRequests.$inferSelect;
type BalanceRow = typeof schema.leaveBalances.$inferSelect;

export type HistoryItem = {
  employee?: string;
  leave_type?: string;
  start_date?: string;
  end_date?: string;
  start_session?: number;
  end_session?: number;
  days?: number | null;
  reason?: string | null;
};
export type HistoryOutcome = "created" | "unchanged" | "error";
export type HistoryKind = "history" | "booked";
export type HistoryResult = {
  employee: string;
  leave_type: string;
  start_date?: string;
  end_date?: string;
  days?: number;
  /** Where `days` came from: the file, or counted the way a request filed now would be. */
  days_from?: "file" | "counted";
  /** history: taken before the records start, moves no balance. booked: from the records start on, takes its days off. */
  kind?: HistoryKind;
  outcome: HistoryOutcome;
  error?: string;
};

type Plan = {
  index: number;
  kind: HistoryKind;
  employeeId: string;
  employeeCode: string | null;
  leaveTypeId: string;
  paid: boolean;
  start: number;
  end: number;
  startSession: number;
  endSession: number;
  days: number;
  reason: string | null;
  /** The balance a booked row takes its days from, as read, or null when the person has none for the type yet. */
  balance: BalanceRow | null;
};

const balanceKey = (employeeId: string, leaveTypeId: string) => `${employeeId}|${leaveTypeId}`;

/**
 * Preview (dry run) or apply leave from the system before HRMS. Each item is one leave: employee, type, dates,
 * optional half-day sessions, optional days (counted as a request filed now would be when absent - the file
 * wins when present, because holidays from before HRMS may never have been entered here). Re-importing a leave
 * that is already here is `unchanged`, so applying the same file twice adds nothing.
 */
export async function importLeaveHistory(deps: Deps, actor: AppUser, items: HistoryItem[], dryRun: boolean) {
  if (items.length > HISTORY_BATCH_MAX) throw invalidArgument(`send at most ${HISTORY_BATCH_MAX} leaves per call`);
  const empIds = [...new Set(items.map((i) => idFromPath(i.employee)).filter((x): x is string => !!x))];
  const employees = await byIdChunks(empIds, (ids) =>
    deps.db
      .select({ uuid: schema.employees.uuid, code: schema.employees.code, deleteTime: schema.employees.deleteTime, startDate: schema.employees.startDate, endDate: schema.employees.endDate, trackedFrom: schema.employees.trackedFrom })
      .from(schema.employees)
      .where(inArray(schema.employees.uuid, ids)),
  );
  const empById = new Map(employees.map((e) => [e.uuid, e]));
  const types = new Map((await refLeaveTypes(deps)).map((t) => [t.uuid, t]));
  const att = await getSettingValue<AttendanceConfig>(deps, "attendance", DEFAULT_ATTENDANCE);
  // Each person's work location, for which regional holidays apply to them - one read for everybody.
  const positions = await byIdChunks(empIds, (ids) =>
    deps.db
      .select({ employeeId: schema.positions.employeeId, location: schema.positions.location })
      .from(schema.positions)
      .where(and(inArray(schema.positions.employeeId, ids), isNull(schema.positions.effectiveTo))),
  );
  const locationOf = new Map(positions.map((p) => [p.employeeId, p.location ?? null]));
  // The balances booked leave takes its days from.
  const balances = await byIdChunks(empIds, (ids) => deps.db.select().from(schema.leaveBalances).where(inArray(schema.leaveBalances.employeeId, ids)));
  const balanceOf = new Map(balances.map((b) => [balanceKey(b.employeeId, b.leaveTypeId), b]));
  // Their live leave over the whole span the file covers - what an imported leave must not land on.
  const starts = items.map((i) => dayMs(i.start_date)).filter((n) => !Number.isNaN(n));
  const ends = items.map((i) => dayMs(i.end_date)).filter((n) => !Number.isNaN(n));
  const live = starts.length && ends.length ? await liveLeave(deps, empIds, Math.min(...starts), Math.max(...ends)) : [];
  const liveByEmp = new Map<string, LeaveRow[]>();
  for (const r of live) liveByEmp.set(r.employeeId, [...(liveByEmp.get(r.employeeId) ?? []), r]);

  const results: HistoryResult[] = [];
  const plans: Plan[] = [];
  const planned = new Map<string, { start: number; end: number }[]>(); // per employee, the slots this file takes
  const bookedSoFar = new Map<string, number>(); // per balance, the days earlier booked rows in this file take
  for (const item of items) {
    const employee = item.employee ?? "";
    const leave_type = item.leave_type ?? "";
    const base: HistoryResult = { employee, leave_type, start_date: item.start_date, end_date: item.end_date, outcome: "created" };
    const fail = (error: string) => results.push({ ...base, outcome: "error", error });
    const emp = empById.get(idFromPath(item.employee) ?? "");
    const lt = types.get(idFromPath(item.leave_type) ?? "");
    if (!emp || emp.deleteTime) { fail("no such employee"); continue; }
    if (!lt || lt.deleteTime) { fail("no such leave type"); continue; }
    if (!emp.trackedFrom) { fail("set when HRMS records start for this person first - it is what tells leave already taken from leave still to come"); continue; }
    const start = dayMs(item.start_date);
    const end = dayMs(item.end_date);
    if (Number.isNaN(start) || Number.isNaN(end)) { fail("start_date and end_date must be dates (YYYY-MM-DD)"); continue; }
    if (end < start) { fail("end_date is before start_date"); continue; }
    const startSession = item.start_session === 2 ? 2 : 1;
    const endSession = item.end_session === 1 ? 1 : 2;
    if (start === end && startSession > endSession) { fail("the start session must be on or before the end session"); continue; }
    const trackedMs = +new Date(emp.trackedFrom);
    const trackedYmd = utcDay(trackedMs);
    if (start < trackedMs && end >= trackedMs) {
      fail(`runs across the day HRMS records start (${trackedYmd}) - split it there: the days before are history, the days from then on are booked leave`);
      continue;
    }
    const kind: HistoryKind = start >= trackedMs ? "booked" : "history";
    if (emp.startDate && start < +new Date(emp.startDate)) { fail(`starts before this person joined (${utcDay(+new Date(emp.startDate))})`); continue; }
    if (kind === "booked" && emp.endDate && end > +new Date(emp.endDate)) { fail(`runs past this person's last day (${utcDay(+new Date(emp.endDate))})`); continue; }

    const startSlot = slotOf(start, startSession);
    const endSlot = slotOf(end, endSession);
    const clashes = overlapping(liveByEmp.get(emp.uuid) ?? [], startSlot, endSlot);
    // The same leave already here, approved: nothing to add. Anything else on those days is a clash to resolve.
    const same = clashes.find((c) => c.state === "APPROVED" && c.leaveTypeId === lt.uuid && +new Date(c.startDate) === start && +new Date(c.endDate) === end
      && c.startSession === startSession && c.endSession === endSession);
    if (same) { results.push({ ...base, kind, days: same.days, outcome: "unchanged" }); continue; }
    if (clashes.length) {
      const c = clashes[0]!;
      fail(`overlaps leave already in HRMS (${utcDay(+new Date(c.startDate))} to ${utcDay(+new Date(c.endDate))})`);
      continue;
    }
    if ((planned.get(emp.uuid) ?? []).some((p) => startSlot <= p.end && p.start <= endSlot)) { fail("overlaps another leave earlier in this file"); continue; }

    let days: number;
    let days_from: "file" | "counted";
    if (item.days != null) {
      days = round2(item.days);
      days_from = "file";
      if (!Number.isFinite(days) || days <= 0 || days > MAX_DAYS) { fail(`days must be more than 0 and at most ${MAX_DAYS}`); continue; }
    } else {
      const holidays = await holidaysInRange(deps, start - 8 * DAY, end + 8 * DAY, locationOf.get(emp.uuid) ?? null);
      // The importer prices history the way the app prices a request: against the schedule THAT person was on
      // over those dates (services/workSchedule.ts).
      const schedOf = (await scheduleCtxWith(deps, att, utcDay(start), utcDay(end), [emp.uuid]))(emp.uuid);
      days = leaveDays(start, end, startSession, endSession, schedOf, holidays.full, holidays.half, sandwichOf(await effectiveLeaveRules(deps, lt)));
      days_from = "counted";
      if (days <= 0) { fail("no working days in that range - give the days in the file if the leave really was taken"); continue; }
    }
    const reason = item.reason?.trim() || null;
    if (reason && reason.length > 500) { fail("keep the reason under 500 characters"); continue; }

    // Booked PAID leave comes out of the balance, which must hold it - the same rule a request filed here
    // meets. Unpaid leave is not entitlement-limited; its balance only counts usage.
    const key = balanceKey(emp.uuid, lt.uuid);
    const balance = balanceOf.get(key) ?? null;
    if (kind === "booked" && lt.paid) {
      const available = round2((balance?.balanceDays ?? 0) - (bookedSoFar.get(key) ?? 0));
      if (days > available + 1e-9) {
        fail(`not enough ${lt.name} balance: ${days} day(s) booked but ${available} left - bring in the opening balance first, as it stood before these days were taken off`);
        continue;
      }
    }
    if (kind === "booked") bookedSoFar.set(key, round2((bookedSoFar.get(key) ?? 0) + days));

    planned.set(emp.uuid, [...(planned.get(emp.uuid) ?? []), { start: startSlot, end: endSlot }]);
    results.push({ ...base, kind, days, days_from });
    plans.push({ index: results.length - 1, kind, employeeId: emp.uuid, employeeCode: emp.code, leaveTypeId: lt.uuid, paid: lt.paid, start, end, startSession, endSession, days, reason, balance });
  }

  if (!dryRun && plans.length) {
    for (const group of chunk(plans, APPLY_CHUNK)) {
      try {
        await writeHistory(deps, actor, group, results);
      } catch (err) {
        // Reported per row so the rest of the file goes ahead, and logged, because a failure here that is not a
        // lost race is a fault somebody needs to see.
        console.error("leave history import: slice not applied", err);
        for (const p of group) results[p.index] = { ...results[p.index]!, outcome: "error", error: "not applied - try again" };
      }
    }
  }

  const counts: Record<HistoryOutcome, number> = { created: 0, unchanged: 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  return { dry_run: dryRun, counts, results };
}

function liveLeave(deps: Deps, employeeIds: string[], fromMs: number, toMs: number) {
  return byIdChunks(employeeIds, (ids) =>
    deps.db
      .select()
      .from(schema.leaveRequests)
      .where(and(
        inArray(schema.leaveRequests.employeeId, ids),
        inArray(schema.leaveRequests.state, ["PENDING", "APPROVED"]),
        gte(schema.leaveRequests.endDate, new Date(fromMs)),
        lte(schema.leaveRequests.startDate, new Date(toMs)),
      )),
  );
}

/** Move a balance by `delta` days, relative, in SQL - composes with a request reserving days in the same instant. */
const moveBalance = (deps: Deps, balanceId: string, delta: number) =>
  deps.db
    .update(schema.leaveBalances)
    .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} + ${delta}) * 100) / 100`, updatedAt: new Date() })
    .where(eq(schema.leaveBalances.uuid, balanceId));

/**
 * One slice, in ONE batch: every leave row, and for booked leave the balance move beside it. A booked PAID row's
 * debit is guarded (`balance_days >= days`), exactly as a request's reservation is, so a balance that fell since
 * the preview refuses that row rather than going below zero; the row it would have paid for is then taken back
 * out. After the batch every row is checked again for a clash, because two imports (or an import and a
 * request) racing for the same days both pass the preview's overlap check. Same rule as a request's create -
 * the later row gives way - and a booked loser gives its days back.
 */
async function writeHistory(deps: Deps, actor: AppUser, group: Plan[], results: HistoryResult[]) {
  const counts = new Map<string, number>();
  for (const p of group) counts.set(p.employeeId, (counts.get(p.employeeId) ?? 0) + 1);
  const ownerCodes = new Map(group.map((p) => [p.employeeId, p.employeeCode]));
  const codes = await allocOwnedCodeRuns(deps, schema.leaveRequests, schema.leaveRequests.employeeId, counts, undefined, ownerCodes);
  // Booked leave of a type the person holds no balance for yet (an unpaid type): one new balance row per
  // (person, type), created at minus the days booked against it - the usage count a request would leave.
  const newBalances = new Map<string, { employeeId: string; leaveTypeId: string; days: number }>();
  for (const p of group) {
    if (p.kind !== "booked" || p.balance || p.paid) continue;
    const key = balanceKey(p.employeeId, p.leaveTypeId);
    const cur = newBalances.get(key);
    newBalances.set(key, { employeeId: p.employeeId, leaveTypeId: p.leaveTypeId, days: round2((cur?.days ?? 0) + p.days) });
  }
  const balanceCounts = new Map<string, number>();
  for (const b of newBalances.values()) balanceCounts.set(b.employeeId, (balanceCounts.get(b.employeeId) ?? 0) + 1);
  const balanceCodes = balanceCounts.size
    ? await allocOwnedCodeRuns(deps, schema.leaveBalances, schema.leaveBalances.employeeId, balanceCounts, undefined, ownerCodes)
    : new Map<string, string[]>();

  const taken = new Map<string, number>();
  const next = (codesOf: Map<string, string[]>, owner: string, counter: Map<string, number>) => {
    const i = counter.get(owner) ?? 0;
    counter.set(owner, i + 1);
    const code = codesOf.get(owner)?.[i];
    if (!code) throw new Error("could not allocate a record code");
    return code;
  };
  const now = new Date();
  const values = group.map((p) => ({
    code: next(codes, p.employeeId, taken), employeeId: p.employeeId, leaveTypeId: p.leaveTypeId, startDate: new Date(p.start), endDate: new Date(p.end),
    startSession: p.startSession, endSession: p.endSession, days: p.days, reason: p.reason,
    state: "APPROVED" as const, source: p.kind === "history" ? ("import" as const) : ("app" as const), decidedBy: actor.uuid ?? null, createdAt: now, updatedAt: now,
  }));
  const stmts: (BatchStmt | CheckedStmt)[] = values.map((v) => deps.db.insert(schema.leaveRequests).values(v));
  group.forEach((p, i) => {
    if (p.kind !== "booked" || !p.balance) return;
    if (p.paid) {
      stmts.push({
        stmt: deps.db
          .update(schema.leaveBalances)
          .set({ balanceDays: sql`round((${schema.leaveBalances.balanceDays} - ${p.days}) * 100) / 100`, updatedAt: now })
          .where(and(eq(schema.leaveBalances.uuid, p.balance.uuid), gte(schema.leaveBalances.balanceDays, p.days)))
          .returning({ uuid: schema.leaveBalances.uuid }),
        expect: 1,
        label: String(i),
      });
    } else {
      stmts.push(moveBalance(deps, p.balance.uuid, -p.days));
    }
  });
  const takenBal = new Map<string, number>();
  for (const b of newBalances.values()) {
    stmts.push(deps.db.insert(schema.leaveBalances).values({ code: next(balanceCodes, b.employeeId, takenBal), employeeId: b.employeeId, leaveTypeId: b.leaveTypeId, balanceDays: round2(-b.days) }));
  }
  // Booked paid rows whose balance fell below their days since the preview: the debit matched nothing, so the
  // leave it was for is taken back out and reported.
  const short = new Set((await runBatchChecked(deps.db, stmts)).map(Number));
  const refused = [...short].map((i) => values[i]!.code);
  if (refused.length) await deps.db.delete(schema.leaveRequests).where(inArray(schema.leaveRequests.code, refused));
  for (const i of short) {
    results[group[i]!.index] = { ...results[group[i]!.index]!, outcome: "error", error: "the balance fell below these days since the preview - preview again" };
  }

  const written = await byIdChunks(values.map((v) => v.code).filter((c) => !refused.includes(c)), (c) => deps.db.select().from(schema.leaveRequests).where(inArray(schema.leaveRequests.code, c)));
  const byCode = new Map(written.map((r) => [r.code, r]));
  const after = await liveLeave(deps, [...counts.keys()], Math.min(...group.map((p) => p.start)), Math.max(...group.map((p) => p.end)));
  const landed: { plan: Plan; row: LeaveRow }[] = [];
  const lost: { plan: Plan; row: LeaveRow }[] = [];
  group.forEach((p, i) => {
    const row = byCode.get(values[i]!.code);
    if (!row) return;
    const others = after.filter((r) => r.employeeId === p.employeeId && r.uuid !== row.uuid);
    if (overlapping(others, slotOf(p.start, p.startSession), slotOf(p.end, p.endSession)).some((c) => arrivedFirst(c, row))) {
      lost.push({ plan: p, row });
      results[p.index] = { ...results[p.index]!, outcome: "error", error: "other leave landed on these days while this ran - preview again" };
    } else landed.push({ plan: p, row });
  });
  if (lost.length) {
    await deps.db.delete(schema.leaveRequests).where(inArray(schema.leaveRequests.uuid, lost.map((l) => l.row.uuid)));
    // A booked loser already took its days: give them back, to whichever balance row now holds them.
    for (const { plan } of lost.filter((l) => l.plan.kind === "booked")) {
      const bal = plan.balance ?? (await deps.db.select().from(schema.leaveBalances).where(and(eq(schema.leaveBalances.employeeId, plan.employeeId), eq(schema.leaveBalances.leaveTypeId, plan.leaveTypeId))).limit(1))[0];
      if (bal) await moveBalance(deps, bal.uuid, plan.days);
    }
  }
  await auditMany(deps, actor, landed.map(({ plan, row }) => ({
    action: "leave_request.import",
    entity: "leave-requests",
    entityId: row.uuid,
    meta: { ...createdMeta(row, "leave-requests"), note: plan.kind === "booked" ? "booked in the system before HRMS" : "taken before HRMS" },
    snapshot: row,
  })));
  // Unpaid leave is docked, including before HRMS records start (domain/attendance.ts isUntracked), so a closed
  // period it falls in is restated the way an approval would restate it. Paid leave excuses days: before the
  // records start they owe nothing anyway, and booked paid leave lies ahead of any closed period. Once per
  // (person, pay period), found from the cached period list - a restatement is about the whole period, and
  // walking every day of years of history one query at a time would spend the invocation on periods that mostly
  // do not exist (HRMS ran no payroll before go-live).
  const periods = await refPayPeriods(deps);
  const restate = new Map<string, { employeeId: string; dayMs: number }>();
  for (const { plan: p } of landed) {
    if (p.paid) continue;
    for (const pp of periods) {
      const from = +new Date(pp.periodStart);
      const to = +new Date(pp.periodEnd);
      if (from > p.end || to < p.start) continue;
      restate.set(`${p.employeeId}|${pp.uuid}`, { employeeId: p.employeeId, dayMs: Math.max(from, p.start) });
    }
  }
  for (const r of restate.values()) await restateLopForDay(deps, r.employeeId, r.dayMs);
}
