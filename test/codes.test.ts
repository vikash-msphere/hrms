import { describe, it, expect } from "vitest";
import { encodeBase32, decodeBase32, compose, segments, isUnder, nextSeg, childSeg, nextChildCode } from "../src/domain/codes";

describe("base32 (Crockford, no i/l/o/u)", () => {
  it("round-trips", () => {
    for (const n of [0, 1, 31, 32, 33, 1023, 1024, 1025, 99999]) {
      expect(decodeBase32(encodeBase32(n))).toBe(n);
    }
  });
  it("encodes known values", () => {
    expect(encodeBase32(0)).toBe("0");
    expect(encodeBase32(31)).toBe("z");
    expect(encodeBase32(32)).toBe("10");
    expect(encodeBase32(1023)).toBe("zz");
    expect(encodeBase32(1024)).toBe("100");
  });
  it("rejects invalid input", () => {
    expect(() => decodeBase32("AB")).toThrow(); // uppercase not allowed
    expect(() => decodeBase32("0-1")).toThrow();
    expect(() => decodeBase32("il")).toThrow(); // ambiguous chars excluded
    expect(() => encodeBase32(-1)).toThrow();
    expect(() => encodeBase32(1.5)).toThrow();
  });
});

describe("compose / segments", () => {
  it("joins with '-' and treats null parent as top-level", () => {
    expect(compose(null, "04")).toBe("04");
    expect(compose("04", "1c")).toBe("04-1c");
    expect(compose("04-1c", "0a9")).toBe("04-1c-0a9");
  });
  it("splits back into segments", () => {
    expect(segments("04-1c-0a9-0kf")).toEqual(["04", "1c", "0a9", "0kf"]);
  });
});

describe("isUnder (delimiter-boundary aware)", () => {
  it("matches self and nested codes", () => {
    expect(isUnder("04", "04")).toBe(true);
    expect(isUnder("04", "04-1c")).toBe(true);
    expect(isUnder("04", "04-1c-0a9")).toBe(true);
    expect(isUnder("04-1c", "04-1c-0a9-0kf")).toBe(true);
  });
  it("does NOT match a sibling that merely shares a string prefix", () => {
    expect(isUnder("04", "041")).toBe(false);
    expect(isUnder("04", "041-1c")).toBe(false);
    expect(isUnder("04-1", "04-1c")).toBe(false);
  });
  it("empty prefix matches everything", () => {
    expect(isUnder("", "04-1c-0a9")).toBe(true);
  });
});

describe("childSeg", () => {
  it("returns the whole code as the seg when parent is null (flat)", () => {
    expect(childSeg("0a", null)).toBe("0a");
    expect(childSeg("04-1c", null)).toBe("04"); // first seg
  });
  it("returns the immediate child segment under a parent", () => {
    expect(childSeg("04-1c", "04")).toBe("1c");
    expect(childSeg("04-1c-0a9", "04-1c")).toBe("0a9");
    expect(childSeg("04-1c-0a9-0kf", "04-1c-0a9")).toBe("0kf");
  });
  it("returns null when not a child of the parent", () => {
    expect(childSeg("041-1c", "04")).toBeNull(); // boundary
    expect(childSeg("04", "04")).toBeNull(); // equal, not a child
  });
});

describe("nextChildCode (unifies flat + hierarchical allocation)", () => {
  it("flat: composes the next top-level seg", () => {
    expect(nextChildCode([], null, 2)).toBe("00");
    expect(nextChildCode(["00", "01"], null, 2)).toBe("02");
  });
  it("hierarchical: composes parent + next child seg", () => {
    expect(nextChildCode([], "04-1c-0a9", 3)).toBe("04-1c-0a9-000");
    expect(nextChildCode(["04-1c-0a9-000", "04-1c-0a9-001"], "04-1c-0a9", 3)).toBe("04-1c-0a9-002");
  });
  it("ignores siblings outside the scope and nullish codes", () => {
    // a sub-dept 04-2a and an employee 04-1c share the '04' child namespace; both counted
    expect(nextChildCode(["04-1c", "04-2a", null, "041-9z"], "04", 2)).toBe("04-2b"); // max(1c,2a)=2a -> 2b
  });
});

describe("nextSeg (sequential, padded, spilling, no reuse)", () => {
  it("starts at the padded minimum width when empty", () => {
    expect(nextSeg([], 2)).toBe("00");
    expect(nextSeg([], 3)).toBe("000");
  });
  it("increments past the max, never reusing gaps", () => {
    expect(nextSeg(["00", "01", "02"], 2)).toBe("03");
    expect(nextSeg(["00", "05"], 2)).toBe("06"); // gap at 01-04 is not reused
  });
  it("spills to a wider segment once the width is exhausted", () => {
    expect(nextSeg(["zz"], 2)).toBe("100"); // 1295 -> 1296, wider than minWidth 2
  });
  it("keeps minimum width even when the value is small", () => {
    expect(nextSeg(["0"], 3)).toBe("001");
  });
});
