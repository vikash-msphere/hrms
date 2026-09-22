// Drafting: turn an instruction the caller typed into a block of text they can edit and save.
//
// The expensive primitive, so it is user-initiated and rate-limited per person, never automatic. The prompts
// are in domain/aiDraft.ts, where they can be read as a set; this file is the plumbing around them.
//
// WHAT COMES BACK IS A SUGGESTION IN A TEXT BOX. It is returned to the caller and nothing else happens: no
// record is written, no field is set, no event is emitted. Whether it becomes anything is the caller's next
// action, through the ordinary create or update path with its ordinary validation and audit row. That is the
// whole safety argument for letting a model generate free text in an HR system, and it holds because there is
// no code path from here to a write.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument, failedPrecondition, resourceExhausted } from "../lib/errors";
import { assertConsentedPath, assertMayReachModel } from "../domain/aiPolicy";
import { MAX_DRAFT_INPUT, draftKind, draftPrompt, draftSystem } from "../domain/aiDraft";
import { aiFeatureOn, aiGenerate } from "./ai";

export type DraftRequest = { kind: string; instruction: string; existing?: string | null };
export type DraftResult = { text: string; cached: boolean };

/**
 * Draft text of one kind. Throws rather than returning a refusal object, unlike the rest of the AI layer.
 *
 * The difference is deliberate and it is about what the caller can do with the answer. Semantic search and
 * triage are ENRICHMENTS: something useful already happened without them, so a refusal is turned into the
 * plain result and the user never learns a model was involved. A draft is the whole point of the request -
 * the user pressed a button labelled "Draft" and is waiting for text - so "the budget is spent" or "this is
 * switched off" has to reach them as an answer, not as an empty box they will press again.
 */
export async function draftText(deps: Deps, user: AppUser, req: DraftRequest): Promise<DraftResult> {
  const kind = draftKind(req.kind);
  if (!kind) throw invalidArgument(`unknown draft kind "${req.kind}"`);
  // Belt to the braces in domain/aiDraft.ts: nothing from a record reaches the prompt, but the host is still
  // checked, so wiring a draft kind onto a sensitive collection fails loudly rather than reading as fine.
  //
  // A kind may instead name a CONSENTED_PATH, which is the declared exception and not a way around the gate:
  // `assertConsentedPath` throws unless that path is declared AND names this exact collection, so the string
  // cannot be borrowed to unlock a different one. A kind gets one door or the other, never both.
  if (kind.consentedPath) assertConsentedPath(kind.consentedPath, kind.collection);
  else assertMayReachModel(kind.collection);

  const instruction = (req.instruction ?? "").trim();
  if (!instruction) throw invalidArgument("say what to write");
  if (instruction.length > MAX_DRAFT_INPUT) throw invalidArgument(`the instruction must be under ${MAX_DRAFT_INPUT} characters`);
  if ((req.existing ?? "").length > MAX_DRAFT_INPUT) throw invalidArgument(`the current draft must be under ${MAX_DRAFT_INPUT} characters to improve it`);

  if (!deps.ai) throw failedPrecondition("AI drafting is not available on this deployment");
  if (!(await aiFeatureOn(deps, "drafting"))) throw failedPrecondition("AI drafting is switched off for this organisation");

  const out = await aiGenerate(
    deps,
    {
      // Per KIND, not one bucket for all drafting: the usage table is how the neuron cost of each feature is
      // learned, and "drafting cost 900 neurons today" does not say which of them to keep.
      feature: `draft.${kind.id}`,
      userId: user.uuid,
      // `reads` DECLARES "content from this collection is going into the prompt", and `aiGenerate` answers it
      // with the absolute `assertMayReachModel`. For an ordinary kind that is exactly right - a second gate
      // behind the one above. For a consented kind it would be a false statement AND an immediate throw:
      // `draftText` reads no record, so the only text sent is the instruction the author typed and whatever
      // is already in their field. The declared exception is asserted above, by path and collection together;
      // claiming the collection here as well would ask the general gate a question the exception exists to
      // answer.
      //
      // Tied to `consentedPath` rather than to a kind id, so a future kind that genuinely does read rows
      // cannot inherit the `"none"` by accident - it would have to claim an exception of its own first.
      reads: kind.consentedPath ? "none" : { collection: kind.collection },
    },
    {
      system: draftSystem(kind),
      user: draftPrompt(instruction, req.existing),
      promptVersion: kind.promptVersion,
      maxTokens: kind.maxTokens,
    },
  );

  if (!out.ok) {
    // Each refusal says the one true thing about itself. "Try again later" for a spent budget would be wrong
    // (it resets at midnight UTC), and for a switched-off feature it would be wrong forever.
    if (out.reason === "rate") throw resourceExhausted("you have used your drafting allowance for this hour");
    if (out.reason === "budget") throw resourceExhausted("the organisation's AI budget for today is spent; it resets at midnight UTC");
    if (out.reason === "unavailable") throw failedPrecondition("AI drafting is not available on this deployment");
    throw failedPrecondition("the model could not be reached just now");
  }

  const text = out.value.trim();
  if (!text) throw failedPrecondition("the model returned nothing; try rewording the request");
  return { text, cached: out.cached };
}
