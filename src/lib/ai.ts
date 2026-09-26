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
//      It goes in `extraHeaders`, NOT as the gateway's `collectLog: false`. That option is the binding's form
//      of `cf-aig-collect-log`, which drops the WHOLE log entry and overrides the gateway's own setting: sent
//      on every call, it left the gateway with no logs at all. The binding has no payload-only option, so the
//      header is passed as-is; checked against the `hrms` gateway, which logged the call with empty bodies.
//
// What this file deliberately does NOT do: decide whether a call is affordable, cache its result, record it,
// or judge whether the text was allowed anywhere near a model. services/ai.ts owns all four. Keeping them out
// means this stays a transport that a test can replace with a fake in one line.
import { assertModelAllowed, MODELS } from "../domain/aiPolicy";
import type { TextModel } from "../ports";

/** Options threaded into every `AI.run` call. `gateway` is set only when the deployment names one. */
type RunOptions = { gateway?: { id: string }; extraHeaders: Record<string, string>; returnRawResponse?: false };

export function makeTextModel(binding: Ai, gatewayId?: string): TextModel {
  // Metadata-only logging when a gateway is configured: usage and latency are recorded, prompts and
  // completions are not. `ai_usage` is the richer record anyway, and it is in our own database.
  const extraHeaders = { "cf-aig-collect-log-payload": "false" };
  const options: RunOptions = gatewayId ? { gateway: { id: gatewayId }, extraHeaders } : { extraHeaders };

  async function run<T>(model: string, input: unknown): Promise<T> {
    assertModelAllowed(model);
    return (await binding.run(model as never, input as never, options as never)) as T;
  }

  return {
    embedModel: MODELS.embed,
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

    async generate({ system, user, maxTokens, role }) {
      // THE SAFETY CLASSIFIER TAKES NO SYSTEM TURN, and sending one broke the feature outright.
      //
      // `@cf/meta/llama-guard-3-8b` declares `messages[].role` as `"user" | "assistant"` and nothing else
      // (`Ai_Cf_Meta_Llama_Guard_3_8B_Input` in @cloudflare/workers-types). Guard builds its own prompt from
      // the conversation and judges the last turn against its fixed taxonomy; there is no instruction slot to
      // write into, so a system message is at best dropped and at worst rejects the call. Either way the
      // moderation drain saw a failed call, broke out of its loop, and the wall was never scanned - which is
      // exactly how a switched-on feature flagged nothing for a queue nobody could tell was empty.
      //
      // The cast at `run` is what let this compile: the binding's per-model input types never reach it.
      const guard = role === "moderate";
      const out = await run<{ response?: unknown; choices?: { message?: { content?: unknown } }[] }>(MODELS[role ?? "generate"], {
        messages: guard
          ? [{ role: "user", content: user }]
          : [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
        max_tokens: maxTokens ?? 512,
        // Low but not zero for PROSE. Drafting reads as a machine at 0, and the constrained-JSON callers
        // validate their output anyway, so determinism buys them nothing a schema does not already give.
        //
        // ZERO for the safety classifier, which is not prose. A verdict that can come out differently on two
        // reads of the same text is not a classification, and the consequences are asymmetric either way: a
        // sampled "safe" leaves an objectionable post unflagged, a sampled "unsafe" puts an innocuous one on a
        // moderator's queue - and `aiGenerate` then caches whichever way it fell for seven days, so the coin
        // toss is settled once and kept. This model was added to the method later than the number was chosen.
        temperature: guard ? 0 : 0.3,
        // THINKING OFF for the instruct model. Gemma 4 reasons before it answers unless told not to, and the
        // reasoning is billed as output and counted against `max_tokens`: measured on the goal-measure prompt
        // with a 200-token ceiling, it spent all 200 thinking and returned EMPTY content. Every caller here
        // wants a short answer in a fixed shape, not a worked argument. The guard model's schema has no such
        // key, so it is not sent there.
        ...(guard ? {} : { chat_template_kwargs: { enable_thinking: false } }),
      });
      // TWO REPLY SHAPES. The guard model answers `{ response }`; Gemma 4 answers in the chat-completions shape
      // and sends no `response` at all, so reading `response` alone returned "" for every generation - a
      // switched-on feature that suggests nothing, with no error anywhere.
      //
      // `response` IS NOT ALWAYS A STRING either. The guard model's post-processed output is
      // `{ safe?: boolean; categories?: string[] }` (same types file), and Workers AI parses a reply that is
      // JSON into an object. Typed as `string`, the object flowed out of here untouched and the first thing
      // that touched it called `.trim()` on it - a TypeError inside the call, recorded as a failed inference,
      // indistinguishable from the model being down. Serialised here so the port keeps its one return type and
      // the dialect stays a parsing question for whoever asked; `domain/moderation.ts parseVerdict` reads both.
      const res = out?.response ?? out?.choices?.[0]?.message?.content;
      if (res == null) return "";
      return typeof res === "string" ? res : JSON.stringify(res);
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
