# Work schedules

## Context

Today the app has exactly one work schedule, and every reader of it reads the same blob. `settings/attendance`
holds `timezone`, `work_days`, `shift_start`, `shift_end`, `grace_minutes`, `full_day_minutes` and
`half_day_minutes`, and that single record decides, for everyone in the org:

- which days are working days (`domain/attendance.ts` `workingDaysInRange`, `lopDayUnits`, `employmentFraction`)
- which window a day is judged late or early against (`domain/punctuality.ts` `shiftScheduleOf`, `judgeDay`)
- how many worked minutes earn a full or half day (`derivedCredit`)
- what a leave request costs (`domain/leave.ts` `leaveDays`, via `att.work_days`)
- the loss-of-pay divisor and the mid-period proration basis (`services/payroll.ts`)

`shifts` and `shift_assignments` exist, but nothing in attendance, punctuality, leave or payroll reads them.
The roster is a planning grid: assigning Priya to the night shift changes what the Schedule page draws and
nothing else. `domain/punctuality.ts` `shiftScheduleOf` reads `settings/attendance` and never looks at a
roster row.

The consequences:

- A part-timer on Mon/Wed/Fri is marked absent on Tue/Thu, and docked if `lop_enabled` is on.
- A night-shift worker arriving at 21:00 is 12 hours late against the 09:00 org window.
- A 4-hour shift has to clear the org's 480-minute bar to count as a full day, so every such day reads
  "Under hours" and is docked half a day.
- Assigning a roster is busywork that changes nothing anyone is paid or measured on.

This plan makes the day's schedule a per-employee, per-day answer, keeps the org blob as the fallback so no
existing org's numbers move, and turns the roster into the surface that sets it.

## What gets built

### 1. One resolved day, one resolver

New pure module `src/domain/workSchedule.ts`:

```ts
/** What ONE day is for ONE person: the window it is judged against, and what it is worth. */
export type DaySchedule = {
  off: boolean;            // nobody is scheduled - a weekend, a rest day in a rotation, an "off" override
  shiftId?: string;        // the shift this came from; absent means the org's own window
  shiftName?: string;
  startMin: number;        // minutes since midnight, org timezone
  endMin: number;          // less than startMin means the shift runs past midnight
  breakMinutes: number;
  graceMinutes: number;
  fullDayMinutes: number;  // worked minutes that earn a full day
  halfDayMinutes: number;  // worked minutes that earn a half day
  flexible: boolean;       // judged on minutes only; never late, never early
};

/** One employee's schedule, day by day. Every reader takes this instead of `work_days` + minutes. */
export type DayScheduleOf = (ymd: string) => DaySchedule;
```

Resolution is three layers, most specific first:

1. **Day override** - a live `shift_assignments` row for that (employee, date). Either a shift, or an
   explicit rest day.
2. **Pattern** - the work pattern the employee is assigned to over that date, at that position in its cycle.
3. **Org default** - `settings/attendance`, exactly as today: `work_days` decides `off`, `shift_start`/
   `shift_end`/`grace_minutes`/`full_day_minutes`/`half_day_minutes` fill the rest.

`orgScheduleOf(att: AttendanceConfig): DayScheduleOf` builds the layer-3-only resolver. Every call site with
no employee in hand passes that and behaves exactly as it does today, which is what keeps the refactor in
step 5 free of behaviour change.

### 2. Half a day is half the shift

In `resolveDay`, for a day governed by a shift:

```
span  = endMin > startMin ? endMin - startMin : endMin - startMin + 1440   // night shift wraps
paid  = max(0, span - breakMinutes)
full  = shift.full_day_minutes ?? paid
half  = shift.half_day_minutes ?? round(full / 2)
```

`web/src/pages/Schedule.tsx` already computes `spanOf` and `paidOf` this way for the shift picker; that
arithmetic moves into the domain module and both read it from there.

