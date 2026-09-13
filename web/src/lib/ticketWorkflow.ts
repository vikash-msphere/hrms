// The ticket lifecycle as the UI sees it: a board of statuses you move a ticket between, rather than a row of
// verb buttons ("Start / Resolve / Cancel") that only made sense if you already knew the state machine.
// Verbs stay the wire contract (tickets:start / :resolve / :close / :reopen / :cancel); only the presentation
// is state-first: pick the status you want, the UI sends the verb that gets there.
//
// THE TABLE IS THE SERVER'S, in two senses.
//
// The DEFAULT is imported from src/domain/stateMachines.ts rather than copied. It used to be duplicated here
// "because the web bundle can't import from src/", which is not true - lib/leaveForecast.ts, lib/eventRepeat.ts,
// lib/attendance.ts and several pages already do - and the copy needed a drift test to hold it in place.
//
// And the ACTIVE table is the org's, not the default. `services/tickets.ts` decides every transition from
// `settings/ticket-workflow`, so a customised workflow made the two disagree: this file rendered the default's
// columns and the default's move menu while the server accepted a different set, offering moves it would refuse
// and hiding custom states entirely. The drift test pinned this copy to the DEFAULT, which is why that looked
// covered - it pinned the client to the seed, not to the org's setting.
import { DEFAULT_TICKET_WORKFLOW, type StateMachine, type Transition } from "../../../src/domain/stateMachines";
import { readSetting } from "./settingsStore";
import { useEffect, useState } from "react";

export type TicketTransition = Transition;

export { DEFAULT_TICKET_WORKFLOW };

// The org's workflow once it has been read, the seeded default until then.
//
// SYNCHRONOUS BY DESIGN, the same trade lib/orgDay.ts makes and for the same reason: the helpers below are
// called from render and from event handlers that cannot await. A render before hydration is correct for any
// org that has not customised the workflow (which is all of them until someone does) and self-corrects once
// `useTicketWorkflow` resolves. The settings snapshot is already loaded once for the whole SPA
// (lib/settingsStore.ts), so reading this key adds no request.
let active: StateMachine = DEFAULT_TICKET_WORKFLOW;
let hydrating: Promise<StateMachine> | null = null;

/** The workflow in force: the org's `settings/ticket-workflow`, or the seeded default. */
export const ticketWorkflow = (): StateMachine => active;

// A stored blob is whatever an admin PATCHed. The server validates it on save now, but a row written before
// that did, or one from a restored export, can still be any shape - and a half-read workflow would hide every
// move rather than fail visibly. Anything that is not a usable machine leaves the default in place.
const usable = (sm: unknown): sm is StateMachine => {
  const m = sm as StateMachine | null;
  return !!m && Array.isArray(m.states) && m.states.length > 0 && Array.isArray(m.transitions) && m.transitions.every((t) => !!t && typeof t.verb === "string" && typeof t.to === "string" && Array.isArray(t.from));
};

/** Read `settings/ticket-workflow` into this module. Idempotent and memoized - call it wherever, it runs once. */
export function hydrateTicketWorkflow(): Promise<StateMachine> {
  hydrating ??= readSetting<StateMachine>("ticket-workflow")
    .then((sm) => {
      if (usable(sm)) active = sm;
      return active;
    })
    .catch(() => active);
  return hydrating;
}

/** The workflow in force, re-rendering the caller once the org's own table has been read. */
export function useTicketWorkflow(): StateMachine {
  const [sm, setSm] = useState<StateMachine>(active);
  useEffect(() => {
    let live = true;
    void hydrateTicketWorkflow().then((next) => { if (live) setSm(next); });
    return () => { live = false; };
  }, []);
  return sm;
}

// Board-column copy: the label on the chip and the one-liner under it in the picker. Covers the default's own
// states; a CUSTOM state an org adds gets a rendered label from its key rather than nothing at all.
export const TICKET_STATUS: Record<string, { label: string; hint: string; dot: string }> = {
  OPEN: { label: "Open", hint: "Waiting to be picked up", dot: "bg-amber-500" },
  IN_PROGRESS: { label: "In progress", hint: "Someone is working on it", dot: "bg-primary" },
  RESOLVED: { label: "Resolved", hint: "Fixed - the requester confirms or reopens", dot: "bg-success" },
  CLOSED: { label: "Closed", hint: "Done and filed away", dot: "bg-muted-foreground" },
  CANCELLED: { label: "Cancelled", hint: "Dropped without a fix - final", dot: "bg-muted-foreground" },
};

/** Title-cased fallback copy for a state this file has no entry for ("AWAITING_PARTS" -> "Awaiting parts"). */
export function ticketStatusMeta(state: string): { label: string; hint: string; dot: string } {
  const s = (state ?? "").toUpperCase();
  return TICKET_STATUS[s] ?? { label: s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "-", hint: "", dot: "bg-muted-foreground" };
}

export const ticketStatusLabel = (state?: string) => (state ? ticketStatusMeta(state).label : "-");

/** The verb that moves a ticket from `from` to `to`, or null when that move isn't part of the workflow. */
export function ticketMove(from: string, to: string): TicketTransition | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  return active.transitions.find((x) => x.to === t && x.from.includes(f)) ?? null;
}

/** Every status reachable from here in one move (drives "is this ticket movable at all?"). */
export function ticketMovesFrom(from: string): TicketTransition[] {
  const f = from.toUpperCase();
  return active.transitions.filter((x) => x.from.includes(f));
}
