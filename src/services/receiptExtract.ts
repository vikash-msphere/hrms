// Turn a receipt into expense fields the submitter can accept, one by one.
//
// THE MODEL TRANSCRIBES. IT DOES NOT DECIDE. Everything here copies figures off a document into fields the
// expense form already has. It does not judge whether a claim is reasonable, in policy, or a duplicate -
// those are separate features with separate designs (`autoApproveBlocks`, `findDuplicateClaims`), and both
// are deterministic on purpose. A model that could decline a claim would be a different act with different
// obligations.
//
// TEXT FROM THE CLIENT, FOR THE REASONS `services/resumeExtract.ts` GIVES. The Worker has no PDF reader -
// `lib/pdf.ts` writes them - while the SPA already runs pdfjs for the document viewer. Extracting in the
// browser is therefore the only option that works, and it is also the better one: a PDF parser is a
// notorious piece of attack surface kept out of the Worker, and parsing a document is exactly the work that
// exhausts an invocation's CPU budget.
//
// SO THIS READS PDFs AND NOT PHOTOGRAPHS, which is a deliberate limit rather than an unfinished one. A photo
// needs a vision model in `MODELS`, and the decisive objection is that AN IMAGE CANNOT BE SCRUBBED:
// `scrubStatutoryIds` runs over text before it reaches the model, and there is no equivalent for a picture,
// which would have to be seen before it could be redacted. Receipts carry whatever is printed on them, and
// the incidental content is often medical. Vendor invoices arrive as PDFs and are most of what `expenses`
// holds; a photographed till receipt stays a typed-in claim.
//
// THE SUBMITTED TEXT IS CALLER-CONTROLLED and that is fine, for the reason the CV path documents: it is
// fenced as untrusted, parsed into a fixed shape, and every field lands as a suggestion a human accepts. A
// caller who posts invented text produces a suggestion about their own draft claim, which they could have
// typed into that claim anyway.
//
// NO CONSENTED PATH. `expenses` is not in `NEVER_TO_MODEL`, so `assertMayReachModel` admits it outright -
// checked against the list rather than taken from the plan, which assumed an exception was needed.
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { failedPrecondition, invalidArgument, notFound, resourceExhausted } from "../lib/errors";
import { MODELS, UNTRUSTED_PREAMBLE, assertMayReachModel, fence, scrubStatutoryIds } from "../domain/aiPolicy";
import { RECEIPT_FIELDS, receiptExtractionConfig, type ReceiptField } from "../domain/receiptFields";
import { aiFeatureOn, aiGenerate } from "./ai";

const PROMPT_VERSION = "v1";
/** A receipt is a page or two. Well above any real invoice, and far below a CV's allowance. */
export const MAX_RECEIPT_CHARS = 8_000;

/**
 * The shape the model must answer in, and the only shape this file accepts.
 *
 * Every field is nullable and the prompt says to use null rather than guess: a receipt that does not state
 * something is ordinary, and an invented figure is far worse than a blank one here - a submitter reviewing a
 * filled amount reads it as "the document said this", and the amount is the thing being claimed.
 *
 * `.strict()` so an unexpected key fails the parse instead of riding along.
 */
const extracted = z
  .object({
    // Non-negative, and bounded. A model that returns a negative total has misread the page, and a credit
    // note is not an expense claim.
    amount: z.number().min(0).max(100_000_000).nullable(),
    tax_amount: z.number().min(0).max(100_000_000).nullable(),
    // A calendar day, validated as a shape here and as a real date at the route.
    incurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    // TEXT, never a vendor reference. Matching it to an existing vendor is the submitter's act: a model
    // picking the wrong one from a list would misattribute spend with nothing on screen saying it guessed.
    vendor_name: z.string().max(200).nullable(),
    invoice_number: z.string().max(80).nullable(),
  })
  .partial()
  .strict();

export type ExtractedReceipt = Partial<Record<ReceiptField, unknown>>;

const BASE_SYSTEM =
  "You read a receipt or invoice and copy what it says into fields. " +
  "Answer with a single JSON object and nothing else: no explanation, no markdown, no code fence. " +
  "Use null for anything the document does not state. Do NOT guess, infer, calculate or estimate. " +
  "Do not judge whether the expense is reasonable, allowable or suspicious. " +
  "Do not describe what was bought.";

/** Per-field guidance, added ONLY for a field the org asked for - so a model told to return two fields is
 *  not also told what a good answer for a third looks like. */
const FIELD_RULES: Partial<Record<ReceiptField, string>> = {
  amount: "amount is the TOTAL the payer paid, as a plain number with no currency symbol or separators. If several totals appear and none is clearly the amount paid, use null.",
  tax_amount: "tax_amount is the tax component only (GST, VAT, sales tax), as a plain number. Never the total. If the document does not separate it, use null.",
  incurred_on: "incurred_on is the date the goods or service were supplied, as YYYY-MM-DD. If only an invoice or due date appears, use null rather than substituting one.",
  vendor_name: "vendor_name is the seller's name exactly as printed, not the buyer's and not a guess at a parent company.",
  invoice_number: "invoice_number is the document's own reference, copied exactly including any letters or punctuation.",
};

