import { allocFlatCode, allocOwnedCode } from "./services/codeAlloc";
import { eq, and, or, ne, isNull, lte, lt, sql, inArray } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Deps } from "./deps";
import { processPayslipRunJob } from "./services/payroll";
import { runDeferredActions, runWorkflowTimer, runScheduledAutomations, withDispatchBudget } from "./services/automationEngine";
import { flushDigests } from "./services/notificationDigest";
import { generateRecurringExpenses } from "./services/expenses";
import { checkBudgetThresholds, openRecurringBudgetPeriods } from "./services/expenseBudgets";
import { emitEvent } from "./services/eventBus";
import { accrueLeave } from "./services/leaveAccrual";
import { generateComplianceOccurrences } from "./services/complianceRules";
import { nudgeStaleAcks } from "./services/documentAck";
import { awardReferralBonuses } from "./services/referrals";
import { nudgeMissingScorecards } from "./services/ats";
import { reconcilePendingEsign } from "./services/esign/callback";
import { publishDueAnnouncements } from "./services/announcements";
import { nextOccurrence } from "./services/events";
import { purgeExpiredAccessRules } from "./services/accessRules";
import { creditHolidayCompOff } from "./services/compOff";
import { getSettingValue } from "./services/settings";
import { renderEmail, loadEmailBrand } from "./lib/emailLayout";
import { notify, managerIdOf } from "./services/notifications";
import { leaveCaps, encashedDaysThisYear, createAutoEncashment } from "./services/leaveEncashments";
import { calendarYearOf, splitCarryForward, splitCarryForwardCumulative, splitEncashExcess } from "./domain/carryForward";
import { custodyPolicy, daysBetween } from "./domain/assetCustody";

import { round2 } from "./domain/money";
import { refLeaveTypes, refHolidays } from "./lib/refData";

// The scheduled triggers this Worker handles (must mirror wrangler.toml `crons`). Exported so the manual
// trigger (cron-runs:run) can validate the requested expression against the real, dispatchable set.
export const KNOWN_CRONS = ["*/5 * * * *", "0 2 * * *"] as const;

// Each tick records a cron_runs row (running -> done/error + duration + summary) so the schedule is
// observable. Split into start/finish so the manual trigger can return the "running" row immediately and
// finish the (potentially long, all-employees) work in the background via ctx.waitUntil.

// Create the cron_runs row in "running" state and return its id + start time. Cheap; safe to await in-request.
export async function startCronRun(cron: string, deps: Deps): Promise<{ runId: string; start: number }> {
  const start = +deps.clock.now();
  const runId = (await deps.db
    .insert(schema.cronRuns)
    .values({ code: await allocFlatCode(deps, schema.cronRuns), cron, status: "running", startedAt: new Date(start) })
    .returning())[0]!.uuid;
  return { runId, start };
}

// Run the actual work for an already-started run and stamp done/error. Safe to run detached (waitUntil): it
// swallows nothing silently - the error is recorded on the row - but it does not rethrow when detached.
export async function finishCronRun(cron: string, deps: Deps, runId: string, start: number, rethrow = true): Promise<void> {
  try {
    const { summary, failures } = await dispatchCron(cron, deps);
    const end = +deps.clock.now();
    // A tick that lost a subtask is NOT a good tick. Every subtask is best-effort (one failure must not cost
    // the other twelve), which used to mean a failed accrual still stamped `done` with a zero count - green in
    // the Operations UI, wrong in fact. Naming the failed subtasks on the row is what makes the difference
    // visible to someone who is not reading Workers Logs. `error` is reused rather than adding a `partial`
    // state: the schema keeps one migration, and "some of this tick did not happen" is the actionable bit.
    await deps.db
      .update(schema.cronRuns)
      .set({
        status: failures.length ? "error" : "done",
        finishedAt: new Date(end),
        durationMs: end - start,
        summaryJson: JSON.stringify(summary),
        error: failures.length ? `subtasks failed: ${failures.join(", ")}` : null,
      })
      .where(eq(schema.cronRuns.uuid, runId));
  } catch (e) {
    const end = +deps.clock.now();
    await deps.db
      .update(schema.cronRuns)
      .set({ status: "error", finishedAt: new Date(end), durationMs: end - start, error: String(e) })
      .where(eq(schema.cronRuns.uuid, runId));
    if (rethrow) throw e;
  }
}

// Scheduled-handler entry point: start + finish, fully awaited (the platform gives the scheduled worker its
// own lifetime). Returns the row id.
export async function runScheduled(cron: string, deps: Deps): Promise<string> {
  const { runId, start } = await startCronRun(cron, deps);
  await finishCronRun(cron, deps, runId, start);
  return runId;
}

// One tick's best-effort runner. A subtask failure must not abort the tick, must not vanish (Workers Logs are
// persisted), and must not leave the tick looking successful - so the wrapper both logs and records the name,
// which finishCronRun turns into an `error` cron_runs row. Per-tick rather than module-level state, so
// concurrent ticks (a manual trigger overlapping the schedule) cannot borrow each other's failures.
// A subtask is an ORIGINATING ACTION, so each gets its own automation dispatch budget (the whole tick shares
// one Deps; without this the fiftieth event of the night silently dropped every emission after it, including
// every later subtask's). `run` therefore takes a THUNK rather than an already-started promise - the budget has
// to be armed before the work begins. A budget that actually refused something is a lost automation, so it goes
// on the cron_runs row next to a thrown failure rather than only into Workers Logs.
function subtasks(deps: Deps) {
  const failures: string[] = [];
  const run = (name: string, work: () => Promise<number>): Promise<number> =>
    withDispatchBudget(deps, work)
      .then(({ result, dropped }) => {
        if (dropped > 0) {
          console.warn(`cron subtask ${name} dropped ${dropped} automation dispatch(es) at the ${name} budget ceiling`);
          failures.push(`${name} (${dropped} automation dispatch(es) dropped)`);
        }
        return result;
      })
      .catch((err) => {
        console.error(`cron subtask ${name} failed (non-fatal)`, err);
        failures.push(name);
        return 0;
      });
  return { run, failures };
}

