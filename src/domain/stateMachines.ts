// State machines as DATA (PURE - no I/O). A collection's status workflow is a declarative table of
// transitions (verb: from-states -> to-state) instead of an inline `if (status !== X) throw` ladder or a
// hardcoded const map. Stored in settings so it is configurable, validated by validateStateMachine, and
// evaluated by canTransition. This is the generalization of the payroll/tickets/offers transition maps; the
// tickets workflow is the first consumer (services/tickets.ts). See docs/workflow-engine-plan.md (Layer 3).

export type Transition = { verb: string; from: string[]; to: string };
export type StateMachine = { states: string[]; initial: string; transitions: Transition[] };

// The transition for `verb` that is legal from `fromState`, or null if the verb doesn't apply / isn't allowed
// from that state. Callers throw a failedPrecondition on null.
// MATCHED ON BOTH HALVES, not on the verb alone. This used to find the FIRST row with the verb and then ask
// whether that row allowed `fromState` - while `verbsFrom` (and the web's `ticketMovesFrom`) filter. So the
// natural multi-row way to author one verb -
//   { verb: "close", from: ["OPEN"],     to: "CLOSED" }
//   { verb: "close", from: ["RESOLVED"], to: "CLOSED" }
// - was listed as available from RESOLVED by one function and refused from RESOLVED by the other, and
// `validateStateMachine` rejected neither. A row that names a state is a row that allows it.
export function transitionFor(sm: StateMachine, verb: string, fromState: string): Transition | null {
  return sm.transitions.find((x) => x.verb === verb && x.from.includes(fromState)) ?? null;
}

export function canTransition(sm: StateMachine, verb: string, fromState: string): boolean {
  return transitionFor(sm, verb, fromState) !== null;
}

// The set of verbs legal from a given state (drives "what can I do next" affordances).
export function verbsFrom(sm: StateMachine, fromState: string): string[] {
  return sm.transitions.filter((t) => t.from.includes(fromState)).map((t) => t.verb);
}

// Returns a list of problems; empty = valid. A saved workflow must reference only declared states and keep a
// valid initial state, so a mis-edit can't strand a row in an unreachable status.
export function validateStateMachine(sm: StateMachine): string[] {
  const errors: string[] = [];
  if (!sm.states?.length) errors.push("states must be non-empty");
  const set = new Set(sm.states ?? []);
  if (!set.has(sm.initial)) errors.push(`initial state "${sm.initial}" is not in states`);
  if (!Array.isArray(sm.transitions) || !sm.transitions.length) errors.push("at least one transition is required");
  for (const [i, t] of (sm.transitions ?? []).entries()) {
    if (!t.verb) errors.push(`transitions[${i}]: verb is required`);
    if (!set.has(t.to)) errors.push(`transitions[${i}]: to-state "${t.to}" is not in states`);
    for (const f of t.from ?? []) if (!set.has(f)) errors.push(`transitions[${i}]: from-state "${f}" is not in states`);
    if (!t.from?.length) errors.push(`transitions[${i}]: needs at least one from-state`);
  }
  // One verb may span several rows (one per from-state group), but never the SAME from-state twice: two rows
  // claiming "close from RESOLVED" disagree about the destination, and `transitionFor` would silently take
  // whichever was written first.
  const seen = new Map<string, string>();
  for (const [i, t] of (sm.transitions ?? []).entries()) {
    for (const f of t.from ?? []) {
      const key = `${t.verb}\u0000${f}`;
      const prior = seen.get(key);
      if (prior !== undefined) errors.push(`transitions[${i}]: "${t.verb}" from "${f}" is already defined (to "${prior}")`);
      else seen.set(key, t.to);
    }
  }
  return errors;
}

// Support tickets workflow (settings key "ticket-workflow"). The web mirrors this table in
// web/src/lib/ticketWorkflow.ts to render the status picker; test/ticketWorkflowDrift.test.ts pins the two.
export const DEFAULT_TICKET_WORKFLOW: StateMachine = {
  states: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "CANCELLED"],
  initial: "OPEN",
  transitions: [
    { verb: "start", from: ["OPEN"], to: "IN_PROGRESS" },
    { verb: "resolve", from: ["OPEN", "IN_PROGRESS"], to: "RESOLVED" },
    // Closable straight from the queue, not only after a resolve: a duplicate or a ticket handled outside the
    // tool has nothing to "resolve", and the status picker offers every column as a one-move destination.
    { verb: "close", from: ["OPEN", "IN_PROGRESS", "RESOLVED"], to: "CLOSED" },
    { verb: "reopen", from: ["RESOLVED", "CLOSED"], to: "OPEN" },
    { verb: "cancel", from: ["OPEN", "IN_PROGRESS"], to: "CANCELLED" },
  ],
};
