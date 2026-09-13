// ATS pipeline config (`settings/ats`) + pure stage logic. HR-configurable recruiting stages, candidate
// sources, and rejection reasons; this is the default used when no config row exists. Pure data + resolvers,
// no I/O, so the stage rules stay trivially testable.

export type StageKind = "active" | "hired" | "rejected";
export type AtsStage = { key: string; label: string; kind: StageKind };
export type ScorecardCriterion = { key: string; label: string };
export type AtsConfig = {
  stages: AtsStage[]; // the ordered pipeline (first = entry stage; a `hired` stage is the success terminal)
  sources: string[]; // candidate/application sources (referral | job_board | ...)
  rejection_reasons: string[]; // canned reasons offered when rejecting an application
  scorecard_criteria: ScorecardCriterion[]; // interview scorecard rating dimensions
  // Hide the rest of the panel's verdicts from an interviewer until they have filed their own. Anchoring is
  // the standard failure of a shared scorecard: the second panelist scores the first one's opinion.
  blind_scorecards: boolean;
  // ---- Offer defaults ----
  // What the pipeline proposes when a card reaches the offer stage. These exist so the seeded "draft the offer"
  // rule stays data: the numbers a rule fills in are the org's policy, not constants buried in an action body.
  offer_validity_days: number; // how long an offer stands before it expires
  join_notice_days: number; // proposed start date, counted from the day the offer is drafted
  // Which point of the requisition's pay band an auto-drafted offer proposes. `none` leaves the figure blank
  // for whoever approves it - correct for orgs that negotiate every number.
  offer_band_point: OfferBandPoint;
};

export const OFFER_BAND_POINTS = ["mid", "min", "max", "none"] as const;
export type OfferBandPoint = (typeof OFFER_BAND_POINTS)[number];

/** The figure an auto-drafted offer proposes, from the requisition's pay band. Null = leave it blank. */
export function bandPointAmount(cfg: AtsConfig, band: { min?: number | null; mid?: number | null; max?: number | null }): number | null {
  switch (cfg.offer_band_point) {
    case "min": return band.min ?? null;
    case "max": return band.max ?? null;
    case "mid": return band.mid ?? band.min ?? band.max ?? null;
    default: return null;
  }
}

export const DEFAULT_ATS_CONFIG: AtsConfig = {
  stages: [
    { key: "applied", label: "Applied", kind: "active" },
    { key: "screening", label: "Screening", kind: "active" },
    { key: "interview", label: "Interview", kind: "active" },
    { key: "offer", label: "Offer", kind: "active" },
    { key: "hired", label: "Hired", kind: "hired" },
  ],
  sources: ["referral", "job_board", "agency", "direct", "linkedin", "career_site"],
  rejection_reasons: ["Not qualified", "Failed interview", "Position filled", "Compensation mismatch", "Candidate withdrew", "Other"],
  scorecard_criteria: [
    { key: "technical", label: "Technical skills" },
    { key: "communication", label: "Communication" },
    { key: "culture", label: "Culture fit" },
    { key: "problem_solving", label: "Problem solving" },
  ],
  blind_scorecards: false,
  offer_validity_days: 7,
  join_notice_days: 30,
  offer_band_point: "mid",
};

