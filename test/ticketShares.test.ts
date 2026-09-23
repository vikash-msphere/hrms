import { describe, it, expect } from "vitest";
import { resolveRequest, decide } from "../src/domain/permissions";
import { rulesToGrant, deriveNarrowing, type CompiledRule } from "../src/domain/compileGrants";
import { ancestorsOf } from "../src/domain/codes";

// Category-based ticket visibility is implemented as ACL data only: a viewer gets a per-object READ share -
// one access_rules row of the exact shape `grantTicketRead` writes (pattern `tickets.<code>.**`, exact
// narrowing). This proves that row grants read on EXACTLY that ticket (so it shows in the list and the GET is
// allowed) and never leaks to a sibling/prefix-neighbour - the contract the feature relies on, against the
// real engine. Ticket codes are owner-embedded under the requester; SELF here is a DIFFERENT employee (the
// category member), so visibility comes purely from the share, not ownership.
const shareRow = (code: string): CompiledRule => {
  const pattern = `tickets.${code}.**`;
  const n = deriveNarrowing(pattern);
  return { namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeKind === "exact" ? n.scopeCode : null, level: "read", effect: "allow" };
};

const SELF = { employeeCode: "04-002-001" }; // the category member - NOT the ticket's owner (04-002-002-*)

// Mirror the middleware: narrow the member's shares to the requested ticket's ancestor codes, build the
// grant, decide.
const canRead = (sharedCodes: string[], ticketCode: string) => {
  const narrowed = sharedCodes.map(shareRow).filter((r) => ancestorsOf(ticketCode).includes(r.matchCode!));
  return decide(rulesToGrant(narrowed), resolveRequest("GET", `/v1/tickets/${ticketCode}`), SELF).allow;
};

describe("category auto-share grants read on exactly the shared ticket", () => {
  it("a ticket read share derives to exact scope (the row grantTicketRead inserts)", () => {
    expect(deriveNarrowing("tickets.04-002-002-7.**")).toEqual({ namespace: "tickets", scopeKind: "exact", scopeCode: "04-002-002-7" });
  });

  it("a member reads a ticket shared with them even though they don't own it", () => {
    expect(canRead(["04-002-002-7"], "04-002-002-7")).toBe(true);
  });

  it("the share does not leak to a sibling or a prefix-collision neighbour", () => {
    expect(canRead(["04-002-002-7"], "04-002-002-8")).toBe(false); // sibling ticket
    expect(canRead(["04-002-002-7"], "04-002-002-70")).toBe(false); // prefix-collision neighbour
  });

  it("no share => no read", () => {
    expect(canRead([], "04-002-002-7")).toBe(false);
  });
});
