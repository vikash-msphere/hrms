// A `TextModel` that answers from a model running on this machine, so the AI layer can be exercised without
// calling Workers AI. Development and the browser suite only.
//
// WHY THIS FILE HAS TO EXIST. Neither AI dependency can be emulated by the platform, which is easy to assume
// and wrong in both directions:
//
//   - `wrangler dev` honours `[ai]` from wrangler.toml and proxies it to the real service. Its own log says
//     "AI bindings always access remote resources, and so may incur usage charges even in local dev".
//   - Miniflare's Vectorize plugin has no local implementation at all - it builds a remote proxy client and
//     nothing else.
//
// So before this existed, "testing locally" meant spending the account's daily neuron allowance and writing
// into the production index, with no configuration that changed it. That is not a theoretical cost: the first
// version of e2e/aiFeatures.spec.ts turned a feature on, pressed the button, and made real inference calls
// on every run of the browser suite.
//
// THE EGRESS GUARD IS THE POINT OF THE FILE, not a precaution around it. domain/aiPolicy.ts keeps a model
// allowlist because the `AI` binding will proxy EXTERNAL providers given a provider-prefixed id, and sending
// employee data to a party with no contract with us is the one thing this layer must never do. A second
// transport that took a URL from configuration would be a way around that allowlist wearing a friendly name.
// `assertLoopback` refuses anything that is not this machine, at construction, by throwing - so the set of
// destinations this file can reach is closed, and it is closed by the code rather than by whoever writes the
// config. scripts/preflight.ts refuses a deploy that sets the var at all, which is the second line, not the
// first.
//
// WHAT A GREEN LOCAL RUN IS EVIDENCE OF, stated here because the answer is narrower than it looks. It proves
// the plumbing: feature gates, budget accounting, cache hits, prompt construction, output parsing, every
// fallback path, the drains. It proves NOTHING about how the production models behave - a different model
// answering a different way is exactly the bug that made moderation flag nothing at all (see the `role` note
// in ports/index.ts). docs/04-testing.md has the full split.
import type { GenerativeRole, TextModel } from "../ports";

/** Which local models answer. Both are ordinary Ollama model names - there is no allowlist here, because the
 *  allowlist's job is to bound the DESTINATION, and `assertLoopback` already bounds it to this machine. */
export type LocalModels = { chat: string; embed: string };

/**
 * How long one local call may take before it is abandoned.
 *
 * Generous, because a model on a laptop with a cold cache is slow in a way the hosted one is not, and a
 * timeout that fires on a first-token wait would read as "the feature is broken". Still bounded: a Worker
 * invocation has its own ceiling (wrangler.toml `[limits]`), and a fetch with no timeout would spend it.
 */
const TIMEOUT_MS = 120_000;

/**
 * Refuse any destination that is not this machine.
 *
 * Loopback by HOSTNAME, and deliberately not by "is it private" or "is it in a range we trust". A host that
 * resolves elsewhere, a LAN address, a tunnel: all of them are somebody else's computer, and the difference
 * between this shim and an unbounded egress channel is exactly that this list is three entries long.
 */
