import { and, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { computeAccrual, roundToIncrement } from "../domain/leave";
import { allocOwnedCodeRuns } from "./codeAlloc";
import { getSettingValue } from "./settings";
import { orgToday, dayStartMs } from "./orgDay";
import { runBatch, insertBatches, type BatchStmt } from "../lib/dbBatch";
import { refLeaveTypes } from "../lib/refData";
import { audit } from "../lib/audit";

// How accrued balances are rounded (settings/leave_accrual). "half" keeps balances in 0.5-day steps (the
// default - prorated joining months otherwise produce values like 2.41); "day" = whole days; "none" = exact.
const INCREMENT: Record<string, number> = { none: 0, half: 0.5, day: 1 };
async function accrualIncrement(deps: Deps): Promise<number> {
  const v = await getSettingValue<{ rounding?: string }>(deps, "leave_accrual", {});
  return INCREMENT[v.rounding ?? "half"] ?? 0.5;
}

// Credits each active employee's leave balance for every accruing leave type, prorating the joining month and
// skipping probation months for types not available during probation. Idempotent: only credits calendar
// months not yet recorded on the balance row. Pass `onlyLeaveTypeId` to (re)accrue a single type - used when a
// leave type's accrual rate changes, so the balance updates immediately instead of waiting for the daily cron.
export async function accrueLeave(deps: Deps, onlyLeaveTypeId?: string): Promise<number> {
  // WHICH DAY IT IS, in the ORG's timezone and off the injected clock - not `Date.now()` in UTC, which is what
  // this used to be. Two things were wrong with that, and they compound.
  //
  // `computeAccrual` keys the credited month off `currentMs` read in UTC (domain/leave.ts `ymOf`), and the tick
  // fires at 02:00 UTC. For an org WEST of UTC that instant is still the previous evening locally, so on the
  // 1st of a month the new month's entitlement was credited a day early - the same class of bug services/
  // orgDay.ts exists to end, and carry-forward (which runs immediately before this in the same tick) already
  // goes through. Anchoring the org's calendar day at UTC midnight is exactly what `dayStartMs` is for, so the
  // month `ymOf` reads is the month the employee is living in.
  //
  // And `Date.now()` ignored `deps.clock` outright, which is how the rest of the app makes time testable - so
  // the one nightly job that hands out entitlement (leave days are encashable; this is money) could not be
  // driven over a month boundary by any test.
  const now = dayStartMs(await orgToday(deps));
  const inc = await accrualIncrement(deps);
  let credited = 0;
  // Both conditions in SQL. `status` and the soft-delete mark are independent columns (the generic soft delete
  // never touches status), and the loop below already skipped deleted rows - so this changes no behaviour, it
  // just stops the tick reading rows it is about to discard.
  //
  // RECENT LEAVERS ARE READ TOO, and that is not an optimisation - it is what makes the exit month deterministic.
  // Reading only `active` meant whether a leaver was credited for their final month depended on a race with
  // offboarding: a tick that ran before the transition flipped them to `terminated` credited the month, one that
  // ran after credited nothing, and both were wrong in opposite directions on a balance the FnF then encashes for
  // cash. `computeAccrual` already stops at `endMs` (and now prorates that month - see domain/leave.ts
  // monthFraction), so including them is safe in the other direction: nobody accrues past their last day.
  //
  // The window is what bounds the cost. A leaver's final month can still be owed on the next tick after it ends,
  // so two months of slack covers a tick that was missed; past that their marker is at their end month and every
  // later pass computes `add: 0` and writes nothing anyway. A `terminated` row with NO end date is excluded, as
  // before - there is no clamp to stop it accruing forever.
  const leaverCutoff = new Date(now - 62 * 86_400_000);
  // THE FIVE COLUMNS THE WALK BELOW ACTUALLY READS, not the whole row.
  //
  // This is one read for the entire roster and it is held in isolate memory for the length of the tick, so
  // what it selects is the tick's memory floor. `employees` is the widest table in the schema - the encrypted
  // national id, the addresses, every profile field - and none of it takes part in accrual: the loop wants an
  // id, a code, and the three dates. Selecting the row meant a nightly job whose working set grew with every
  // column anyone ever added to a person, against a 128 MiB isolate, for data it never looked at.
  //
  // Deliberately still ONE unpaginated read: the subrequest budget is what bounds this job (see the note on
  // the code reservation below), so paging it would trade a memory bound for the failure mode that actually
  // bites. Narrowing costs nothing and moves the ceiling out by roughly an order of magnitude.
  const employees = await deps.db
    .select({
      uuid: schema.employees.uuid,
      code: schema.employees.code,
      startDate: schema.employees.startDate,
      endDate: schema.employees.endDate,
      probationEndDate: schema.employees.probationEndDate,
    })
    .from(schema.employees)
    .where(
      and(
        isNull(schema.employees.deleteTime),
        or(
          eq(schema.employees.status, "active"),
          and(isNotNull(schema.employees.endDate), gte(schema.employees.endDate, leaverCutoff)),
        ),
      ),
    );
  const leaveTypes = (await refLeaveTypes(deps)).filter((lt) => !onlyLeaveTypeId || lt.uuid === onlyLeaveTypeId);
  // One read for every balance row, keyed (employee, type) - the nightly walk over employees x types is then
  // pure lookups, instead of one query per pair (which alone could blow the per-invocation subrequest budget).
  // Same reason as the roster read above: the map is keyed (employee, type) and the walk reads the row's id,
  // its balance and its accrual marker. `code` and the carry-forward marker are along for the ride otherwise.
  const balances = await deps.db
    .select({
      uuid: schema.leaveBalances.uuid,
      employeeId: schema.leaveBalances.employeeId,
      leaveTypeId: schema.leaveBalances.leaveTypeId,
      balanceDays: schema.leaveBalances.balanceDays,
      lastAccrualYm: schema.leaveBalances.lastAccrualYm,
    })
    .from(schema.leaveBalances);
  const balByKey = new Map(balances.map((b) => [`${b.employeeId}|${b.leaveTypeId}`, b]));
  // Every write of the tick collects into ONE atomic batch. The batch costs one subrequest where a
  // month-boundary night would cost one per balance row. Because the write is an ABSOLUTE balance derived from
  // the snapshot above, and the snapshot is taken once for the whole org rather than per row, each update is
  // guarded on the balance it read (compare-and-set) - see the claim below.
  const updates: BatchStmt[] = [];
  // First-touch balance rows. PLANNED first, coded second, inserted with the batch - three passes rather than a
  // round-trip per row.
  //
  // The allocation is why. `allocOwnedCode` takes one number per call, so composing a code inside this loop cost
  // one subrequest per new (employee x type) pair - roughly headcount x accruing types, in the ONE invocation the
  // nightly tick gets, on the night every pair is new. A first-ever accrual night on a real roster therefore ran
  // out of subrequests part-way through and left the rest of the org with no balance rows at all, which is the
  // worst shape a failure can take here: silent, partial, and invisible until somebody's leave balance is wrong.
  // `allocOwnedCodeRuns` reserves each employee's whole run of codes in one batch of indexed counter bumps, so
  // the cost is a constant few subrequests whatever the headcount. Steady state was never affected - after the
  // first night these rows exist and the loop takes the update path - which is exactly why this only bites once,
  // on the night nobody gets a second try at.
  type PlannedRow = { employeeId: string; leaveTypeId: string; balanceDays: number; lastAccrualYm: string | null };
  const planned: PlannedRow[] = [];
  for (const emp of employees) {
    if (!emp.startDate) continue;
    const startMs = +new Date(emp.startDate);
    const endMs = emp.endDate ? +new Date(emp.endDate) : null;
    const probationEndMs = emp.probationEndDate ? +new Date(emp.probationEndDate) : null;
    for (const lt of leaveTypes) {
      if (!lt.accrualDaysPerYear || lt.deleteTime || lt.disabled) continue;
      const existing = balByKey.get(`${emp.uuid}|${lt.uuid}`);
      const { add, newLastYm } = computeAccrual({
        accrualDaysPerYear: lt.accrualDaysPerYear,
        probationAccrualDaysPerYear: lt.probationAccrualDaysPerYear,
        startMs,
        endMs,
        probationEndMs,
        lastAccrualYm: existing?.lastAccrualYm ?? null,
        currentMs: now,
        frequency: lt.accrualFrequency === "semi_monthly" ? "semi_monthly" : "monthly",
      });
      if (existing) {
        // Round the resulting balance to the configured increment; also re-rounds (normalizes) an existing
        // balance even when no new month accrued, so a tidied policy fixes old values like 2.41 on the next run.
        const newBalance = roundToIncrement(existing.balanceDays + add, inc);
        if (newBalance === existing.balanceDays && newLastYm === existing.lastAccrualYm) continue; // nothing changed
        // Compare-and-set on the balance we read: `newBalance` is absolute, so writing it blind would undo any
        // debit/credit committed between the snapshot at the top of this function and the batch at the bottom
        // (an approved leave request, an encashment) - restoring days the employee already spent, which is real
        // money once those days are encashed. If the row moved, the claim matches nothing and the row is simply
        // left for the next nightly tick: lastAccrualYm is unchanged, so the same month is still owed and
        // accrues then off the fresh balance.
        updates.push(
          deps.db
            .update(schema.leaveBalances)
            .set({ balanceDays: newBalance, lastAccrualYm: newLastYm, updatedAt: new Date() })
            .where(and(eq(schema.leaveBalances.uuid, existing.uuid), eq(schema.leaveBalances.balanceDays, existing.balanceDays))),
        );
        credited++;
      } else {
        if (add === 0 && newLastYm === null) continue; // employee hasn't started yet
        // Recorded without its code: the codes for every row this tick creates are reserved together below, so
        // nothing inside the walk touches the database at all.
        planned.push({ employeeId: emp.uuid, leaveTypeId: lt.uuid, balanceDays: roundToIncrement(add, inc), lastAccrualYm: newLastYm });
        credited++;
      }
    }
  }

  // One reservation for the whole tick: each employee's run is as long as the number of rows they are about to
  // get, and the codes come back in that order. The owners' employee codes are already in hand from the roster
  // read above, so the allocator skips its own lookup for them.
  const perOwner = new Map<string, number>();
  for (const p of planned) perOwner.set(p.employeeId, (perOwner.get(p.employeeId) ?? 0) + 1);
  const codeRuns = planned.length
    ? await allocOwnedCodeRuns(
        deps,
        schema.leaveBalances,
        schema.leaveBalances.employeeId,
        perOwner,
        undefined,
        new Map(employees.map((e) => [e.uuid, e.code])),
      )
    : new Map<string, string[]>();
  const taken = new Map<string, number>();
  const newRows: (typeof schema.leaveBalances.$inferInsert)[] = [];
  for (const p of planned) {
    const i = taken.get(p.employeeId) ?? 0;
    taken.set(p.employeeId, i + 1);
    const code = codeRuns.get(p.employeeId)?.[i];
    // A missing code means the reservation did not cover this owner, which no path above produces. Skipping the
    // row is the only safe answer - inserting with no code would put a row outside every access scope, since the
    // code IS the scoping key - and the next tick re-plans it because `last_accrual_ym` was never written.
    if (!code) {
      console.error(`[accrual] no code reserved for employees/${p.employeeId}; balance row deferred to the next tick`);
      credited--;
      continue;
    }
    newRows.push({ code, employeeId: p.employeeId, leaveTypeId: p.leaveTypeId, balanceDays: p.balanceDays, lastAccrualYm: p.lastAccrualYm });
  }
  // One atomic batch for the whole tick: the guarded updates plus any first-touch inserts, the latter split to
  // stay inside the D1 bound-parameter cap (insertBatches measures the real per-row parameter count rather
  // than guessing from the columns set).
  await runBatch(deps.db, [...updates, ...insertBatches(newRows, (group) => deps.db.insert(schema.leaveBalances).values(group))]);
  // The nightly walk recorded NOTHING before this, and accrued leave is encashable - it is money that appears
  // on people's balances while they sleep, and "why do I have 14.5 days" had no answer anywhere in the app.
  //
  // A summary rather than one entry per balance, and that IS the trade: this runs every night over every
  // employee x every leave type, so per-row would put tens of thousands of entries a month into a D1 free-plan
  // table to record, mostly, "+1.5 days as scheduled". The individual number stays derivable - the balance row
  // carries `last_accrual_ym`, and a leave type's rate is its own record - where the fact that the run HAPPENED,
  // covered this many people and moved this many balances is derivable from nothing else.
  if (credited) {
    await audit(deps, "system", "leave.accrue", "leave-balances", undefined, {
      diff: {
        balancesCredited: { from: null, to: credited },
        employees: { from: null, to: employees.filter((e) => e.startDate).length },
        leaveTypes: { from: null, to: leaveTypes.filter((lt) => lt.accrualDaysPerYear && !lt.deleteTime && !lt.disabled).length },
      },
      ...(onlyLeaveTypeId ? { note: "a single leave type was re-accrued on request" } : {}),
    });
  }
  return credited;
}
