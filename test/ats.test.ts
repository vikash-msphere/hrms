import { describe, it, expect } from "vitest";
import { DEFAULT_ATS_CONFIG, isStage, stageKind, nextStage, statusForStage, stageKeys, canOfferTransition, type AtsConfig } from "../src/domain/ats";

const cfg: AtsConfig = DEFAULT_ATS_CONFIG;

describe("ATS pipeline stages", () => {
  it("default pipeline runs applied -> screening -> interview -> offer -> hired", () => {
    expect(stageKeys(cfg)).toEqual(["applied", "screening", "interview", "offer", "hired"]);
  });

  it("isStage recognises configured stages and rejects unknown ones", () => {
    expect(isStage(cfg, "screening")).toBe(true);
    expect(isStage(cfg, "nope")).toBe(false);
  });

  it("stageKind marks the terminal hired stage", () => {
    expect(stageKind(cfg, "applied")).toBe("active");
    expect(stageKind(cfg, "hired")).toBe("hired");
    expect(stageKind(cfg, "nope")).toBeNull();
  });

  it("nextStage walks the pipeline and stops at the last stage", () => {
    expect(nextStage(cfg, "applied")).toBe("screening");
    expect(nextStage(cfg, "offer")).toBe("hired");
    expect(nextStage(cfg, "hired")).toBeNull(); // already last
    expect(nextStage(cfg, "nope")).toBeNull(); // unknown stage
  });

  it("statusForStage flips to hired only on a hired-kind stage", () => {
    expect(statusForStage(cfg, "applied")).toBe("active");
    expect(statusForStage(cfg, "offer")).toBe("active");
    expect(statusForStage(cfg, "hired")).toBe("hired");
  });

  it("offer workflow allows only forward transitions + rescind", () => {
    expect(canOfferTransition("draft", "approved")).toBe(true);
    expect(canOfferTransition("approved", "extended")).toBe(true);
    expect(canOfferTransition("extended", "accepted")).toBe(true);
    expect(canOfferTransition("extended", "declined")).toBe(true);
    expect(canOfferTransition("approved", "rescinded")).toBe(true);
    // Illegal jumps.
    expect(canOfferTransition("draft", "accepted")).toBe(false);
    expect(canOfferTransition("accepted", "declined")).toBe(false);
    expect(canOfferTransition("declined", "extended")).toBe(false);
  });

  it("honours a custom stage list", () => {
    const custom: AtsConfig = { ...cfg, stages: [
      { key: "new", label: "New", kind: "active" },
      { key: "won", label: "Won", kind: "hired" },
    ] };
    expect(nextStage(custom, "new")).toBe("won");
    expect(statusForStage(custom, "won")).toBe("hired");
    expect(isStage(custom, "applied")).toBe(false);
  });
});
