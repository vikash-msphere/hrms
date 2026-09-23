// Sending one message to many people, without spending the invocation on it.
//
// WHY THIS EXISTS. Two paths blasted a whole audience by awaiting `deps.email.send` once per recipient inside
// a single invocation: the announcement email (services/announcements.ts) and the workflow `emailAudience`
// action (services/automationEngine.ts). Every send is an outbound fetch, so it spends from the SAME
// per-invocation subrequest budget as every D1 call around it - 50 on the free plan, 1000 on paid - and the
// announcement one runs inside the five-minute cron tick, sharing that budget with every other subtask.
//
// The announcement path was worse than slow. It claimed `emailed_at` BEFORE the loop, so a blast that ran out
// of budget half way through left the post marked as mailed: the first N people got it, nobody else ever
// would, and the per-recipient catch meant nothing said so. An org-wide policy notice silently reaching a
// third of the company is the failure this file removes.
//
// THE SHAPE is the one `payslip.generateRun` and `reminder.email` already use: send a bounded batch now, hand
// the rest to the job queue, which drains every five minutes, retries on a widening backoff and dead-letters
// after five attempts. The claim stays where it is (it is what stops a double blast); what changes is that
// the remainder is now owned by a durable row instead of by an invocation that may not survive.
//
// RECIPIENTS ARE FROZEN INTO THE PAYLOAD rather than re-derived per pass. A cursor into a re-derived list is
// only stable while the list is: one person joining the org between two passes shifts every index after them
// and skips somebody, and one leaving duplicates somebody. The audience of a blast is decided once, when it
// is sent, which is also the honest answer - "everyone" means everyone as at the moment of publication.
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { allocFlatCode } from "./codeAlloc";

/** The job kind the drain dispatches (src/cron.ts). Named once so enqueue and drain cannot disagree. */
export const EMAIL_FANOUT_JOB = "email.fanOut";

/** Messages per invocation. Matches `reminder.email`: enough to finish a small org in one pass, small enough
 *  that a batch plus its address read never threatens the free plan's 50-subrequest budget. */
export const EMAIL_FANOUT_BATCH = 20;

export type EmailFanOutPayload = {
  /** Employee ids, in the order they will be mailed. Frozen at enqueue - see the header. */
  recipients: string[];
  subject: string;
  /** Fully rendered, branded HTML. Built once by the caller, because it is identical for every recipient. */
  html: string;
  /** How many of `recipients` have already been attempted. */
  cursor: number;
  /** What this blast is, for the log line when it stops early. */
  label: string;
  correlationId?: string;
};

/**
 * Mail `recipients[cursor .. cursor+batch)`. Returns how many were ATTEMPTED, which is what advances the
 * cursor: a recipient with no address or a vendor rejection is attempted and moved past, because retrying the
 * whole batch to chase one bad address would re-send to everyone before it.
 *
 * Individual failures are swallowed and logged - one bad address must not cost the rest of the audience. A
 * failure that takes out the whole batch (the read throws, the vendor is unreachable) propagates, so the job
 * retries on its backoff rather than quietly skipping people.
 */