For a day on the org default the numbers stay `att.full_day_minutes ?? 480` and `att.half_day_minutes ?? 240`.
Deriving those from the 09:00-18:00 window would silently move every org's full day from 480 to 540, so the
derivation applies only where a shift actually governs the day.

`shifts` gains four nullable columns, so every existing row keeps behaving:

| column | null means |
|---|---|
| `full_day_minutes` | span minus break |
| `half_day_minutes` | half of the resolved full day |
| `grace_minutes` | the org's `grace_minutes` |
| `flexible_hours` | the org's `flexible_hours` |

### 3. Patterns: the "multiple schedules" part

New collection `work-patterns` - a named cycle, the thing a person is put on:

```
work_patterns
  uuid, code (flat), name, color
  cycle_weeks   integer 1..8
  days          JSON, length cycle_weeks * 7, index = weekIndex * 7 + weekday(0=Sun)
                each entry: a shift uuid, or null for a rest day
  delete_time, created_at, updated_at
```

A 1-week pattern covers "Mon-Fri day shift" and "Mon/Wed/Fri mornings". A 2- or 3-week `cycle_weeks` covers a
rotation. The cycle is one JSON column rather than a child table because it is at most 56 entries and every
read wants all of it; that is one row read per pattern instead of a join.

New collection `work-pattern-assignments` - who is on which pattern, and when. Employee-owned and code-scoped
exactly like `shift-assignments`, so own/dept/all scoping already works:

```
work_pattern_assignments
  uuid, code (owner-embedded), employee_id, pattern_id
  start_date    date-only, UTC midnight
  end_date      date-only, null = open ended
  anchor_date   date-only, null = start_date. Cycle day 0. Two teams on the same rotation offset by a week
                differ only here.
  note, delete_time, created_at, updated_at
```

**Overlap rule.** Two live assignments for one employee may not overlap. A new assignment whose start falls
inside an existing OPEN-ENDED one closes that one the day before and says so in the audit meta - that is the
"Priya moves to the night rotation from March" gesture, and refusing it would make the common case a two-step
chore. Any other overlap is refused with the dates that clash. SQLite cannot express range overlap as an
index, so this is checked in the service on insert and on patch, the same shape as `rosteredOn` in
`services/shiftAssignments.ts`.

History matters because payroll restates closed periods (`services/payroll.ts` `recomputeLopUnits`): someone
who changed pattern in April must have their March loss of pay recomputed against their March pattern. That
is why assignments are date-ranged rather than a single `employees.work_pattern_id` column.

### 4. Rest days on the roster

`shift_assignments.shift_id` is `NOT NULL` today, so a day override cannot say "off". It gains:

- `kind` - `"shift" | "off"`, NOT NULL DEFAULT `'shift'`
- `shift_id` becomes nullable, required only when `kind = 'shift'`

Dropping NOT NULL in SQLite needs a table rebuild (create, copy, drop, rename). That is the one migration in
this plan that is not a plain `ADD COLUMN`. It must carry over all four indexes and the partial unique index
`sa_emp_day_idx ... where delete_time is null`; the plan's verification step checks the index list before and
after. Migrations are append-only, so this is a new numbered file, not an edit to `0000`.

### 5. The pure signatures take the resolver

Mechanical, compiler-checked, no behaviour change. `workDays: number[]`, `fullDayMinutes` and
`halfDayMinutes` come out; `schedOf: DayScheduleOf` goes in.

`src/domain/attendance.ts`
- `workingDaysInRange(startYmd, endYmd, schedOf, holidays)` - counts days where `!schedOf(d).off`
- `lopDayUnits({ ..., schedOf })` - reads the day's own full/half minutes in `derivedCredit`
- `employmentFraction({ ..., schedOf })`
- `eventCreditByDay({ ..., schedOf })` - an all-day event credits that day's full-day minutes
- `unpaidLeaveDayUnits(startYmd, endYmd, schedOf, holidays, ranges)`

