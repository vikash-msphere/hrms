import { allocFlatCode } from "./services/codeAlloc";
import { eq, and, or, ne, isNull, lte } from "drizzle-orm";
import * as schema from "./db/schema";
import type { Deps } from "./deps";
import { processPayslipRunJob } from "./services/payroll";
import { runDeferredActions, runWorkflowTimer, runScheduledAutomations } from "./services/automationEngine";
import { flushDigests } from "./services/notificationDigest";
import { generateRecurringExpenses } from "./services/expenses";
import { checkBudgetThresholds } from "./services/expenseBudgets";
import { emitEvent } from "./services/eventBus";
import { accrueLeave } from "./services/leaveAccrual";
import { generateComplianceOccurrences } from "./services/complianceRules";
import { awardReferralBonuses } from "./services/referrals";
import { reconcilePendingEsign } from "./services/esign/callback";
import { getSettingValue } from "./services/settings";
import { renderEmail, loadEmailBrand } from "./lib/emailLayout";
import { notify, managerIdOf } from "./services/notifications";
import { leaveCaps, encashedDaysThisYear, createAutoEncashment } from "./services/leaveEncashments";
import { calendarYearOf, splitCarryForward, splitCarryForwardCumulative, splitEncashExcess } from "./domain/carryForward";

import { round2 } from "./domain/money";

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
    const summary = await dispatchCron(cron, deps);
    const end = +deps.clock.now();
    await deps.db
      .update(schema.cronRuns)
      .set({ status: "done", finishedAt: new Date(end), durationMs: end - start, summaryJson: JSON.stringify(summary) })
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

async function dispatchCron(cron: string, deps: Deps): Promise<Record<string, number>> {
  if (cron === "*/5 * * * *") return { drained: await drainJobs(deps, 20) };
  if (cron === "0 2 * * *") {
    // Carry-forward runs BEFORE accrual so it caps last year's balance before the new year accrues on top.
    const carriedForward = await carryForwardLeave(deps);
    const accrued = await accrueLeave(deps);
    // Roll the compliance-calendar horizon forward (best-effort; never aborts the tick).
    const complianceGenerated = await generateComplianceOccurrences(deps).catch(() => 0);
    // Award referral bonuses whose referred hire reached the configured milestone (best-effort).
    const referralBonuses = await awardReferralBonuses(deps).catch(() => 0);
    // Reminders are best-effort: an email failure must never abort the accrual tick.
    const reminders = await sendReminders(deps).catch(() => 0);
    // Time-based domain events (probation ending, work anniversary, document expiring) so automations can react
    // to the passage of time, not just user actions. Best-effort - never aborts the tick.
    const scheduledEvents = await emitScheduledEvents(deps).catch(() => 0);
    // Fire time-driven automation rules whose recurrence matches today (weekly nudges, month-start prep,
    // per-employee smart reminders). Guarded per-day so a re-run can't double-fire. Best-effort.
    const scheduledAutomations = await runScheduledAutomations(deps).catch(() => 0);
    // Flush queued digest notifications into one summary per recipient (best-effort).
    const digestsFlushed = await flushDigests(deps).catch(() => 0);
    // Generate due recurring expenses (rent, subscriptions) and raise budget-threshold alerts (best-effort).
    const recurringExpenses = await generateRecurringExpenses(deps).catch(() => 0);
    const budgetAlerts = await checkBudgetThresholds(deps).catch(() => 0);
    // Reconcile e-sign documents stuck pending (missed/dropped vendor webhook): poll the vendor or auto-expire
    // past the signing window. Best-effort - never aborts the tick.
    const esignReconciled = await reconcilePendingEsign(deps).catch(() => 0);
    return { carriedForward, accrued, complianceGenerated, referralBonuses, reminders, scheduledEvents, scheduledAutomations, digestsFlushed, recurringExpenses, budgetAlerts, esignReconciled };
  }
  return {};
}

// A job left `running` longer than this was almost certainly orphaned by a mid-tick crash (real jobs are
// bounded batches that finish in seconds, and an LRO that legitimately resumes refreshes updated_at each
// tick). Such a job is reclaimed to `queued` so it gets retried instead of hanging forever.
const STALE_RUNNING_MS = 10 * 60 * 1000;
type JobRow = typeof schema.jobs.$inferSelect;

