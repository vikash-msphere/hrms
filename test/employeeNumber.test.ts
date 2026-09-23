import { describe, it, expect } from "vitest";
import { DEFAULT_EMPLOYEE_NUMBER_CONFIG, formatEmployeeNumber, seqOf, nextSeq, normalizeConfig } from "../src/domain/employeeNumber";

describe("employeeNumber format", () => {
  it("formats the default scheme with zero-padding", () => {
    expect(formatEmployeeNumber(DEFAULT_EMPLOYEE_NUMBER_CONFIG, 42, 2026)).toBe("EMP-0042");
    expect(formatEmployeeNumber(DEFAULT_EMPLOYEE_NUMBER_CONFIG, 1, 2026)).toBe("EMP-0001");
  });

  it("includes the year in the chosen format when enabled", () => {
    const cfg = { ...DEFAULT_EMPLOYEE_NUMBER_CONFIG, include_year: true, year_format: "YYYY" as const };
    expect(formatEmployeeNumber(cfg, 7, 2026)).toBe("EMP-2026-0007");
    expect(formatEmployeeNumber({ ...cfg, year_format: "YY" }, 7, 2026)).toBe("EMP-26-0007");
  });

  it("honors a blank prefix and separator", () => {
    expect(formatEmployeeNumber({ ...DEFAULT_EMPLOYEE_NUMBER_CONFIG, prefix: "", separator: "" }, 42, 2026)).toBe("0042");
  });

  it("clamps width to a sane range", () => {
    expect(normalizeConfig({ width: 0 }).width).toBe(1);
    expect(normalizeConfig({ width: 999 }).width).toBe(12);
  });
});

describe("employeeNumber sequence", () => {
  it("parses the trailing integer, ignoring prefix/year", () => {
    expect(seqOf("EMP-0042")).toBe(42);
    expect(seqOf("EMP-2026-0007")).toBe(7);
    expect(seqOf("CUSTOM-ID")).toBeNull();
    expect(seqOf(null)).toBeNull();
  });

  it("allocates one past the highest existing sequence", () => {
    expect(nextSeq(DEFAULT_EMPLOYEE_NUMBER_CONFIG, ["EMP-0001", "EMP-0100", "EMP-0042"])).toBe(101);
  });

  it("starts from config.start when nothing parses", () => {
    expect(nextSeq({ ...DEFAULT_EMPLOYEE_NUMBER_CONFIG, start: 1000 }, [])).toBe(1000);
    expect(nextSeq({ ...DEFAULT_EMPLOYEE_NUMBER_CONFIG, start: 1 }, ["ACME", null])).toBe(1);
  });

  it("a fully custom override doesn't move the max", () => {
    expect(nextSeq(DEFAULT_EMPLOYEE_NUMBER_CONFIG, ["EMP-0005", "VIP"])).toBe(6);
  });
});
