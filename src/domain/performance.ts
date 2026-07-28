// The org's performance-review framework (stored in settings/performance; HR edits it). Pure data: the
// competencies each review rates and the scale they're rated on. Reviews store ratings keyed by competency
// `key`; the web renders the form + results from this framework. Loosely validated - unknown keys are inert.
export type Competency = { key: string; label: string };
export type RatingLevel = { value: number; label: string };
export type PerformanceFramework = {
  competencies: Competency[];
  scale: RatingLevel[];
};

export const DEFAULT_PERFORMANCE: PerformanceFramework = {
  competencies: [
    { key: "impact", label: "Impact & results" },
    { key: "ownership", label: "Ownership & reliability" },
    { key: "collaboration", label: "Collaboration & teamwork" },
    { key: "communication", label: "Communication" },
    { key: "growth", label: "Growth & learning" },
  ],
  scale: [
    { value: 1, label: "Below expectations" },
    { value: 2, label: "Partially meets" },
    { value: 3, label: "Meets expectations" },
    { value: 4, label: "Exceeds" },
    { value: 5, label: "Outstanding" },
  ],
};
