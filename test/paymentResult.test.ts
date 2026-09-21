/// <reference types="vite/client" />
// Matching a bank's response back onto the run that paid.
//
// The cases that matter are the three that are NOT a straightforward success: a row naming somebody the run
// never paid (the wrong file), a person the response says nothing about (sent, nothing heard), and a re-sent
// correction for a payment already reported. Each has a different right answer, and collapsing any of them
// into "paid" or "failed" is how a reconciliation starts lying.
import { describe, it, expect } from "vitest";
import { reconcilePayments, type PaymentResultRow } from "../src/domain/paymentResult";

const paid = (employeeId: string): PaymentResultRow => ({ employeeId, status: "paid" });
const failed = (employeeId: string, reason?: string): PaymentResultRow => ({ employeeId, status: "failed", reason });

describe("reconcilePayments", () => {
  it("matches a clean response", () => {
    const r = reconcilePayments(new Set(["a", "b"]), [paid("a"), paid("b")]);
    expect(r.counts).toEqual({ paid: 2, failed: 0, returned: 0, unreported: 0 });
    expect(r.unmatched).toEqual([]);
    expect(r.unreported).toEqual([]);
  });

  it("keeps the bank's reason on a failure", () => {
    // The reason is the whole value of a failure row: "account closed" and "name mismatch" send different
    // people to do different things.
    const r = reconcilePayments(new Set(["a"]), [failed("a", "account closed")]);
    expect(r.matched[0]).toMatchObject({ status: "failed", reason: "account closed" });
    expect(r.counts.failed).toBe(1);
  });

  it("reports a row naming somebody the run did not pay, rather than dropping it", () => {
    // A response that does not line up is the loudest sign somebody uploaded the wrong file. Silently
    // ignoring the rows that did not fit would turn that into "nothing happened".
    const r = reconcilePayments(new Set(["a"]), [paid("a"), paid("stranger")]);
    expect(r.unmatched).toEqual(["stranger"]);
    expect(r.counts.paid).toBe(1);
  });

  it("counts somebody the response never mentions as unreported, not as paid or failed", () => {
    // Sent, nothing heard. Defaulting it either way would either claim money arrived that nobody confirmed,
    // or raise a failure the bank never reported.
    const r = reconcilePayments(new Set(["a", "b"]), [paid("a")]);
    expect(r.unreported).toEqual(["b"]);
    expect(r.counts).toEqual({ paid: 1, failed: 0, returned: 0, unreported: 1 });
  });

  it("takes the LAST word when a bank re-sends a correction", () => {
    // Banks re-send. A later line about the same payment is the newer fact, so taking the first would make a
    // corrected file keep asserting the failure it was sent to retract.
    const r = reconcilePayments(new Set(["a"]), [failed("a", "timeout"), paid("a")]);
    expect(r.matched).toEqual([{ employeeId: "a", status: "paid", reference: null, reason: null }]);
    expect(r.counts).toEqual({ paid: 1, failed: 0, returned: 0, unreported: 0 });
  });

  it("treats a returned payment as its own outcome", () => {
    // Returned is not failed: the money left and came back, which is a different conversation with the bank
    // and a different thing to tell the employee.
    const r = reconcilePayments(new Set(["a"]), [{ employeeId: "a", status: "returned", reference: "RT-9" }]);
    expect(r.counts.returned).toBe(1);
    expect(r.matched[0]!.reference).toBe("RT-9");
  });

  it("reports everybody as unreported for an empty response", () => {
    const r = reconcilePayments(new Set(["a", "b"]), []);
    expect(r.unreported).toEqual(["a", "b"]);
    expect(r.matched).toEqual([]);
  });

  it("normalises blank references and reasons to null", () => {
    // An empty string in a CSV column is not a reference, and storing one makes "has a reference" untrue.
    const r = reconcilePayments(new Set(["a"]), [{ employeeId: "a", status: "paid", reference: "  ", reason: "" }]);
    expect(r.matched[0]).toMatchObject({ reference: null, reason: null });
  });
});