async function dispatchCron(cron: string, deps: Deps): Promise<{ summary: Record<string, number>; failures: string[] }> {
  const { run, failures } = subtasks(deps);
  if (cron === "*/5 * * * *") {
    // Scheduled board posts ride the fast tick, not the nightly one: an announcement set for 09:00 has to land
    // at 09:00, give or take the tick. Best-effort - a failure here must not stop the job queue draining.
    const announcementsPublished = await run("publishDueAnnouncements", () => publishDueAnnouncements(deps));
    // The drain runs jobs authored by other people's rules, so it gets its own budget too rather than
    // inheriting whatever the announcement publish spent.
    const drained = await run("drainJobs", () => drainJobs(deps, 20));
    return { summary: { drained, announcementsPublished }, failures };
  }
  if (cron === "0 2 * * *") {
    // Carry-forward runs BEFORE accrual so it caps last year's balance before the new year accrues on top.
    // Both are best-effort like everything else here: leave balances are the most consequential thing the tick
    // touches, but an exception in accrual is not a reason to also skip reminders, digests and e-sign
    // reconciliation. The tick stays alive and the run goes red naming what failed.
    const carriedForward = await run("carryForwardLeave", () => carryForwardLeave(deps));
    const accrued = await run("accrueLeave", () => accrueLeave(deps));
    // Roll the compliance-calendar horizon forward (best-effort; never aborts the tick).
    const complianceGenerated = await run("generateComplianceOccurrences", () => generateComplianceOccurrences(deps));
    // Award referral bonuses whose referred hire reached the configured milestone (best-effort).
    const referralBonuses = await run("awardReferralBonuses", () => awardReferralBonuses(deps));
    // Reminders are best-effort: an email failure must never abort the accrual tick.
    const reminders = await run("sendReminders", () => sendReminders(deps));
    // Time-based domain events (probation ending, work anniversary, document expiring) so automations can react
    // to the passage of time, not just user actions. Best-effort - never aborts the tick.
    const scheduledEvents = await run("emitScheduledEvents", () => emitScheduledEvents(deps));
    // Fire time-driven automation rules whose recurrence matches today (weekly nudges, month-start prep,
    // per-employee smart reminders). Guarded per-day so a re-run can't double-fire. Best-effort.
    const scheduledAutomations = await run("runScheduledAutomations", () => runScheduledAutomations(deps));
    // Flush queued digest notifications into one summary per recipient (best-effort).
    const digestsFlushed = await run("flushDigests", () => flushDigests(deps));
    // Chase unconfirmed asset custody: nudge holders who owe a scan, flag stock nobody counted in, and mark
    // assets nobody has sighted in months as stale (best-effort).
    const assetCustody = await run("remindAssetCustody", () => remindAssetCustody(deps));
    // Generate due recurring expenses (rent, subscriptions) and raise budget-threshold alerts (best-effort).
    const recurringExpenses = await run("generateRecurringExpenses", () => generateRecurringExpenses(deps));
    const budgetAlerts = await run("checkBudgetThresholds", () => checkBudgetThresholds(deps));
    // Recurring caps open their next period once the current one closes, so no month goes unbudgeted.
    const budgetPeriodsOpened = await run("openRecurringBudgetPeriods", () => openRecurringBudgetPeriods(deps));
    // Reconcile e-sign documents stuck pending (missed/dropped vendor webhook): poll the vendor or auto-expire
    // past the signing window. Best-effort - never aborts the tick.
    const esignReconciled = await run("reconcilePendingEsign", () => reconcilePendingEsign(deps));
    // Recurring 1:1s roll forward once their date passes, and tomorrow's 1:1s get a day-before nudge.
    const checkInsRolled = await run("rollRecurringCheckIns", () => rollRecurringCheckIns(deps));
    const checkInReminders = await run("remindUpcomingCheckIns", () => remindUpcomingCheckIns(deps));
    // Repeating events (the weekly all-hands, the yearly Founders' Day) create their next occurrence once the
    // current one has finished, one step at a time.
    const eventsRolled = await run("rollRepeatingEvents", () => rollRepeatingEvents(deps));
    // Optional-holiday picks going spare, ahead of the org's pick-by date (best-effort).
    const holidayPickReminders = await run("remindOptionalHolidayPicks", () => remindOptionalHolidayPicks(deps));
    // Policies still unsigned: nudge the outstanding people at 3, 7 and 14 days, then emit ackOverdue so a
    // rule can escalate. Publishing a policy used to be the only time anyone was ever asked.
    const ackNudges = await run("nudgeStaleAcks", () => nudgeStaleAcks(deps));
    // Interviews held with scorecards still owed: nudge the panelists at 1, 3 and 7 days, then emit
    // scorecardOverdue so a rule can escalate. A hiring decision stalls on silence more often than on
    // disagreement, and nothing used to ask twice.
    const scorecardNudges = await run("nudgeMissingScorecards", () => nudgeMissingScorecards(deps));
    // Comp-off for anyone who worked yesterday's holiday (opt-in; idempotent per employee+day).
    const compOffCredited = await run("creditHolidayCompOff", () => creditHolidayCompOff(deps));
    // Sweep lapsed temporary access rules. They already stopped deciding at their expiry instant (policyLoad
    // filters on it), so this is table hygiene, not the enforcement mechanism.
    const accessRulesExpired = await run("purgeExpiredAccessRules", () => purgeExpiredAccessRules(deps));
    return {
      summary: { carriedForward, accrued, complianceGenerated, referralBonuses, reminders, scheduledEvents, scheduledAutomations, digestsFlushed, assetCustody, recurringExpenses, budgetAlerts, budgetPeriodsOpened, esignReconciled, checkInsRolled, checkInReminders, eventsRolled, holidayPickReminders, ackNudges, scorecardNudges, compOffCredited, accessRulesExpired },
      failures,
    };
  }
  return { summary: {}, failures };
}

// A job left `running` longer than this was almost certainly orphaned by a mid-tick crash (real jobs are
// bounded batches that finish in seconds, and an LRO that legitimately resumes stamps `updated_at` on each
// claim - see schema.ts `updated()`, which carries $onUpdateFn so the clock this cutoff reads actually moves).
// Such a job is reclaimed to `queued` so it gets retried instead of hanging forever.
const STALE_RUNNING_MS = 10 * 60 * 1000;
type JobRow = typeof schema.jobs.$inferSelect;