async function sendBatch(deps: Deps, payload: EmailFanOutPayload, batch: number): Promise<number> {
  const slice = payload.recipients.slice(payload.cursor, payload.cursor + batch);
  if (!slice.length) return 0;
  // One read for the slice's addresses. The slice is at most `batch`, well inside D1's bound-parameter cap,
  // so this never needs chunking - but it is read per batch rather than up front so a queued blast picks up
  // an address corrected after it started.
  //
  // AND SO THAT A DEPARTURE LANDS TOO. The recipient list is frozen into the payload when the blast is queued,
  // which is what makes the cursor an index into a list that cannot shift underneath it - but a frozen list is
  // not a licence to mail somebody who has since gone. A blast can sit in the queue across several five-minute
  // ticks, so the check is made per batch, on the same query the address comes from, and costs nothing.
  //
  // ALL THREE COLUMNS. This read `delete_time` alone, under a comment naming the soft delete as "the write
  // that is supposed to stop company mail reaching a leaver" - which is the one write that does not happen
  // when somebody leaves. Offboarding stamps `status: "terminated"` and disables the account
  // (services/transitions.ts) and never stamps `delete_time`, so the guard that exists for leavers did not
  // fire for anyone who left through the front door. Same roster rule as services/notifications.ts
  // `activeEmployeeIds`, which decides who is in the blast in the first place.
  const emps = await deps.db
    .select({ uuid: schema.employees.uuid, workEmail: schema.employees.workEmail })
    .from(schema.employees)
    .where(and(
      inArray(schema.employees.uuid, slice),
      eq(schema.employees.status, "active"),
      isNull(schema.employees.deleteTime),
      eq(schema.employees.disabled, false),
    ));
  const emailOf = new Map(emps.map((e) => [e.uuid, e.workEmail]));
  for (const id of slice) {
    const to = emailOf.get(id);
    if (!to) continue; // no row, removed since the blast was queued, or no work email: nothing to send to
    try {
      await deps.email.send(to, payload.subject, payload.html);
    } catch (err) {
      console.error(`[emailFanOut] ${payload.label}: send to ${id} failed (non-fatal)`, err);
    }
  }
  return slice.length;
}

/**
 * Send the first batch now and queue whatever is left.
 *
 * Returns how many recipients this invocation attempted, which is what the callers already report as "sent".
 * The queued remainder is not counted here: it has not happened yet, and reporting it would make a partial
 * blast look complete, which is the bug this replaces.
 */
export async function fanOutEmail(
  deps: Deps,
  opts: { recipients: string[]; subject: string; html: string; label: string },
): Promise<number> {
  // De-duplicated and ordered, so the cursor means the same thing on every pass and nobody is mailed twice
  // because they matched the audience two ways.
  const recipients = [...new Set(opts.recipients.filter(Boolean))].sort();
  if (!recipients.length) return 0;
  const payload: EmailFanOutPayload = { recipients, subject: opts.subject, html: opts.html, cursor: 0, label: opts.label };
  // A THROW HERE STILL LEAVES THE AUDIENCE OWNED. Per-recipient failures are already swallowed inside
  // `sendBatch`, so an exception at this level is the batch-level read or the vendor being unreachable - and
  // the announcement caller has by then taken its `emailed_at` claim, which is what makes "the post says it
  // was mailed" true. Swallowing it here and enqueueing from cursor 0 means the queue owns the whole blast
  // and retries it on its backoff, instead of the claim standing over mail that was never sent.
  let sent = 0;
  try {
    sent = await sendBatch(deps, payload, EMAIL_FANOUT_BATCH);
  } catch (err) {
    console.error(`[emailFanOut] ${opts.label}: first batch failed, handing the whole audience to the queue`, err);
  }
  if (sent < recipients.length) {
    await deps.db.insert(schema.jobs).values({
      code: await allocFlatCode(deps, schema.jobs),
      kind: EMAIL_FANOUT_JOB,
      payload: JSON.stringify({ ...payload, cursor: sent, correlationId: deps.trace }),
    });
    console.warn(`[emailFanOut] ${opts.label}: ${recipients.length - sent} recipient(s) queued for the drain`);
  }
  return sent;
}

/**
 * Continue a queued fan-out. Enqueued by `fanOutEmail`; drained by the five-minute tick, which requeues it
 * with the advanced cursor until it reports done.
 *
 * Unlike `reminder.email` there is no day guard: an announcement or a workflow blast is about a thing that
 * happened, not about "today", so a backlog that survives midnight is late mail rather than stale mail and is
 * still worth sending.
 */
export async function processEmailFanOutJob(
  deps: Deps,
  payload: EmailFanOutPayload,
  batch = EMAIL_FANOUT_BATCH,
): Promise<{ done: boolean; sent: number; cursor: number }> {
  const sent = await sendBatch(deps, payload, batch);
  const cursor = payload.cursor + sent;
  return { done: cursor >= payload.recipients.length, sent, cursor };
}