`src/domain/punctuality.ts`
- `punctualityOverPeriod({ ..., schedOf })` - `startMin`, `endMin`, `grace` and `flexible` per day
- `periodLop({ ..., schedOf })`, `owedDays({ ..., schedOf })`
- `checkFiling({ ..., sched })` - `sched` becomes the resolved `DaySchedule` for `ctx.date`, so a late
  arrival is measured against the shift that day actually had
- `shiftScheduleOf` stays, as the reader of the org blob that `orgScheduleOf` is built on

`src/domain/leave.ts`
- `leaveDays(...)` and `daysByMonth(...)` take `schedOf` in place of `workDays`. `kindOf` calls a day
  "weekend" when `schedOf(d).off`.

The night-shift wrap needs one decision in `judgeDay`: a shift whose `endMin < startMin` ends on the next
calendar day, so "left early" compares against `endMin + 1440` when the departure punch is past midnight.
`punchDays` already groups by the clock-in's local day, so the day a night shift belongs to is its start day.

### 6. Loading the context on the server

New `src/services/workSchedule.ts`:

```ts
export async function scheduleCtxFor(
  deps: Deps, employeeIds: string[], fromYmd: string, toYmd: string,
): Promise<Map<string, DayScheduleOf>>
```

Three reads for a whole payroll run, whatever the headcount:

1. the shift catalogue - added to `src/lib/refData.ts` as `refShifts`, for the reason every table there is
   there: `batch:run` and the payroll build read it repeatedly within one request
2. `work_pattern_assignments` overlapping the window for those employees
3. `shift_assignments` overlapping the window for those employees (the existing `sa_date_idx`)

Then a memoized closure per employee. `assembleLop` gains two queries total, not two per person.

`workingDaysInPeriod` - today one number, used as the loss-of-pay divisor - becomes a `Map<employeeId, number>`
computed in the same walk, and `employeeLop` reads its own.

### 7. The gate

Turning this on changes what existing rosters mean: an org that has been using the roster as a planning grid
would find those rows suddenly governing pay. So `settings/attendance` gains:

```
schedule_source: "org" | "resolved"     // default "org"
```

`"org"` is layer 3 only, which is exactly today. `"resolved"` runs the three layers. Existing orgs stay on
`"org"` until HR switches it, and the Settings panel says in a sentence what switching does. New orgs seed
`"resolved"`.

`validateAttendance` in `src/routes/settings.ts` gains the key to its closed vocabulary, beside `lop_basis`
and `proration_basis`.

### 8. Roster UI

`web/src/pages/Schedule.tsx`:

- **Span** - Week / 2 weeks / 4 weeks / Month, replacing the fixed seven columns. The table is already
  `overflow-x-auto`; a month is 31 columns with a frozen name column. `ROSTER_ROW_CAP` stays, and the
  truncation notice already in place covers a long span.
- **Resolved cells** - this is the part that keeps the page honest. Once patterns exist, an empty cell no
  longer means "unscheduled", it means "whatever the pattern says". Cells rendered from a pattern get a
  lighter treatment (tint only, no border); day overrides stay solid; rest days show a dash. The row header
  names the pattern the person is on for the visible span.
- **Assign a schedule** - select people (or a department), pick a pattern, pick a date range, one
  `work-pattern-assignments` write each. No roster rows are generated.
- **Save this week as a schedule** - takes the seven cells just drawn and offers them as a new 1-week pattern.
  This is what makes patterns discoverable from the place people already are, rather than an admin chore in
  Settings.
- **Off** joins the shift cards in the cell dialog.

The existing per-day dialog, its multi-day spread within the visible span, and the `runSequential` write path
are unchanged.

`web/src/pages/ShiftsAdmin.tsx` gains the four new shift fields (each showing the derived default as its
placeholder, so "half day" reads `240` under a 09:00-13:00 shift without anyone typing it) and a Schedules
editor for patterns beside the shifts list.

### 9. The client's copy of the rule

