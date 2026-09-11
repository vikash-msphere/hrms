// Chasing acknowledgements.
//
// A policy that requires signing is only useful if it gets signed, and until now nothing ever asked twice: the
// audience was notified once at publish, and after that the only mechanism was HR reading the pending list and
// copying email addresses out of it. Two things live here:
//
//  - `remindAckPending`, behind `org-documents:remindAck`: HR nudges everyone still outstanding, or one person.
//  - `nudgeStaleAcks`, on the daily cron: an automatic nudge at 3, 7 and 14 days after the version landed.
//    The ages are a fixed ladder rather than "every day", so nobody learns to ignore it, and no per-employee
//    reminder state has to be stored - the age of `ackVersionTime` IS the schedule.
//
// NO access control here: the middleware gates `org-documents.remindAck` by grants (hr_admin holds the broad
// `org-documents.**`), and the cron runs as the system principal.
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { idFromPath } from "./documentsCommon";
import { emitEvent } from "./eventBus";
import { notifyMany } from "./notifications";

const DAY_MS = 86_400_000;
/** Days after a version lands at which the automatic chase-up fires. */
export const NUDGE_DAYS = [3, 7, 14];

type OrgDoc = typeof schema.orgDocuments.$inferSelect;

/**
 * The roster a document's audience is approximated by: active, not soft-deleted, not disabled.
 *
 * IDS ONLY, and both conditions in SQL. This used to be `select()` - every column of every active employee,
 * including the encrypted identity and bank blobs - filtered down to `uuid` in JS. `status` and the
 * soft-delete mark are independent columns (the generic soft delete never touches `status`), so the filter
 * has to stay; it just does not have to happen here, and the rows it drops do not have to be read.
 *
 * Resolved ONCE by the caller and passed down, because `nudgeStaleAcks` asks per document: three policies
 * hitting a nudge day meant three whole-roster reads in one cron subtask.
 */
async function ackRoster(deps: Deps): Promise<string[]> {
  const rows = await deps.db
    .select({ uuid: schema.employees.uuid })
    .from(schema.employees)
    .where(and(eq(schema.employees.status, "active"), isNull(schema.employees.deleteTime), eq(schema.employees.disabled, false)));
  return rows.map((r) => r.uuid);
}

/** Who still owes a signature on this document's current version, split by whether they ever started. */
export async function pendingAck(deps: Deps, doc: OrgDoc, roster?: string[]): Promise<{ notStarted: string[]; started: string[] }> {
  const version = doc.ackVersion ?? 1;
  const acks = await deps.db
    .select({ employeeId: schema.documentAcknowledgements.employeeId, version: schema.documentAcknowledgements.version, acknowledgedTime: schema.documentAcknowledgements.acknowledgedTime, deleteTime: schema.documentAcknowledgements.deleteTime })
    .from(schema.documentAcknowledgements)
    .where(eq(schema.documentAcknowledgements.documentId, doc.uuid));
  const done = new Set<string>();
  const inFlight = new Set<string>();
  for (const a of acks) {
    if (a.version !== version || a.deleteTime) continue;
    // A row without `acknowledgedTime` is an Aadhaar journey that was opened and not finished.
    if (a.acknowledgedTime) done.add(a.employeeId);
    else inFlight.add(a.employeeId);
  }
  // "Everyone who can see it" is approximated by the active roster, exactly as the HR progress view does.
  const live = roster ?? (await ackRoster(deps));
  return {
    notStarted: live.filter((id) => !done.has(id) && !inFlight.has(id)),
    started: live.filter((id) => !done.has(id) && inFlight.has(id)),
  };
}

/**
 * Nudge everyone who owes a signature, in ONE write.
 *
 * ONE `notifyMany`, NOT a `notify()` per person - and this is the whole point of the function. `notify()`
 * costs a recipient read, an owned-code allocation (a read plus a counter bump) and an insert, plus an
 * outbound web-push fetch per registered device. Looped over a roster that is exactly as long as the company,
 * that is the invocation's entire subrequest budget spent on one document:
 *
 *   - `remindAckPending` is a REQUEST path, so twenty outstanding signatures was already over the free
 *     ceiling and a few hundred is over the paid one.
 *   - `nudgeStaleAcks` is one of twenty-two nightly subtasks SHARING one invocation, so exhausting the budget
 *     here also killed every subtask after it. And its ladder fires only at 3/7/14 days, so a night lost is
 *     not made up tomorrow - the nudge simply never happens.
 *
 * services/notifications.ts says this outright ("the answer is to enqueue it as a job with a bounded batch
 * per invocation, not to loop `notify()`"), and src/cron.ts fixed the identical shape in the optional-holiday
 * reminder. This was the last caller still doing it.
 *
 * The two audiences differ only in wording, so they go out as one batch with `titleFor`/`bodyFor` resolving
 * per recipient - which is exactly what those callbacks exist for. Returns how many were told.
 */
