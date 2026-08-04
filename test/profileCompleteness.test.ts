import { describe, it, expect } from "vitest";
import { computeProfileCompleteness } from "../src/services/profileCompleteness";

// The meter reads only what the employee GET already loaded: the encrypted blob columns on the row.
// A stub encryptor (identity passthrough) lets the section rules be asserted without real crypto.
const deps = { encryptor: { decrypt: async (s: string) => s } } as any;

const row = (over: Record<string, unknown> = {}) =>
  ({
    photoKey: null,
    signatureKey: null,
    personalDetailsEnc: null,
    bankDetailsEnc: null,
    identityDetailsEnc: null,
    ...over,
  }) as any;

describe("computeProfileCompleteness", () => {
  it("everything false on an empty row", async () => {
    expect(await computeProfileCompleteness(deps, row())).toEqual({
      photo: false,
      personal: false,
      contact: false,
      emergency: false,
      identity: false,
      bank: false,
      signature: false,
    });
  });

  it("photo/signature ride the R2 key columns", async () => {
    const c = await computeProfileCompleteness(deps, row({ photoKey: "k1", signatureKey: "k2" }));
    expect(c.photo).toBe(true);
    expect(c.signature).toBe(true);
  });

  it("personal needs dob AND gender; contact needs phone AND an address; emergency needs name AND phone", async () => {
    const partial = await computeProfileCompleteness(
      deps,
      row({ personalDetailsEnc: JSON.stringify({ date_of_birth: "1990-01-01", personal_phone: "111", emergency_name: "A" }) }),
    );
    expect(partial.personal).toBe(false);
    expect(partial.contact).toBe(false);
    expect(partial.emergency).toBe(false);

    const full = await computeProfileCompleteness(
      deps,
      row({
        personalDetailsEnc: JSON.stringify({
          date_of_birth: "1990-01-01",
          gender: "Other",
          personal_phone: "111",
          permanent_address: "somewhere",
          emergency_name: "A",
          emergency_phone: "222",
        }),
      }),
    );
    expect(full.personal).toBe(true);
    expect(full.contact).toBe(true);
    expect(full.emergency).toBe(true);
  });

  it("bank needs account number AND ifsc; identity needs any non-blank value", async () => {
    const c = await computeProfileCompleteness(
      deps,
      row({
        bankDetailsEnc: JSON.stringify({ account_number: "123", ifsc_code: "HDFC0001" }),
        identityDetailsEnc: JSON.stringify({ pan: "  " }),
      }),
    );
    expect(c.bank).toBe(true);
    expect(c.identity).toBe(false); // blank-only values don't count
  });

  it("a malformed blob counts as empty, never throws", async () => {
    const c = await computeProfileCompleteness(deps, row({ bankDetailsEnc: "not-json" }));
    expect(c.bank).toBe(false);
  });
});
