import { describe, it, expect } from "vitest";
import { DEFAULT_TICKET_WORKFLOW } from "../src/domain/stateMachines";
import { TICKET_WORKFLOW, TICKET_STATUS, ticketMove, ticketMovesFrom } from "../web/src/lib/ticketWorkflow";

// The ticket status picker (web) offers a destination per state and sends the verb that gets there, so its
// transition table has to be the server's. The web bundle can't import from src/, so the table is duplicated
// and pinned here - a server-side workflow edit that the UI doesn't mirror fails this test.
describe("web TICKET_WORKFLOW stays in sync with the server default", () => {
  it("equals DEFAULT_TICKET_WORKFLOW", () => {
    expect(TICKET_WORKFLOW).toEqual(DEFAULT_TICKET_WORKFLOW);
  });
  it("labels every state the picker can render", () => {
    for (const s of DEFAULT_TICKET_WORKFLOW.states) expect(TICKET_STATUS[s]?.label).toBeTruthy();
  });
  it("maps a destination back to the verb that reaches it", () => {
    expect(ticketMove("OPEN", "IN_PROGRESS")?.verb).toBe("start");
    expect(ticketMove("OPEN", "CLOSED")?.verb).toBe("close");
    expect(ticketMove("CLOSED", "OPEN")?.verb).toBe("reopen");
    expect(ticketMove("open", "resolved")?.verb).toBe("resolve"); // state casing is normalised
    expect(ticketMove("CANCELLED", "OPEN")).toBeNull(); // cancelling is final
    expect(ticketMovesFrom("CANCELLED")).toEqual([]);
  });
});
