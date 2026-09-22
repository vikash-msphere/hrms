import { allocFlatCode, allocOwnedCode } from "./services/codeAlloc";
// The successor row's id is minted before the claim in the recurrence rolls, so a failed create can be asked
// whether it landed before the claim is released. Same shape as services/cards.ts#rollRecurringCards.
import { genId } from "./lib/idCodec";
import { systemActor } from "./lib/systemActor";
import { asc, eq, and, or, ne, isNull, isNotNull, lte, lt, gte, sql, inArray } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Deps } from "./deps";
import { processPayslipRunJob } from "./services/payroll";
import { runDeferredActions, runWorkflowTimer, runScheduledAutomations, runScheduledFanOut, SCHEDULED_FAN_OUT_JOB, withDispatchBudget } from "./services/automationEngine";
import { flushDigests } from "./services/notificationDigest";
import { weeklyAttentionDigest, attentionSettings, goalTrouble } from "./services/attention";
import { rankAttention, type AttentionItem } from "./domain/attention";
import { generateRecurringExpenses } from "./services/expenses";
import { checkBudgetThresholds, openRecurringBudgetPeriods } from "./services/expenseBudgets";
import { openRecurringPayrollBudgets } from "./services/payrollBudgets";
import { emitEvent } from "./services/eventBus";
import { accrueLeave } from "./services/leaveAccrual";
import { generateComplianceOccurrences } from "./services/complianceRules";
import { nudgeStaleAcks } from "./services/documentAck";
import { awardReferralBonuses } from "./services/referrals";
import { nudgeMissingScorecards } from "./services/ats";
import { reconcilePendingEsign } from "./services/esign/callback";
import { publishDueAnnouncements } from "./services/announcements";
import { drainSearchEmbeddings } from "./services/searchEmbed";
import { drainModeration, reconcileHolds } from "./services/moderation";
import { sweepCardDuplicates, pruneDuplicateSuggestions } from "./services/cardDuplicateSweep";
import { sweepAiCache, sweepAiUsage } from "./services/ai";
import { nextOccurrence } from "./services/events";
import { purgeExpiredAccessRules, reviewStandingAccess } from "./services/accessRules";
import { purgeIdentityFieldsSlice, IDENTITY_PURGE_JOB, type IdentityPurgeCursor } from "./services/identityDetails";
import { rollRecurringCards } from "./services/cards";
import { creditHolidayCompOff } from "./services/compOff";
import { getSettingValue } from "./services/settings";
import { orgToday, orgDayFromToday, orgTimezone, orgYear, dayStartMs } from "./services/orgDay";
import { localDay } from "./domain/attendance";
import { renderEmail, loadEmailBrand, escapeHtml } from "./lib/emailLayout";
import { notify, notifyMany } from "./services/notifications";
import { leaveCaps, encashedDaysThisYearAll, createAutoEncashment } from "./services/leaveEncashments";
import { splitCarryForward, splitCarryForwardCumulative, splitEncashExcess } from "./domain/carryForward";
import { custodyPolicy, daysBetween } from "./domain/assetCustody";
import { addDaysUtc, addMonthsFromAnchor, advanceUntilAfter, isAnniversaryOf, seriesAnchorDay } from "./domain/calendar";

import { round2 } from "./domain/money";
import { byIdChunks, runBatchChecked, type CheckedStmt } from "./lib/dbBatch";
import { EMAIL_FANOUT_JOB, processEmailFanOutJob, type EmailFanOutPayload } from "./services/emailFanOut";
import { refLeaveTypes, refHolidays } from "./lib/refData";

