import { describe, it, expect } from "vitest";
import { parseSerialLines, usableSerials, appendSerial, batchSizes } from "../web/src/lib/assetBulk";

// The bulk-add form's parsing. A rejected line is harmless - the reader sees it and fixes it - so what these
// pin is the dangerous case: a line that parses into the WRONG serial, or the same device landing twice.

describe("parseSerialLines", () => {
  it("takes one serial per line", () => {
    const rows = parseSerialLines("C02XK1FTQ6LR\n5CD1234ABC");
    expect(rows.map((r) => r.serial)).toEqual(["C02XK1FTQ6LR", "5CD1234ABC"]);
    expect(rows.every((r) => !r.error)).toBe(true);
  });

  it("reads a per-line name after any of the separators", () => {
    const rows = parseSerialLines("C02X, MacBook Air 13\n5CD1 | ThinkPad T14\nDMPQ\tPixel 9");
    expect(rows.map((r) => [r.serial, r.name])).toEqual([
      ["C02X", "MacBook Air 13"],
      ["5CD1", "ThinkPad T14"],
      ["DMPQ", "Pixel 9"],
    ]);
  });

  it("skips blanks and comments, keeping the reader's own line numbers", () => {
    const rows = parseSerialLines("\n# from the delivery note\nC02X\n\n5CD1");
    expect(rows.map((r) => [r.line, r.serial])).toEqual([
      [3, "C02X"],
      [5, "5CD1"],
    ]);
  });

  it("reports a repeat on the SECOND line, so the first still creates", () => {
    const rows = parseSerialLines("C02X\nc02x");
    expect(rows[0]?.serial).toBe("C02X");
    expect(rows[1]?.error).toMatch(/earlier line/);
    expect(usableSerials(rows).map((r) => r.serial)).toEqual(["C02X"]);
  });

  it("refuses a whole pasted paragraph masquerading as a serial", () => {
    const rows = parseSerialLines("x".repeat(80));
    expect(rows[0]?.error).toMatch(/characters/);
    expect(usableSerials(rows)).toEqual([]);
  });
});

describe("appendSerial", () => {
  it("adds a line, and ignores the same label drifting back into frame", () => {
    const first = appendSerial("", "C02X");
    expect(first).toEqual({ text: "C02X\n", added: true });
    const second = appendSerial(first.text, "5CD1");
    expect(second.text).toBe("C02X\n5CD1\n");
    expect(appendSerial(second.text, "c02x")).toEqual({ text: second.text, added: false });
  });

  it("does not glue itself onto a half-typed line", () => {
    expect(appendSerial("C02X", "5CD1").text).toBe("C02X\n5CD1\n");
  });
});

describe("batchSizes", () => {
  it("splits a run into calls of at most the cap", () => {
    expect(batchSizes(10, 100)).toEqual([10]);
    expect(batchSizes(250, 100)).toEqual([100, 100, 50]);
    expect(batchSizes(0, 100)).toEqual([]);
  });
});
