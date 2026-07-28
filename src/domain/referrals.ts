// Referral-bonus policy. HR-configurable via the `settings/referrals` blob; this is only the default used when
// no config exists. `award_trigger` decides WHEN a referral bonus becomes eligible for the referrer:
//   "joining"   -> as soon as the referred candidate's employment start date has passed.
//   "probation" -> only after the candidate completes probation (their probation end date has passed).
// `default_bonus_amount` is the amount awarded when a referral carries no explicit override. Pure data + a
// resolver, no I/O.
export type ReferralAwardTrigger = "joining" | "probation";
// A time-tiered bonus schedule: the amount depends on how fast the candidate joined after the offer. Tiers are
// ordered ascending by `max_days`; the first whose `max_days >= elapsedDays` wins; a `null` max_days is the
// catch-all fallback. Empty `join_tiers` => flat `default_bonus_amount` (the pre-tier behaviour).
export type JoinTier = { max_days: number | null; amount: number };
export type ReferralsConfig = { award_trigger: ReferralAwardTrigger; default_bonus_amount: number; join_tiers: JoinTier[] };

export const DEFAULT_REFERRALS_CONFIG: ReferralsConfig = { award_trigger: "probation", default_bonus_amount: 10000, join_tiers: [] };

const DAY_MS = 86_400_000;

// Resolve the bonus amount for a referral. Precedence (matches the design decisions):
//   C. an explicit per-referral amount always wins;
//   B/A. else, if the offer->join window is known and tiers are configured, the first matching tier;
//   else the flat default_bonus_amount.
// `offeredDate`/`joinedDate` come from the offer that produced the hire (offer date -> join date is the clock).
export function resolveBonusAmount(
  cfg: ReferralsConfig,
  referral: { bonusAmount: number | null },
  window: { offeredDate: Date | number | null; joinedDate: Date | number | null },
): number {
  if (referral.bonusAmount != null) return referral.bonusAmount; // C: explicit override wins
  const tiers = cfg.join_tiers ?? [];
  if (tiers.length && window.offeredDate != null && window.joinedDate != null) {
    const elapsedDays = Math.floor((+new Date(window.joinedDate) - +new Date(window.offeredDate)) / DAY_MS);
    for (const t of tiers) if (t.max_days == null || elapsedDays <= t.max_days) return t.amount;
  }
  return cfg.default_bonus_amount;
}

// The milestone anchor on the linked hire, used by the cron to decide eligibility. Only the two date fields we
// read are required, so this stays trivially testable.
export type HireMilestone = { startDate: Date | number | null; probationEndDate: Date | number | null };

// Whether the referred hire has reached the configured milestone as of `now`. Joining = start date passed;
// probation = a probation end date that has passed (no end date -> never eligible on the probation trigger).
export function milestoneReached(cfg: ReferralsConfig, hire: HireMilestone, now: number = Date.now()): boolean {
  const at = cfg.award_trigger === "joining" ? hire.startDate : hire.probationEndDate;
  if (at == null) return false;
  return +new Date(at) <= now;
}