export const systemFor = (fields: readonly ReceiptField[]): string => {
  const rules = fields.map((f) => FIELD_RULES[f]).filter(Boolean);
  return [
    BASE_SYSTEM,
    `The keys are exactly: ${fields.join(", ")}.`,
    ...rules,
    "",
    UNTRUSTED_PREAMBLE,
  ].join(" ").replace(`  ${UNTRUSTED_PREAMBLE}`, `\n\n${UNTRUSTED_PREAMBLE}`);
};

export type ReceiptSuggestion = { fields: ExtractedReceipt; cached: boolean };

/**
 * Extract fields from `receiptText` for one expense, and record the suggestion.
 *
 * Throws rather than returning a refusal: somebody pressed a button and is waiting, so "switched off" or
 * "budget spent" has to be an answer they can read.
 */
export async function extractReceipt(deps: Deps, user: AppUser, expenseId: string, receiptText: string): Promise<ReceiptSuggestion> {
  // Asserted by name even though `expenses` is not denied. The check is cheap and it is the line that would
  // start failing if somebody later moved `expenses` onto NEVER_TO_MODEL - which is exactly when this path
  // must stop working rather than quietly keep going.
  assertMayReachModel("expenses");

  const text = (receiptText ?? "").trim();
  if (!text) throw invalidArgument("no receipt text to read");
  if (text.length > MAX_RECEIPT_CHARS) throw invalidArgument(`the receipt text must be under ${MAX_RECEIPT_CHARS} characters`);

  // Existence, not permission - the route has already applied the caller's scope to this expense.
  const [expense] = await deps.db
    .select({ uuid: schema.expenses.uuid, state: schema.expenses.state })
    .from(schema.expenses)
    .where(eq(schema.expenses.uuid, expenseId))
    .limit(1);
  if (!expense) throw notFound("expense not found");
  // Only a draft can take the suggestion: every other state has been submitted for somebody's decision, and
  // filling fields underneath an approver is a different and much worse feature.
  if (expense.state !== "DRAFT") throw failedPrecondition("only a draft expense can be filled from a receipt");

  if (!deps.ai) throw failedPrecondition("AI extraction is not available on this deployment");
  if (!(await aiFeatureOn(deps, "expenses.receiptExtraction"))) {
    throw failedPrecondition("AI receipt extraction is switched off for this organisation");
  }

  const allowed = await receiptExtractionConfig(deps);
  if (allowed.length === 0) {
    throw failedPrecondition("no receipt fields are enabled for extraction; choose them in Settings -> AI features");
  }

  const out = await aiGenerate(
    deps,
    { feature: "expenses.receiptExtract", userId: user.uuid, subject: `expenses/${expenseId}` },
    {
      system: systemFor(allowed),
      // `scrubStatutoryIds`, NOT the general identifier scrub: that one deletes long digit runs, and an
      // invoice number is a long digit run. The same choice the CV path makes for a phone number.
      user: fence("the receipt", scrubStatutoryIds(text)),
      // The field set is part of the cache key: two orgs asking for different fields must not be served each
      // other's answer.
      promptVersion: `${PROMPT_VERSION}:${allowed.join(",")}`,
      maxTokens: 400,
    },
  );

  if (!out.ok) {
    if (out.reason === "rate") throw resourceExhausted("you have used your extraction allowance for this hour");
    if (out.reason === "budget") throw resourceExhausted("the organisation's AI budget for today is spent; it resets at midnight UTC");
    if (out.reason === "unavailable") throw failedPrecondition("AI extraction is not available on this deployment");
    throw failedPrecondition("the model could not be reached just now");
  }

  const fields = parseReceipt(out.value, allowed);
  await recordSuggestion(deps, expenseId, fields);
  return { fields, cached: out.cached };
}

/**
 * Parse the model's answer into the fixed shape, keeping only the fields this org enabled.
 *
 * The outermost braces are taken first, because a model asked for JSON will sometimes wrap it in a fence
 * however firmly the prompt says not to. Everything after that is strict: an unexpected key, a wrong type or
 * a bad value fails rather than being patched up. This is where model output stops being text and becomes
 * data, and a lenient boundary here is how a model ends up proposing a field nobody designed.
 *
 * The `allowed` filter runs AFTER the schema, so a model answering with a field the org switched off has it
 * dropped rather than failing the whole extraction.
 */
export function parseReceipt(raw: string, allowed: readonly ReceiptField[]): ExtractedReceipt {
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

  const out: ExtractedReceipt = {};
  for (const key of RECEIPT_FIELDS) {
    if (!allowed.includes(key)) continue;
    const value = (result.data as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Park the suggestion beside the expense. Accepting it is the submitter PATCHing the expense through the
 *  ordinary route, so nothing here writes to the claim. */
async function recordSuggestion(deps: Deps, expenseId: string, fields: ExtractedReceipt): Promise<void> {
  try {
    await deps.db.insert(schema.aiSuggestions).values({
      hostCollection: "expenses",
      hostRecordId: expenseId,
      feature: "expenses.receiptExtract",
      payloadJson: JSON.stringify(fields),
      model: MODELS.generate,
      basis: 1,
    });
  } catch (err) {
    // A suggestion that cannot be recorded is not a reason to withhold it from the person waiting: the
    // fields are already computed and the record is for the audit trail, not for the answer.
    console.error("receipt suggestion not recorded", { expenseId, err });
  }
}
