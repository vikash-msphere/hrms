// The org's performance-review framework, mirrored on the web (the bundle can't import from src/). Reviews
// render their competency ratings + scale from this; HR overrides it via settings/performance. Defaults match
// src/domain/performance.ts.
export type Competency = { key: string; label: string };
export type RatingLevel = { value: number; label: string };
export type PerformanceFramework = { competencies: Competency[]; scale: RatingLevel[] };

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

// The label for a rating value on the given scale (falls back to the bare number).
export const ratingLabel = (scale: RatingLevel[], value?: number) =>
  value == null ? "" : scale.find((s) => s.value === value)?.label ?? String(value);
