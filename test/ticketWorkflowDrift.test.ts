import { describe, it, expect } from "vitest";
import { DEFAULT_TICKET_WORKFLOW } from "../src/domain/stateMachines";
import { DEFAULT_TICKET_WORKFLOW as WEB_DEFAULT, TICKET_STATUS, ticketMove, ticketMovesFrom, ticketStatusMeta } from "../web/src/lib/ticketWorkflow";

// The ticket status picker (web) offers a destination per state and sends the verb that gets there, so its
// transition table has to be the server's. It no longer keeps a copy to drift from - the web module re-exports
// the server's own table - so what is left to pin is that the re-export is still the same object, that the
// picker can label every state it can render, and that the destination -> verb mapping holds.
describe("the web ticket workflow is the server's", () => {
  it("re-exports DEFAULT_TICKET_WORKFLOW rather than copying it", () => {
    expect(WEB_DEFAULT).toBe(DEFAULT_TICKET_WORKFLOW);
  });
  it("labels every state the picker can render", () => {
    for (const s of DEFAULT_TICKET_WORKFLOW.states) expect(TICKET_STATUS[s]?.label).toBeTruthy();
  });
  it("gives a custom state a readable label rather than nothing", () => {
    // An org can add states the default never had; the picker renders them, so they need copy.
    expect(ticketStatusMeta("AWAITING_PARTS").label).toBe("Awaiting parts");
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