async function sendNudges(deps: Deps, doc: OrgDoc, notStarted: string[], started: string[], actorId?: string | null): Promise<number> {
  const recipients = [...notStarted, ...started];
  if (!recipients.length) return 0;
  const inFlight = new Set(started);
  await notifyMany(deps, recipients, {
    type: "document.ackPending",
    title: `Still to sign: ${doc.title}`, // the category fallback; both branches resolve below
    titleFor: (id) => (inFlight.has(id) ? `Finish signing: ${doc.title}` : `Still to sign: ${doc.title}`),
    bodyFor: (id) =>
      inFlight.has(id)
        ? "Your Aadhaar e-sign was started but not completed - open the document to finish it."
        : "This document requires your acknowledgement.",
    link: "documents",
    subject: `org-documents/${doc.uuid}`,
    action: "sign",
    priority: "high",
    ...(actorId ? { actorId } : {}),
  });
  return recipients.length;
}

/**
 * `org-documents:remindAck` - nudge the people who haven't signed the current version. With `employee` it
 * nudges exactly that person (the per-row Remind button in the progress dialog); without, everyone pending.
 * Returns the document plus how many were reminded, so the UI can say so without a second read.
 */
export async function remindAckPending(deps: Deps, actor: AppUser, id: string, body?: { employee?: string | null }) {
  const doc = (await deps.db.select().from(schema.orgDocuments).where(eq(schema.orgDocuments.uuid, id)).limit(1))[0];
  if (!doc || doc.deleteTime) throw notFound("document not found");
  if (!doc.requiresAck) throw invalidArgument("this document does not require acknowledgement");

  const { notStarted, started } = await pendingAck(deps, doc);
  const target = idFromPath(body?.employee ?? undefined);
  const pick = (list: string[]) => (target ? list.filter((empId) => empId === target) : list);
  const one = pick(notStarted);
  const two = pick(started);
  if (target && one.length === 0 && two.length === 0) throw invalidArgument("that employee has already acknowledged this document");

  const reminded = await sendNudges(deps, doc, one, two, actor.employeeId);
  await audit(deps, actor, "document.remindAck", "org-documents", id, { reminded, version: doc.ackVersion ?? 1, ...(target ? { employee: `employees/${target}` } : {}) });
  return { ...doc, reminded };
}

/**
 * Daily pass: for every published policy awaiting signatures, nudge the outstanding people when the current
 * version turns 3, 7 or 14 days old, and emit `document.ackOverdue` at the 14-day mark so a data-defined
 * automation can escalate (to the manager, to a ticket) without new code. Returns the notifications sent.
 */
export async function nudgeStaleAcks(deps: Deps): Promise<number> {
  const now = +deps.clock.now();
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const docs = await deps.db.select().from(schema.orgDocuments).where(eq(schema.orgDocuments.requiresAck, true));
  // Which documents are due a nudge tonight, and how old each version is - decided before any roster read.
  // The ladder fires on three days out of a version's life, so most nights this is empty and the whole
  // subtask costs the one read above.
  const due = docs.flatMap((doc) => {
    if (doc.deleteTime || doc.disabled || !doc.published || !doc.ackVersionTime) return [];
    const landed = new Date(doc.ackVersionTime);
    const landedDay = Date.UTC(landed.getUTCFullYear(), landed.getUTCMonth(), landed.getUTCDate());
    const age = Math.round((today - landedDay) / DAY_MS);
    return NUDGE_DAYS.includes(age) ? [{ doc, age }] : [];
  });
  if (!due.length) return 0;
  // ONE roster read for the whole pass, not one per document (see ackRoster).
  const roster = await ackRoster(deps);
  let sent = 0;
  for (const { doc, age } of due) {
    const { notStarted, started } = await pendingAck(deps, doc, roster);
    if (notStarted.length === 0 && started.length === 0) continue;
    sent += await sendNudges(deps, doc, notStarted, started);
    // One escalation signal at the end of the ladder, carrying who is still outstanding as a count.
    if (age === NUDGE_DAYS[NUDGE_DAYS.length - 1]) {
      await emitEvent(deps, null, "document.ackOverdue", {
        subject: `org-documents/${doc.uuid}`,
        payload: { title: doc.title, pending: notStarted.length + started.length, daysOpen: age },
      });
    }
  }
  return sent;
}