// The scheduled triggers this Worker handles (must mirror wrangler.toml `crons`). Exported so the manual
// trigger (cron-runs:run) can validate the requested expression against the real, dispatchable set.
export const KNOWN_CRONS = ["*/5 * * * *", "0 2 * * *"] as const;
/** The nightly run (accrual, reminders, digests) - the one with a Sentry cron monitor on it (src/index.ts). */
export const NIGHTLY_CRON = "0 2 * * *";

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
  // The tick names itself for the whole run: every audit entry it writes is a scheduled job's, not a person's,
  // and one trace ties the night's writes together the way a request's does for a human act.
  deps.actingAs = { kind: "cron", name: cron, ref: `cron-runs/${runId}` };
  deps.trace ??= runId;
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
    // Reconcile the semantic search index against `search_docs`: embed what changed, drop what no longer has
    // a row. On the FAST tick rather than the nightly one because a search index a day behind is a search
    // index people stop trusting - somebody who just filed a ticket expects to find it. Bounded per tick by
    // the neuron budget, so a first-run backfill spreads over several ticks instead of spending the day at
    // once, and it no-ops entirely on a deployment with no model or no index bound.
    const embedded = await run("drainSearchEmbeddings", async () => (await drainSearchEmbeddings(deps)).embedded);
    // Scan the public walls for content a guard model objects to. On the FAST tick rather than the nightly
    // one because the queue is only useful while the post is still the thing people are reading; a flag that
    // arrives the next morning is a flag about a conversation that already happened. Bounded hard by
    // `BUDGET.moderationsPerDrain` - it is a generation call, unlike the embed drain above - and it no-ops
    // entirely with no model bound or the feature switched off.
    const moderated = await run("drainModeration", async () => (await drainModeration(deps)).flagged);
    return { summary: { drained, announcementsPublished, embedded, moderated }, failures };
  }
  if (cron === NIGHTLY_CRON) {
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
    // The Monday roundup: one notification to each person with something off track - a goal that will not
    // land, one nobody has touched in three weeks, a card stuck in a column, a review waiting on them. A
    // no-op on the other six days, decided in the ORG's timezone rather than the Worker's, so nobody gets
    // their week on the wrong day. Reads each source once for the whole company rather than three times per
    // person, which is what keeps it inside this invocation's subrequest budget (best-effort).
    const attentionDigests = await run("weeklyAttentionDigest", () => weeklyAttentionDigest(deps));
    // Chase unconfirmed asset custody: nudge holders who owe a scan, flag stock nobody counted in, and mark
    // assets nobody has sighted in months as stale (best-effort).
    const assetCustody = await run("remindAssetCustody", () => remindAssetCustody(deps));
    // Generate due recurring expenses (rent, subscriptions) and raise budget-threshold alerts (best-effort).
    const recurringExpenses = await run("generateRecurringExpenses", () => generateRecurringExpenses(deps));
    const budgetAlerts = await run("checkBudgetThresholds", () => checkBudgetThresholds(deps));
    // Recurring caps open their next period once the current one closes, so no month goes unbudgeted.
    const budgetPeriodsOpened = await run("openRecurringBudgetPeriods", () => openRecurringBudgetPeriods(deps));
    // Salary caps roll the same way, for the same reason. Its own step rather than a branch inside the one
    // above: a failure rolling expense periods must not leave payroll unbudgeted, and `run` isolates each.
    const payrollBudgetPeriodsOpened = await run("openRecurringPayrollBudgets", () => openRecurringPayrollBudgets(deps));
    // Reconcile e-sign documents stuck pending (missed/dropped vendor webhook): poll the vendor or auto-expire
    // past the signing window. Best-effort - never aborts the tick.
    const esignReconciled = await run("reconcilePendingEsign", () => reconcilePendingEsign(deps));
    // Recurring 1:1s roll forward once their date passes, and tomorrow's 1:1s get a day-before nudge.
    const checkInsRolled = await run("rollRecurringCheckIns", () => rollRecurringCheckIns(deps));
    const checkInReminders = await run("remindUpcomingCheckIns", () => remindUpcomingCheckIns(deps));
    // Repeating events (the weekly all-hands, the yearly Founders' Day) create their next occurrence once the
    // current one has finished, one step at a time.
    const eventsRolled = await run("rollRepeatingEvents", () => rollRepeatingEvents(deps));
    // Repeating board work (the weekly compliance sweep, the monthly access review) files its next card once
    // the current one is DELIVERED - so a chore that is running late gets chased, not duplicated.
    const cardsRolled = await run("rollRecurringCards", () => rollRecurringCards(deps));
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
    // Drop expired AI generations. `cacheGet` already ignores an expired row, so this is hygiene rather than
    // the enforcement - but the table holds generated text about real records, and without this it grows for
    // the life of the deployment.
    const aiCacheSwept = await run("sweepAiCache", () => sweepAiCache(deps));
    // And the ledger's own retention. `ai_usage` is the larger of the two tables and each row pairs a person
    // with a record they had a model consulted about, so without a window it is a permanent per-person log
    // going back to deployment - the half of "answer this a year later" that had no code behind it.
    const aiUsageSwept = await run("sweepAiUsage", () => sweepAiUsage(deps));
    // Periodic recertification of STANDING privilege (opt-in per org via the `access-review` setting). The
    // expiry sweep above only handles access somebody knew was temporary; this is the rest - the grant made
    // for one project or one person's leave cover that nobody's job it is to remove. No-ops on every tick
    // that is not due, so it costs one settings read a night.
    const accessReviewed = await run("reviewStandingAccess", () => reviewStandingAccess(deps));
    // The board's duplicate check, run on the backlog rather than on whoever happens to open a panel. The
    // pair that matters is the one two people filed in two different weeks, and nobody goes looking for it.
    // Queries only - every card already has its vector - and bounded per tick, so a large backlog is swept
    // over several nights. No-ops with no index bound or the feature switched off.
    const duplicatesFlagged = await run("sweepCardDuplicates", async () => (await sweepCardDuplicates(deps)).flagged);
    // And the hygiene half: answers about cards that have since been delivered or deleted are cleared, so a
    // groomer is never sent to check a pair that stopped existing.
    const duplicatesPruned = await run("pruneDuplicateSuggestions", () => pruneDuplicateSuggestions(deps));
    // Posts the gate is still holding with nothing outstanding that could release them. `held_at` hides a row
    // from every read in the app and only a PENDING flag puts it in front of a moderator, so a hold whose flag
    // was retired, decided or never written is a post nobody can see and nobody can let out. This is the
    // mirror of `retireOrphans`: that closes a flag with no host, this re-queues a host with no flag.
    const holdsRequeued = await run("reconcileHolds", async () => (await reconcileHolds(deps)).requeued);
    return {
      summary: { carriedForward, accrued, complianceGenerated, referralBonuses, reminders, scheduledEvents, scheduledAutomations, digestsFlushed, attentionDigests, assetCustody, recurringExpenses, budgetAlerts, budgetPeriodsOpened, payrollBudgetPeriodsOpened, esignReconciled, checkInsRolled, checkInReminders, eventsRolled, cardsRolled, holidayPickReminders, ackNudges, scorecardNudges, compOffCredited, accessRulesExpired, aiCacheSwept, aiUsageSwept, accessReviewed, duplicatesFlagged, duplicatesPruned, holdsRequeued },
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

// The night's reminder mail, past the first batch the nightly tick sends inline. Named once because the
// enqueue (sendReminders) and the drain (processOneJob) have to agree on the string.
const REMINDER_EMAIL_JOB = "reminder.email";

// Year-end leave rollover, past the employees the nightly tick got through. Same reason for the constant.
const CARRY_FORWARD_JOB = "leave.carryForward";

// How many employees one invocation rolls over. With the claims batched (one write group per employee per
// attempt) the floor cost is two round-trips a head - the fresh balances read and the claim batch - so ten
// employees is twenty, which leaves the rest of the nightly tick room inside the free plan's 50-subrequest
// budget. An auto-encashment payout costs about five more on top, and only the employees who actually have
// encashable excess pay it, which is why the number is conservative rather than tuned to the floor.
const CARRY_FORWARD_EMPLOYEE_BATCH = 10;

// How many continuation passes the queued rollover may take before it gives up and leaves the rest to the
// next nightly tick. Ten employees a pass, so this covers a five-thousand-person roster. It is a runaway
// backstop, not a capacity limit - the termination condition is `remaining === 0`.
//
// HOW LONG THAT ACTUALLY TAKES, said plainly because the number invites a guess: the drain runs every five
// minutes and takes ONE pass of this job per drain (the continuation requeues itself), so throughput is ten
// employees per five minutes - 120 an hour. A 500-person year-end rollover therefore finishes in about four
// hours, and the 5,000-person ceiling in about forty - not "overnight", which is what the arithmetic looks
// like at a glance and is not what it does.
//
// That is acceptable, and it is worth saying why rather than leaving it to be rediscovered. The rollover is
// idempotent per calendar year and each employee's claim is guarded, so a pass landing at 06:00 is the same
// write it would have been at 02:00; the auto-encashment it creates is dated by the ORG's year (`orgYear`),
// not by the instant it was inserted, so a payout that lands mid-morning still belongs to the year that just
// ended. What the spread costs is only that the last employee's balance reads the old figure for a few hours
// on 1 January. Raising the slice is not the lever: a pass shares its invocation with up to nineteen other
// drained jobs (`drainJobs(deps, 20)`), and each employee already costs about two subrequests before any
// payout, so ten is already most of the free plan's fifty-subrequest floor for this job alone.
const CARRY_FORWARD_MAX_PASSES = 500;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const backoffMs = (attempts: number): number => RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1]!;

// Kinds whose failure someone is waiting on, and can act on. Engine-internal kinds (`automation.action`,
// `workflow.timer`) are deliberately excluded: they already record an automation_runs row for the Workflows UI,
// and the employee a rule happens to be ABOUT is not the person who can fix a broken rule.
const OWNER_NOTIFIED_KINDS = new Set(["payslip.generateRun"]);

// Tell the job's owner when it has given up for good. `notify` is itself best-effort (it swallows), so this
// cannot turn a job failure into a tick failure.
async function notifyJobDeadLetter(deps: Deps, job: JobRow, error: string, why = `after ${MAX_JOB_ATTEMPTS} attempts`): Promise<void> {
  if (!job.employeeId || !OWNER_NOTIFIED_KINDS.has(job.kind)) return;
  await notify(deps, {
    recipient: job.employeeId,
    type: "system.jobFailed",
    title: "Background job failed",
    body: `${job.kind} gave up ${why}: ${error.slice(0, 300)}`,
    link: "operations",
    subject: `operations/${job.uuid}`,
    priority: "high",
    action: "retry",
  });
}

// Run one job through its state machine. Returns "requeued" if an LRO asked to resume next tick (state
// unchanged from the queue's perspective), "skipped" if another drain claimed it first, else "done"/"error".
// Idempotent per call; never throws.
/** The correlation id an enqueued job carries, when it carries one. Best-effort: a payload with no
 *  correlation id is ordinary, not an error. */
function jobTrace(payload: unknown): string | undefined {
  const v = payload as { correlationId?: unknown } | null;
  return typeof v?.correlationId === "string" ? v.correlationId : undefined;
}

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

  // PARSED ONCE, OUTSIDE THE RETRY. Every branch below used to `JSON.parse(job.payload)` inside the try, so a
  // payload that is not JSON at all threw a SyntaxError into the retry ladder and walked the whole thing -
  // 1 minute, 5, 15, an hour - before dead-lettering. Nothing about a malformed payload changes between
  // attempts: it is the one failure that is permanent by construction, and the backoff exists for the ones
  // that are not (a vendor blip, a contended write). So it fails terminally here, with the same dead-letter
  // notice a job that genuinely exhausted its attempts gets, and the four wasted drain slots go back to work
  // that can still succeed.
  let payload: unknown;
  try {
    payload = JSON.parse(job.payload);
  } catch (e) {
    const attempts = job.attempts + 1;
    await deps.db.update(schema.jobs).set({ status: "error", attempts, lastError: String(e) }).where(eq(schema.jobs.uuid, job.uuid));
    console.error(`job ${job.kind} ${job.uuid} has an unreadable payload (terminal, not retried)`, e);
    await notifyJobDeadLetter(deps, job, String(e), "without retrying (its payload is not readable)");
    return "error";
  }

  // The job belongs to the ACT that enqueued it, not to the tick that happens to drain it. Publishing a run
  // and the payslips that publish generated are one thing a person did; without this they land under two
  // different traces - the request's and the cron's - and the async half of every long operation is orphaned
  // from the action it came from. The engine already threads this through its own deferred jobs; the same
  // rule now covers every kind.
  const enqueuedTrace = jobTrace(payload);
  const tickTrace = deps.trace;
  if (enqueuedTrace) deps.trace = enqueuedTrace;
  try {
    if (job.kind === "payslip.generateRun") {
      const res = await processPayslipRunJob(deps, job.uuid, payload as { runId: string });
      if (!res.done) {
        // Clear any backoff left over from an earlier failed attempt: this is a healthy LRO asking to continue
        // next tick, and it must not inherit an hour-long delay set when the same job last errored.
        await deps.db.update(schema.jobs).set({ status: "queued", runAfter: null }).where(eq(schema.jobs.uuid, job.uuid));
        return "requeued";
      }
    } else if (job.kind === "automation.action") {
      // A deferred (`wait`) automation payload whose delay has elapsed - run its actions with system authority.
      await runDeferredActions(deps, payload as Parameters<typeof runDeferredActions>[1]);
    } else if (job.kind === "workflow.timer") {
      // A durable timer arm of a suspended `waitFor` whose delay elapsed before any event arm fired.
      await runWorkflowTimer(deps, payload as Parameters<typeof runWorkflowTimer>[1]);
    } else if (job.kind === CARRY_FORWARD_JOB) {
      // Another pass over whoever still owes a rollover. Idempotent per calendar year, so it needs no cursor -
      // the `last_carry_forward_year` stamp is what makes an already-rolled row invisible to the next pass -
      // and it requeues on the REMAINING count rather than on what it just did, so a pass that only met rows
      // it could not claim still comes back. `queueRemainder` is false: this row IS the continuation.
      const carry = payload as { year: string; pass?: number };
      const res = await rollCarryForward(deps, false);
      const pass = (carry.pass ?? 0) + 1;
      // The pass counter is a RUNAWAY BACKSTOP, not the termination condition - `remaining === 0` is. Without
      // one, the single case the rollover deliberately gives up on (rows whose balance keeps changing under
      // every attempt) leaves `remaining` unchanged and requeues for ever, burning a drain slot every five
      // minutes with nothing to show. Past the cap the progress made stands and the next nightly tick picks
      // up the rest, which is the fallback the subtask already documents for that case.
      if (res.remaining > 0 && pass < CARRY_FORWARD_MAX_PASSES) {
        await deps.db
          .update(schema.jobs)
          .set({ status: "queued", runAfter: null, payload: JSON.stringify({ ...carry, pass }) })
          .where(eq(schema.jobs.uuid, job.uuid));
        return "requeued";
      }
      if (res.remaining > 0) console.warn(`[cron] carry-forward continuation stopped after ${pass} pass(es) with ${res.remaining} employee(s) left; the nightly tick will retry`);
    } else if (job.kind === REMINDER_EMAIL_JOB) {
      // The night's reminder mail past the first batch. Same LRO shape as the payslip run above: a bounded
      // number of vendor calls per invocation, requeued with the advanced cursor until the list is exhausted.
      const reminder = payload as { day: string; after?: string };
      const res = await processReminderEmailJob(deps, reminder);
      if (!res.done) {
        await deps.db
          .update(schema.jobs)
          .set({ status: "queued", runAfter: null, payload: JSON.stringify({ ...reminder, after: res.after }) })
          .where(eq(schema.jobs.uuid, job.uuid));
        return "requeued";
      }
    } else if (job.kind === SCHEDULED_FAN_OUT_JOB) {
      // A `perEmployee` scheduled automation past the employees the nightly tick fanned out to. Same LRO shape
      // as the reminder mail: a bounded slice of the roster per invocation, requeued with the advanced offset
      // until the roster is exhausted. The rule's per-day claim is already stamped, so this cannot re-fire the
      // day; it only carries it the rest of the way.
      const fan = payload as { automationId: string; day: string; offset: number };
      const res = await runScheduledFanOut(deps, fan);
      if (!res.done) {
        await deps.db
          .update(schema.jobs)
          .set({ status: "queued", runAfter: null, payload: JSON.stringify({ ...fan, offset: res.nextOffset }) })
          .where(eq(schema.jobs.uuid, job.uuid));
        return "requeued";
      }
    } else if (job.kind === IDENTITY_PURGE_JOB) {
      // Removed identity fields past the slice the settings write did inline. Same LRO shape as the rest: a
      // bounded number of proof deletions, then a bounded walk of the encrypted blobs by employee uuid,
      // requeued with the advanced cursor. The settings row is ALREADY written, so a purge that stalls leaves
      // the field gone from every surface with some values still on disk - recoverable by the next tick, which
      // is the direction that does not destroy data it cannot finish destroying.
      const purge = payload as IdentityPurgeCursor;
      const res = await purgeIdentityFieldsSlice(deps, systemActor(), purge);
      if (!res.done && res.next) {
        await deps.db
          .update(schema.jobs)
          .set({ status: "queued", runAfter: null, payload: JSON.stringify({ ...purge, ...res.next }) })
          .where(eq(schema.jobs.uuid, job.uuid));
        return "requeued";
      }
    } else if (job.kind === EMAIL_FANOUT_JOB) {
      // One message to many people, past the batch the originating action sent inline. The recipient list
      // rides IN the payload, so the cursor is an index into a list that cannot shift underneath it.
      const fanOut = payload as EmailFanOutPayload;
      const res = await processEmailFanOutJob(deps, fanOut);
      if (!res.done) {
        await deps.db
          .update(schema.jobs)
          .set({ status: "queued", runAfter: null, payload: JSON.stringify({ ...fanOut, cursor: res.cursor }) })
          .where(eq(schema.jobs.uuid, job.uuid));
        return "requeued";
      }
    }
    // `last_error` is cleared with the success. It is the column the Operations page prints in its Result
    // cell, so a job that failed twice and then worked went on showing the failure that is no longer true.
    await deps.db.update(schema.jobs).set({ status: "done", lastError: null }).where(eq(schema.jobs.uuid, job.uuid));
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
  } finally {
    // The next job in this drain is a different act, and the tick's own writes are the tick's.
    deps.trace = tickTrace;
  }
}