// A failing job is retried on a widening delay, not parked on its first error. Most job failures are transient
// (a D1 blip mid-batch, a vendor 503), and a payslip run that dies at attempt 1 with no retry is a month of
// payslips nobody notices are missing until an employee asks. Past the cap it stops retrying and STAYS `error`:
// that terminal state IS the dead-letter queue, already listed on the Operations page with a Retry button, so a
// human keeps the last word. The delay rides `jobs.run_after`, which the drain already honours - no new column.
const MAX_JOB_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const backoffMs = (attempts: number): number => RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]!;

// Kinds whose failure someone is waiting on, and can act on. Engine-internal kinds (`automation.action`,
// `workflow.timer`) are deliberately excluded: they already record an automation_runs row for the Workflows UI,
// and the employee a rule happens to be ABOUT is not the person who can fix a broken rule.
const OWNER_NOTIFIED_KINDS = new Set(["payslip.generateRun"]);

// Tell the job's owner when it has given up for good. `notify` is itself best-effort (it swallows), so this
// cannot turn a job failure into a tick failure.
async function notifyJobDeadLetter(deps: Deps, job: JobRow, error: string): Promise<void> {
  if (!job.employeeId || !OWNER_NOTIFIED_KINDS.has(job.kind)) return;
  await notify(deps, {
    recipient: job.employeeId,
    type: "system.jobFailed",
    title: "Background job failed",
    body: `${job.kind} gave up after ${MAX_JOB_ATTEMPTS} attempts: ${error.slice(0, 300)}`,
    link: "operations",
    subject: `operations/${job.uuid}`,
    priority: "high",
    action: "retry",
  });
}

// Run one job through its state machine. Returns "requeued" if an LRO asked to resume next tick (state
// unchanged from the queue's perspective), "skipped" if another drain claimed it first, else "done"/"error".
// Idempotent per call; never throws.
async function processOneJob(deps: Deps, job: JobRow): Promise<"done" | "error" | "requeued" | "skipped"> {
  // GUARDED CLAIM, not a bare flip: the `queued` predicate is what makes at-most-one-runner true. Two drains
  // overlap for real - `cron-runs:run` fires a tick on demand (routes/cronTrigger.ts) with no lock against the
  // schedule - and both select the same queued rows before either writes. Whoever's UPDATE reports a changed
  // row owns the job; the loser sees zero and leaves it alone, instead of both running the same automation
  // actions (duplicate email/notifications) or the same payslip batch.
  const claim = await deps.db
    .update(schema.jobs)
    .set({ status: "running" })
    .where(and(eq(schema.jobs.uuid, job.uuid), eq(schema.jobs.status, "queued")))
    .returning({ uuid: schema.jobs.uuid });
  if (!claim.length) return "skipped";
  try {
    if (job.kind === "payslip.generateRun") {
      const res = await processPayslipRunJob(deps, job.uuid, JSON.parse(job.payload));
      if (!res.done) {
        // Clear any backoff left over from an earlier failed attempt: this is a healthy LRO asking to continue
        // next tick, and it must not inherit an hour-long delay set when the same job last errored.
        await deps.db.update(schema.jobs).set({ status: "queued", runAfter: null }).where(eq(schema.jobs.uuid, job.uuid));
        return "requeued";
      }
    } else if (job.kind === "automation.action") {
      // A deferred (`wait`) automation payload whose delay has elapsed - run its actions with system authority.
      await runDeferredActions(deps, JSON.parse(job.payload));
    } else if (job.kind === "workflow.timer") {
      // A durable timer arm of a suspended `waitFor` whose delay elapsed before any event arm fired.
      await runWorkflowTimer(deps, JSON.parse(job.payload));
    }
    await deps.db.update(schema.jobs).set({ status: "done" }).where(eq(schema.jobs.uuid, job.uuid));
    return "done";
  } catch (e) {
    const attempts = job.attempts + 1;
    const retry = attempts < MAX_JOB_ATTEMPTS;
    await deps.db
      .update(schema.jobs)
      .set(
        retry
          ? { status: "queued", attempts, lastError: String(e), runAfter: new Date(+deps.clock.now() + backoffMs(attempts)) }
          : { status: "error", attempts, lastError: String(e) },
      )
      .where(eq(schema.jobs.uuid, job.uuid));
    console.error(`job ${job.kind} ${job.uuid} failed (attempt ${attempts}/${MAX_JOB_ATTEMPTS}, ${retry ? "will retry" : "terminal"})`, e);
    if (!retry) await notifyJobDeadLetter(deps, job, String(e));
    // A retry is queue-neutral, like an LRO that asked to resume: the row is back in `queued` and this tick
    // advanced nothing, so it is not counted as processed.
    return retry ? "requeued" : "error";
  }
}

// Re-queue jobs orphaned in `running` so the drain retries them. Returns how many were reclaimed.
//
// The cutoff is only meaningful because `updated_at` moves on every write (schema.ts `updated()` carries
// $onUpdateFn): a job claimed this tick stamps a fresh timestamp, so a drain that overlaps another tick's
// in-flight work no longer mistakes it for an orphan and yank it back to `queued` underneath the runner.
// Filtered in SQL rather than read-all-then-filter - `running` is normally a handful of rows, but D1 bills
// rows read and this runs on every five-minute tick.
async function reclaimStuckJobs(deps: Deps): Promise<number> {
  const cutoff = new Date(+deps.clock.now() - STALE_RUNNING_MS);
  const stale = await deps.db
    .update(schema.jobs)
    .set({ status: "queued", attempts: sql`${schema.jobs.attempts} + 1` })
    .where(and(eq(schema.jobs.status, "running"), lt(schema.jobs.updatedAt, cutoff)))
    .returning({ uuid: schema.jobs.uuid });
  return stale.length;
}