The SPA imports `src/domain/*` directly today (`web/src/lib/attendance.ts` imports `leaveCover` and
`judgeDay` for exactly this reason - a second copy of the rule is how the grid and the payroll build came to
disagree). `domain/workSchedule.ts` is pure, so the same applies.

- `web/src/lib/clock.tsx` - `sched` becomes `{ org: AttendanceSchedule; today: DaySchedule }`. Today's
  resolved day rides the bootstrap prefetch so the top bar costs no extra round trip.
- `web/src/pages/Attendance.tsx` - the month grid needs the resolver over the visible range, assembled by
  `web/src/lib/workSchedule.ts` from the four collections the page can already read.
- `buildAttendanceRows` and `statsOf` in `web/src/lib/attendance.ts` take `schedOf` in place of `sched`.
  `statsOf`'s `expectedMinutes` becomes the sum of each counted day's own `fullDayMinutes` rather than
  `expectedDays * fullDayMinutes`, which is what makes the ledger read correctly for a mixed week.
- `web/src/pages/LateEarly.tsx`, `Overtime.tsx`, `components/common/TeamTimeline.tsx` follow.

### 10. What follows for part-time

With the resolver in place, the gaps a part-timer hits close by construction:

- Tue/Thu are `off` for a Mon/Wed/Fri pattern, so nothing is owed and nothing is docked.
- A 4-hour shift's full day is 240 minutes and its half day 120.
- `leaveDays` charges only that person's working days, so a Mon-Fri week of leave costs a Mon/Wed/Fri
  part-timer 3 days. Nobody is on a pattern until HR puts them on one, so no existing balance moves.
- The loss-of-pay divisor is that person's scheduled days.
- `employmentFraction` on the `working_days` basis prorates a mid-month joiner against their own days.
- `services/peopleAnalytics.ts` `expectedWorkingDays` is per person, so "days absent" and "remote share" stop
  measuring a part-timer against a full-timer's calendar.

Still out of scope, and unchanged by this plan: hourly pay. `pay_components.method` has no `per_hour`, and
`time_entries` do not reach payroll. A part-timer is paid a monthly figure prorated by days, not by hours.
Noted so it is a decision rather than an omission.

## Order of work

Each step is shippable and green on its own.

1. `domain/workSchedule.ts` + `orgScheduleOf`. Refactor every pure signature in step 5 to take `schedOf`.
   Every call site passes `orgScheduleOf(att)`. Zero behaviour change; existing tests adapt at the boundary.
2. `services/workSchedule.ts` + `refShifts`. Wire `scheduleCtxFor` into `services/payroll.ts`
   (`assembleLop`, `employeeLop`, the proration block and the divisor), `services/settlements.ts`,
   `services/leaveRequests.ts`, `services/leaveHistoryImport.ts`, `services/attendanceDayMarks.ts`
   (`assertOwedDay`), `services/lateEarlyRequests.ts`, `services/peopleAnalytics.ts`. Behind
   `schedule_source`, defaulting to `"org"`: still zero behaviour change.
3. Migration: the four `shifts` columns. `resolveDay` derives full/half from the span. Turning on
   `schedule_source: "resolved"` now makes day overrides govern the day.
4. Migration: the `shift_assignments` rebuild for `kind` + nullable `shift_id`.
5. Migration + collections: `work-patterns`, `work-pattern-assignments`. Full add-a-resource checklist -
   spec, route, mount, serializer, `authzResolve.TABLES`, `encodeWireIds.ENCODABLE`, `bootstrap/authz/grants.ts`,
   `bootstrap/authz/policy.ts`, `permMatrix.ts` `COLLECTION_GROUPS`, `collectionMeta.ts`, `searchIndex.ts`,
   `codeCascade.ts`, `nav.ts` / `entityKinds.ts` / `resourceRoute.ts`, then regenerate `scripts/seed.sql` and
   `bootstrap/bootstrap.sql`.
