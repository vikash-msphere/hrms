// The Workers AI transport. One place where a model id becomes a subrequest, so there is one place that can
// check what is being called and how the call is logged.
//
// Two things are enforced here rather than left to call sites, because both are properties of the CALL and
// both fail silently when a call site forgets them:
//
//   1. THE MODEL ALLOWLIST (domain/aiPolicy.ts). The `AI` binding will happily proxy an external provider if
//      given a provider-prefixed id, which would send HR text to a party with no contract with us through an
//      edit that reads as a model upgrade. `assertModelAllowed` refuses by shape and by membership.
//   2. GATEWAY PAYLOAD LOGGING. AI Gateway stores request and response bodies by default. For this app that
//      would mean a retained third copy of whatever went into a prompt, with its own lifetime and its own
//      deletion story. `cf-aig-collect-log-payload: false` suppresses the bodies while keeping the metrics,
//      and it is sent on every call whether or not a gateway is configured, so turning one on later cannot
//      quietly start recording payloads.
//
// What this file deliberately does NOT do: decide whether a call is affordable, cache its result, record it,
// or judge whether the text was allowed anywhere near a model. services/ai.ts owns all four. Keeping them out
// means this stays a transport that a test can replace with a fake in one line.
import { assertModelAllowed, MODELS } from "../domain/aiPolicy";
import type { TextModel } from "../ports";

/** Options threaded into every `AI.run` call. `gateway` is set only when the deployment names one. */
type RunOptions = { gateway?: { id: string; collectLog: boolean }; returnRawResponse?: false };

export function makeTextModel(binding: Ai, gatewayId?: string): TextModel {
  // Metadata-only logging when a gateway is configured: usage and latency are recorded, prompts and
  // completions are not. `ai_usage` is the richer record anyway, and it is in our own database.
  const options: RunOptions = gatewayId ? { gateway: { id: gatewayId, collectLog: false } } : {};

  async function run<T>(model: string, input: unknown): Promise<T> {
    assertModelAllowed(model);
    return (await binding.run(model as never, input as never, options as never)) as T;
  }

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      const out = await run<{ data: number[][] }>(MODELS.embed, { text: texts });
      // The model returns one vector per input, in order. A mismatch means the batch was silently truncated,
      // and pairing vector 3 with row 4 would poison the index in a way no later test could attribute - so it
      // is an error here rather than a misalignment downstream.
      if (!out?.data || out.data.length !== texts.length) {
        throw new Error(`AI embed returned ${out?.data?.length ?? 0} vectors for ${texts.length} inputs`);
      }
      return out.data;
    },

    async generate({ system, user, maxTokens }) {
      const out = await run<{ response?: string }>(MODELS.generate, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens ?? 512,
        // Low but not zero. Drafting reads as a machine at 0, and the constrained-JSON callers validate their
        // output anyway, so determinism buys them nothing a schema does not already give.
        temperature: 0.3,
      });
      return out?.response ?? "";
    },

    async rerank(query, candidates) {
      if (candidates.length === 0) return [];
      const out = await run<{ response: { id: number; score: number }[] }>(MODELS.rerank, {
        query,
        contexts: candidates.map((text) => ({ text })),
      });
      return (out?.response ?? []).map((r) => ({ index: r.id, score: r.score }));
    },
  };
}
