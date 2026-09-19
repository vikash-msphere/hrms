// Turn a resume into form fields a recruiter can accept, one by one.
//
// THE MODEL TRANSCRIBES. IT DOES NOT JUDGE. Everything here reads a document the candidate submitted and
// copies what it says into the fields the candidate record already has. There is no score, no ranking, no
// "strength of fit", and adding one would not be an extension of this file - it would be a different act with
// different obligations (see the note over CONSENTED_PATHS in domain/aiPolicy.ts).
//
// WHY THE TEXT ARRIVES FROM THE CLIENT. The Worker has no PDF text extractor - `lib/pdf.ts` writes PDFs, it
// does not read them - while the SPA already runs pdfjs for the document viewer. Extracting in the browser
// and posting the text is therefore the only option that works, and it happens to be the better one twice
// over: a PDF parser is a notorious piece of attack surface and this keeps it out of the Worker, and parsing
// a large document is exactly the kind of work that exhausts an invocation's CPU budget.
//
// That makes the submitted text CALLER-CONTROLLED, which is worth being explicit about rather than assuming
// it came from the file it claims to. It does not matter: the text is fenced as untrusted, the output is
// parsed into a fixed shape, and every field lands as a suggestion a human accepts. A caller who posts
// invented text can produce a suggestion about their own candidate record, which they could have typed into
// that record anyway.
//
// EVERYTHING HERE IS OFF UNTIL AN ORG TURNS IT ON, and then only for the fields it names. See `atsConfig`.
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { failedPrecondition, invalidArgument, notFound, resourceExhausted } from "../lib/errors";
import { MODELS, UNTRUSTED_PREAMBLE, assertConsentedPath, fence, scrubStatutoryIds } from "../domain/aiPolicy";
import {
  EXTRACTABLE_FIELDS,
  extractionConfig,
  type ExtractField,
} from "../domain/resumeFields";
import { aiFeatureOn, aiGenerate } from "./ai";

/** The consented path this file is, named in domain/aiPolicy.ts. */
const PATH = "ats.resumeExtraction";
const PROMPT_VERSION = "v2"; // bumped when the field list became configurable - the prompt now varies by org
export const MAX_RESUME_CHARS = 20_000;

/**
 * The shape the model must answer in, and the only shape this file will accept.
 *
 * Every field is nullable and the prompt says to use null rather than guess, because a resume that does not
 * state something is the normal case and an invented value is worse than a blank one - a recruiter checking
 * a filled field reads it as "the document said this".
 *
 * `.strict()` so an extra key is a parse failure rather than something that quietly rides along. There is no
 * field here that is not already a column on the candidate record: the model cannot propose anything the
 * form could not have been typed into by hand.
 */
const extracted = z
  .object({
    name: z.string().max(200).nullable(),
    email: z.string().max(200).nullable(),
    phone: z.string().max(60).nullable(),
    // Free text rather than an enum: the catalogue of skills is the org's business, and a model picking from
    // a closed list would silently drop whatever the candidate actually knows.
    skills: z.array(z.string().max(80)).max(40).nullable(),
    current_employer: z.string().max(200).nullable(),
    current_title: z.string().max(200).nullable(),
    years_experience: z.number().min(0).max(70).nullable(),
    summary: z.string().max(1200).nullable(),
  })
  .partial()
  .strict();

export type ExtractedResume = Partial<Record<ExtractField, unknown>>;

const BASE_SYSTEM =
  "You read a job applicant's CV and copy what it says into fields. " +
  "Answer with a single JSON object and nothing else: no explanation, no markdown, no code fence. " +
  "Use null for anything the document does not state. Do NOT guess, infer or estimate. " +
  "Do not assess the candidate. Do not say whether they are suitable, strong, or a good fit for anything. " +
  "Do not mention age, gender, marital status, nationality, religion, caste or health even if the CV does.";

/** Per-field guidance, added ONLY for a field the org actually asked for. */
const FIELD_RULES: Partial<Record<ExtractField, string>> = {
  skills: "skills is an array of short strings taken from the document, or null.",
  years_experience: "years_experience is a number ONLY if the CV states one. Do not add up dates or estimate; otherwise it is null.",
  summary: "summary is at most three sentences describing what the person has done, in their own document's terms.",
};

/**
 * The system prompt for one org's chosen field set.
 *
 * The key list AND the per-field rules are both built from that set. Only interpolating the key list was not
 * enough: the fixed prose went on to describe `summary` and `skills` whatever the org had chosen, so a model
 * told to return two fields was still being told what a good summary looks like - which is an invitation to
 * produce one, and works against the setting rather than with it.
 */
export const systemFor = (fields: readonly ExtractField[]): string => {
  const rules = fields.map((f) => FIELD_RULES[f]).filter(Boolean);
  return [
    BASE_SYSTEM,
    `The keys are exactly: ${fields.join(", ")}.`,
    ...rules,
    "",
    UNTRUSTED_PREAMBLE,
  ].join(" ").replace(`  ${UNTRUSTED_PREAMBLE}`, `\n\n${UNTRUSTED_PREAMBLE}`);
};

export type ResumeSuggestion = { fields: ExtractedResume; cached: boolean };