export function assertLoopback(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`AI_LOCAL_URL is not a URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`AI_LOCAL_URL must be http or https, got ${url.protocol}`);
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error(
      `AI_LOCAL_URL must point at this machine (127.0.0.1, localhost or ::1), got ${url.hostname}. ` +
      "This transport exists to keep local testing off Workers AI, not to become a second way to send " +
      "employee data somewhere the model allowlist in domain/aiPolicy.ts does not cover.",
    );
  }
  return url;
}

export function makeLocalTextModel(baseUrl: string, models: LocalModels): TextModel {
  const base = assertLoopback(baseUrl);
  const at = (path: string): string => new URL(path, base).toString();

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(at(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // The body carries Ollama's own message ("model 'x' not found, try pulling it first"), which is the
      // single most useful thing to see here and is lost if this throws a generic status error.
      throw new Error(`local model ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Chat, with reasoning turned off.
   *
   * WHY `think: false` IS NOT OPTIONAL HERE. Many current local models reason before answering, and the
   * reasoning is generated - so it spends `num_predict`. Asked the moderation prompt with a 64-token budget,
   * the model on the machine this was written against produced 58 tokens of deliberation and an EMPTY
   * `content`; `parseVerdict` then saw "" and the feature flagged nothing, which looks exactly like a model
   * that found the post acceptable. `maxTokens` at every call site is sized for an ANSWER, because neither
   * production model reasons, so a local model that does silently means something different by it.
   *
   * Ollama refuses the flag for models that cannot think, so a 400 mentioning it retries without. Anything
   * else is a real failure and is rethrown - a blanket retry would turn "model not found" into two identical
   * requests and a confusing error.
   */
  async function chat(body: Record<string, unknown>): Promise<{ message?: { content?: string } }> {
    try {
      return await post<{ message?: { content?: string } }>("/api/chat", { ...body, think: false });
    } catch (e) {
      if (!/\b400\b/.test(String(e)) || !/think/i.test(String(e))) throw e;
      return post<{ message?: { content?: string } }>("/api/chat", body);
    }
  }

  async function embedAll(texts: string[]): Promise<number[][]> {
    const out = await post<{ embeddings?: number[][] }>("/api/embed", { model: models.embed, input: texts });
    // The same invariant lib/ai.ts enforces, for the same reason: a short batch means the input was silently
    // truncated, and pairing vector 3 with row 4 poisons the index in a way no later test can attribute.
    if (!out?.embeddings || out.embeddings.length !== texts.length) {
      throw new Error(`local embed returned ${out?.embeddings?.length ?? 0} vectors for ${texts.length} inputs`);
    }
    return out.embeddings;
  }

  return {
    async embed(texts) {
      if (texts.length === 0) return [];
      return embedAll(texts);
    },

    async generate({ system, user, maxTokens, role }) {
      const out = await chat({
        model: models.chat,
        messages: [
          { role: "system", content: systemFor(system, role) },
          { role: "user", content: user },
        ],
        stream: false,
        // The same temperature lib/ai.ts sends, so a draft reads about as machine-like here as it will there.
        options: { temperature: 0.3, num_predict: maxTokens ?? 512 },
      });
      return out?.message?.content ?? "";
    },

    async rerank(query, candidates) {
      if (candidates.length === 0) return [];
      // Ollama serves no reranker, so this is cosine over the same embedding model rather than a cross-encoder
      // like `@cf/baai/bge-reranker-base`. It satisfies the port - indices, best first - and it is honestly
      // weaker: a bi-encoder cannot see the query and the candidate together, which is the whole reason a
      // reranker is a second stage. Good enough to prove the caller wires the indices back to the right rows,
      // which is what rerank has actually got wrong before.
      const vectors = await embedAll([query, ...candidates]);
      const q = vectors[0] ?? [];
      return vectors.slice(1)
        .map((v, index) => ({ index, score: cosine(q, v) }))
        .sort((a, b) => b.score - a.score);
    },
  };
}

/**
 * The system prompt actually sent, which for the safety classifier is not the one the caller wrote.
 *
 * `role: "moderate"` reaches `@cf/meta/llama-guard-3-8b` in production - a model FINE-TUNED to answer `safe`,
 * or `unsafe` followed by a line of hazard codes, and nothing else. A general instruct model asked the same
 * question writes a paragraph, `parseVerdict` (domain/moderation.ts) correctly rejects it, and the feature
 * flags nothing. That is not hypothetical either: it is the bug that shipped when moderation called the
 * instruct model by mistake.
 *
 * So the format is demanded in the prompt here. Be clear about what that buys: it lets the drain, the parser,
 * the flag rows and the queue page be exercised locally. It is NOT evidence that this model judges content the
 * way Llama Guard does, and a local pass must never be read as moderation having been validated.
 */
function systemFor(system: string, role?: GenerativeRole): string {
  if (role !== "moderate") return system;
  return [
    system,
    "",
    "ANSWER FORMAT, which is not optional:",
    "Reply with the single word `safe`, or with `unsafe` on its own line followed by one line of",
    "comma-separated hazard codes (S1 to S13). No explanation, no apology, no other text.",
  ].join("\n");
}

/** Cosine similarity. Zero for a zero-length vector rather than NaN, so one degenerate embedding cannot make
 *  the whole sort incomparable. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