// Re-queue jobs orphaned in `running` so the drain retries them. Returns how many were reclaimed.
//
// The cutoff is only meaningful because `updated_at` moves on every write (schema.ts `updated()` carries
// $onUpdateFn): a job claimed this tick stamps a fresh timestamp, so a drain that overlaps another tick's
// in-flight work no longer mistakes it for an orphan and yank it back to `queued` underneath the runner.
// Filtered in SQL rather than read-all-then-filter - `running` is normally a handful of rows, but D1 bills
// rows read and this runs on every five-minute tick.
//
// THE ATTEMPT CAP APPLIES HERE TOO, and that is not a detail. `processOneJob` is the only other way out of
// `running`, and it decides "terminal" from a THROWN error - which a job that DIED rather than threw never
// produces. An invocation killed at the CPU ceiling is exactly that shape, and exactly what a 25-PDF payslip
// batch runs into (it is why `[limits] cpu_ms` is raised at all). Reclaiming such a job unconditionally looped
// it forever: back to `queued` every five minutes, `attempts` climbing with nothing reading it, one drain slot
// and one killed invocation burned per tick, and no dead-letter row for anyone to notice. So the two paths out
// of `running` now agree on when a job has had enough, and the one that cannot see an exception says so in
// `last_error` rather than leaving the column holding whatever failure came before.
async function reclaimStuckJobs(deps: Deps): Promise<number> {
  const cutoff = new Date(+deps.clock.now() - STALE_RUNNING_MS);
  // Dead-letter FIRST: these rows leave `running`, so the reclaim below no longer matches them.
  const spent = await deps.db
    .update(schema.jobs)
    .set({
      status: "error",
      attempts: sql`${schema.jobs.attempts} + 1`,
      lastError: "orphaned mid-run with no attempts left - the runner stopped without throwing (most likely the invocation's CPU limit)",
    })
    .where(and(eq(schema.jobs.status, "running"), lt(schema.jobs.updatedAt, cutoff), gte(schema.jobs.attempts, MAX_JOB_ATTEMPTS - 1)))
    .returning();
  for (const job of spent) {
    console.error(`job ${job.kind} ${job.uuid} orphaned in running at attempt ${job.attempts}/${MAX_JOB_ATTEMPTS} (terminal)`);
    await notifyJobDeadLetter(deps, job, job.lastError ?? "orphaned mid-run");
  }
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
  //
  // OLDEST FIRST, which it was not. `LIMIT` with no `ORDER BY` takes whatever rows the plan reaches first, and
  // for an indexed scan on `status` that is effectively insertion order of the index - stable enough that a
  // job which does not clear is met by the same slice every tick. Two shapes turn that into starvation rather
  // than untidiness: an LRO requeues itself (a payslip batch, the reminder mail, carry-forward), and a failing
  // job comes back with a backoff - so a handful of them sitting at the head of the scan can fill `limit`
  // every five minutes while a job queued behind them is never once looked at. Nothing reports that; the drain
  // returns a healthy count of jobs it did advance.
  //
  // FIFO makes the queue a queue: a requeued LRO goes back with a fresh `updated_at` but keeps its original
  // `created_at`, so it holds its place rather than either monopolising the front or being pushed to the back,
  // and anything waiting behind it reaches the front in bounded time.
  const now = deps.clock.now();
  const queued = await deps.db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, "queued"), or(isNull(schema.jobs.runAfter), lte(schema.jobs.runAfter, now))))
    .orderBy(asc(schema.jobs.createdAt), asc(schema.jobs.uuid))
    .limit(limit);
  let processed = 0;
  let dropped = 0;
  for (const job of queued) {
    // ONE DISPATCH BUDGET PER JOB, not one for the whole drain. A job is its own originating action - it was
    // enqueued by a request or a rule that has already finished - and jobs in a drain are unrelated to each
    // other. Sharing one allowance meant the queue order decided whose automations ran: a payslip run emits
    // one `payslip.published` per slip in its batch, so two of them ahead of you in the queue could spend the
    // whole budget and every later job's events were refused for reasons that had nothing to do with that job.
    // Same argument `subtasks()` makes for the nightly subtasks, applied one level down.
    const { result: outcome, dropped: jobDropped } = await withDispatchBudget(deps, () => processOneJob(deps, job));
    dropped += jobDropped;
    // A requeue is queue-neutral (the row is back in `queued`, nothing advanced) and a skip means another
    // drain owns it - neither is work this tick did, so neither counts.
    if (outcome !== "requeued" && outcome !== "skipped") processed++;
  }
  // Surfaced the way the subtask wrapper surfaces its own: a job whose automations were refused is a lost
  // automation, and the drain must not report a clean tick over it.
  if (dropped > 0) console.warn(`drainJobs: ${dropped} automation dispatch(es) dropped at the per-job budget ceiling`);
  return processed;
}

// Run a single job on demand (the operations:run custom method). A `done` job is a no-op; queued / errored
// / orphaned-running jobs are (re)processed. Returns the fresh row for the response.
//
// WHY THIS RE-QUEUES INSTEAD OF CALLING processOneJob STRAIGHT. That claim is guarded on `queued` and nothing
// else - the predicate that makes at-most-one-runner true when a manual tick overlaps the schedule - so an
// `error` or orphaned-`running` row matched nothing and the call did NOTHING. Which is the whole point of the
// terminal `error` state: MAX_JOB_ATTEMPTS stops the QUEUE retrying, and the Operations page's Retry button is
// how a human overrides that once the cause is fixed. That button was inert, and worse than inert - it came
// back with the unchanged row, so the page re-rendered the same failure and its stale detail as though the job
// had just run and failed again. A payslip run that spent its attempts was recoverable only by hand in D1.
//
// So the state is moved to `queued` first, GUARDED on the state we just read, and only then claimed. The guard
// is what keeps the drain race closed: if a drain took the row in between, or another operator pressed the
// button first, this UPDATE matches nothing and the job is left alone instead of being yanked out from under
// its runner.
export async function runJob(deps: Deps, jobId: string): Promise<JobRow | undefined> {
  const read = async () => (await deps.db.select().from(schema.jobs).where(eq(schema.jobs.uuid, jobId)).limit(1))[0];
  const job = await read();
  if (!job || job.status === "done") return job;

  if (job.status !== "queued") {
    // A `running` row is only claimable once it is past the orphan cutoff - the same rule reclaimStuckJobs
    // applies, and for the same reason. Before it, the row is somebody's live work and re-queueing it would put
    // two runners on one job; after it, the runner is gone and this is the manual version of the reclaim.
    if (job.status === "running" && +new Date(job.updatedAt) >= +deps.clock.now() - STALE_RUNNING_MS) return job;
    // `run_after` goes with it: an on-demand run means now, not after whatever backoff the last failure set.
    // `attempts` deliberately does NOT reset - the row has already failed that many times and hiding it would
    // make the Attempts column a lie. So a manual retry is ONE more attempt: if it fails, the job returns to
    // terminal rather than quietly buying itself another five rounds of automatic retries in the background.
    const requeued = await deps.db
      .update(schema.jobs)
      .set({ status: "queued", runAfter: null })
      .where(and(eq(schema.jobs.uuid, jobId), eq(schema.jobs.status, job.status)))
      .returning();
    if (!requeued.length) return read(); // someone else moved it first - report what it actually is now
    await processOneJob(deps, requeued[0]!);
    return read();
  }

  await processOneJob(deps, job);
  return read();
}


type LeaveTypeRow = typeof schema.leaveTypes.$inferSelect;

// ---- Shared reads for the nightly reminder subtasks ------------------------------------------------------
//
// The roster the reminders work over. `status` and the soft-delete mark are INDEPENDENT columns: the generic
// soft delete (services/softDelete.ts) only stamps `delete_time` and deliberately never touches `status`, so a
// removed employee stays `status = "active"` forever. Three subtasks needed this roster; two of them filtered
// on status alone and went on emailing and notifying people who had been deleted. One reader, both conditions,
// pushed into SQL so the tick does not pay to read rows it will drop.
const activeRoster = (deps: Deps) =>
  deps.db
    .select()
    .from(schema.employees)
    .where(and(eq(schema.employees.status, "active"), isNull(schema.employees.deleteTime)));

/** Live personal documents lapsing within `[todayMs, untilMs]`.
 *
 *  Two fixes in one read. The `delete_time` condition is the correctness half: a document in the trash was
 *  still emitting `document.expiring` - which automation rules act on - and still nudging its owner by email
 *  and in-app, every night for the thirty nights before a date nobody cared about any more. (The org-document
 *  loop three subtasks down had always checked it, which is what makes this an omission rather than a policy.)
 *  Pushing the window into SQL is the cost half: this was a whole-table scan on every nightly tick, over the
 *  one table in the app that only ever grows, and D1 bills rows read. */
const expiringPersonalDocuments = (deps: Deps, todayMs: number, untilMs: number) =>
  deps.db
    .select()
    .from(schema.personalDocuments)
    .where(
      and(
        isNull(schema.personalDocuments.deleteTime),
        gte(schema.personalDocuments.expireTime, new Date(todayMs)),
        lte(schema.personalDocuments.expireTime, new Date(untilMs)),
      ),
    );

