/// <reference types="vite/client" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertLoopback, cosine, makeLocalTextModel } from "../src/lib/aiLocal";

// lib/aiLocal.ts is a second transport for the AI layer, and the reason it needs its own tests is that it is
// the only place in the app where a DESTINATION for employee text comes out of configuration.
//
// Everywhere else the destination is fixed: lib/ai.ts calls a binding, and which model it may name is a
// closed allowlist in domain/aiPolicy.ts precisely because the binding would otherwise proxy external
// providers. A transport that takes a URL is the shape of thing that quietly re-opens that, so the loopback
// refusal below is the most important assertion in this file - not the happy paths.
//
// The rest is the two invariants the port carries: a batch of embeddings has to come back the same length it
// went in (pairing vector 3 with row 4 poisons the index in a way no later test can attribute), and rerank
// has to return INPUT INDICES in score order, because the caller maps them straight back onto its own rows.

const OK = { chat: "gemma3", embed: "all-minilm" };

afterEach(() => vi.unstubAllGlobals());

/** A `fetch` that answers Ollama's shapes, and records what it was asked. */
function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    seen.push({ url: String(url), body });
    return { ok: true, json: async () => handler(String(url), body) } as unknown as Response;
  });
  return seen;
}

describe("the local transport only talks to this machine", () => {
  // The whole point of the file. Each of these is a host somebody could plausibly write - a LAN box, a
  // tunnel, an "internal" name, a hosted endpoint that speaks the same API - and every one of them is
  // somebody else's computer receiving HR text.
  it.each([
    "http://192.168.1.50:11434",
    "http://ollama.internal:11434",
    "https://api.some-provider.com",
    "http://169.254.169.254",
  ])("refuses %s", (url) => {
    expect(() => assertLoopback(url)).toThrow(/must point at this machine/);
  });

  it.each(["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"])("allows %s", (url) => {
    expect(() => assertLoopback(url)).not.toThrow();
  });

  it("refuses a non-URL and a non-http scheme", () => {
    expect(() => assertLoopback("11434")).toThrow(/not a URL/);
    // `file:` and friends have no host to check, so the protocol gate has to come first or they would pass
    // the hostname test by having nothing to fail it with.
    expect(() => assertLoopback("file:///etc/passwd")).toThrow(/must be http or https/);
  });

  it("refuses at construction, not at first call", () => {
    // A transport that accepted the URL and failed later would be one that a feature nobody exercised in
    // testing could still reach on the day somebody turned it on.
    expect(() => makeLocalTextModel("https://api.some-provider.com", OK)).toThrow(/must point at this machine/);
  });
});

describe("embed", () => {
  it("returns one vector per input, in order", async () => {
    stubFetch((_u, b) => ({ embeddings: (b.input as string[]).map((t) => [t.length, 1]) }));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    expect(await model.embed(["a", "bbb"])).toEqual([[1, 1], [3, 1]]);
  });

  it("throws when the batch comes back short", async () => {
    // The same invariant lib/ai.ts keeps. A truncated batch is not a degraded answer - it is a misalignment,
    // and it would be written into the index as row 4's vector belonging to row 3.
    stubFetch(() => ({ embeddings: [[1, 1]] }));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    await expect(model.embed(["a", "b", "c"])).rejects.toThrow(/returned 1 vectors for 3 inputs/);
  });

  it("calls nothing for an empty batch", async () => {
    const seen = stubFetch(() => ({ embeddings: [] }));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    expect(await model.embed([])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("generate", () => {
  it("sends the caller's system prompt unchanged for the default role", async () => {
    const seen = stubFetch(() => ({ message: { content: "drafted" } }));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    expect(await model.generate({ system: "be brief", user: "hello" })).toBe("drafted");
    expect((seen[0]?.body.messages as { content: string }[])[0]?.content).toBe("be brief");
  });

  it("demands Llama Guard's answer format for the moderate role", async () => {
    // Production reaches a model FINE-TUNED to answer `safe` / `unsafe` + codes; a general instruct model
    // asked the same question writes a paragraph and `parseVerdict` correctly rejects all of it. That is not
    // hypothetical - it is the bug that shipped when moderation called the instruct model by mistake - so the
    // local shim has to ask for the format explicitly or the whole moderation path is untestable here.
    const seen = stubFetch(() => ({ message: { content: "safe" } }));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    await model.generate({ system: "judge this", user: "a post", role: "moderate" });
    const system = (seen[0]?.body.messages as { content: string }[])[0]?.content ?? "";
    expect(system).toContain("judge this");
    expect(system).toContain("`unsafe` on its own line");
  });

  it("turns the model's own reasoning off", async () => {
    // NOT A DETAIL. Local models increasingly reason before answering, and the reasoning is GENERATED, so it
    // spends `num_predict`. Against the model this was written on, the moderation prompt at its usual 64-token
    // budget produced 58 tokens of deliberation and an empty answer - which `parseVerdict` reads as nothing,
    // and nothing is indistinguishable from "the model found this post acceptable". Every call site sizes
    // `maxTokens` for an ANSWER because neither production model reasons.
    const seen = stubFetch(() => ({ message: { content: "ok" } }));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    await model.generate({ system: "s", user: "u" });
    expect(seen[0]?.body.think).toBe(false);
  });

  it("retries without the flag for a model that cannot think, and only for that", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 400, text: async () => "model does not support thinking" } as unknown as Response;
      return { ok: true, json: async () => ({ message: { content: "answered" } }) } as unknown as Response;
    });
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    expect(await model.generate({ system: "s", user: "u" })).toBe("answered");
    expect(calls).toBe(2);

    // A blanket retry would turn "model not found" into two identical requests and an error naming the wrong
    // cause, so anything that is not the thinking refusal is rethrown on the first attempt.
    let other = 0;
    vi.stubGlobal("fetch", async () => {
      other++;
      return { ok: false, status: 404, text: async () => "model 'nope' not found" } as unknown as Response;
    });
    await expect(model.generate({ system: "s", user: "u" })).rejects.toThrow(/not found/);
    expect(other).toBe(1);
  });

  it("answers empty rather than throwing when the response has no content", async () => {
    stubFetch(() => ({}));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    expect(await model.generate({ system: "s", user: "u" })).toBe("");
  });
});

describe("rerank", () => {
  it("returns input indices, best first", async () => {
    // The contract that has actually been got wrong before: the caller maps these numbers straight back onto
    // its own array, so returning positions in the SORTED order rather than the input order silently reorders
    // somebody's search results.
    stubFetch((_u, b) => {
      const vectors: Record<string, number[]> = { q: [1, 0], far: [0, 1], near: [0.9, 0.1], mid: [0.5, 0.5] };
      return { embeddings: (b.input as string[]).map((t) => vectors[t] ?? [0, 0]) };
    });
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    const out = await model.rerank("q", ["far", "near", "mid"]);
    expect(out.map((r) => r.index)).toEqual([1, 2, 0]);
  });

  it("calls nothing for no candidates", async () => {
    const seen = stubFetch(() => ({ embeddings: [] }));
    const model = makeLocalTextModel("http://127.0.0.1:11434", OK);
    expect(await model.rerank("q", [])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("cosine", () => {
  it("is 1 for identical, 0 for orthogonal, and 0 rather than NaN for a zero vector", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    // One degenerate embedding must not make the whole sort incomparable, which NaN would.
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
