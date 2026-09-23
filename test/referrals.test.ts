import { describe, it, expect } from "vitest";
import { milestoneReached, resolveBonusAmount, DEFAULT_REFERRALS_CONFIG, type ReferralsConfig } from "../src/domain/referrals";

const DAY = 86_400_000;
const past = Date.now() - 10 * DAY;
const future = Date.now() + 10 * DAY;

describe("milestoneReached", () => {
  it("default trigger is probation", () => {
    expect(DEFAULT_REFERRALS_CONFIG.award_trigger).toBe("probation");
  });

  it("joining: eligible once the start date has passed", () => {
    const cfg: ReferralsConfig = { award_trigger: "joining", default_bonus_amount: 1000, join_tiers: [] };
    expect(milestoneReached(cfg, { startDate: past, probationEndDate: future })).toBe(true);
    expect(milestoneReached(cfg, { startDate: future, probationEndDate: past })).toBe(false);
    expect(milestoneReached(cfg, { startDate: null, probationEndDate: past })).toBe(false);
  });

  it("probation: eligible only after a probation end date that has passed", () => {
    const cfg: ReferralsConfig = { award_trigger: "probation", default_bonus_amount: 1000, join_tiers: [] };
    expect(milestoneReached(cfg, { startDate: past, probationEndDate: past })).toBe(true);
    expect(milestoneReached(cfg, { startDate: past, probationEndDate: future })).toBe(false);
    // No probation end date -> never eligible on the probation trigger (even if long since joined).
    expect(milestoneReached(cfg, { startDate: past, probationEndDate: null })).toBe(false);
  });

  it("accepts Date instances as well as epoch millis", () => {
    const cfg: ReferralsConfig = { award_trigger: "joining", default_bonus_amount: 1000, join_tiers: [] };
    expect(milestoneReached(cfg, { startDate: new Date(past), probationEndDate: null })).toBe(true);
  });
});

describe("resolveBonusAmount", () => {
  const tiered: ReferralsConfig = {
    award_trigger: "joining",
    default_bonus_amount: 5000,
    join_tiers: [
      { max_days: 15, amount: 15000 },
      { max_days: 30, amount: 10000 },
      { max_days: null, amount: 5000 },
    ],
  };
  const win = (days: number) => ({ offeredDate: 0, joinedDate: days * DAY });

  it("an explicit per-referral amount always wins", () => {
    expect(resolveBonusAmount(tiered, { bonusAmount: 42000 }, win(5))).toBe(42000);
  });
  it("picks the first tier whose max_days covers the offer->join gap", () => {
    expect(resolveBonusAmount(tiered, { bonusAmount: null }, win(10))).toBe(15000); // <=15
    expect(resolveBonusAmount(tiered, { bonusAmount: null }, win(15))).toBe(15000); // boundary
    expect(resolveBonusAmount(tiered, { bonusAmount: null }, win(16))).toBe(10000); // next tier
    expect(resolveBonusAmount(tiered, { bonusAmount: null }, win(90))).toBe(5000); // catch-all
  });
  it("falls back to the default when the window is unknown or no tiers configured", () => {
    expect(resolveBonusAmount(tiered, { bonusAmount: null }, { offeredDate: null, joinedDate: null })).toBe(5000);
    expect(resolveBonusAmount({ ...tiered, join_tiers: [] }, { bonusAmount: null }, win(3))).toBe(5000);
  });
});