// Bounded batch keeps each tick within Worker CPU limits. LRO jobs may re-queue themselves to resume.
// Reclaims orphaned `running` jobs first (they get picked up in this same drain), then processes the queue.
// Returns the number of jobs whose state advanced this tick.
async function drainJobs(deps: Deps, limit: number): Promise<number> {
  await reclaimStuckJobs(deps);
  // A queued job runs when it has no runAfter, or its runAfter has passed (delayed automation actions).
  const now = deps.clock.now();
  const queued = await deps.db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, "queued"), or(isNull(schema.jobs.runAfter), lte(schema.jobs.runAfter, now))))
    .limit(limit);
  let processed = 0;
  for (const job of queued) {
    // A requeue is queue-neutral (the row is back in `queued`, nothing advanced) and a skip means another
    // drain owns it - neither is work this tick did, so neither counts.
    const outcome = await processOneJob(deps, job);
    if (outcome !== "requeued" && outcome !== "skipped") processed++;
  }
  return processed;
}

// Run a single job on demand (the operations:run custom method). A `done` job is a no-op; queued / errored
// / orphaned-running jobs are (re)processed. Returns the fresh row for the response.
export async function runJob(deps: Deps, jobId: string): Promise<JobRow | undefined> {
  const job = (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.uuid, jobId)).limit(1))[0];
  if (!job) return undefined;
  if (job.status !== "done") await processOneJob(deps, job);
  return (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.uuid, jobId)).limit(1))[0];
}


type LeaveTypeRow = typeof schema.leaveTypes.$inferSelect;

// Year-end carry-forward: caps each balance at the carry-forward limit (per-type or one cumulative cap) and
// either auto-encashes the excess (up to the encashment cap) or forfeits it - all driven by the leave_caps
// settings. Idempotent per calendar year via leave_balances.lastCarryForwardYear; a never-stamped row is just
// initialized (no forfeiture) so the first run can't strip mid-year balances. Runs BEFORE accrual.
export async function carryForwardLeave(deps: Deps): Promise<number> {
  const year = calendarYearOf(deps.clock.now());
  const caps = await leaveCaps(deps);
  const employees = await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"));
  const leaveTypes = await refLeaveTypes(deps);
  const ltById = new Map(leaveTypes.map((lt) => [lt.uuid, lt] as const));
  // All balances in one read, grouped per employee: on an ordinary night (everything already stamped for
  // `year`) the whole subtask costs 3 reads, not one per employee. This snapshot is only a cheap "is there
  // anything to roll over" probe - the rollover itself re-reads the employee's rows (below), because it
  // writes ABSOLUTE balances and a stale one would restore days already spent. The per-row guarded claims
  // are rollover-only writes and deliberately stay individual - each claim gates a payout on its own result.
  const balByEmp = new Map<string, (typeof schema.leaveBalances.$inferSelect)[]>();
  for (const b of await deps.db.select().from(schema.leaveBalances)) {
    const arr = balByEmp.get(b.employeeId);
    if (arr) arr.push(b);
    else balByEmp.set(b.employeeId, [b]);
  }
  let processed = 0;

  for (const emp of employees) {
    if (emp.deleteTime) continue;
    if (!(balByEmp.get(emp.uuid) ?? []).some((b) => b.lastCarryForwardYear !== year)) continue;
    // There IS work for this employee, so pay for one fresh read of their rows. Carry-forward collapses the
    // balance to the carried days and sizes an auto-encashment PAYOUT from the excess, both derived from the
    // balance it reads - computing either off the org-wide snapshot taken at the top of this subtask would
    // silently hand back days spent in between and pay out cash for them. Rollover is one night a year (and
    // already does per-row writes), so the extra read is only spent on the night that needs it.
    const balances = await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp.uuid));
    const due = balances.filter((b) => b.lastCarryForwardYear !== year);
    if (due.length === 0) continue;

    // Never-stamped rows: initialize to this year with no forfeiture (one chunked statement for the
    // employee's rows - a first-deploy night stamps every row in the org, and per-row writes would eat the
    // subrequest budget). Earlier-year rows actually roll over.
    const roll = due.filter((b) => b.lastCarryForwardYear != null);
    const init = due.filter((b) => b.lastCarryForwardYear == null);
    if (init.length) {
      await deps.db
        .update(schema.leaveBalances)
        .set({ lastCarryForwardYear: year, updatedAt: new Date() })
        .where(inArray(schema.leaveBalances.uuid, init.map((b) => b.uuid)));
    }
    if (roll.length === 0) continue;

    // (carried, excess) per balance row, by mode. Cumulative mode splits ONE shared cap across the rows
    // passed in, so a retry below re-runs this over what is still pending against the cap that is still free.
    type BalanceRow = typeof schema.leaveBalances.$inferSelect;
    const splitsFor = (rows: BalanceRow[], cumulativeCap: number | null): Map<string, { carried: number; excess: number }> => {
      const splits = new Map<string, { carried: number; excess: number }>();
      if (caps.carry_forward_mode === "cumulative") {
        const eligible = rows.filter((b) => ltById.get(b.leaveTypeId)?.carryForward);
        const cum = splitCarryForwardCumulative(eligible.map((b) => b.balanceDays), cumulativeCap);
        eligible.forEach((b, i) => splits.set(b.uuid, cum[i]!));
        for (const b of rows.filter((b) => !ltById.get(b.leaveTypeId)?.carryForward)) splits.set(b.uuid, { carried: 0, excess: round2(b.balanceDays) });
      } else {
        for (const b of rows) {
          const lt = ltById.get(b.leaveTypeId);
          splits.set(b.uuid, splitCarryForward(b.balanceDays, !!lt?.carryForward, lt?.carryForwardCapDays ?? null));
        }
      }
      return splits;
    };

    // Remaining encashment cap for auto-encash; in cumulative mode it's shared across the employee's types.
    let cumEncRemaining = caps.encashment_mode === "cumulative"
      ? (caps.encashment_cumulative_cap_days == null ? Infinity : Math.max(0, caps.encashment_cumulative_cap_days - (await encashedDaysThisYear(deps, emp.uuid))))
      : Infinity;
    const encashRemainingFor = async (lt: LeaveTypeRow): Promise<number> => {
      if (!lt.encashable) return 0; // only encashable types can absorb excess as a payout
      if (caps.encashment_mode === "cumulative") return cumEncRemaining;
      return lt.encashmentCapDaysPerYear == null ? Infinity : Math.max(0, lt.encashmentCapDaysPerYear - (await encashedDaysThisYear(deps, emp.uuid, lt.uuid)));
    };

    // Claim each row for `year`, guarded on BOTH the year stamp and the balance that was read. The stamp
    // guard stops a concurrent tick (or a retry of a crashed run) from creating a SECOND auto-encashment
    // payout for the same excess. The balance guard stops the absolute write from erasing a debit committed
    // in between (a leave approval, an encashment): those days would come back and be encashable, i.e. real
    // money, and the payout below would be sized off a balance the employee no longer has.
    // A row that loses its claim is RETRIED here rather than left for tomorrow: in cumulative mode one cap is
    // shared across the employee's types, and tomorrow's run would re-split the whole cap across that single
    // leftover row and carry over more than the cap allows. `capLeft` shrinks by what each claimed row kept,
    // so a retry only ever splits what is still free. Stamping before creating the payout means a crash
    // mid-loop can at worst skip the encashment (recoverable), never double-pay it.
    let capLeft = caps.carry_forward_cumulative_cap_days;
    let pending = roll;
    for (let attempt = 0; pending.length && attempt < 4; attempt++) {
      if (attempt > 0) {
        const wanted = new Set(pending.map((b) => b.uuid));
        const fresh = await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp.uuid));
        // Drop anything another tick has since stamped - that run owns its own cap accounting for those rows.
        pending = fresh.filter((b) => wanted.has(b.uuid) && b.lastCarryForwardYear !== year);
        if (!pending.length) break;
      }
      const splits = splitsFor(pending, capLeft);
      const lost: BalanceRow[] = [];
      for (const b of pending) {
        const lt = ltById.get(b.leaveTypeId);
        const split = splits.get(b.uuid)!;
        const claimed = await deps.db.update(schema.leaveBalances)
          .set({ balanceDays: split.carried, lastCarryForwardYear: year, updatedAt: new Date() })
          .where(and(eq(schema.leaveBalances.uuid, b.uuid), ne(schema.leaveBalances.lastCarryForwardYear, year), eq(schema.leaveBalances.balanceDays, b.balanceDays)))
          .returning();
        if (!claimed.length) { lost.push(b); continue; }
        if (capLeft != null) capLeft = Math.max(0, round2(capLeft - split.carried));
        if (split.excess > 0 && caps.carry_forward_excess === "encash" && lt) {
          const { encash } = splitEncashExcess(split.excess, "encash", await encashRemainingFor(lt));
          if (encash > 0) {
            const ok = await createAutoEncashment(deps, emp.uuid, lt.uuid, encash);
            if (ok && caps.encashment_mode === "cumulative") cumEncRemaining = Math.max(0, cumEncRemaining - encash);
          }
        }
        processed++;
      }
      pending = lost;
    }
    // Only reachable if the same rows kept changing under every attempt. Leaving them unstamped is the safe
    // side (no forfeiture, no payout); tomorrow's tick retries them.
    if (pending.length) console.warn(`[cron] carry-forward skipped ${pending.length} balance row(s) for employee ${emp.uuid}: balances kept changing mid-rollover`);
  }
  return processed;
}

