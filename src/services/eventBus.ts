// The event spine. `emitEvent` is the single seam every service calls at the tail of an action to announce
// "X happened". It (1) appends an append-only event_log row and (2) hands the event to the automation engine,
// which runs any matching data-defined rules. BEST-EFFORT, exactly like notify(): an event or automation
// failure must NEVER break the action that triggered it (an approval still succeeds if logging fails) - so the
// whole thing is wrapped and swallowed. This is what lets cross-module workflows be data instead of inline code.
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { DomainEvent } from "../domain/events";
import { dispatchAutomations } from "./automationEngine";
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
    const [row] = await deps.db
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
      .returning();
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
