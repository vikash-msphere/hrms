import { describe, it, expect } from "vitest";
import { DEFAULT_KUDOS_CONFIG, pointsForLevel } from "../src/domain/kudos";

describe("kudos level points", () => {
  it("resolves a configured level to its weight (trim + case-insensitive)", () => {
    expect(pointsForLevel(DEFAULT_KUDOS_CONFIG, "Appreciation")).toBe(1);
    expect(pointsForLevel(DEFAULT_KUDOS_CONFIG, "impact")).toBe(2);
    expect(pointsForLevel(DEFAULT_KUDOS_CONFIG, "  Exceptional ")).toBe(3);
  });
  it("is 0 for a blank/unknown/removed level", () => {
    expect(pointsForLevel(DEFAULT_KUDOS_CONFIG, "")).toBe(0);
    expect(pointsForLevel(DEFAULT_KUDOS_CONFIG, null)).toBe(0);
    expect(pointsForLevel(DEFAULT_KUDOS_CONFIG, "Legendary")).toBe(0);
  });
  it("honors a custom config", () => {
    const cfg = { levels: [{ name: "Gold", points: 5 }] };
    expect(pointsForLevel(cfg, "Gold")).toBe(5);
    expect(pointsForLevel(cfg, "Appreciation")).toBe(0);
  });
});
