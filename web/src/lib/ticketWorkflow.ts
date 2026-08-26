// The ticket lifecycle as the UI sees it: a board of statuses you move a ticket between, rather than a row of
// verb buttons ("Start / Resolve / Cancel") that only made sense if you already knew the state machine. The
// transitions here MIRROR the server's DEFAULT_TICKET_WORKFLOW (src/domain/stateMachines.ts) - the web bundle
// can't import from src/, so the table is duplicated and pinned by test/ticketWorkflowDrift.test.ts.
// Verbs stay the wire contract (tickets:start / :resolve / :close / :reopen / :cancel); only the presentation
// is state-first: pick the status you want, the UI sends the verb that gets there.

export type TicketTransition = { verb: string; from: string[]; to: string };

export const TICKET_WORKFLOW: { states: string[]; initial: string; transitions: TicketTransition[] } = {
  states: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "CANCELLED"],
  initial: "OPEN",
  transitions: [
    { verb: "start", from: ["OPEN"], to: "IN_PROGRESS" },
    { verb: "resolve", from: ["OPEN", "IN_PROGRESS"], to: "RESOLVED" },
    { verb: "close", from: ["OPEN", "IN_PROGRESS", "RESOLVED"], to: "CLOSED" },
    { verb: "reopen", from: ["RESOLVED", "CLOSED"], to: "OPEN" },
    { verb: "cancel", from: ["OPEN", "IN_PROGRESS"], to: "CANCELLED" },
  ],
};

// Board-column copy: the label on the chip and the one-liner under it in the picker.
export const TICKET_STATUS: Record<string, { label: string; hint: string; dot: string }> = {
  OPEN: { label: "Open", hint: "Waiting to be picked up", dot: "bg-amber-500" },
  IN_PROGRESS: { label: "In progress", hint: "Someone is working on it", dot: "bg-primary" },
  RESOLVED: { label: "Resolved", hint: "Fixed - the requester confirms or reopens", dot: "bg-success" },
  CLOSED: { label: "Closed", hint: "Done and filed away", dot: "bg-muted-foreground" },
  CANCELLED: { label: "Cancelled", hint: "Dropped without a fix - final", dot: "bg-muted-foreground" },
};

export const ticketStatusLabel = (state?: string) => TICKET_STATUS[(state ?? "").toUpperCase()]?.label ?? state ?? "-";

/** The verb that moves a ticket from `from` to `to`, or null when that move isn't part of the workflow. */
export function ticketMove(from: string, to: string): TicketTransition | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  return TICKET_WORKFLOW.transitions.find((x) => x.to === t && x.from.includes(f)) ?? null;
}

/** Every status reachable from here in one move (drives "is this ticket movable at all?"). */
export function ticketMovesFrom(from: string): TicketTransition[] {
  const f = from.toUpperCase();
  return TICKET_WORKFLOW.transitions.filter((x) => x.from.includes(f));
}
