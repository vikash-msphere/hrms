import { describe, it, expect } from "vitest";
import { fnv1a64 } from "../src/lib/fnv";

// The hash behind two IDENTITIES that decide whether a stored payload may be reused: `authzVersion` ("these
// are still the same rights") and `listEtag`'s request key ("you already hold this exact answer"). What it has
// to be is stable, wide, and sensitive to every part of its input - a collision is a stale 304, not a
// funny-looking string. It is not a security primitive and is not asked to be one.
describe("fnv1a64", () => {
  it("is deterministic and stable across calls", () => {
    expect(fnv1a64("employees.04-002.identity")).toBe(fnv1a64("employees.04-002.identity"));
    expect(fnv1a64("")).toBe(fnv1a64(""));
  });

  it("is 64 bits wide, as two fixed-width base36 lanes", () => {
    // 32 bits in base36 is at most 7 characters, so each lane is padded to 7 and the pair is always 14 - a
    // variable-width join could otherwise let two different (a, b) pairs render as the same string.
    for (const s of ["", "a", "employees", "x".repeat(500)]) expect(fnv1a64(s)).toHaveLength(14);
  });

  it("separates inputs that differ only in order, length or one character", () => {
    const seen = new Set<string>();
    const inputs = [
      "/v1/tickets&max_page_size=100",
      "/v1/leave-requests&max_page_size=100",
      "ab",
      "ba",
      "a",
      "aa",
      "employees.04-002.bank-account.account_number",
      "employees.04-003.bank-account.account_number",
      // The grant canonical form: same rules, one level apart.
      "04-002|payslips=read|",
      "04-002|payslips=write|",
    ];
    for (const s of inputs) seen.add(fnv1a64(s));
    expect(seen.size).toBe(inputs.length);
  });

  it("the second lane is not a copy of the first", () => {
    // Byte-swapping the code unit into lane B is what keeps the halves independent; if it were the same
    // sequence with a different basis, every output would carry two lanes moving in lockstep. Checking that
    // the halves differ for an ordinary input is the cheap assertion that the two lanes are doing two things.
    const h = fnv1a64("employees.04-002.identity");
    expect(h.slice(0, 7)).not.toBe(h.slice(7));
  });
});
