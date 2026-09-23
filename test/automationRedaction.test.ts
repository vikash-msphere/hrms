import { describe, it, expect } from "vitest";
import { redactSensitivePayload, sensitiveFieldsInCondition } from "../src/domain/events";

// A rule written by somebody who is not a super admin runs its text over the event, and the event log's own
// serializer redacts payload VALUES below super (http/serialize.ts toEventLogResource). Templating a
// notification over the raw payload walked straight past that - a rule on `payslip.published` could print
// every employee's net pay into its author's inbox.

describe("redactSensitivePayload", () => {
  it("masks the money fields an event declares sensitive and keeps the rest", () => {
    const out = redactSensitivePayload("payslip.published", { netPay: 51234.5, other: "x" });
    expect(out).toEqual({ netPay: "[redacted]", other: "x" });
    const loan = redactSensitivePayload("loan.approved", { amount: 1e5, emiAmount: 5e3, installments: 20 });
    expect(loan).toEqual({ amount: "[redacted]", emiAmount: "[redacted]", installments: 20 });
  });

  it("leaves an event with nothing sensitive untouched", () => {
    const p = { leaveTypeId: "leave-types/x", days: 2 };
    expect(redactSensitivePayload("leave.approved", p)).toEqual(p);
  });
});

describe("sensitiveFieldsInCondition", () => {
  it("finds a sensitive field however the condition spells it", () => {
    expect(sensitiveFieldsInCondition("payslip.published", { field: "netPay", op: "gt", value: 1 })).toEqual(["netPay"]);
    expect(sensitiveFieldsInCondition("payslip.published", { all: [{ field: "payload.netPay", op: "exists" }] })).toEqual(["netPay"]);
    expect(sensitiveFieldsInCondition("leave.approved", { field: "days", op: "gt", value: 1 })).toEqual([]);
  });
});