// Year-end carry-forward: caps each balance at the carry-forward limit (per-type or one cumulative cap) and
// either auto-encashes the excess (up to the encashment cap) or forfeits it - all driven by the leave_caps
// settings. Idempotent per calendar year via leave_balances.lastCarryForwardYear; a never-stamped row is just
// initialized (no forfeiture) so the first run can't strip mid-year balances. Runs BEFORE accrual.
export async function carryForwardLeave(deps: Deps): Promise<number> {
  return (await rollCarryForward(deps, true)).processed;
}

/** One pass of the rollover: at most `CARRY_FORWARD_EMPLOYEE_BATCH` employees, and how many were left over.
 *  `queueRemainder` is true only for the nightly tick - the queued continuation is requeued by the drain
 *  instead, so a pass that enqueued again would fork a new job on every pass. */
async function rollCarryForward(deps: Deps, queueRemainder: boolean): Promise<{ processed: number; remaining: number }> {
  // The ORG's calendar year, not the Worker's - the same rule emitScheduledEvents follows below, and for the
  // same reason: this tick runs at 02:00 UTC, which is still 31 December in every timezone west of UTC. Taken
  // from the UTC year, an org in the Americas had its year-end forfeiture and its auto-encashment payouts run
  // on the evening of the 31st, against balances that still had a day of the year left to be spent.
  //
  // Resolved ONCE for the whole tick and passed down. This subtask reads the encashment cap per employee, and
  // in per-type mode per leave type as well; the tick has no per-request settings memo (lib/refData), so a year
  // derived at each of those would be a D1 read at each of those. Sharing one value also makes it impossible
  // for the year a balance is STAMPED with to differ from the year its payout cap was measured over - the two
  // are now literally the same string.
  const oy = await orgYear(deps);
  const year = oy.year;
  const caps = await leaveCaps(deps);
  const employees = await activeRoster(deps);
  const leaveTypes = await refLeaveTypes(deps);
  const ltById = new Map(leaveTypes.map((lt) => [lt.uuid, lt] as const));
  // The year's encashments for the WHOLE org, in one read. The paragraph above explains why the year is
  // resolved once and passed down; the reads it feeds were still per employee, and in per-type mode per
  // employee per leave type. That is a round-trip apiece on the single night this subtask does anything, and
  // it is competing with twenty-one other subtasks for one invocation's subrequest budget while forfeiting
  // leave and creating real payouts. Same window, same `covers` decision, one read.
  const encashedThisYear = await encashedDaysThisYearAll(deps, oy);
  // The rows still OWED a rollover for `year`, grouped per employee: on an ordinary night this reads nothing
  // (every row is already stamped) instead of the whole balances table, which is what it used to cost every
  // night of the year for the sake of one night's work. This snapshot is only a cheap "is there anything to
  // roll over" probe - the rollover itself re-reads the employee's rows (below), because it writes ABSOLUTE
  // balances and a stale one would restore days already spent. The per-row guarded claims are rollover-only
  // writes and deliberately stay individual - each claim gates a payout on its own result.
  const balByEmp = new Map<string, (typeof schema.leaveBalances.$inferSelect)[]>();
  const owed = await deps.db
    .select()
    .from(schema.leaveBalances)
    .where(or(isNull(schema.leaveBalances.lastCarryForwardYear), ne(schema.leaveBalances.lastCarryForwardYear, year)));
  for (const b of owed) {
    const arr = balByEmp.get(b.employeeId);
    if (arr) arr.push(b);
    else balByEmp.set(b.employeeId, [b]);
  }
  let processed = 0;
  // BOUNDED PER INVOCATION, with the remainder handed to the queue.
  //
  // Everything below is per employee and per balance row - a fresh read of their rows, a guarded claim per
  // row, and up to five more calls per auto-encashment payout (`createAutoEncashment` prices from
  // compensation and allocates a code before it inserts). On an ordinary night the probe above matches
  // nothing and none of it runs; on year-end night it runs for the whole roster, in the one invocation the
  // tick has, alongside twenty-one other subtasks. Running out of subrequests part-way through the roster is
  // the worst failure this app can have: some people's leave forfeited and paid out, the rest untouched.
  //
  // A slice is safe to take because the rollover is already idempotent per calendar year - the
  // `last_carry_forward_year` stamp is what makes a re-run skip what is done - so a continuation needs no
  // cursor, only another pass. The queue drains every five minutes and takes one pass per drain, so the roster
  // finishes over the following hours (about four for 500 people) rather than a day later, which is what
  // leaving it to tomorrow's tick would mean for the payouts. See CARRY_FORWARD_MAX_PASSES for the arithmetic
  // and for why the spread is harmless.
  const withWork = employees.filter((e) => balByEmp.has(e.uuid));
  const slice = withWork.slice(0, CARRY_FORWARD_EMPLOYEE_BATCH);

  for (const emp of slice) {
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
      // Chunked to the id cap like every other IN list in the app: the statement also binds the year and the
      // stamp, so a list sized at the cap is over it. An employee with more leave types than that is unusual,
      // which is exactly why an unchunked list here would have failed for the first org that had one, on
      // first-deploy night, in the subtask that stamps every balance row in the org.
      await byIdChunks(init.map((b) => b.uuid), (group) =>
        deps.db
          .update(schema.leaveBalances)
          .set({ lastCarryForwardYear: year, updatedAt: new Date() })
          .where(inArray(schema.leaveBalances.uuid, group))
          .returning({ uuid: schema.leaveBalances.uuid }),
      );
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
    // Both figures come out of the one org-wide read taken above, so neither is a round-trip.
    let cumEncRemaining = caps.encashment_mode === "cumulative"
      ? (caps.encashment_cumulative_cap_days == null ? Infinity : Math.max(0, caps.encashment_cumulative_cap_days - encashedThisYear.total(emp.uuid)))
      : Infinity;
    const encashRemainingFor = (lt: LeaveTypeRow): number => {
      if (!lt.encashable) return 0; // only encashable types can absorb excess as a payout
      if (caps.encashment_mode === "cumulative") return cumEncRemaining;
      return lt.encashmentCapDaysPerYear == null ? Infinity : Math.max(0, lt.encashmentCapDaysPerYear - encashedThisYear.perType(emp.uuid, lt.uuid));
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
      // ONE BATCH for the employee's claims, not one round-trip per balance row. Each claim keeps its own
      // guard and its own verdict: `runBatchChecked` reports the LABEL of any statement that touched no row,
      // which is precisely the "this row lost its claim" signal the per-row loop read off `.returning()`.
      // D1 runs a batch as one implicit transaction and one subrequest, so a five-leave-type employee costs
      // one write instead of five - and the whole subtask stops scaling its round-trips by the org's balance
      // rows on the single night it does anything.
      const claims: CheckedStmt[] = pending.map((b) => ({
        stmt: deps.db
          .update(schema.leaveBalances)
          .set({ balanceDays: splits.get(b.uuid)!.carried, lastCarryForwardYear: year, updatedAt: new Date() })
          .where(and(eq(schema.leaveBalances.uuid, b.uuid), ne(schema.leaveBalances.lastCarryForwardYear, year), eq(schema.leaveBalances.balanceDays, b.balanceDays)))
          .returning({ uuid: schema.leaveBalances.uuid }),
        expect: 1,
        label: b.uuid,
      }));
      const lostIds = new Set(await runBatchChecked(deps.db, claims));
      const lost = pending.filter((b) => lostIds.has(b.uuid));
      // Only the rows that actually landed spend from the caps and earn a payout. `capLeft` is reduced by the
      // sum of what they kept, which is the same figure the per-row decrement arrived at - the splits for the
      // whole attempt were sized off one `capLeft` to begin with, so only a RETRY ever sees the difference.
      const won = pending.filter((b) => !lostIds.has(b.uuid));
      for (const b of won) {
        const split = splits.get(b.uuid)!;
        if (capLeft != null) capLeft = Math.max(0, round2(capLeft - split.carried));
        processed++;
      }
      // Payouts after the claims, for the reason the note above gives: a stamped row with no payout is
      // recoverable, a payout with no stamp is paid twice.
      for (const b of won) {
        const lt = ltById.get(b.leaveTypeId);
        const split = splits.get(b.uuid)!;
        if (!(split.excess > 0) || caps.carry_forward_excess !== "encash" || !lt) continue;
        const { encash } = splitEncashExcess(split.excess, "encash", encashRemainingFor(lt));
        if (encash <= 0) continue;
        const ok = await createAutoEncashment(deps, emp.uuid, lt.uuid, encash);
        if (ok && caps.encashment_mode === "cumulative") cumEncRemaining = Math.max(0, cumEncRemaining - encash);
      }
      pending = lost;
    }
    // Only reachable if the same rows kept changing under every attempt. Leaving them unstamped is the safe
    // side (no forfeiture, no payout); tomorrow's tick retries them.
    if (pending.length) console.warn(`[cron] carry-forward skipped ${pending.length} balance row(s) for employee ${emp.uuid}: balances kept changing mid-rollover`);
  }
  // Anything the slice did not reach. Enqueued rather than left silent: a partial rollover looks identical to
  // a finished one from the outside (the subtask returns a count either way), and the difference is whether
  // some of the org still has last year's balance and an unpaid encashment.
  const remaining = withWork.length - slice.length;
  if (remaining > 0 && queueRemainder) {
    await deps.db.insert(schema.jobs).values({
      code: await allocFlatCode(deps, schema.jobs),
      kind: CARRY_FORWARD_JOB,
      payload: JSON.stringify({ year, correlationId: deps.trace }),
    });
    console.warn(`[cron] carry-forward queued for ${remaining} more employee(s): the roster outran one invocation`);
  }
  return { processed, remaining };
}

