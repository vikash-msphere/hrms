// Pay grades: the org's band catalog (level + min/mid/max). A grade is a guardrail for compensation, never a
// hard gate - see domain/payGrade.ts for the compa-ratio read side.
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";

export type PayGradeInput = {
  display_name?: string;
  level?: number;
  band_min?: number | null;
  band_mid?: number | null;
  band_max?: number | null;
  currency_code?: string;
  description?: string | null;
};

// A band is a guardrail, never blocking. We only reject an internally-inconsistent band: a value out of
// min <= mid <= max order. `effective` is the would-be saved state after this write.
function validateBand(effective: { bandMin?: number | null; bandMid?: number | null; bandMax?: number | null }) {
  const { bandMin, bandMid, bandMax } = effective;
  if (bandMin != null && bandMid != null && bandMin > bandMid) throw invalidArgument("band_min must not exceed band_mid");
  if (bandMid != null && bandMax != null && bandMid > bandMax) throw invalidArgument("band_mid must not exceed band_max");
  if (bandMin != null && bandMax != null && bandMin > bandMax) throw invalidArgument("band_min must not exceed band_max");
}

export const payGradeSpec: CrudSpec<PayGradeInput, typeof schema.payGrades> = {
  table: schema.payGrades,
  collection: "pay-grades",
  auditName: "pay_grade",
  notFound: "pay grade not found",
  // The catalog reads as a ladder, so a page is ordered by level rather than by age.
  sort: (a, b) => a.level - b.level || +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  insert: (input) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    validateBand({ bandMin: input.band_min ?? null, bandMid: input.band_mid ?? null, bandMax: input.band_max ?? null });
    return {
      name: input.display_name,
      level: input.level ?? 0,
      bandMin: input.band_min ?? null,
      bandMid: input.band_mid ?? null,
      bandMax: input.band_max ?? null,
      currency: input.currency_code?.trim() || "INR",
      description: input.description ?? null,
    };
  },
  patch: (patch, row) => {
    const set: SetOf<typeof schema.payGrades> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "level")) set.level = patch.level ?? 0;
    if (has(patch, "band_min")) set.bandMin = patch.band_min ?? null;
    if (has(patch, "band_mid")) set.bandMid = patch.band_mid ?? null;
    if (has(patch, "band_max")) set.bandMax = patch.band_max ?? null;
    if (has(patch, "currency_code")) set.currency = patch.currency_code?.trim() || "INR";
    if (has(patch, "description")) set.description = patch.description ?? null;
    // Validate the band as it WILL be, merging the patch over the stored row - a lone band_min still has to
    // respect a mid/max it never mentions.
    validateBand({
      bandMin: has(patch, "band_min") ? patch.band_min ?? null : row.bandMin,
      bandMid: has(patch, "band_mid") ? patch.band_mid ?? null : row.bandMid,
      bandMax: has(patch, "band_max") ? patch.band_max ?? null : row.bandMax,
    });
    return set;
  },
};

