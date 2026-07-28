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
};

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