/**
 * Extract fields from `resumeText` for one candidate, and record the suggestion.
 *
 * Throws rather than returning a refusal, for the same reason drafting does: a recruiter pressed a button and
 * is waiting, so "switched off" or "budget spent" has to be an answer they can read.
 */
export async function extractResume(deps: Deps, user: AppUser, candidateId: string, resumeText: string): Promise<ResumeSuggestion> {
  // The narrow exception, asserted by name. `candidates` is on NEVER_TO_MODEL and stays there; this is the
  // one path allowed through, and it can only ever be this collection.
  assertConsentedPath(PATH, "candidates");

  const text = (resumeText ?? "").trim();
  if (!text) throw invalidArgument("no resume text to read");
  if (text.length > MAX_RESUME_CHARS) throw invalidArgument(`the resume text must be under ${MAX_RESUME_CHARS} characters`);

  // The candidate must exist. Read access to it was already decided by the authz middleware on the item path;
  // this is existence, not permission.
  const [candidate] = await deps.db
    .select({ uuid: schema.candidates.uuid })
    .from(schema.candidates)
    .where(eq(schema.candidates.uuid, candidateId))
    .limit(1);
  if (!candidate) throw notFound("candidate not found");

  if (!deps.ai) throw failedPrecondition("AI extraction is not available on this deployment");
  if (!(await aiFeatureOn(deps, "ats.extraction"))) throw failedPrecondition("AI resume extraction is switched off for this organisation");

  // WHICH FIELDS this org allows a model to propose. Empty means the feature is on but nothing was chosen,
  // which is a configuration mistake rather than a licence to read everything - so it is refused, and the
  // message says what to do about it.
  const allowed = await extractionConfig(deps);
  if (allowed.length === 0) {
    throw failedPrecondition("no resume fields are enabled for extraction; choose them in Settings -> AI features");
  }

  const out = await aiGenerate(
    deps,
    { feature: "ats.resumeExtract", userId: user.uuid, subject: `candidates/${candidateId}` },
    {
      system: systemFor(allowed),
      // Statutory ids go; phone numbers stay, because a phone number is a field this is trying to fill.
      user: fence("the CV", scrubStatutoryIds(text)),
      // The chosen field set is part of the cache key: two orgs (or one org before and after a change) asking
      // for different fields must not be served each other's answer.
      promptVersion: `${PROMPT_VERSION}:${allowed.join(",")}`,
      maxTokens: 700,
    },
  );

  if (!out.ok) {
    if (out.reason === "rate") throw resourceExhausted("you have used your extraction allowance for this hour");
    if (out.reason === "budget") throw resourceExhausted("the organisation's AI budget for today is spent; it resets at midnight UTC");
    if (out.reason === "unavailable") throw failedPrecondition("AI extraction is not available on this deployment");
    throw failedPrecondition("the model could not be reached just now");
  }

  const fields = parseExtraction(out.value, allowed);
  await recordSuggestion(deps, candidateId, fields);
  return { fields, cached: out.cached };
}

/**
 * Parse the model's answer into the fixed shape, keeping only the fields this org enabled.
 *
 * A model asked for JSON will sometimes wrap it in a code fence or a sentence however firmly the prompt says
 * not to, so the outermost braces are taken before parsing. Everything after that is strict: an unexpected
 * key, a wrong type or a bad value is a failure, not something to patch up. This is the boundary where model
 * output stops being text and becomes data, and a lenient boundary is how a model ends up able to propose a
 * field nobody designed.
 *
 * The `allowed` filter runs AFTER the schema, so a model that answers with a field the org switched off has
 * that field dropped rather than the whole extraction failing - the org's choice is enforced here regardless
 * of what the prompt asked for.
 */
export function parseExtraction(raw: string, allowed: readonly ExtractField[]): ExtractedResume {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw failedPrecondition("the model did not return the expected fields");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw failedPrecondition("the model did not return the expected fields");
  }
  const result = extracted.safeParse(parsed);
  if (!result.success) throw failedPrecondition("the model did not return the expected fields");

  const out: ExtractedResume = {};
  for (const key of EXTRACTABLE_FIELDS) {
    if (!allowed.includes(key)) continue;
    const value = (result.data as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Park the suggestion on the candidate, in the same table ticket triage uses. Accepting is the recruiter
 *  PATCHing the candidate through the ordinary route, so nothing here writes to the record. */
async function recordSuggestion(deps: Deps, candidateId: string, fields: ExtractedResume): Promise<void> {
  try {
    const now = deps.clock.now();
    const values = {
      hostCollection: "candidates",
      hostRecordId: candidateId,
      feature: "ats.resumeExtract",
      payloadJson: JSON.stringify(fields),
      model: MODELS.generate,
      basis: 1,
    };
    await deps.db
      .insert(schema.aiSuggestions)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.aiSuggestions.hostCollection, schema.aiSuggestions.hostRecordId, schema.aiSuggestions.feature],
        set: { payloadJson: values.payloadJson, model: values.model, state: "pending", decidedBy: null, decidedAt: null, updatedAt: now },
      });
  } catch (e) {
    console.error("resume extraction suggestion record failed", e);
  }
}