6. `web/src/lib/workSchedule.ts`: the same resolver in the browser, assembled from the shift and pattern
   catalogs plus the two assignment lists.
7. Roster UI: span, resolved cells, assign-a-schedule, Off. ShiftsAdmin's day-length fields and the schedules
   editor.
8. The consequences in step 10: analytics, the Attendance page's expected-minutes ledger, the Leave page's
   working-day hints.

## Files

New:
- `src/domain/workSchedule.ts`, `src/services/workSchedule.ts`, `src/routes/workPatterns.ts`,
  `src/routes/workPatternAssignments.ts`, `src/routes/workSchedule.ts`
- `web/src/settings/WorkPatternsPanel.tsx`
- `src/db/migrations/0008_shift_day_lengths.sql`, `0009_shift_assignment_kind.sql`, `0010_work_patterns.sql`
- `test/workSchedule.test.ts`, `test/workPatternAssignments.test.ts`, `e2e/workPatterns.spec.ts`

Changed, the ones that carry the design:
- `src/domain/attendance.ts`, `src/domain/punctuality.ts`, `src/domain/leave.ts`, `src/domain/leaveRestrictions.ts`
- `src/services/payroll.ts` (`assembleLop`, `employeeLop`, the proration and divisor block around 1000-1150),
  `src/services/settlements.ts`, `src/services/leaveRequests.ts`, `src/services/attendanceDayMarks.ts`,
  `src/services/lateEarlyRequests.ts`, `src/services/peopleAnalytics.ts`
- `src/db/schema.ts`, `src/lib/refData.ts`, `src/http/serialize.ts`, `src/routes/settings.ts`, `src/index.ts`
- `web/src/lib/attendance.ts`, `web/src/lib/clock.tsx`, `web/src/lib/leaveDays.ts`,
  `web/src/pages/Schedule.tsx`, `web/src/pages/ShiftsAdmin.tsx`, `web/src/pages/Attendance.tsx`,
  `web/src/pages/LateEarly.tsx`, `web/src/pages/Overtime.tsx`, `web/src/components/common/TeamTimeline.tsx`
- `openapi.yaml`

## Verification

Unit, per step:
- `test/workSchedule.test.ts` - the three layers in priority order; the half-of-the-shift default; an explicit
  `half_day_minutes` beating it; a night shift's span; a rotation's cycle position against its `anchor_date`;
  an assignment's last day and the day after it.
- `test/workPatternAssignments.test.ts` - the overlap rule through the real service: a window inside a closed
  one refused by its dates, two schedules starting the same day refused, a window starting the day the last
  one ended allowed, an open-ended predecessor closed the day before a new one starts, a PATCH onto another
  live window refused, a withdrawn assignment ignored - then what each resolves to, and that the gate makes
  all of it inert.
- `test/punctuality.test.ts` - a shift that runs past midnight: late before midnight, early after it, and
  leaving an hour in (which a plain wall-clock comparison read as staying late).
- `test/attendanceLop.test.ts`, `test/lopRestate.test.ts`, `test/punctuality.test.ts`,
  `test/attendanceGrid.test.ts`, `test/leave.test.ts`, `test/leaveRestrictions.test.ts`,
  `test/attendanceDayMarks.test.ts`, `test/attendanceSettings.test.ts` - after step 1 they pass unchanged
  except for building `orgScheduleOf(att)` at the boundary. That is the check that step 1 moved no behaviour.
- New cases in `test/attendanceLop.test.ts`: a Mon/Wed/Fri pattern owes nothing on Tue/Thu; a 4-hour shift
  reads a 4-hour day as full and a 2-hour day as half; a day override beats the pattern; a rest-day override
  beats a working pattern day.
- `test/payroll.test.ts` - the divisor is per employee; two people in one run on different patterns get
  different per-day rates from the same gross.
- `test/collections.test.ts` and `test/collectionLaneDrift.test.ts` - the two new collections are factory-built
  and grantable in the permissions matrix.