// Emit time-based domain events for automations to react to: probation ending today, a work anniversary today,
// and personal documents expiring within 30 days. This is the event twin of sendReminders (which sends email):
// it lets a data-defined rule ("congratulate anniversaries", "renewal task on expiry") run WITHOUT new code.
// System-emitted (actor = null). Returns the number of events emitted.
async function emitScheduledEvents(deps: Deps): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = +today;
  const dayMs = 86_400_000;
  let emitted = 0;

  const employees = await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"));
  for (const emp of employees) {
    if (emp.deleteTime || !emp.startDate) continue;
    const start = +new Date(emp.startDate);
    const probationEnd = emp.probationEndDate ? +new Date(emp.probationEndDate) : start + 90 * dayMs;
    if (probationEnd >= todayMs && probationEnd < todayMs + dayMs) {
      await emitEvent(deps, null, "schedule.probationEnding", { subject: `employees/${emp.uuid}`, employeeId: emp.uuid, payload: { probationEndDate: new Date(probationEnd).toISOString() } });
      // In-app: tell the employee + their manager (system event, no actor).
      await notify(deps, { recipient: emp.uuid, type: "transition.probation_ending", title: "Your probation ends today", body: "Your probation period ends today - your manager will confirm your status.", link: "profile" });
      const mgr = await managerIdOf(deps, emp.uuid);
      if (mgr) await notify(deps, { recipient: mgr, type: "transition.probation_ending", title: "A report's probation ends today", body: `${emp.firstName} ${emp.lastName}'s probation ends today - please confirm their status.`, link: "employees", subject: `employees/${emp.uuid}`, actorId: emp.uuid });
      emitted++;
    }
    const startDate = new Date(start);
    if (startDate.getUTCMonth() === today.getUTCMonth() && startDate.getUTCDate() === today.getUTCDate() && start < todayMs) {
      const years = today.getUTCFullYear() - startDate.getUTCFullYear();
      await emitEvent(deps, null, "schedule.workAnniversary", { subject: `employees/${emp.uuid}`, employeeId: emp.uuid, payload: { years } });
      await notify(deps, { recipient: emp.uuid, type: "system.work_anniversary", title: "Happy work anniversary! 🎉", body: `Congratulations on ${years} year${years !== 1 ? "s" : ""} with us.`, link: "dashboard" });
      emitted++;
    }
  }

  const thirtyDaysMs = todayMs + 30 * dayMs;
  const docs = await deps.db.select().from(schema.personalDocuments);
  for (const doc of docs) {
    if (!doc.expireTime || !doc.employeeId) continue;
    const expMs = +new Date(doc.expireTime);
    if (expMs >= todayMs && expMs <= thirtyDaysMs) {
      const daysLeft = Math.ceil((expMs - todayMs) / dayMs);
      await emitEvent(deps, null, "document.expiring", { subject: `personal-documents/${doc.uuid}`, employeeId: doc.employeeId, payload: { daysLeft, title: doc.title } });
      await notify(deps, { recipient: doc.employeeId, type: "document.expiring", title: "Document expiring soon", body: `"${doc.title}" expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""} - please renew it.`, link: "documents", subject: `personal-documents/${doc.uuid}`, action: "respond" });
      emitted++;
    }
  }

  // Compliance filings due within a week: remind the assignee (pending, dated, assigned events only).
  const sevenDaysMs = todayMs + 7 * dayMs;
  const dueEvents = await deps.db.select().from(schema.complianceEvents).where(eq(schema.complianceEvents.status, "pending"));
  for (const ev of dueEvents) {
    if (ev.deleteTime || !ev.assigneeId || !ev.dueDate) continue;
    const dueMs = +new Date(ev.dueDate);
    if (dueMs >= todayMs && dueMs <= sevenDaysMs) {
      const daysLeft = Math.ceil((dueMs - todayMs) / dayMs);
      await notify(deps, { recipient: ev.assigneeId, type: "compliance.due", title: "Compliance filing due soon", body: `${ev.title} is due in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}.`, link: "compliance", subject: `compliance-events/${ev.uuid}`, priority: "high" });
      emitted++;
    }
  }
  return emitted;
}

