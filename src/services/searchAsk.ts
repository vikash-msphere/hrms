// ⌘K "Ask" - one generation, on Enter, paid by the person who pressed it. See domain/searchAsk.ts for what
// the model is shown and why it only ever routes.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { failedPrecondition, invalidArgument, resourceExhausted } from "../lib/errors";
import { fence, scrubIdentifiers } from "../domain/aiPolicy";
import { ASK_PROMPT_VERSION, ASK_SYSTEM, MAX_QUESTION, destinationLines, parseAskAnswer, type AskAnswer, type AskDestination } from "../domain/searchAsk";
import { aiFeatureOn, aiGenerate } from "./ai";
import { askLabel, recordInsight } from "./searchInsights";

export async function askSearch(
  deps: Deps,
  user: AppUser,
  question: string,
  destinations: AskDestination[],
): Promise<AskAnswer & { cached: boolean }> {
  const q = question.trim();
  if (q.length < 3) throw invalidArgument("ask a question of at least a few words");
  if (q.length > MAX_QUESTION) throw invalidArgument(`a question is at most ${MAX_QUESTION} characters`);
  if (destinations.length === 0) throw invalidArgument("no destinations to choose from");

  // Throws rather than returning a refusal, as drafting and goal measures do: somebody pressed Enter and is
  // waiting, so "switched off" has to be an answer they can read.
  if (!deps.ai) throw failedPrecondition("AI is not available on this deployment");
  if (!(await aiFeatureOn(deps, "search.ask"))) throw failedPrecondition("Ask is switched off for this organisation");

  const out = await aiGenerate(
    deps,
    // `reads: "none"`: the question is the caller's own words and the destinations are the app's own labels.
    // No record goes in, which is the whole design (domain/searchAsk.ts).
    { feature: "search.ask", userId: user.uuid, reads: "none" },
    {
      system: ASK_SYSTEM,
      // Scrubbed as well as fenced: a question is free text, and somebody will paste a PAN into it.
      user: `Question:\n${fence("the question", scrubIdentifiers(q))}\n\nDESTINATIONS:\n${destinationLines(destinations)}`,
      promptVersion: ASK_PROMPT_VERSION,
      maxTokens: 200,
    },
  );

  if (!out.ok) {
    if (out.reason === "rate") throw resourceExhausted("you have used your AI allowance for this hour");
    if (out.reason === "budget") throw resourceExhausted("the organisation's AI budget for today is spent; it resets at midnight UTC");
    if (out.reason === "unavailable") throw failedPrecondition("AI is not available on this deployment");
    throw failedPrecondition("the model could not be reached just now");
  }

  const parsed = parseAskAnswer(out.value, new Set(destinations.map((d) => d.key)));
  if (!parsed) throw failedPrecondition("the model did not answer in a form Ask can use; try rephrasing");
  await recordInsight(deps, "ask", askLabel(parsed.destinations.length || parsed.search ? "answered" : "empty"));
  return { ...parsed, cached: out.cached };
}
