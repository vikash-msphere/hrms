// The event spine. `emitEvent` is the single seam every service calls at the tail of an action to announce
// "X happened". It (1) appends an append-only event_log row and (2) hands the event to the automation engine,
// which runs any matching data-defined rules. BEST-EFFORT, exactly like notify(): an event or automation
// failure must NEVER break the action that triggered it (an approval still succeeds if logging fails) - so the
// whole thing is wrapped and swallowed. This is what lets cross-module workflows be data instead of inline code.
import { allocFlatCode, allocFlatCodes, withFreshCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { DomainEvent } from "../domain/events";
import { anyAutomationInterest, dispatchAutomations } from "./automationEngine";
import { insertBatches, runBatch } from "../lib/dbBatch";
import { genId } from "../lib/idCodec";

export type EmitOptions = {
  subject?: string | null; // "<collection>/<uuid>" this event is about
  employeeId?: string | null; // primary employee concerned (scoping / the `employee` condition field)
  payload?: Record<string, unknown>; // event-specific fields (see domain/events.ts EVENT_TYPES)
  depth?: number; // internal: event-chain recursion depth (loop guard); callers leave unset
};

// Emit one domain event. Never throws. `actor` is the caller who triggered the action (null for system/cron).
export async function emitEvent(deps: Deps, actor: AppUser | null, type: string, opts: EmitOptions = {}): Promise<void> {
  // Correlation: the ROOT emit of a workflow mints a trace id and parks it on Deps for the duration of the
  // synchronous fan-out (apiCall re-dispatch reuses the same Deps, so nested emits inherit it). It's released
  // in `finally` so the next INDEPENDENT root emit (e.g. the next event in a cron loop) gets a fresh trace.
  const isRoot = !deps.trace;
  const correlationId = deps.trace ?? genId();
  if (isRoot) deps.trace = correlationId;
  const event: DomainEvent = {
    type,
    subject: opts.subject ?? null,
    // The system principal (automation apiCalls / cron) is not a real `users` row, so it has no audit lineage:
    // record actorId null rather than the "system" sentinel, which would fail event_log's actor FK and drop the
    // event from the log entirely.
    actorId: actor && actor.uuid !== "system" ? actor.uuid : null,
    employeeId: opts.employeeId ?? null,
    payload: opts.payload ?? {},
    occurredAt: deps.clock.now(),
  };
  let eventId: string | null = null;
  try {
    // Retried on a lost code race, and for the same reason the notify path is: the catch below is
    // non-fatal, so a collision here means an action that happened with no event to show for it - no trail,
    // and no automation fired off it. The event log is written by EVERY action in the app, which makes it the
    // one scope where two writers at the same instant is the normal case rather than the unlucky one.
    const [row] = await withFreshCode(async () =>
      deps.db
        .insert(schema.eventLog)
        .values({
          code: await allocFlatCode(deps, schema.eventLog),
          type: event.type,
          subject: event.subject,
          actorId: event.actorId,
          employeeId: event.employeeId,
          payloadJson: JSON.stringify(event.payload),
          correlationId,
          occurredAt: event.occurredAt,
        })
        .returning(),
    );
    eventId = row?.uuid ?? null;
  } catch (e) {
    console.error("[emitEvent] event_log insert failed (non-fatal)", e);
  }
  try {
    await dispatchAutomations(deps, event, eventId, opts.depth ?? 0);
  } catch (e) {
    console.error("[emitEvent] automation dispatch failed (non-fatal)", e);
  } finally {
    if (isRoot) deps.trace = undefined;
  }
}

/**
 * Emit MANY events of one type in a single act (twenty assets added out of one box), as one write.
 *
 * Same contract as emitEvent - append the log rows, then hand each event to the engine - shaped for the
 * subrequest budget instead of for one event: the codes are allocated from one read, the rows land in one
 * batch, and the engine is asked ONCE whether anything is listening at all. An org with no rule and no waiting
 * workflow for the type therefore pays two reads for a hundred events rather than three hundred; when
 * something IS listening, each event is dispatched individually exactly as a single emit would be, because a
 * rule that fires per asset must still fire per asset.
 *
 * The whole run shares one correlation id: it was one act, and the trace should say so.
 */
export async function emitEvents(deps: Deps, actor: AppUser | null, type: string, list: EmitOptions[]): Promise<void> {
  if (!list.length) return;
  const isRoot = !deps.trace;
  const correlationId = deps.trace ?? genId();
  if (isRoot) deps.trace = correlationId;
  const actorId = actor && actor.uuid !== "system" ? actor.uuid : null;
  const occurredAt = deps.clock.now();
  const events: { event: DomainEvent; id: string | null }[] = list.map((opts) => ({
    id: genId(), // minted here, not read back: a batched insert returns no rows to take ids from
    event: { type, subject: opts.subject ?? null, actorId, employeeId: opts.employeeId ?? null, payload: opts.payload ?? {}, occurredAt },
  }));
  try {
    const codes = await allocFlatCodes(deps, schema.eventLog, events.length);
    const values = events.map((e, i) => ({
      uuid: e.id!,
      code: codes[i]!,
      type,
      subject: e.event.subject,
      actorId,
      employeeId: e.event.employeeId,
      payloadJson: JSON.stringify(e.event.payload),
      correlationId,
      occurredAt,
    }));
    await runBatch(deps.db, insertBatches(values, (rows) => deps.db.insert(schema.eventLog).values(rows)));
  } catch (e) {
    console.error("[emitEvents] event_log insert failed (non-fatal)", e);
    for (const ev of events) ev.id = null; // the rows are not there, so no run may claim to point at one
  }
  try {
    if (await anyAutomationInterest(deps, type)) {
      for (const { event, id } of events) await dispatchAutomations(deps, event, id, list[0]?.depth ?? 0);
    }
  } catch (e) {
    console.error("[emitEvents] automation dispatch failed (non-fatal)", e);
  } finally {
    if (isRoot) deps.trace = undefined;
  }
}