// Run one job through its state machine. Returns "requeued" if an LRO asked to resume next tick (state
// unchanged from the queue's perspective), else "done"/"error". Idempotent per call; never throws.
async function processOneJob(deps: Deps, job: JobRow): Promise<"done" | "error" | "requeued"> {
  await deps.db.update(schema.jobs).set({ status: "running" }).where(eq(schema.jobs.uuid, job.uuid));
  try {
    if (job.kind === "payslip.generateRun") {
      const res = await processPayslipRunJob(deps, job.uuid, JSON.parse(job.payload));
      if (!res.done) {
        await deps.db.update(schema.jobs).set({ status: "queued" }).where(eq(schema.jobs.uuid, job.uuid));
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
    await deps.db.update(schema.jobs).set({ status: "error", attempts: job.attempts + 1, lastError: String(e) }).where(eq(schema.jobs.uuid, job.uuid));
    return "error";
  }
}

// Re-queue jobs orphaned in `running` so the drain retries them. Returns how many were reclaimed.
async function reclaimStuckJobs(deps: Deps): Promise<number> {
  const cutoff = +deps.clock.now() - STALE_RUNNING_MS;
  const running = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.status, "running"));
  const stale = running.filter((j) => +new Date(j.updatedAt) < cutoff);
  for (const j of stale) {
    await deps.db.update(schema.jobs).set({ status: "queued", attempts: j.attempts + 1 }).where(eq(schema.jobs.uuid, j.uuid));
  }
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
    if ((await processOneJob(deps, job)) !== "requeued") processed++;
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
  const leaveTypes = await deps.db.select().from(schema.leaveTypes);
  const ltById = new Map(leaveTypes.map((lt) => [lt.uuid, lt] as const));
  let processed = 0;

  for (const emp of employees) {
    if (emp.deleteTime) continue;
    const balances = await deps.db.select().from(schema.leaveBalances).where(eq(schema.leaveBalances.employeeId, emp.uuid));
    const due = balances.filter((b) => b.lastCarryForwardYear !== year);
    if (due.length === 0) continue;

    // Never-stamped rows: initialize to this year with no forfeiture. Earlier-year rows actually roll over.
    const roll = due.filter((b) => b.lastCarryForwardYear != null);
    for (const b of due.filter((b) => b.lastCarryForwardYear == null)) {
      await deps.db.update(schema.leaveBalances).set({ lastCarryForwardYear: year, updatedAt: new Date() }).where(eq(schema.leaveBalances.uuid, b.uuid));
    }
    if (roll.length === 0) continue;

    // (carried, excess) per balance row, by mode.
    const splits = new Map<string, { carried: number; excess: number }>();
    if (caps.carry_forward_mode === "cumulative") {
      const eligible = roll.filter((b) => ltById.get(b.leaveTypeId)?.carryForward);
      const cum = splitCarryForwardCumulative(eligible.map((b) => b.balanceDays), caps.carry_forward_cumulative_cap_days);
      eligible.forEach((b, i) => splits.set(b.uuid, cum[i]!));
      for (const b of roll.filter((b) => !ltById.get(b.leaveTypeId)?.carryForward)) splits.set(b.uuid, { carried: 0, excess: round2(b.balanceDays) });
    } else {
      for (const b of roll) {
        const lt = ltById.get(b.leaveTypeId);
        splits.set(b.uuid, splitCarryForward(b.balanceDays, !!lt?.carryForward, lt?.carryForwardCapDays ?? null));
      }
    }

    // Remaining encashment cap for auto-encash; in cumulative mode it's shared across the employee's types.
    let cumEncRemaining = caps.encashment_mode === "cumulative"
      ? (caps.encashment_cumulative_cap_days == null ? Infinity : Math.max(0, caps.encashment_cumulative_cap_days - (await encashedDaysThisYear(deps, emp.uuid))))
      : Infinity;
    const encashRemainingFor = async (lt: LeaveTypeRow): Promise<number> => {
      if (!lt.encashable) return 0; // only encashable types can absorb excess as a payout
      if (caps.encashment_mode === "cumulative") return cumEncRemaining;
      return lt.encashmentCapDaysPerYear == null ? Infinity : Math.max(0, lt.encashmentCapDaysPerYear - (await encashedDaysThisYear(deps, emp.uuid, lt.uuid)));
    };

    for (const b of roll) {
      const lt = ltById.get(b.leaveTypeId);
      const split = splits.get(b.uuid)!;
      // Claim this balance for `year` FIRST: collapse it to the carried days and stamp lastCarryForwardYear
      // in one conditional update guarded on it not already being `year`. If a concurrent tick or a retry of
      // a crashed run already processed it (0 rows), skip - otherwise we'd create a SECOND auto-encashment
      // payout for the same excess. Stamping before creating the payout means a crash mid-loop can at worst
      // skip the encashment (recoverable), never double-pay it.
      const claimed = await deps.db.update(schema.leaveBalances)
        .set({ balanceDays: split.carried, lastCarryForwardYear: year, updatedAt: new Date() })
        .where(and(eq(schema.leaveBalances.uuid, b.uuid), ne(schema.leaveBalances.lastCarryForwardYear, year)))
        .returning();
      if (!claimed.length) continue;
      if (split.excess > 0 && caps.carry_forward_excess === "encash" && lt) {
        const { encash } = splitEncashExcess(split.excess, "encash", await encashRemainingFor(lt));
        if (encash > 0) {
          const ok = await createAutoEncashment(deps, emp.uuid, lt.uuid, encash);
          if (ok && caps.encashment_mode === "cumulative") cumEncRemaining = Math.max(0, cumEncRemaining - encash);
        }
      }
      processed++;
    }
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
