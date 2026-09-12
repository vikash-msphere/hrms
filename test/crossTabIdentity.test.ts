import { describe, it, expect } from "vitest";
import { deliverable } from "../web/src/lib/crossTabBus";

// A SINGLE BroadcastChannel SERVES THE WHOLE ORIGIN, so "sibling tabs of the same user" is a thing the bus has
// to ENFORCE, not assume. It is false during a "view as" simulation: that tab answers as the subject, and the
// payload topics hand rows and preferences straight into whatever the receiving tab holds (the row cache even
// persists them). The disk namespace keeps those apart; the bus has to as well.
//
// The check was `(env.who ?? null) !== storedIdentity()`, which is fail-closed in every case but one: when
// BOTH sides are null. Identity lands a beat after boot, so two tabs opened together are both null for that
// window and delivered to each other - and one of them may be about to resolve as a simulation.
const ADMIN = "admin@x.test";
const SIMULATING = "admin@x.test~employees/abc";

describe("cross-tab messages are applied only by the identity they were sent from", () => {
  it("delivers between tabs answering as the same identity", () => {
    expect(deliverable(ADMIN, ADMIN)).toBe(true);
    expect(deliverable(SIMULATING, SIMULATING)).toBe(true);
  });

  it("does not deliver across identities", () => {
    expect(deliverable(ADMIN, SIMULATING)).toBe(false);
    expect(deliverable(SIMULATING, ADMIN)).toBe(false);
  });

  // The case this exists for: neither side knows who it is yet.
  it("treats an unknown identity as matching nothing, on either side", () => {
    expect(deliverable(null, null)).toBe(false);
    expect(deliverable(null, ADMIN)).toBe(false);
    expect(deliverable(ADMIN, null)).toBe(false);
  });

  // A dead session is a fact about the BROWSER, not about a caller's data: every tab has to bounce to the
  // login screen, including a simulation running beside the admin's own.
  it("delivers the everyone broadcast regardless of identity", () => {
    expect(deliverable("*", ADMIN)).toBe(true);
    expect(deliverable("*", SIMULATING)).toBe(true);
    expect(deliverable("*", null)).toBe(true);
  });
});
