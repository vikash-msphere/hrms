import { describe, it, expect } from "vitest";
import { FLAT_KEYS, READ_KEY, redactFlat } from "../src/http/fieldAccess";
import { BANK_FIELDS, toMaskedBankView } from "../src/services/bankDetails";
import { PERSONAL_FIELDS } from "../src/services/personalDetails";
import type { Grant } from "../src/domain/permissions";

// http/fieldAccess.ts is what makes a per-field DENY mean anything: `deniedFieldKeys` only ever asks the
// engine about keys listed in FLAT_KEYS, so a field the list does not mention CANNOT be denied - an access
// rule written against it is accepted, stored, shown in the UI, and does nothing. That is a field ACL failing
// OPEN, with no error and nothing in a log to notice.
//
// It used to be a hand-written second copy of each sub-resource's field list, and the copies had already come
// apart: it listed a `branch` that services/bankDetails.ts did not store. That instance was harmless (denying
// a key nothing emits changes nothing) - it is the same mistake pointing the other way that costs something,
// and nothing would have caught it. The lists are now imported from the services that own the fields; this
// file is what keeps them imported, and keeps the read-key remap honest about what actually reaches the wire.

const SELF = { employeeCode: "04-1c-0a9" };
/** A grant that allows everything, so anything missing from the output was removed by the redaction itself. */
const ALLOW_ALL: Grant = { levels: { "**": "admin" }, allow: ["**"] };
/** Broad read with an explicit deny on every field key of one sub-resource. */
const denyEvery = (sub: string, keys: readonly string[]): Grant => ({
  levels: { "**": "admin" },
  allow: ["**"],
  deny: keys.map((k) => `employees.*.${sub}.${k}.read`),
});

describe("fieldAccess: FLAT_KEYS is the services' own field list", () => {
  it("bank-account keys come from services/bankDetails.ts", () => {
    expect(FLAT_KEYS["bank-account"]).toBe(BANK_FIELDS);
  });

  it("personal-info keys come from services/personalDetails.ts", () => {
    expect(FLAT_KEYS["personal-info"]).toBe(PERSONAL_FIELDS);
  });

  // The lists are the WRITE keys. `redactFlat` deletes by write key unless READ_KEY remaps it, so a remap
  // entry naming a key the service does not have would delete nothing while looking like it does.
  it("every read-key remap is FROM a real field key", () => {
    for (const [sub, remap] of Object.entries(READ_KEY)) {
      for (const from of Object.keys(remap)) {
        expect(FLAT_KEYS[sub], `${sub} has no field list`).toBeDefined();
        expect(FLAT_KEYS[sub], `${sub}: remap names "${from}", which is not one of its fields`).toContain(from);
      }
    }
  });
});

describe("fieldAccess: everything the wire carries can be denied", () => {
  // THE assertion this file exists for, stated against the REAL serializer rather than a re-typed sample: a
  // fully-populated bank view, with every field denied, must come back holding nothing but the structural
  // `on_file` flag. A field added to `toMaskedBankView` under an output name the remap does not know about
  // survives the deny and fails here.
  it("a denied bank view keeps no field-bearing key", () => {
    const full = toMaskedBankView(Object.fromEntries(BANK_FIELDS.map((k) => [k, `value-of-${k}`])));
    const visible = redactFlat(full, "bank-account", ALLOW_ALL, SELF.employeeCode!, SELF);
    // Sanity: with nothing denied the view is intact, so the assertion below is about the deny and not about
    // an empty fixture.
    expect(Object.keys(visible).length).toBeGreaterThan(1);

    const redacted = redactFlat(full, "bank-account", denyEvery("bank-account", BANK_FIELDS), SELF.employeeCode!, SELF);
    const left = Object.keys(redacted).filter((k) => redacted[k as keyof typeof redacted] !== undefined);
    expect(left, `these keys outlived a deny on every bank field: ${left.join(", ")}`).toEqual(["on_file"]);
  });

  // personal-info is returned as the stored blob itself, so its output keys ARE its field keys plus the one
  // structural flag the form writes alongside them.
  it("a denied personal-info view keeps no field-bearing key", () => {
    const full = { ...Object.fromEntries(PERSONAL_FIELDS.map((k) => [k, `value-of-${k}`])), same_as_communication: true };
    const redacted = redactFlat(full, "personal-info", denyEvery("personal-info", PERSONAL_FIELDS), SELF.employeeCode!, SELF);
    expect(Object.keys(redacted)).toEqual(["same_as_communication"]);
  });
});
