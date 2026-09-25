// `employees:setTrackedFrom` - the one-time act that tells the app when its records start for everybody who
// joined before the org began using it (db/schema.ts `employees.trackedFrom`, opening-balances-plan.md).
//
// Per person the date is the LATER of the go-live date and the org-local day their record was created: someone
// imported a week after launch had no way to punch in the week before their record existed either. People who
// joined on or after the go-live date are left alone - their records start on their start date, which is what
// an empty `tracked_from` already means - and so is anybody who already has a date, so a second run changes
// nothing and a date HR corrected by hand for one person survives the bulk act.
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument } from "../lib/errors";
import { auditMany, diffMeta } from "../lib/audit";
import { chunk, runBatchChecked, type CheckedStmt } from "../lib/dbBatch";
import { localDay, utcDay } from "../domain/attendance";
import { orgTimezone, orgToday } from "./orgDay";

/** Statements per D1 batch for the writes: one batch is one subrequest whatever it holds. */
const WRITE_BATCH = 100;

export type TrackedFromOutcome = "set" | "already_set" | "joined_after";

export type TrackedFromRow = {
  employee: string; // employees/<id>
  name: string;
  employee_number?: string;
  start_date?: string;
  /** The org-local day the record was created. */
  created_day: string;
  /** The date the employee has (already_set) or gets (set). Absent for joined_after. */
  tracked_from?: string;
  outcome: TrackedFromOutcome;
};

export type TrackedFromResult = {
  date: string;
  dry_run: boolean;
  counts: Record<TrackedFromOutcome, number>;
  results: TrackedFromRow[];
};

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Plan (dry run) or apply the go-live date. Idempotent: a person is only ever written while their
 * `tracked_from` is still empty, and that condition is repeated in the UPDATE itself, so a date somebody set in
 * the meantime is reported as `already_set` rather than overwritten.
 */
export async function setTrackedFrom(deps: Deps, actor: AppUser, input: { date: string; dryRun: boolean }): Promise<TrackedFromResult> {
  const date = input.date?.trim();
  if (!date || !isYmd(date)) throw invalidArgument("date must be a calendar date (YYYY-MM-DD)");
  // A date in the future would turn the days between now and then into "before HRMS" for everyone, and the
  // people clocking in today would see their own attendance disappear from the grid.
  if (date > (await orgToday(deps))) throw invalidArgument("the date HRMS records start can't be in the future");
  const tz = await orgTimezone(deps);

  const rows = await deps.db
    .select({
      uuid: schema.employees.uuid,
      firstName: schema.employees.firstName,
      lastName: schema.employees.lastName,
      employeeNumber: schema.employees.employeeNumber,
      startDate: schema.employees.startDate,
      trackedFrom: schema.employees.trackedFrom,
      createdAt: schema.employees.createdAt,
    })
    .from(schema.employees)
    .where(isNull(schema.employees.deleteTime));

  const results: TrackedFromRow[] = [];
  const toSet: { row: (typeof rows)[number]; ymd: string }[] = [];
  for (const r of rows) {
    // DATE-ONLY columns read in UTC; the creation instant read in the org's timezone (domain/attendance.ts
    // utcDay vs localDay).
    const startYmd = r.startDate ? utcDay(+new Date(r.startDate)) : undefined;
    const createdDay = localDay(+new Date(r.createdAt), tz);
    const base = {
      employee: `employees/${r.uuid}`,
      name: `${r.firstName} ${r.lastName}`.trim(),
      ...(r.employeeNumber ? { employee_number: r.employeeNumber } : {}),
      ...(startYmd ? { start_date: startYmd } : {}),
      created_day: createdDay,
    };
    if (r.trackedFrom) {
      results.push({ ...base, tracked_from: utcDay(+new Date(r.trackedFrom)), outcome: "already_set" });
    } else if (startYmd && startYmd >= date) {
      results.push({ ...base, outcome: "joined_after" });
    } else {
      const ymd = createdDay > date ? createdDay : date;
      results.push({ ...base, tracked_from: ymd, outcome: "set" });
      toSet.push({ row: r, ymd });
    }
  }

  if (!input.dryRun && toSet.length) {
    const lost = new Set<string>();
    for (const group of chunk(toSet, WRITE_BATCH)) {
      const stmts: CheckedStmt[] = group.map(({ row, ymd }) => ({
        stmt: deps.db
          .update(schema.employees)
          .set({ trackedFrom: new Date(`${ymd}T00:00:00Z`), updatedAt: new Date() })
          .where(and(eq(schema.employees.uuid, row.uuid), isNull(schema.employees.trackedFrom)))
          .returning({ uuid: schema.employees.uuid }),
        expect: 1,
        label: row.uuid,
      }));
      for (const id of await runBatchChecked(deps.db, stmts)) lost.add(id);
    }
    // One entry per person, in the employee's own trail, so "when did this start applying to me" has an answer
    // on their record rather than only in a summary nobody opens.
    const landed = toSet.filter(({ row }) => !lost.has(row.uuid));
    await auditMany(
      deps,
      actor,
      landed.map(({ row, ymd }) => {
        const set = { trackedFrom: new Date(`${ymd}T00:00:00Z`) };
        return { action: "employee.update", entity: "employees", entityId: row.uuid, meta: diffMeta(row, { ...row, ...set }, set, "employees"), snapshot: row };
      }),
    );
    // A row somebody else dated between the read and the write kept THEIR date, which this read never saw - so
    // it is reported as already set, without claiming to know the value.
    if (lost.size) {
      for (const res of results) {
        if (res.outcome !== "set" || !lost.has(res.employee.slice("employees/".length))) continue;
        res.outcome = "already_set";
        delete res.tracked_from;
      }
    }
  }

  const counts: Record<TrackedFromOutcome, number> = { set: 0, already_set: 0, joined_after: 0 };
  for (const r of results) counts[r.outcome]++;
  return { date, dry_run: input.dryRun, counts, results };
}
