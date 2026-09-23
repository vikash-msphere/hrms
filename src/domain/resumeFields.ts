// WHICH fields a model may propose from a CV, as an org setting rather than a constant.
//
// The feature flag answers "may a CV be read by a model at all". This answers the separate and narrower
// question an HR team actually has: "which parts of it". They are different decisions and an org can
// reasonably want the first without all of the second - contact details are clerical, whereas a free-text
// summary is a machine's paraphrase of somebody's career that a recruiter will then read as if the document
// said it. Letting the org draw that line is the difference between a switch and a setting.
//
// The chosen list is interpolated into the prompt, so a model asked for three fields is not told the other
// five exist, and it is applied again after parsing, so what the org switched off cannot come back through a
// model that ignored the instruction. Prompt and filter, not prompt alone.
import type { Deps } from "../deps";
import { getSettingValue } from "../services/settings";

/** Every field extraction can offer. Each one is already a column on the candidate record: this list cannot
 *  propose anything the form could not have been typed into by hand. */
export const EXTRACTABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "skills",
  "current_employer",
  "current_title",
  "years_experience",
  "summary",
] as const;

export type ExtractField = (typeof EXTRACTABLE_FIELDS)[number];

/** What each field is, in the words the settings screen shows. `caution` marks the ones where the model is
 *  doing more than transcribing, so the person choosing can tell those apart at a glance. */
export const EXTRACT_FIELD_META: Record<ExtractField, { label: string; caution?: string }> = {
  name: { label: "Name" },
  email: { label: "Email address" },
  phone: { label: "Phone number" },
  skills: { label: "Skills", caution: "A list the model picks out of the document. It decides what counts as a skill." },
  current_employer: { label: "Current employer" },
  current_title: { label: "Current job title" },
  years_experience: { label: "Years of experience", caution: "Only when the CV states it. The model is told not to add up dates or estimate, but this is the field most likely to read as fact when it is not." },
  summary: { label: "Summary of experience", caution: "A paraphrase in the model's words, not the candidate's. A recruiter will read it as what the CV said." },
};

/**
 * The org's chosen fields, defaulting to the plainly clerical ones.
 *
 * The DEFAULT deliberately excludes `summary` and `years_experience`: both are the model doing more than
 * copying, and a default should be the version of a feature nobody has to review before turning it on. An org
 * that wants them adds them, which is a decision somebody made rather than one they inherited.
 *
 * An unknown name in the stored blob is dropped rather than honoured - a typo must not become a field the
 * model is asked for.
 */
export async function extractionConfig(deps: Deps): Promise<ExtractField[]> {
  const raw = await getSettingValue<{ resume_fields?: unknown }>(deps, "ai", {});
  const chosen = raw.resume_fields;
  if (!Array.isArray(chosen)) return [...DEFAULT_EXTRACT_FIELDS];
  const valid = chosen.filter((f): f is ExtractField => typeof f === "string" && (EXTRACTABLE_FIELDS as readonly string[]).includes(f));
  // Order by the canonical list rather than by however the blob happened to be written, so the prompt and the
  // cache key are stable for one chosen set.
  return EXTRACTABLE_FIELDS.filter((f) => valid.includes(f));
}

export const DEFAULT_EXTRACT_FIELDS: readonly ExtractField[] = [
  "name",
  "email",
  "phone",
  "skills",
  "current_employer",
  "current_title",
];