Migration:
- `.schema shift_assignments` and `PRAGMA index_list(shift_assignments)` before and after 0009, against a
  restored copy of production, to confirm the rebuild kept `sa_emp_day_idx` partial and the other four indexes.
- Run the change-stamp trigger check across migrations (`genChangeDdl` prints the delta) for the three new
  tables and columns.

Contract and types:
- `npm run api:lint` (the flow-mapping comma trap in `openapi.yaml` shows up as a useless
  "reading 'enum'" from spectral)
- `./node_modules/.bin/tsc` and check `$?` - the output is filtered, so the exit code is the verdict

End to end (`npm run test:e2e -- <spec>`, never the full suite):
- `e2e/schedule.spec.ts`, `e2e/scheduleSpread.spec.ts` - the existing roster still assigns and spreads
- `e2e/workPatterns.spec.ts` - switch the org onto resolved schedules, define a four-hour shift (checking the
  editor offers the derived full and half day rather than storing them), build a Mon/Wed/Fri cycle from it,
  assign it to somebody from the roster, and confirm the grid then draws their working days from the schedule
  and the days between as not working - then roster over a rest day and confirm the entry wins.

Whole gate: `npm run verify`.

## Where the build differs from this plan

- **One migration, not three.** `0008_work_schedules.sql` carries the two new tables, the four `shifts`
  columns and the `shift_assignments` rebuild. The rebuild is hand-written: drizzle-kit generated a `SELECT`
  naming the `kind` column from the OLD table, which has none, and it dropped the six triggers `DROP TABLE`
  takes with it without recreating them. Both are fixed in the file, and the change-stamp and search-index
  triggers for the two new collections are appended there rather than to the newest migration, because 0008
  is where their tables are created.
- **No `GET /v1/work-schedule`.** A virtual route needs three edits in `middleware/authz.ts` plus the two
  copies of `AGGREGATE_ROUTES` the tests keep, to serve data the SPA can already read. `domain/workSchedule.ts`
  is pure, so `web/src/lib/workSchedule.ts` assembles the same resolver from four collections the roster
  already fetches. One rule, no new registry entries.
- **Retiring a schedule does not refuse.** `refWorkPatterns` includes soft-deleted rows, so a retired pattern
  keeps resolving for the people still on it - the reading `refPayGrades` makes of a retired grade a signed
  revision was priced at. `assignedCount` is there for the UI to say how many people that is; dropping them
  back onto the org's week would change what they are owed by way of a catalog edit.
- **Span tops out at four weeks**, not a calendar month: 28 columns is the width a cell can still name a
  shift in, and every month then draws at one width.
- **The gate binds the browser too.** `web/src/lib/workSchedule.ts` returns the org's own week while
  `schedule_source` is "org", exactly as `services/workSchedule.ts` does. Without it the roster would draw a
  pattern's days as covered while the payroll build had never heard of them - the drift the gate exists to
  prevent, arriving from the other side.
- **The leave dialog resolves the requester's own days.** `services/leaveRequests.ts` charges against them, so
  a form quoting the org's week would tell a part-timer a Mon-Fri week costs five days and then spend three.
  Two narrowed reads, and only while the org resolves days per person.

## Open questions

1. **Cycle ceiling.** `cycle_weeks` 1..8 covers every rotation worth naming, at 56 JSON entries. Longer than
   that is a calendar, not a pattern.
2. **Minute-weighted loss of pay.** A day-unit stays a day-unit, so someone whose pattern mixes a 6-hour and a
   4-hour day is docked the same for either. Correct against their own monthly wage and consistent with how
   the divisor is built, but an `lop_basis: "hours"` is the honest version and is not in this plan.
3. **Mirroring the current pattern onto `employees`.** `positions` mirrors job title and department onto the
   employee row because the directory reads them per row. Nothing lists a schedule today, so this plan does not
   add the column. If the directory or the org chart starts showing it, that is the precedent to follow.
