import { describe, it, expect } from "vitest";
import { canTransition, transitionFor, verbsFrom, validateStateMachine, DEFAULT_TICKET_WORKFLOW, type StateMachine } from "../src/domain/stateMachines";

describe("stateMachines - ticket workflow (default)", () => {
  it("allows the legal transitions from each state", () => {
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "start", "OPEN")).toBe(true);
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "resolve", "IN_PROGRESS")).toBe(true);
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "resolve", "OPEN")).toBe(true);
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "close", "RESOLVED")).toBe(true);
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "reopen", "CLOSED")).toBe(true);
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "cancel", "OPEN")).toBe(true);
  });
  it("rejects illegal transitions", () => {
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "close", "OPEN")).toBe(false); // must resolve first
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "start", "RESOLVED")).toBe(false);
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "cancel", "CLOSED")).toBe(false);
    expect(canTransition(DEFAULT_TICKET_WORKFLOW, "nope", "OPEN")).toBe(false); // unknown verb
  });
  it("transitionFor returns the target state", () => {
    expect(transitionFor(DEFAULT_TICKET_WORKFLOW, "start", "OPEN")?.to).toBe("IN_PROGRESS");
    expect(transitionFor(DEFAULT_TICKET_WORKFLOW, "close", "OPEN")).toBeNull();
  });
  it("verbsFrom lists the legal next actions", () => {
    expect(verbsFrom(DEFAULT_TICKET_WORKFLOW, "OPEN").sort()).toEqual(["cancel", "resolve", "start"]);
    expect(verbsFrom(DEFAULT_TICKET_WORKFLOW, "RESOLVED").sort()).toEqual(["close", "reopen"]);
  });
});

describe("stateMachines - validation", () => {
  it("accepts the default workflow", () => {
    expect(validateStateMachine(DEFAULT_TICKET_WORKFLOW)).toEqual([]);
  });
  it("flags unknown states in transitions and a bad initial", () => {
    const bad: StateMachine = { states: ["A", "B"], initial: "Z", transitions: [{ verb: "go", from: ["A"], to: "Q" }] };
    const errs = validateStateMachine(bad);
    expect(errs.some((e) => e.includes(`initial state "Z"`))).toBe(true);
    expect(errs.some((e) => e.includes(`to-state "Q"`))).toBe(true);
  });
  it("requires at least one transition and one from-state", () => {
    expect(validateStateMachine({ states: ["A"], initial: "A", transitions: [] }).some((e) => e.includes("at least one transition"))).toBe(true);
    expect(validateStateMachine({ states: ["A"], initial: "A", transitions: [{ verb: "x", from: [], to: "A" }] }).some((e) => e.includes("at least one from-state"))).toBe(true);
  });
});
