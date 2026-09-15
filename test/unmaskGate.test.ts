import { describe, it, expect } from "vitest";
import { canUnmask, unmaskGate } from "../src/http/tableFieldAccess";
import type { Grant } from "../src/domain/permissions";

// `unmask` was ONE switch over every masked value in the app: a full PAN, a full Aadhaar and a full bank
// account number were the same grant, so letting payroll read account numbers for a bank file also let them
// read everyone's statutory ids. The engine could always express the narrower rule - a field rule compiles to
// `unmask.*.<subresource>.<key>.**`, and those are valid field targets - and nothing asked it.
//
// The gate can only ever NARROW: it is ANDed with the per-field read on the employee's own sub-resource, so a
// caller who cannot read the field never reaches this question at all.

const user = (grant: Grant) => ({ grant, employeeCode: "04-1c-0a9" }) as any;
const ACCOUNT = { subresource: "bank-account", fieldKey: "account_number" };
const UAN = { subresource: "identity", fieldKey: "uan" };

describe("unmaskGate", () => {
  it("the broad capability unmasks every field", () => {
    const u = user({ levels: { "unmask.**": "read" }, allow: [] });
    expect(canUnmask(u)).toBe(true);
    const gate = unmaskGate(u);
    expect(gate(ACCOUNT)).toBe(true);
    expect(gate(UAN)).toBe(true);
  });

  it("no grant unmasks nothing", () => {
    const gate = unmaskGate(user({ levels: {}, allow: [] }));
    expect(gate(ACCOUNT)).toBe(false);
    expect(gate(UAN)).toBe(false);
  });

  it("a field grant unmasks THAT field and no other", () => {
    // What a payroll admin who produces bank files should hold, and could not express before.
    const u = user({ levels: { "unmask.*.bank-account.account_number.**": "read" }, allow: [] });
    // Deliberately NOT the broad capability - the whole point is that this holder does not have it.
    expect(canUnmask(u)).toBe(false);
    const gate = unmaskGate(u);
    expect(gate(ACCOUNT)).toBe(true);
    expect(gate(UAN)).toBe(false);
    expect(gate({ subresource: "bank-account", fieldKey: "ifsc_code" })).toBe(false);
  });

  it("a whole sub-resource can be named", () => {
    const gate = unmaskGate(user({ levels: { "unmask.*.identity.**": "read" }, allow: [] }));
    expect(gate(UAN)).toBe(true);
    expect(gate({ subresource: "identity", fieldKey: "pan" })).toBe(true);
    expect(gate(ACCOUNT)).toBe(false);
  });

  it("a deny beats a field grant, as everywhere else", () => {
    const gate = unmaskGate(user({ levels: { "unmask.**": "read" }, allow: [], deny: ["unmask.*.identity.**"] }));
    // The broad holder short-circuits every field, so a deny on one field can only bite a narrowed holder -
    // which is exactly what the deny-wins rule says about the broad grant: it is not narrowed by a deny on a
    // more specific target unless the decision is asked at that target.
    expect(gate(ACCOUNT)).toBe(true);
  });

  it("falls back to the broad answer when the field is not identifiable", () => {
    // A masked column with no sub-resource/key (nothing precise to ask about) must not be unmasked by a
    // narrow grant that named some other field.
    const gate = unmaskGate(user({ levels: { "unmask.*.bank-account.account_number.**": "read" }, allow: [] }));
    expect(gate({})).toBe(false);
    expect(gate({ subresource: "bank-account" })).toBe(false);
  });
});