// Emit time-based domain events for automations to react to: probation ending today, a work anniversary today,
// and personal documents expiring within 30 days. This is the event twin of sendReminders (which sends email):
// it lets a data-defined rule ("congratulate anniversaries", "renewal task on expiry") run WITHOUT new code.
// System-emitted (actor = null). Returns the number of events emitted.
async function emitScheduledEvents(deps: Deps): Promise<number> {
  // The ORG's calendar day, not the Worker's. Date-only columns (start, probation end, expiry) are anchored at
  // UTC midnight, so the day is compared as UTC ms - but which day that is comes from the org timezone. The
  // tick runs at 02:00 UTC, which is the same date in IST and the PREVIOUS EVENING in the Americas, so a
  // UTC-derived "today" congratulated anniversaries and ended probations a day early for any org west of UTC.
  const todayMs = dayStartMs(await orgToday(deps));
  const today = new Date(todayMs); // read with getUTC* below, so this anchor IS the org-local calendar day
  const dayMs = 86_400_000;
  let emitted = 0;

  // MATCH FIRST, THEN FAN OUT. Every notification below used to be an awaited `notify()` inside the loop that
  // found it - roughly three D1 calls each, plus a fourth when push is configured - so a day on which a lot of
  // people happen to share an anniversary spent the invocation's whole subrequest budget here and every later
  // subtask in the tick failed with it. The matches are collected as plain data and handed to `notifyMany`,
  // which allocates every code and inserts every row in one batch (see its `titleFor`/`bodyFor` note).
  //
  // `emitEvent` stays per match on purpose: it is the automation trigger, one row and one dispatch each, and
  // it is bounded by how many people match today rather than by headcount.
  const employees = await activeRoster(deps);
  const byId = new Map(employees.map((e) => [e.uuid, e]));
  const probationEnding: string[] = [];
  const anniversaries = new Map<string, number>(); // employee -> completed years
  for (const emp of employees) {
    if (!emp.startDate) continue;
    const start = +new Date(emp.startDate);
    const probationEnd = emp.probationEndDate ? +new Date(emp.probationEndDate) : start + 90 * dayMs;
    if (probationEnd >= todayMs && probationEnd < todayMs + dayMs) {
      await emitEvent(deps, null, "schedule.probationEnding", { subject: `employees/${emp.uuid}`, employeeId: emp.uuid, payload: { probationEndDate: new Date(probationEnd).toISOString() } });
      probationEnding.push(emp.uuid);
      emitted++;
    }
    const startDate = new Date(start);
    if (isAnniversaryOf(startDate, today) && start < todayMs) {
      const years = today.getUTCFullYear() - startDate.getUTCFullYear();
      await emitEvent(deps, null, "schedule.workAnniversary", { subject: `employees/${emp.uuid}`, employeeId: emp.uuid, payload: { years } });
      anniversaries.set(emp.uuid, years);
      emitted++;
    }
  }

  if (probationEnding.length) {
    // The employee's own copy: one wording for everybody.
    await notifyMany(deps, probationEnding, {
      type: "transition.probation_ending",
      title: "Your probation ends today",
      body: "Your probation period ends today - your manager will confirm your status.",
      link: "profile",
    });
    // The manager's copy names the report, so the audience is grouped BY MANAGER and the body is resolved per
    // recipient. `managerId` rides on the roster row already read above - it used to be a `managerIdOf` read
    // per matching employee, which is a second per-person round-trip for a column already in memory.
    const reportsByManager = new Map<string, string[]>();
    for (const id of probationEnding) {
      const mgr = byId.get(id)?.managerId;
      if (!mgr || mgr === id) continue;
      const arr = reportsByManager.get(mgr);
      if (arr) arr.push(id);
      else reportsByManager.set(mgr, [id]);
    }
    const nameOfEmp = (id: string) => {
      const e = byId.get(id);
      return `${e?.firstName ?? ""} ${e?.lastName ?? ""}`.trim() || "A report";
    };
    if (reportsByManager.size) {
      await notifyMany(deps, [...reportsByManager.keys()], {
        type: "transition.probation_ending",
        title: "A report's probation ends today",
        bodyFor: (mgr) => {
          const reports = reportsByManager.get(mgr) ?? [];
          const names = reports.map(nameOfEmp).join(", ");
          return `${names}${reports.length === 1 ? "'s probation ends" : " have probations ending"} today - please confirm their status.`;
        },
        link: "employees",
        // One manager can have several reports ending today, so the subject is the report only when there is
        // exactly one; otherwise the notification is about the group and the link carries it.
        subjectFor: (mgr) => {
          const reports = reportsByManager.get(mgr) ?? [];
          return reports.length === 1 ? `employees/${reports[0]}` : null;
        },
      });
    }
  }

  if (anniversaries.size) {
    await notifyMany(deps, [...anniversaries.keys()], {
      type: "system.work_anniversary",
      title: "Happy work anniversary! 🎉",
      bodyFor: (id) => {
        const years = anniversaries.get(id) ?? 0;
        return `Congratulations on ${years} year${years !== 1 ? "s" : ""} with us.`;
      },
      link: "dashboard",
    });
  }

  const thirtyDaysMs = todayMs + 30 * dayMs;
  // A person can have several documents lapsing in the window, so the fan-out is per RECIPIENT and the body
  // names them. One notification per person beats one per document for the reader too.
  const expiringByEmp = new Map<string, { title: string; daysLeft: number; uuid: string }[]>();
  for (const doc of await expiringPersonalDocuments(deps, todayMs, thirtyDaysMs)) {
    const daysLeft = Math.ceil((+new Date(doc.expireTime!) - todayMs) / dayMs);
    await emitEvent(deps, null, "document.expiring", { subject: `personal-documents/${doc.uuid}`, employeeId: doc.employeeId, payload: { daysLeft, title: doc.title } });
    const arr = expiringByEmp.get(doc.employeeId);
    if (arr) arr.push({ title: doc.title, daysLeft, uuid: doc.uuid });
    else expiringByEmp.set(doc.employeeId, [{ title: doc.title, daysLeft, uuid: doc.uuid }]);
    emitted++;
  }
  if (expiringByEmp.size) {
    const days = (n: number) => `${n} day${n !== 1 ? "s" : ""}`;
    await notifyMany(deps, [...expiringByEmp.keys()], {
      type: "document.expiring",
      title: "Document expiring soon",
      titleFor: (id) => ((expiringByEmp.get(id)?.length ?? 0) > 1 ? "Documents expiring soon" : "Document expiring soon"),
      bodyFor: (id) => {
        const docs = (expiringByEmp.get(id) ?? []).slice().sort((a, b) => a.daysLeft - b.daysLeft);
        if (docs.length === 1) return `"${docs[0]!.title}" expires in ${days(docs[0]!.daysLeft)} - please renew it.`;
        return `${docs.length} of your documents lapse soon, the first ("${docs[0]!.title}") in ${days(docs[0]!.daysLeft)} - please renew them.`;
      },
      link: "documents",
      subjectFor: (id) => {
        const docs = expiringByEmp.get(id) ?? [];
        return docs.length === 1 ? `personal-documents/${docs[0]!.uuid}` : null;
      },
      action: "respond",
    });
  }

  // Compliance filings due within a week: remind the assignee (pending, dated, assigned events only). Windowed
  // and filtered in SQL, matching the document read above - this scanned every pending event and dropped most
  // of them in JS. Grouped by assignee, since one person often owns several filings in the same week.
  const sevenDaysMs = todayMs + 7 * dayMs;
  const dueEvents = await deps.db
    .select()
    .from(schema.complianceEvents)
    .where(
      and(
        eq(schema.complianceEvents.status, "pending"),
        isNull(schema.complianceEvents.deleteTime),
        gte(schema.complianceEvents.dueDate, new Date(todayMs)),
        lte(schema.complianceEvents.dueDate, new Date(sevenDaysMs)),
      ),
    );
  const dueByAssignee = new Map<string, { title: string; daysLeft: number; uuid: string }[]>();
  for (const ev of dueEvents) {
    if (!ev.assigneeId || !ev.dueDate) continue;
    const daysLeft = Math.ceil((+new Date(ev.dueDate) - todayMs) / dayMs);
    const arr = dueByAssignee.get(ev.assigneeId);
    if (arr) arr.push({ title: ev.title, daysLeft, uuid: ev.uuid });
    else dueByAssignee.set(ev.assigneeId, [{ title: ev.title, daysLeft, uuid: ev.uuid }]);
    emitted++;
  }
  if (dueByAssignee.size) {
    const days = (n: number) => `${n} day${n !== 1 ? "s" : ""}`;
    await notifyMany(deps, [...dueByAssignee.keys()], {
      type: "compliance.due",
      title: "Compliance filing due soon",
      titleFor: (id) => ((dueByAssignee.get(id)?.length ?? 0) > 1 ? "Compliance filings due soon" : "Compliance filing due soon"),
      bodyFor: (id) => {
        const evs = (dueByAssignee.get(id) ?? []).slice().sort((a, b) => a.daysLeft - b.daysLeft);
        if (evs.length === 1) return `${evs[0]!.title} is due in ${days(evs[0]!.daysLeft)}.`;
        return `${evs.length} filings are due this week, the first (${evs[0]!.title}) in ${days(evs[0]!.daysLeft)}.`;
      },
      link: "compliance",
      subjectFor: (id) => {
        const evs = dueByAssignee.get(id) ?? [];
        return evs.length === 1 ? `compliance-events/${evs[0]!.uuid}` : null;
      },
      priority: "high",
    });
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
  // The ORG's today, not the Worker's. `meeting_date` is date-only at UTC midnight and this tick fires at
  // 02:00 UTC - which is still the previous EVENING anywhere west of UTC, so a UTC-derived "today" is a day
  // ahead of the org's and rolled a 1:1 whose meeting had not happened yet. See services/orgDay.ts.
  const todayMs = dayStartMs(await orgToday(deps));
  const today = new Date(todayMs);
  // Only the rows that could possibly roll: live, cadence-bearing, and already past their meeting date. Exactly
  // the conditions the loop applied, moved into SQL - one row of a series carries the cadence at a time, so
  // this reads a handful where it used to read every 1:1 the org has ever held, on every nightly tick.
  const rows = await deps.db
    .select()
    .from(schema.checkIns)
    .where(
      and(
        isNull(schema.checkIns.deleteTime),
        isNotNull(schema.checkIns.cadence),
        lt(schema.checkIns.meetingDate, today),
      ),
    );
  let rolled = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.cadence || !r.meetingDate) continue; // narrowing only; SQL already excluded both
    // The series' day of the month, carried onto the successor below. A month step clamps into a short month
    // (domain/calendar.ts), and stepping from where that clamp landed is what moved a monthly 1:1 on the 31st
    // to the 28th at its first February and kept it there. The anchor puts it back on the 31st in March.
    const cadence = r.cadence;
    const anchorDay = seriesAnchorDay(+new Date(r.meetingDate), r.cadenceAnchorDay);
    const next = advanceUntilAfter(new Date(+new Date(r.meetingDate)), todayMs - 1, (d) =>
      cadence === "monthly" ? addMonthsFromAnchor(d, 1, anchorDay) : addDaysUtc(d, cadence === "weekly" ? 7 : 14));
    // GUARDED, like the attendee list in rollRepeatingEvents below. This parse used to be bare, so one row
    // whose `action_items_json` could not be read threw out of the whole subtask and every OTHER series went
    // unrolled that night - a single bad blob stopping every recurring 1:1 in the org. An unreadable list is
    // read as no list: the 1:1 still rolls, carrying nothing forward, which is the outcome that loses least.
    let items: CheckInItem[] = [];
    try {
      const parsed = r.actionItemsJson ? JSON.parse(r.actionItemsJson) : [];
      if (Array.isArray(parsed)) items = parsed as CheckInItem[];
    } catch {
      console.error(`[cron] check-in ${r.uuid} has unreadable action items; rolling without carrying them forward`);
    }
    const open = items.filter((i) => !i.done);
    // The successor's id is minted HERE rather than by the insert, so the failure path below can ask whether it
    // landed - the same shape services/cards.ts#rollRecurringCards uses, and for the same reason.
    const nextId = genId();
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
    try {
      const created = (await deps.db
        .insert(schema.checkIns)
        .values({
          uuid: nextId,
          code: await allocOwnedCode(deps, schema.checkIns, schema.checkIns.employeeId, r.employeeId),
          employeeId: r.employeeId,
          counterpartId: r.counterpartId,
          meetingDate: next,
          actionItemsJson: open.length ? JSON.stringify(open.map((i) => ({ text: i.text, done: false }))) : null,
          cadence: r.cadence,
          cadenceAnchorDay: anchorDay, // the series' day travels with the cadence, onto the one row that carries it
        })
        .returning())[0]!;
      const when = next.toISOString().slice(0, 10);
      const carried = open.length ? ` ${open.length} open action item${open.length === 1 ? "" : "s"} carried forward.` : "";
      // Both sides in one batch: the wording is the same for the pair, so this is one insert group rather than
      // two independent notify() round-trips per rolled 1:1.
      await notifyMany(deps, [r.employeeId, r.counterpartId].filter((x): x is string => !!x), {
        type: "checkin.scheduled",
        title: "Next 1:1 scheduled",
        body: `Your recurring 1:1 was scheduled for ${when}.${carried}`,
        link: "check-ins",
        subject: `check-ins/${created.uuid}`,
      });
      rolled++;
    } catch (err) {
      // The claim already took the cadence off the old row, so put it back: the series retries on the next
      // tick instead of ENDING HERE. Claim-and-then-throw meant a recurring 1:1 the pair had set up simply
      // stopped existing, with nothing anywhere saying so - and worse than the card case, because the claim
      // also marked the open action items done, so those were lost with it. The original list goes back too.
      //
      // Unless the successor actually landed first: it carries the cadence now, so the series is intact and
      // restoring the old row as well would hand the next tick two 1:1s for one pair. Guarded on the value
      // this run wrote (cadence now NULL), so releasing cannot stamp over a cadence set by hand since.
      const landed = (await deps.db.select({ uuid: schema.checkIns.uuid }).from(schema.checkIns).where(eq(schema.checkIns.uuid, nextId)).limit(1))[0];
      if (!landed) {
        await deps.db
          .update(schema.checkIns)
          .set({ cadence: r.cadence, actionItemsJson: r.actionItemsJson, updatedAt: new Date() })
          .where(and(eq(schema.checkIns.uuid, r.uuid), isNull(schema.checkIns.cadence)));
      }
      failed++;
      console.error(`[cron] recurring 1:1 roll failed for check-in ${r.uuid}; claim released for retry`, err);
    }
  }
  // Loudly, so a night that could not roll a 1:1 shows as a failed tick in Operations rather than as silence.
  // Thrown only after every other series has had its turn.
  if (failed) throw new Error(`${failed} recurring 1:1(s) could not be rolled (${rolled} succeeded); each claim was released for the next tick`);
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
  // Resolved ONCE for the whole pass, not per row: `orgTimezone` reads settings, and a cron tick has no
  // request to memoize that read against (see services/orgDay.ts), so a per-row call is a D1 read per rolled
  // event. Used below to name the successor's date in the ORG's calendar - `start_date` is a real instant, so
  // rendering it with toISOString() names the UTC day, which in IST is the previous date for anything starting
  // before 05:30 local. A 6am stand-up was announced as happening yesterday.
  const tz = await orgTimezone(deps);
  // The loop's own conditions, in SQL: live, repeat-bearing, and finished. One row of a series carries the
  // repeat, so this reads a handful rather than the whole calendar on every tick.
  const rows = await deps.db
    .select()
    .from(schema.events)
    .where(and(isNull(schema.events.deleteTime), isNotNull(schema.events.repeat), lt(schema.events.endTime, new Date(nowMs))));
  let rolled = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.repeat) continue; // narrowing only; SQL already excluded the null case
    // The series' day of the month, resolved once and carried onto the successor below. Without it a monthly
    // all-hands on the 31st moved to the 28th at its first February and stayed there, and a yearly event on
    // 29 February never saw another leap day. See domain/calendar.ts#seriesAnchorDay for what re-anchors it.
    const anchorDay = seriesAnchorDay(+new Date(r.startTime), r.repeatAnchorDay);
    // Step until the occurrence is in the future: a series nobody touched for two months lands on its next
    // real date rather than replaying every date it missed.
    let { start, end } = nextOccurrence(+new Date(r.startTime), +new Date(r.endTime), r.repeat, anchorDay);
    let guard = 0;
    while (end < nowMs && guard++ < 400) ({ start, end } = nextOccurrence(start, end, r.repeat, anchorDay));
    // Minted here so the failure path can ask whether the successor landed - see rollRecurringCheckIns above.
    const nextId = genId();
    const claimed = await deps.db
      .update(schema.events)
      .set({ repeat: null, updatedAt: new Date() })
      .where(and(eq(schema.events.uuid, r.uuid), eq(schema.events.repeat, r.repeat)))
      .returning();
    if (!claimed.length) continue;
    try {
      const created = (await deps.db
        .insert(schema.events)
        .values({
          uuid: nextId,
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
          repeatAnchorDay: anchorDay, // the series' day travels with the repeat, onto the one row that carries it
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
      const when = localDay(start, tz);
      // One batch for the whole attendee list. An all-hands with two hundred named attendees was two hundred
      // notify() round-trips for a single rolled occurrence, all of them carrying identical text.
      await notifyMany(deps, attendees, {
        type: "event.scheduled",
        title: `${r.title} scheduled`,
        body: `The next one is on ${when}.`,
        link: "events",
        subject: `events/${created.uuid}`,
      });
      rolled++;
    } catch (err) {
      // Put the repeat back, for the reason spelled out in rollRecurringCheckIns: the claim has already
      // committed, so a throw here ended the series outright - a weekly all-hands that stopped appearing on
      // the calendar, with nothing saying why. Unless the successor landed and now carries the repeat itself,
      // in which case restoring this one would fill the calendar with two of everything.
      const landed = (await deps.db.select({ uuid: schema.events.uuid }).from(schema.events).where(eq(schema.events.uuid, nextId)).limit(1))[0];
      if (!landed) {
        await deps.db
          .update(schema.events)
          .set({ repeat: r.repeat, updatedAt: new Date() })
          .where(and(eq(schema.events.uuid, r.uuid), isNull(schema.events.repeat)));
      }
      failed++;
      console.error(`[cron] repeating-event roll failed for event ${r.uuid}; claim released for retry`, err);
    }
  }
  if (failed) throw new Error(`${failed} repeating event(s) could not be rolled (${rolled} succeeded); each claim was released for the next tick`);
  return rolled;
}

// Day-before reminder: both attendees of a 1:1 dated tomorrow get an in-app nudge on the nightly tick.
// The one-day window means each 1:1 matches exactly one tick, so there is nothing to dedupe.
export async function remindUpcomingCheckIns(deps: Deps): Promise<number> {
  // "Tomorrow" in the ORG's calendar. Derived from the UTC clock at a 02:00 UTC tick, this named the day
  // AFTER tomorrow for any org west of UTC - so the day-before nudge arrived two days before, and the actual
  // day before never matched a tick at all. See services/orgDay.ts.
  const dayMs = 86_400_000;
  const tomorrowMs = dayStartMs(await orgDayFromToday(deps, 1));
  // Tomorrow's live 1:1s, selected in SQL. The one-day window is narrow enough that the answer is a handful of
  // rows; reading every 1:1 in the org to find them was a whole-table scan per tick over a table that grows
  // with every meeting anyone has ever had.
  const due = await deps.db
    .select()
    .from(schema.checkIns)
    .where(
      and(
        isNull(schema.checkIns.deleteTime),
        gte(schema.checkIns.meetingDate, new Date(tomorrowMs)),
        lt(schema.checkIns.meetingDate, new Date(tomorrowMs + dayMs)),
      ),
    );
  if (!due.length) return 0;
  const ids = [...new Set(due.flatMap((r) => [r.employeeId, r.counterpartId]).filter((x): x is string => !!x))];
  // Both sides of every 1:1 tomorrow, so this can exceed the D1 bound-parameter cap on a busy day.
  const nameRows = await byIdChunks(ids, (group) =>
    deps.db.select().from(schema.employees).where(inArray(schema.employees.uuid, group)),
  );
  const names = new Map(nameRows.map((e) => [e.uuid, `${e.firstName} ${e.lastName}`]));
  // Collect first, fan out once. Every side of every 1:1 tomorrow was an awaited notify(), so a day on which
  // the whole company holds its 1:1s cost two round-trip groups per person; on a company that size it spent
  // the invocation and took the rest of the tick down with it. A person with two 1:1s tomorrow gets one
  // notification naming both counterparts, which is also the better read.
  const perRecipient = new Map<string, { with: string | null; checkIn: string }[]>();
  for (const r of due) {
    for (const [rid, other] of [[r.employeeId, r.counterpartId], [r.counterpartId, r.employeeId]] as const) {
      if (!rid) continue;
      const entry = { with: other ? names.get(other) ?? null : null, checkIn: r.uuid };
      const arr = perRecipient.get(rid);
      if (arr) arr.push(entry);
      else perRecipient.set(rid, [entry]);
    }
  }
  if (!perRecipient.size) return 0;

  // WHAT THERE IS TO TALK ABOUT, not just that there is a meeting. "Jot down talking points beforehand" is
  // advice nobody has ever acted on; the app already knows which of this person's goals are behind or have
  // gone quiet, and naming one of them is the difference between a reminder and a prompt. Same predicate the
  // dashboard uses (services/attention.ts#goalTrouble), so the 1:1 note and the "needs you" list can never
  // disagree about which goal is in trouble.
  //
  // ONE QUERY FOR EVERYBODY being reminded, not one per person: this runs on a tick that already has twenty
  // subtasks to get through.
  const cfg = await attentionSettings(deps);
  const trouble = new Map<string, AttentionItem[]>();
  const recipients = [...perRecipient.keys()];
  const goalRows = await byIdChunks(recipients, (group) =>
    deps.db
      .select({
        uuid: schema.goals.uuid, title: schema.goals.title, status: schema.goals.status, employeeId: schema.goals.employeeId,
        progress: schema.goals.progress, dueDate: schema.goals.dueDate, createdAt: schema.goals.createdAt, updatedAt: schema.goals.updatedAt,
      })
      .from(schema.goals)
      .where(and(
        inArray(schema.goals.employeeId, group),
        isNull(schema.goals.deleteTime),
        inArray(schema.goals.status, ["not_started", "in_progress"]),
      )),
  );
  const nowMs = deps.clock.now().getTime();
  for (const g of goalRows) {
    for (const item of goalTrouble(g, nowMs, cfg)) {
      const arr = trouble.get(g.employeeId) ?? [];
      arr.push(item);
      trouble.set(g.employeeId, arr);
    }
  }
  /** At most two, and each with its own specifics: a list of six is an agenda nobody reads on a phone. */
  const talkingPoints = (rid: string): string => {
    const items = rankAttention(trouble.get(rid) ?? []).slice(0, 2);
    if (items.length === 0) return "";
    return `\n\nWorth raising: ${items.map((i) => `${i.title} (${i.detail})`).join("; ")}.`;
  };

  await notifyMany(deps, [...perRecipient.keys()], {
    type: "checkin.reminder",
    title: "1:1 tomorrow",
    titleFor: (rid) => ((perRecipient.get(rid)?.length ?? 0) > 1 ? `${perRecipient.get(rid)!.length} 1:1s tomorrow` : "1:1 tomorrow"),
    bodyFor: (rid) => {
      const mine = perRecipient.get(rid) ?? [];
      if (mine.length === 1) {
        const withWho = mine[0]!.with ? ` with ${mine[0]!.with}` : "";
        return `Your 1:1${withWho} is tomorrow.${talkingPoints(rid) || " Jot down talking points beforehand."}`;
      }
      const who = mine.map((m) => m.with).filter(Boolean).join(", ");
      return `You have ${mine.length} 1:1s tomorrow${who ? ` (${who})` : ""}.${talkingPoints(rid) || " Jot down talking points beforehand."}`;
    },
    link: "check-ins",
    subjectFor: (rid) => {
      const mine = perRecipient.get(rid) ?? [];
      return mine.length === 1 ? `check-ins/${mine[0]!.checkIn}` : null;
    },
  });
  return perRecipient.size;
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
  // Counted from the ORG's today. `pick_by` is a calendar date somebody typed, and this subtask fires on
  // exactly two days of the year - the lead day and the deadline - so a "today" a day out west of UTC does
  // not shift the reminder, it MISSES it: the tick lands on daysLeft = lead + 1 and then lead - 1, matches
  // neither, and the deadline passes with nobody told. See services/orgDay.ts.
  const todayMs = dayStartMs(await orgToday(deps));
  const daysLeft = Math.round((deadlineMs - todayMs) / 86_400_000);
  const lead = cfg.pick_reminder_days ?? 7;
  if (daysLeft !== lead && daysLeft !== 0) return 0;

  // Only picks for holidays in the deadline's own year count: last year's choices don't fill this year's quota.
  const year = new Date(deadlineMs).getUTCFullYear();
  const holidaysById = new Map((await refHolidays(deps)).map((h) => [h.uuid, h]));
  // Which holidays a pick could even be FOR this year - a small, already-cached set. Selections are then read
  // for those holidays only, rather than reading every pick anyone has ever made and discarding the other
  // years' in JS. (This subtask only runs on two nights a year, so the read was cheap in aggregate - but a
  // whole-table read that is only ever mostly discarded is still the wrong shape, and the id list is right here.)
  const thisYearHolidayIds = [...holidaysById.values()].filter((h) => new Date(h.date).getUTCFullYear() === year).map((h) => h.uuid);
  const perEmployee = new Map<string, number>();
  if (thisYearHolidayIds.length) {
    const sels = await byIdChunks(thisYearHolidayIds, (group) =>
      deps.db.select().from(schema.holidaySelections).where(inArray(schema.holidaySelections.holidayId, group)),
    );
    for (const sel of sels) perEmployee.set(sel.employeeId, (perEmployee.get(sel.employeeId) ?? 0) + 1);
  }
  // Something to pick FROM, or the nudge is just noise.
  const openOptional = [...holidaysById.values()].filter(
    (h) => h.kind === "optional" && !h.deleteTime && !h.disabled && +new Date(h.date) >= todayMs && new Date(h.date).getUTCFullYear() === year,
  ).length;
  if (!openOptional) return 0;

  // ONE batch for the whole roster. This was an awaited notify() per employee - roughly three D1 calls each,
  // plus a fourth when push is configured - over every active person who still had a pick going spare, which
  // on any real headcount is the entire invocation's subrequest budget spent inside a single subtask. Since
  // the twenty-two subtasks of the nightly tick share one invocation, that also took down every subtask after
  // it. And this one cannot be recovered by tomorrow's tick: it fires only on the lead day and the deadline
  // (the `daysLeft` test above), so a night lost here is a deadline nobody was ever told about.
  //
  // The count left to pick differs per person, so the wording is resolved per recipient rather than shared.
  const remaining = new Map<string, number>();
  for (const emp of await activeRoster(deps)) {
    const left = max - (perEmployee.get(emp.uuid) ?? 0);
    if (left > 0) remaining.set(emp.uuid, left);
  }
  if (!remaining.size) return 0;
  const when = daysLeft === 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  await notifyMany(deps, [...remaining.keys()], {
    type: "holiday.pick_reminder",
    title: "Optional holidays left to pick",
    titleFor: (id) => {
      const left = remaining.get(id) ?? 0;
      return `${left} optional holiday${left === 1 ? "" : "s"} left to pick`;
    },
    body: `Picks for ${year} close ${when}. Choose your optional holidays before then - unused picks are lost.`,
    link: "holidays",
  });
  return remaining.size;
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
  // Nudges collected per HOLDER and sent in one batch below, rather than an awaited notify() per asset. A
  // fleet rollout hands out hardware to everybody at once, so "assets awaiting a scan" is roster-sized on
  // exactly the days it matters - and one person holding three unconfirmed items got three notifications.
  type Owed = { name: string; assetTag: string | null; days: number; uuid: string };
  const owedByHolder = new Map<string, Owed[]>();
  for (const r of rows) {
    const waiting = r.custodySince ? daysBetween(r.custodySince, now) : null;
    if (r.status === "pending_ack" && r.assignedTo && waiting !== null && waiting >= policy.ackReminderDays) {
      // The holder is nudged on every tick past the threshold: it is one line in their notification list, and
      // the whole point is that the asset stays visibly unconfirmed until they scan it.
      const owed = owedByHolder.get(r.assignedTo);
      const entry: Owed = { name: r.name, assetTag: r.assetTag, days: waiting, uuid: r.uuid };
      if (owed) owed.push(entry);
      else owedByHolder.set(r.assignedTo, [entry]);
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
  const label = (a: { name: string; assetTag: string | null }) => `${a.name}${a.assetTag ? ` (${a.assetTag})` : ""}`;
  if (owedByHolder.size) {
    await notifyMany(deps, [...owedByHolder.keys()], {
      type: "asset.assigned",
      title: "Confirm the asset you were given",
      titleFor: (id) => ((owedByHolder.get(id)?.length ?? 0) > 1 ? "Confirm the assets you were given" : "Confirm the asset you were given"),
      bodyFor: (id) => {
        const mine = (owedByHolder.get(id) ?? []).slice().sort((a, b) => b.days - a.days);
        if (mine.length === 1) return `${label(mine[0]!)} has been waiting ${mine[0]!.days} days for you to scan its tag.`;
        return `${mine.length} assets are waiting for you to scan their tags, the longest (${label(mine[0]!)}) for ${mine[0]!.days} days.`;
      },
      link: "assets",
      subjectFor: (id) => {
        const mine = owedByHolder.get(id) ?? [];
        return mine.length === 1 ? `assets/${mine[0]!.uuid}` : null;
      },
    });
  }

  // Managers hear about it once the holder has ignored the ask for twice the reminder window. ONE read for
  // every manager, which is what the comment here always claimed and what the code never did - it was a
  // `managerIdOf` round-trip per escalated asset, and then a notify() round-trip on top of it. `managerId`
  // comes off the holders' own rows, read once and chunked under D1's bound-parameter cap.
  if (escalations.length) {
    const holderIds = [...new Set(escalations.map((e) => e.row.assignedTo!).filter(Boolean))];
    const holders = await byIdChunks(holderIds, (group) =>
      deps.db.select({ uuid: schema.employees.uuid, managerId: schema.employees.managerId }).from(schema.employees).where(inArray(schema.employees.uuid, group)),
    );
    const managerOf = new Map(holders.map((h) => [h.uuid, h.managerId]));
    const byManager = new Map<string, { row: (typeof rows)[number]; days: number }[]>();
    for (const e of escalations) {
      const manager = managerOf.get(e.row.assignedTo!);
      if (!manager || manager === e.row.assignedTo) continue;
      const arr = byManager.get(manager);
      if (arr) arr.push(e);
      else byManager.set(manager, [e]);
    }
    if (byManager.size) {
      await notifyMany(deps, [...byManager.keys()], {
        type: "asset.assigned",
        title: "An asset in your team is unconfirmed",
        titleFor: (id) => ((byManager.get(id)?.length ?? 0) > 1 ? "Assets in your team are unconfirmed" : "An asset in your team is unconfirmed"),
        bodyFor: (id) => {
          const mine = (byManager.get(id) ?? []).slice().sort((a, b) => b.days - a.days);
          if (mine.length === 1) return `${label(mine[0]!.row)} has been unconfirmed for ${mine[0]!.days} days.`;
          return `${mine.length} assets are unconfirmed, the longest (${label(mine[0]!.row)}) for ${mine[0]!.days} days.`;
        },
        link: "assets",
        subjectFor: (id) => {
          const mine = byManager.get(id) ?? [];
          return mine.length === 1 ? `assets/${mine[0]!.row.uuid}` : null;
        },
      });
      acted += byManager.size;
    }
  }
  return acted;
}

// ---- Nightly reminder EMAIL -------------------------------------------------------------------------------
//
// Every message the nightly reminders owe: probation endings, work anniversaries, expiring personal documents,
// expiring company documents. Derived, never sent - the sending is paged (see below).
//
// WHY IT IS SPLIT THIS WAY. Each `deps.email.send` is an outbound fetch, so it spends from the SAME
// per-invocation subrequest budget as every D1 call the tick makes (50 on the free plan, 1000 on paid), and
// they were awaited one after another inside the roster loop. On the days this subtask has real work - a
// shared joining date coming off probation, a month whose document expiries have piled up - it therefore
// competed with the twenty-one other subtasks for the budget, and whichever ran after it failed with it.
//
// The vendor API is one HTTP request per message (lib/email.ts), so there is no batch call to reach for. What
// there IS is the job queue: it drains every five minutes, retries on a widening backoff, dead-letters after
// five attempts, and already carries exactly this shape of work in `payslip.generateRun` - a bounded batch per
// invocation that asks to be requeued until it is done. So the tick sends the first batch and hands the rest
// to the queue, which is also what finally makes a vendor outage recoverable rather than a night of lost mail.
type ReminderMail = { to: string; subject: string; bodyHtml: string; key: string };

const REMINDER_EMAIL_BATCH = 20; // messages per invocation; the queue requeues until the list is exhausted

async function reminderMails(deps: Deps, todayMs: number): Promise<ReminderMail[]> {
  const today = new Date(todayMs); // read with getUTC* below, so this anchor IS the org-local calendar day
  const dayMs = 86_400_000;
  // `bodyHtml` is RAW HTML by contract (lib/emailLayout.ts), so every value folded into one of the templates
  // below has to be escaped by the caller - which is why emailLayout exports `escapeHtml` at all, and what
  // services/ats.ts and services/automationEngine.ts already do. This subtask did not: a person's first name
  // and a document's TITLE went into the markup as written. A document title is employee-supplied text that
  // reaches the HR contact's inbox in the org-document branch below, so an anchor tag typed into a title
  // arrived as a live link in a company email. `heading` is escaped by the shell already; only the body was open.
  const h = escapeHtml;
  const days = (n: number) => `${n} day${n !== 1 ? "s" : ""}`;
  const out: ReminderMail[] = [];

  const employees = await activeRoster(deps);
  for (const emp of employees) {
    if (!emp.startDate) continue;
    const start = +new Date(emp.startDate);

    // Probation end: the per-employee date if set, else 90 days after startDate.
    const probationEnd = emp.probationEndDate ? +new Date(emp.probationEndDate) : start + 90 * dayMs;
    if (probationEnd >= todayMs && probationEnd < todayMs + dayMs) {
      out.push({
        to: emp.workEmail,
        subject: "Probation period ending today",
        bodyHtml: `<p>Hi ${h(emp.firstName ?? "")},</p><p>Your probation period ends today. Please connect with HR to confirm your status.</p>`,
        key: `probation:${emp.uuid}`,
      });
    }

    // Work anniversary (same month+day each year, 29 February clamped to the 28th - see isAnniversaryOf)
    const startDate = new Date(start);
    if (isAnniversaryOf(startDate, today) && start < todayMs) {
      const years = today.getUTCFullYear() - startDate.getUTCFullYear();
      out.push({
        to: emp.workEmail,
        subject: `Happy ${years}-year work anniversary!`,
        bodyHtml: `<p>Hi ${h(emp.firstName ?? "")},</p><p>Congratulations on <strong>${years} year${years !== 1 ? "s" : ""}</strong> with us! Thank you for everything you bring to the team.</p>`,
        key: `anniversary:${emp.uuid}`,
      });
    }
  }

  // Expiring personal documents: notify the owning employee if expires within 30 days. (Org documents
  // have no owner, so no per-employee reminder.) Live rows only, windowed in SQL - see
  // expiringPersonalDocuments for why both of those matter.
  const thirtyDaysMs = todayMs + 30 * dayMs;
  const byId = new Map(employees.map((e) => [e.uuid, e]));
  for (const doc of await expiringPersonalDocuments(deps, todayMs, thirtyDaysMs)) {
    // No row in the active roster = the owner is inactive or deleted; their document is not their problem now.
    const emp = byId.get(doc.employeeId);
    if (!emp) continue;
    const daysLeft = Math.ceil((+new Date(doc.expireTime!) - todayMs) / dayMs);
    out.push({
      to: emp.workEmail,
      subject: `Document expiring in ${days(daysLeft)}: ${doc.title}`,
      bodyHtml: `<p>Hi ${h(emp.firstName ?? "")},</p><p>Your document "<strong>${h(doc.title)}</strong>" expires in <strong>${days(daysLeft)}</strong>. Please upload a renewed copy before it lapses.</p>`,
      key: `pdoc:${doc.uuid}`,
    });
  }

  // Expiring ORG documents (no owner) -> notify the configured HR contact, if any. Closes the org-doc gap;
  // personal docs reach their owner above.
  const org = await getSettingValue<{ letter_defaults?: { hr_email?: string } }>(deps, "organization", {});
  const hrEmail = org.letter_defaults?.hr_email;
  if (hrEmail) {
    // Windowed and filtered in SQL, matching the personal-document read above: the conditions were already
    // right here, they were just applied after reading the whole table on every tick.
    const orgDocs = await deps.db
      .select()
      .from(schema.orgDocuments)
      .where(
        and(
          isNull(schema.orgDocuments.deleteTime),
          eq(schema.orgDocuments.disabled, false),
          gte(schema.orgDocuments.expireTime, new Date(todayMs)),
          lte(schema.orgDocuments.expireTime, new Date(thirtyDaysMs)),
        ),
      );
    for (const doc of orgDocs) {
      const daysLeft = Math.ceil((+new Date(doc.expireTime!) - todayMs) / dayMs);
      out.push({
        to: hrEmail,
        subject: `Company document expiring in ${days(daysLeft)}: ${doc.title}`,
        bodyHtml: `<p>The company document "<strong>${h(doc.title)}</strong>" expires in <strong>${days(daysLeft)}</strong>. Please review and renew it.</p>`,
        key: `odoc:${doc.uuid}`,
      });
    }
  }

  // STABLY ORDERED, because the cursor below is an index into this list and the job re-derives it on each of
  // its invocations. Sorted on the synthetic key rather than on anything the reads happen to return in, so a
  // row written between two batches cannot shuffle the messages a later batch is about to skip past.
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Send the first `batch` messages whose key sorts after `after`. Returns how many were attempted and the key
 * to resume from. Individual failures are swallowed - one bad address must not stop the rest of the night's
 * mail.
 *
 * RESUMED BY KEY, NOT BY INDEX. The list is re-derived on every pass (the alternative is carrying every
 * message body through the job payload), so an INDEX into it is only stable while the list is. It is not: a
 * document uploaded with an expiry inside the window, or one deleted, between two passes shifts every
 * position after it - which silently skips one person's mail or sends another's twice. The keys are unique
 * and the list is sorted by them (see `reminderMails`), so "everything after this key" survives both.
 */
async function sendReminderBatch(deps: Deps, mails: ReminderMail[], after: string | undefined, batch: number): Promise<{ sent: number; after: string | undefined; done: boolean }> {
  const pending = after === undefined ? mails : mails.filter((m) => m.key > after);
  const slice = pending.slice(0, batch);
  if (!slice.length) return { sent: 0, after, done: true };
  const brand = await loadEmailBrand(deps);
  for (const m of slice) {
    await deps.email
      .send(m.to, m.subject, renderEmail({ heading: m.subject, preheader: m.subject, bodyHtml: m.bodyHtml }, brand))
      .catch(() => {});
  }
  return { sent: slice.length, after: slice[slice.length - 1]!.key, done: slice.length === pending.length };
}

/**
 * Continue a paged reminder-email send. Enqueued by the nightly tick when the night's list outran one
 * invocation; drained by the five-minute tick, which requeues it (`processOneJob`) until it reports done.
 *
 * The payload carries the DAY the list was derived for, and the job stops if the org day has since moved on:
 * the messages are about "today", so a backlog that survives midnight is stale mail, not late mail.
 */
export async function processReminderEmailJob(
  deps: Deps,
  payload: { day: string; after?: string },
  batch = REMINDER_EMAIL_BATCH,
): Promise<{ done: boolean; sent: number; after: string | undefined }> {
  const day = await orgToday(deps);
  if (day !== payload.day) {
    console.warn(`[cron] reminder email backlog for ${payload.day} dropped after ${payload.after ?? "(start)"}: the org day is now ${day}`);
    return { done: true, sent: 0, after: payload.after };
  }
  const mails = await reminderMails(deps, dayStartMs(day));
  return sendReminderBatch(deps, mails, payload.after, batch);
}

// Sends email reminders for probation endings (90-day), expiring documents, and work anniversaries. The first
// batch goes out on this tick; anything past it is handed to the job queue (see reminderMails).
async function sendReminders(deps: Deps): Promise<number> {
  // Org-local day, for the same reason emitScheduledEvents uses one: this is its email twin and the two must
  // agree on which day it is, or a rule fires on one date and the mail about it goes out on another.
  const day = await orgToday(deps);
  const mails = await reminderMails(deps, dayStartMs(day));
  if (!mails.length) return 0;
  const first = await sendReminderBatch(deps, mails, undefined, REMINDER_EMAIL_BATCH);
  if (!first.done) {
    await deps.db.insert(schema.jobs).values({
      code: await allocFlatCode(deps, schema.jobs),
      kind: REMINDER_EMAIL_JOB,
      payload: JSON.stringify({ day, after: first.after, correlationId: deps.trace }),
    });
    console.warn(`[cron] ${mails.length - first.sent} reminder email(s) queued for the drain: a night's mail outran one invocation`);
  }
  return first.sent;
}