// Application status is the coarse outcome; `stage` is the fine-grained pipeline position.
export const APPLICATION_STATUSES = ["active", "hired", "rejected", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const REQUISITION_STATUSES = ["draft", "open", "on_hold", "closed", "filled"] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

// Offer workflow: draft -> approved -> extended -> accepted | declined | rescinded. Rescind is reachable from
// any non-terminal state. Pure transition guard, unit-testable (mirrors the referral/application patterns).
export const OFFER_STATUSES = ["draft", "approved", "extended", "accepted", "declined", "rescinded"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OFFER_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  draft: ["approved", "rescinded"],
  approved: ["extended", "rescinded"],
  extended: ["accepted", "declined", "rescinded"],
  accepted: [],
  declined: [],
  rescinded: [],
};
export function canOfferTransition(from: string, to: string): boolean {
  return (OFFER_TRANSITIONS[from as OfferStatus] ?? []).includes(to as OfferStatus);
}

const STAGE_KEY_RE = /^[a-z0-9][a-z0-9_]*$/;

/**
 * What a storable `settings/ats` looks like. Returns the problems, empty when there are none - the same shape
 * `validateStateMachine` uses, so routes/settings.ts registers both the same way.
 *
 * THE KEYS ARE AN IDENTITY, and nothing used to enforce that they are unique. The Settings panel minted them
 * from the array LENGTH (`stage_${stages.length + 1}`), so add-remove-add produced two stages called the same
 * thing, and every reader downstream resolves a stage BY KEY: the board seeds one column per key and the second
 * overwrites the first, so those applications render in both columns; `nextStage` resolves by `indexOf`, so
 * `:advance` from either duplicate moves to the successor of the FIRST and silently skips a stage of the
 * pipeline. Boards refuse exactly this (domain/boards.ts normalizeColumns / normalizeSwimlanes /
 * normalizeLabels, "duplicate column key") - the recruiting pipeline is the same kind of config with the same
 * consequence, and was the one without the check.
 *
 * The ordered list also has to END somewhere: a pipeline with no `hired` stage can never mark anybody hired
 * (`statusForStage`), which is the whole point of the last column. The SPA checks that one already; a check
 * that only exists in the browser is not a check.
 */
export function validateAtsConfig(value: unknown): string[] {
  const errors: string[] = [];
  const cfg = value as Partial<AtsConfig> | null;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return ["ats must be an object"];
  if (cfg.stages == null) return errors; // not touching the pipeline: the default table stands
  if (!Array.isArray(cfg.stages) || cfg.stages.length === 0) return ["ats.stages must be a non-empty array"];
  const seen = new Set<string>();
  cfg.stages.forEach((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const key = typeof s.key === "string" ? s.key.trim() : "";
    if (!STAGE_KEY_RE.test(key)) {
      errors.push(`ats.stages[${i}].key ("${key}") must be a lowercase slug (letters, digits and underscores)`);
      return;
    }
    if (seen.has(key)) errors.push(`duplicate stage key "${key}": an application's stage is stored as this key, so two stages sharing one are the same stage`);
    seen.add(key);
    if (typeof s.label !== "string" || !s.label.trim()) errors.push(`ats.stages[${i}].label must be a non-empty string`);
    if (s.kind !== "active" && s.kind !== "hired" && s.kind !== "rejected") errors.push(`ats.stages[${i}].kind must be "active", "hired" or "rejected"`);
  });
  if (!cfg.stages.some((s) => (s as AtsStage | null)?.kind === "hired")) {
    errors.push('ats.stages must include one stage of kind "hired": it is the terminal that marks a candidate hired');
  }
  if (cfg.scorecard_criteria != null) {
    if (!Array.isArray(cfg.scorecard_criteria)) errors.push("ats.scorecard_criteria must be an array");
    else {
      const keys = new Set<string>();
      cfg.scorecard_criteria.forEach((raw, i) => {
        const c = (raw ?? {}) as Record<string, unknown>;
        const key = typeof c.key === "string" ? c.key.trim() : "";
        // Same rule, same reason: an interview score is filed against the criterion's key.
        if (!key) errors.push(`ats.scorecard_criteria[${i}].key must be a non-empty string`);
        else if (keys.has(key)) errors.push(`duplicate scorecard criterion key "${key}"`);
        keys.add(key);
      });
    }
  }
  if (cfg.offer_band_point != null && !OFFER_BAND_POINTS.includes(cfg.offer_band_point)) {
    errors.push(`ats.offer_band_point must be one of ${OFFER_BAND_POINTS.join(", ")}`);
  }
  for (const k of ["offer_validity_days", "join_notice_days"] as const) {
    const v = cfg[k];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) errors.push(`ats.${k} must be a non-negative number`);
  }
  return errors;
}

/** The stages an application could be sitting in that `stages` no longer names - see validateAtsConfig. */
export function orphanedStages(stages: AtsStage[], inUse: string[]): string[] {
  const keys = new Set(stages.map((s) => s.key));
  return [...new Set(inUse.filter((s) => !keys.has(s)))];
}

export function stageKeys(cfg: AtsConfig): string[] {
  return cfg.stages.map((s) => s.key);
}
export function isStage(cfg: AtsConfig, key: string): boolean {
  return cfg.stages.some((s) => s.key === key);
}
export function stageKind(cfg: AtsConfig, key: string): StageKind | null {
  return cfg.stages.find((s) => s.key === key)?.kind ?? null;
}

// The stage after `current` in the ordered pipeline, or null if `current` is the last stage or unknown.
// Drives the `:advance` custom method (move an application one step forward without a free-form stage set).
export function nextStage(cfg: AtsConfig, current: string): string | null {
  const keys = stageKeys(cfg);
  const i = keys.indexOf(current);
  if (i < 0 || i >= keys.length - 1) return null;
  return keys[i + 1]!;
}

// The application status implied by landing on `stage`: a `hired`-kind stage flips the coarse status to
// "hired"; every other stage keeps it "active". Rejection/withdrawal are set explicitly, never by stage.
export function statusForStage(cfg: AtsConfig, stage: string): ApplicationStatus {
  return stageKind(cfg, stage) === "hired" ? "hired" : "active";
}