type CheckInItem = { text: string; done?: boolean };

// Recurring 1:1s: once a cadence-bearing 1:1's meeting date has passed, create the next occurrence - same
// pair, next date on the cadence grid (stepping from the previous date, so the weekday / day-of-month
// sticks), open action items carried forward - and MOVE the cadence onto the new row, so exactly one row
// per pair ever carries it. The claim clears the cadence with a guard on its current value (same
// guarded-flip shape as carry-forward): a re-run or concurrent tick finds it already NULL and skips, so
// two next-occurrences can never be minted for one 1:1.
export async function rollRecurringCheckIns(deps: Deps): Promise<number> {
  const today = new Date(deps.clock.now());
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = +today;
  const rows = await deps.db.select().from(schema.checkIns);
  let rolled = 0;
  for (const r of rows) {
    if (r.deleteTime || !r.cadence || !r.meetingDate || +new Date(r.meetingDate) >= todayMs) continue;
    const next = new Date(+new Date(r.meetingDate));
    while (+next < todayMs) {
      if (r.cadence === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
      else next.setUTCDate(next.getUTCDate() + (r.cadence === "weekly" ? 7 : 14));
    }
    const items: CheckInItem[] = r.actionItemsJson ? JSON.parse(r.actionItemsJson) : [];
    const open = items.filter((i) => !i.done);
    // Claim: clear the cadence off the old row and retire its open items (they move to the new one).
    const claimed = await deps.db
      .update(schema.checkIns)
      .set({
        cadence: null,
        ...(open.length ? { actionItemsJson: JSON.stringify(items.map((i) => ({ ...i, done: true }))) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.checkIns.uuid, r.uuid), eq(schema.checkIns.cadence, r.cadence)))
      .returning();
    if (!claimed.length) continue;
    const created = (await deps.db
      .insert(schema.checkIns)
      .values({
        code: await allocOwnedCode(deps, schema.checkIns, schema.checkIns.employeeId, r.employeeId),
        employeeId: r.employeeId,
        counterpartId: r.counterpartId,
        meetingDate: next,
        actionItemsJson: open.length ? JSON.stringify(open.map((i) => ({ text: i.text, done: false }))) : null,
        cadence: r.cadence,
      })
      .returning())[0]!;
    const when = next.toISOString().slice(0, 10);
    const carried = open.length ? ` ${open.length} open action item${open.length === 1 ? "" : "s"} carried forward.` : "";
    for (const rid of [r.employeeId, r.counterpartId].filter((x): x is string => !!x))
      await notify(deps, { recipient: rid, type: "checkin.scheduled", title: "Next 1:1 scheduled", body: `Your recurring 1:1 was scheduled for ${when}.${carried}`, link: "check-ins", subject: `check-ins/${created.uuid}` });
    rolled++;
  }
  return rolled;
}

// Repeating events: once a repeat-bearing event has finished, create the next occurrence (same title, length,
// attendees and work rules, dates stepped by the cadence) and MOVE the repeat onto it - so exactly one row of a
// series carries it and nothing quietly fills the calendar years ahead. The claim clears the repeat with a
// guard on its current value, the same guarded flip recurring 1:1s use: a re-run or a concurrent tick finds it
// already NULL and skips, so one event can never mint two successors.
//
// RSVPs deliberately do NOT carry over: "coming to the all-hands on the 3rd" is not a promise about the 10th.
export async function rollRepeatingEvents(deps: Deps): Promise<number> {
  const nowMs = +deps.clock.now();
  const rows = await deps.db.select().from(schema.events);
  let rolled = 0;
  for (const r of rows) {
    if (r.deleteTime || !r.repeat || +new Date(r.endTime) >= nowMs) continue;
    // Step until the occurrence is in the future: a series nobody touched for two months lands on its next
    // real date rather than replaying every date it missed.
    let { start, end } = nextOccurrence(+new Date(r.startTime), +new Date(r.endTime), r.repeat);
    let guard = 0;
    while (end < nowMs && guard++ < 400) ({ start, end } = nextOccurrence(start, end, r.repeat));
    const claimed = await deps.db
      .update(schema.events)
      .set({ repeat: null, updatedAt: new Date() })
      .where(and(eq(schema.events.uuid, r.uuid), eq(schema.events.repeat, r.repeat)))
      .returning();
    if (!claimed.length) continue;
    const created = (await deps.db
      .insert(schema.events)
      .values({
        code: await allocFlatCode(deps, schema.events),
        title: r.title,
        startTime: new Date(start),
        endTime: new Date(end),
        allDay: r.allDay,
        countAsWork: r.countAsWork,
        requiresClockIn: r.requiresClockIn,
        color: r.color,
        description: r.description,
        attendeeIds: r.attendeeIds,
        repeat: r.repeat,
      })
      .returning())[0]!;
    // The people it is aimed at hear about it, so an RSVP has something to answer. A company-wide event (no
    // attendee list) tells nobody: that is the calendar's job, not forty notifications'.
    let attendees: string[] = [];
    try {
      attendees = r.attendeeIds ? (JSON.parse(r.attendeeIds) as string[]) : [];
    } catch {
      attendees = [];
    }
    const when = new Date(start).toISOString().slice(0, 10);
    for (const rid of attendees)
      await notify(deps, { recipient: rid, type: "event.scheduled", title: `${r.title} scheduled`, body: `The next one is on ${when}.`, link: "events", subject: `events/${created.uuid}` });
    rolled++;
  }
  return rolled;
}

// Day-before reminder: both attendees of a 1:1 dated tomorrow get an in-app nudge on the nightly tick.
// The one-day window means each 1:1 matches exactly one tick, so there is nothing to dedupe.
export async function remindUpcomingCheckIns(deps: Deps): Promise<number> {
  const today = new Date(deps.clock.now());
  today.setUTCHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const tomorrowMs = +today + dayMs;
  const due = (await deps.db.select().from(schema.checkIns)).filter((r) => {
    if (r.deleteTime || !r.meetingDate) return false;
    const ms = +new Date(r.meetingDate);
    return ms >= tomorrowMs && ms < tomorrowMs + dayMs;
  });
  if (!due.length) return 0;
  const ids = [...new Set(due.flatMap((r) => [r.employeeId, r.counterpartId]).filter((x): x is string => !!x))];
  const names = new Map(
    (await deps.db.select().from(schema.employees).where(inArray(schema.employees.uuid, ids))).map((e) => [e.uuid, `${e.firstName} ${e.lastName}`]),
  );
  let sent = 0;
  for (const r of due) {
    for (const [rid, other] of [[r.employeeId, r.counterpartId], [r.counterpartId, r.employeeId]] as const) {
      if (!rid) continue;
      const withWho = other ? ` with ${names.get(other) ?? "your counterpart"}` : "";
      await notify(deps, { recipient: rid, type: "checkin.reminder", title: "1:1 tomorrow", body: `Your 1:1${withWho} is tomorrow - jot down talking points beforehand.`, link: "check-ins", subject: `check-ins/${r.uuid}` });
      sent++;
    }
  }
  return sent;
}

// Nudge anyone who still has optional-holiday picks going spare, `reminder_days` before the org's pick-by date
// (settings/holidays `pick_by`, `pick_reminder_days`, `max_optional`). An unused pick is a day off silently
// forfeited, and nobody remembers a deadline nobody told them about. No pick_by set -> nothing to remind about.
// Fires on exactly one day (and again on the deadline itself), so the daily tick can't turn it into a drip.
export async function remindOptionalHolidayPicks(deps: Deps): Promise<number> {
  const cfg = await getSettingValue<{ max_optional?: number; pick_by?: string; pick_reminder_days?: number }>(deps, "holidays", {});
  const max = cfg.max_optional ?? 2;
  if (!cfg.pick_by || max <= 0) return 0;
  const deadlineMs = Date.parse(cfg.pick_by.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(deadlineMs)) return 0;
  const today = new Date(deps.clock.now());
  today.setUTCHours(0, 0, 0, 0);
  const daysLeft = Math.round((deadlineMs - +today) / 86_400_000);
  const lead = cfg.pick_reminder_days ?? 7;
  if (daysLeft !== lead && daysLeft !== 0) return 0;

  // Only picks for holidays in the deadline's own year count: last year's choices don't fill this year's quota.
  const year = new Date(deadlineMs).getUTCFullYear();
  const holidaysById = new Map((await refHolidays(deps)).map((h) => [h.uuid, h]));
  const perEmployee = new Map<string, number>();
  for (const sel of await deps.db.select().from(schema.holidaySelections)) {
    const h = holidaysById.get(sel.holidayId);
    if (!h || new Date(h.date).getUTCFullYear() !== year) continue;
    perEmployee.set(sel.employeeId, (perEmployee.get(sel.employeeId) ?? 0) + 1);
  }
  // Something to pick FROM, or the nudge is just noise.
  const openOptional = [...holidaysById.values()].filter(
    (h) => h.kind === "optional" && !h.deleteTime && !h.disabled && +new Date(h.date) >= +today && new Date(h.date).getUTCFullYear() === year,
  ).length;
  if (!openOptional) return 0;

  let sent = 0;
  for (const emp of await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"))) {
    const left = max - (perEmployee.get(emp.uuid) ?? 0);
    if (left <= 0) continue;
    const when = daysLeft === 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
    await notify(deps, {
      recipient: emp.uuid,
      type: "holiday.pick_reminder",
      title: `${left} optional holiday${left === 1 ? "" : "s"} left to pick`,
      body: `Picks for ${year} close ${when}. Choose your optional holidays before then - unused picks are lost.`,
      link: "holidays",
    });
    sent++;
  }
  return sent;
}

/**
 * Chase the scans that were owed and never happened.
 *
 * An unconfirmed asset is the only kind that goes missing quietly, so the tick does three things: nudges the
 * holder who has not confirmed receipt (and, once the wait has doubled, their manager), and emits events for
 * stock that nobody has counted in and for assets nobody has laid eyes on in months. The two events carry no
 * recipient of their own - there is no "IT role" to notify - so an org routes them wherever it wants through
 * an automation rule (mail the asset owner, open a ticket, post to the board).
 */
export async function remindAssetCustody(deps: Deps): Promise<number> {
  const policy = custodyPolicy(await getSettingValue<unknown>(deps, "asset-tags", {}));
  const now = new Date(deps.clock.now());
  const rows = await deps.db.select().from(schema.assets).where(ne(schema.assets.status, "retired"));
  let acted = 0;
  const escalations: { row: (typeof rows)[number]; days: number }[] = [];
  for (const r of rows) {
    const waiting = r.custodySince ? daysBetween(r.custodySince, now) : null;
    if (r.status === "pending_ack" && r.assignedTo && waiting !== null && waiting >= policy.ackReminderDays) {
      // The holder is nudged on every tick past the threshold: it is one line in their notification list, and
      // the whole point is that the asset stays visibly unconfirmed until they scan it.
      await notify(deps, {
        recipient: r.assignedTo,
        type: "asset.assigned",
        title: "Confirm the asset you were given",
        body: `${r.name}${r.assetTag ? ` (${r.assetTag})` : ""} has been waiting ${waiting} days for you to scan its tag.`,
        link: "assets",
        subject: `assets/${r.uuid}`,
      });
      acted++;
      if (waiting >= policy.ackReminderDays * 2) escalations.push({ row: r, days: waiting });
      await emitEvent(deps, null, "asset.custodyOverdue", { subject: `assets/${r.uuid}`, employeeId: r.assignedTo, payload: { categoryId: r.categoryId, assetTag: r.assetTag, name: r.name, kind: "ack", days: waiting } });
      continue;
    }
    if (r.status === "pending_verification" && waiting !== null && waiting >= policy.ackReminderDays) {
      await emitEvent(deps, null, "asset.custodyOverdue", { subject: `assets/${r.uuid}`, employeeId: r.assignedTo, payload: { categoryId: r.categoryId, assetTag: r.assetTag, name: r.name, kind: "verification", days: waiting } });
      acted++;
      continue;
    }
    // Settled assets go stale instead: nobody has seen this one in half a year, which is what makes a
    // stocktake fall due rather than be remembered. Repeated monthly past the threshold rather than daily, so
    // a skipped tick costs a month's delay instead of losing the signal entirely.
    const sinceSeen = daysBetween(r.verifiedAt ?? r.createdAt, now);
    if (sinceSeen >= policy.verifyStaleDays && (sinceSeen - policy.verifyStaleDays) % 30 === 0) {
      await emitEvent(deps, null, "asset.stale", { subject: `assets/${r.uuid}`, employeeId: r.assignedTo, payload: { categoryId: r.categoryId, assetTag: r.assetTag, name: r.name, days: sinceSeen } });
      acted++;
    }
  }
  // Managers hear about it once the holder has ignored the ask for twice the reminder window - one lookup for
  // all of them rather than one per asset.
  for (const e of escalations) {
    const manager = await managerIdOf(deps, e.row.assignedTo!);
    if (!manager || manager === e.row.assignedTo) continue;
    await notify(deps, {
      recipient: manager,
      type: "asset.assigned",
      title: "An asset in your team is unconfirmed",
      body: `${e.row.name}${e.row.assetTag ? ` (${e.row.assetTag})` : ""} has been unconfirmed for ${e.days} days.`,
      link: "assets",
      subject: `assets/${e.row.uuid}`,
    });
    acted++;
  }
  return acted;
}

// Sends email reminders for probation endings (90-day), expiring documents, and work anniversaries.
async function sendReminders(deps: Deps): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = +today;
  const dayMs = 86_400_000;
  let sent = 0;
  const brand = await loadEmailBrand(deps);
  const mail = (to: string, subject: string, bodyHtml: string) => deps.email.send(to, subject, renderEmail({ heading: subject, preheader: subject, bodyHtml }, brand));

  const employees = await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"));

  for (const emp of employees) {
    if (!emp.startDate) continue;
    const start = +new Date(emp.startDate);

    // Probation end: the per-employee date if set, else 90 days after startDate.
    const probationEnd = emp.probationEndDate ? +new Date(emp.probationEndDate) : start + 90 * dayMs;
    if (probationEnd >= todayMs && probationEnd < todayMs + dayMs) {
      await mail(
        emp.workEmail,
        "Probation period ending today",
        `<p>Hi ${emp.firstName},</p><p>Your probation period ends today. Please connect with HR to confirm your status.</p>`,
      ).catch(() => {});
      sent++;
    }

    // Work anniversary (same month+day each year)
    const startDate = new Date(start);
    if (startDate.getUTCMonth() === today.getUTCMonth() && startDate.getUTCDate() === today.getUTCDate() && start < todayMs) {
      const years = today.getUTCFullYear() - startDate.getUTCFullYear();
      await mail(
        emp.workEmail,
        `Happy ${years}-year work anniversary!`,
        `<p>Hi ${emp.firstName},</p><p>Congratulations on <strong>${years} year${years !== 1 ? "s" : ""}</strong> with us! Thank you for everything you bring to the team.</p>`,
      ).catch(() => {});
      sent++;
    }
  }

  // Expiring personal documents: notify the owning employee if expires within 30 days. (Org documents
  // have no owner, so no per-employee reminder.)
  const thirtyDaysMs = todayMs + 30 * dayMs;
  const docs = await deps.db.select().from(schema.personalDocuments);
  for (const doc of docs) {
    if (!doc.expireTime) continue;
    const expMs = +new Date(doc.expireTime);
    if (expMs >= todayMs && expMs <= thirtyDaysMs) {
      if (!doc.employeeId) continue;
      const emp = employees.find((e) => e.uuid === doc.employeeId);
      if (!emp) continue;
      const daysLeft = Math.ceil((expMs - todayMs) / dayMs);
      await mail(
        emp.workEmail,
        `Document expiring in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}: ${doc.title}`,
        `<p>Hi ${emp.firstName},</p><p>Your document "<strong>${doc.title}</strong>" expires in <strong>${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong>. Please upload a renewed copy before it lapses.</p>`,
      ).catch(() => {});
      sent++;
    }
  }

  // Expiring ORG documents (no owner) -> notify the configured HR contact, if any. Closes the org-doc gap;
  // personal docs reach their owner above.
  const org = await getSettingValue<{ letter_defaults?: { hr_email?: string } }>(deps, "organization", {});
  const hrEmail = org.letter_defaults?.hr_email;
  if (hrEmail) {
    const orgDocs = await deps.db.select().from(schema.orgDocuments);
    for (const doc of orgDocs) {
      if (!doc.expireTime || doc.deleteTime || doc.disabled) continue;
      const expMs = +new Date(doc.expireTime);
      if (expMs >= todayMs && expMs <= thirtyDaysMs) {
        const daysLeft = Math.ceil((expMs - todayMs) / dayMs);
        await mail(
          hrEmail,
          `Company document expiring in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}: ${doc.title}`,
          `<p>The company document "<strong>${doc.title}</strong>" expires in <strong>${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong>. Please review and renew it.</p>`,
        ).catch(() => {});
        sent++;
      }
    }
  }
  return sent;
}
