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
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { invalidArgument, notFound } from "../lib/errors";
import { idFromPath } from "./documentsCommon";
import { emitEvent } from "./eventBus";
import { notify } from "./notifications";

const DAY_MS = 86_400_000;
/** Days after a version lands at which the automatic chase-up fires. */
export const NUDGE_DAYS = [3, 7, 14];

type OrgDoc = typeof schema.orgDocuments.$inferSelect;
type Employee = typeof schema.employees.$inferSelect;

/** Who still owes a signature on this document's current version, split by whether they ever started. */
export async function pendingAck(deps: Deps, doc: OrgDoc): Promise<{ notStarted: Employee[]; started: Employee[] }> {
  const version = doc.ackVersion ?? 1;
  const acks = await deps.db.select().from(schema.documentAcknowledgements).where(eq(schema.documentAcknowledgements.documentId, doc.uuid));
  const done = new Set<string>();
  const inFlight = new Set<string>();
  for (const a of acks) {
    if (a.version !== version || a.deleteTime) continue;
    // A row without `acknowledgedTime` is an Aadhaar journey that was opened and not finished.
    if (a.acknowledgedTime) done.add(a.employeeId);
    else inFlight.add(a.employeeId);
  }
  // "Everyone who can see it" is approximated by the active roster, exactly as the HR progress view does.
  const employees = await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"));
  const live = employees.filter((e) => !e.deleteTime && !e.disabled);
  return {
    notStarted: live.filter((e) => !done.has(e.uuid) && !inFlight.has(e.uuid)),
    started: live.filter((e) => !done.has(e.uuid) && inFlight.has(e.uuid)),
  };
}

async function sendNudge(deps: Deps, doc: OrgDoc, employeeId: string, started: boolean, actorId?: string | null) {
  await notify(deps, {
    recipient: employeeId,
    type: "document.ackPending",
    title: started ? `Finish signing: ${doc.title}` : `Still to sign: ${doc.title}`,
    body: started
      ? "Your Aadhaar e-sign was started but not completed - open the document to finish it."
      : "This document requires your acknowledgement.",
    link: "documents",
    subject: `org-documents/${doc.uuid}`,
    action: "sign",
    priority: "high",
    ...(actorId ? { actorId } : {}),
  });
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
  const pick = (list: Employee[]) => (target ? list.filter((e) => e.uuid === target) : list);
  const one = pick(notStarted);
  const two = pick(started);
  if (target && one.length === 0 && two.length === 0) throw invalidArgument("that employee has already acknowledged this document");

  for (const e of one) await sendNudge(deps, doc, e.uuid, false, actor.employeeId);
  for (const e of two) await sendNudge(deps, doc, e.uuid, true, actor.employeeId);
  const reminded = one.length + two.length;
  await audit(deps, actor, "document.remindAck", "org-documents", id, { reminded, version: doc.ackVersion ?? 1, ...(target ? { employee: target } : {}) });
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
  let sent = 0;
  for (const doc of docs) {
    if (doc.deleteTime || doc.disabled || !doc.published || !doc.ackVersionTime) continue;
    const landed = +new Date(doc.ackVersionTime);
    const landedDay = Date.UTC(new Date(landed).getUTCFullYear(), new Date(landed).getUTCMonth(), new Date(landed).getUTCDate());
    const age = Math.round((today - landedDay) / DAY_MS);
    if (!NUDGE_DAYS.includes(age)) continue;
    const { notStarted, started } = await pendingAck(deps, doc);
    if (notStarted.length === 0 && started.length === 0) continue;
    for (const e of notStarted) { await sendNudge(deps, doc, e.uuid, false); sent++; }
    for (const e of started) { await sendNudge(deps, doc, e.uuid, true); sent++; }
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
