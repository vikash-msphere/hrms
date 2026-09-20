/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeTextModel } from "../src/lib/ai";
import { makeLocalTextModel } from "../src/lib/aiLocal";
import { makeVectorIndex } from "../src/lib/vector";
import { makeLocalVectorIndex } from "../src/lib/vectorLocal";
import { MODELS } from "../src/domain/aiPolicy";

// TWO IMPLEMENTATIONS OF EACH AI PORT, HELD AGAINST EACH OTHER.
//
// `lib/ai.ts` + `lib/vector.ts` talk to Workers AI and Vectorize; `lib/aiLocal.ts` + `lib/vectorLocal.ts` talk
// to a model on the developer's machine and to D1. A local run is only worth anything if the thing it
// exercises behaves like the thing it stands in for, and nothing made that true: both pairs stated their
// shared constants in prose, on each side, in comments that had to be kept honest by hand.
//
// They were not kept honest. `aiLocal.ts` carried "the same temperature lib/ai.ts sends" for months after that
// file started sending a different one for the safety classifier - a sampled verdict where production is
// deterministic, which is exactly the kind of difference that makes a local pass mean less than it looks.
// The vector pair had it worse: `vectorLocal.ts` aliased a column to `values`, a reserved word SQLite refuses,
// so every read of the local index threw and every caller swallowed it as "nothing found". Its own integration
// test is `skipIf(!LIVE)` and skips without a running Ollama, so nothing ran it.
//
// WHAT IS ASSERTED HERE is the CONTRACT, not the wire: each transport is driven through a fake of its own
// backend and the two answers are compared. Where the spelling differs (`max_tokens` against `num_predict`)
// the test knows both and compares the VALUE - that is the point, since a constant agreeing in two spellings
// is precisely what no comment can enforce.
//
// WHAT IS NOT ASSERTED, so nobody reads more into a green run than is there: that the models answer alike.
// A local model is not Llama Guard and this cannot make it one (see lib/aiLocal.ts). Plumbing only.

const b = env as unknown as Bindings;
const db = drizzle(b.DB, { schema });

// ---- the text port ---------------------------------------------------------------------------------------

/** The Workers AI binding, as a fake that records what it was asked. */
function fakeBinding(reply: (model: string, input: Record<string, unknown>) => unknown) {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const binding = {
    run: async (model: string, input: Record<string, unknown>) => {
      calls.push({ model, input });
      return reply(model, input);
    },
  };
  return { binding: binding as unknown as Ai, calls };
}

/** The local model's HTTP endpoint, as a `fetch` stub that records what it was posted. */
function fakeOllama(reply: (path: string, body: Record<string, unknown>) => unknown) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: url.pathname, body });
    return new Response(JSON.stringify(reply(url.pathname, body)), { headers: { "content-type": "application/json" } });
  });
  return calls;
}

const LOCAL_URL = "http://127.0.0.1:11434";
const LOCAL_MODELS = { chat: "gemma3", embed: "all-minilm" };

afterEach(() => vi.unstubAllGlobals());

describe("the two text transports", () => {
  it("both shortcut an empty batch without calling anything", async () => {
    const { binding, calls } = fakeBinding(() => ({ data: [] }));
    const localCalls = fakeOllama(() => ({ embeddings: [] }));

    expect(await makeTextModel(binding).embed([])).toEqual([]);
    expect(await makeLocalTextModel(LOCAL_URL, LOCAL_MODELS).embed([])).toEqual([]);
    expect(await makeTextModel(binding).rerank("q", [])).toEqual([]);
    expect(await makeLocalTextModel(LOCAL_URL, LOCAL_MODELS).rerank("q", [])).toEqual([]);
    // The saving is the whole reason the shortcut exists: an empty batch must cost no subrequest and no neuron.
    expect(calls).toHaveLength(0);
    expect(localCalls).toHaveLength(0);
  });

  it("both refuse a short batch rather than pairing vector 3 with row 4", async () => {
    // A transport that returns fewer vectors than it was given has truncated the batch somewhere, and silently
    // accepting it misaligns the index in a way no later test can attribute to this.
    const { binding } = fakeBinding(() => ({ data: [[0.1]] }));
    fakeOllama(() => ({ embeddings: [[0.1]] }));

    await expect(makeTextModel(binding).embed(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
    await expect(makeLocalTextModel(LOCAL_URL, LOCAL_MODELS).embed(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("send the SAME temperature for the same role, in their own spellings", async () => {
    const { binding, calls } = fakeBinding(() => ({ response: "ok" }));
    const localCalls = fakeOllama(() => ({ message: { content: "ok" } }));
    const hosted = makeTextModel(binding);
    const local = makeLocalTextModel(LOCAL_URL, LOCAL_MODELS);

    for (const role of ["generate", "moderate"] as const) {
      await hosted.generate({ system: "s", user: "u", role });
      await local.generate({ system: "s", user: "u", role });
      const sent = calls.at(-1)!.input.temperature;
      const sentLocal = (localCalls.at(-1)!.body.options as { temperature: number }).temperature;
      expect(sentLocal, `${role}: the two transports disagree about temperature`).toBe(sent);
    }
    // ...and the classifier's is ZERO on both. A verdict that can come out differently on two reads of the same
    // text is not a classification, and `aiGenerate` caches whichever way it fell for a week.
    expect(calls.at(-1)!.input.temperature).toBe(0);
  });

  it("agree on the token ceiling, default and explicit", async () => {
    const { binding, calls } = fakeBinding(() => ({ response: "ok" }));
    const localCalls = fakeOllama(() => ({ message: { content: "ok" } }));

    await makeTextModel(binding).generate({ system: "s", user: "u" });
    await makeLocalTextModel(LOCAL_URL, LOCAL_MODELS).generate({ system: "s", user: "u" });
    expect((localCalls.at(-1)!.body.options as { num_predict: number }).num_predict).toBe(calls.at(-1)!.input.max_tokens);

    await makeTextModel(binding).generate({ system: "s", user: "u", maxTokens: 32 });
    await makeLocalTextModel(LOCAL_URL, LOCAL_MODELS).generate({ system: "s", user: "u", maxTokens: 32 });
    expect(calls.at(-1)!.input.max_tokens).toBe(32);
    expect((localCalls.at(-1)!.body.options as { num_predict: number }).num_predict).toBe(32);
  });

  it("both carry the caller's prompt as system + user, in that order", async () => {
    const { binding, calls } = fakeBinding(() => ({ response: "ok" }));
    const localCalls = fakeOllama(() => ({ message: { content: "ok" } }));

    await makeTextModel(binding).generate({ system: "SYS", user: "USR" });
    await makeLocalTextModel(LOCAL_URL, LOCAL_MODELS).generate({ system: "SYS", user: "USR" });

    const hostedMsgs = calls.at(-1)!.input.messages as { role: string; content: string }[];
    const localMsgs = localCalls.at(-1)!.body.messages as { role: string; content: string }[];
    expect(hostedMsgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(localMsgs.map((m) => m.role)).toEqual(["system", "user"]);
    // The USER half must travel verbatim on both: it is the fenced, scrubbed payload services/ai.ts built, and
    // a transport that reshapes it is one where the fence stops meaning what the preamble says it means.
    expect(hostedMsgs[1]!.content).toBe("USR");
    expect(localMsgs[1]!.content).toBe("USR");
    // The SYSTEM half is the one legitimate difference, and it is one-way: the local lane appends the answer
    // format Llama Guard is fine-tuned for and a general instruct model is not (lib/aiLocal.ts systemFor).
    expect(hostedMsgs[0]!.content).toBe("SYS");
    expect(localMsgs[0]!.content).toBe("SYS");
  });

  it("both return indices into the candidate list, best first", async () => {
    // `rerank` hands back positions, not strings, and a transport that returns its own ordering without the
    // indices would have the caller score the wrong rows. Production reads them off the response; the local
    // lane derives them from cosine over the embedding model.
    const { binding } = fakeBinding((model) =>
      model === MODELS.rerank ? { response: [{ id: 2, score: 0.9 }, { id: 0, score: 0.4 }] } : { data: [] });
    fakeOllama((_p, body) => {
      // query, then the three candidates: the third is the one pointing the same way as the query.
      const inputs = (body.input as string[]) ?? [];
      const vector = (t: string) => (t === "q" || t === "c3" ? [1, 0] : t === "c2" ? [0.2, 1] : [0, 1]);
      return { embeddings: inputs.map(vector) };
    });

    const hosted = await makeTextModel(binding).rerank("q", ["c1", "c2", "c3"]);
    const local = await makeLocalTextModel(LOCAL_URL, LOCAL_MODELS).rerank("q", ["c1", "c2", "c3"]);

    for (const out of [hosted, local]) {
      expect(out.length).toBeGreaterThan(0);
      for (const r of out) expect(r.index).toBeGreaterThanOrEqual(0);
      for (const r of out) expect(r.index).toBeLessThan(3);
      expect([...out].sort((a, b) => b.score - a.score).map((r) => r.index)).toEqual(out.map((r) => r.index));
    }
    expect(local[0]!.index).toBe(2); // the candidate the query actually points at
  });
});

// ---- the vector port -------------------------------------------------------------------------------------

/** The Vectorize index, as a fake over a Map. */
function fakeVectorize() {
  const store = new Map<string, { id: string; values: number[]; metadata?: { collection?: string } }>();
  const calls: string[] = [];
  const index = {
    async upsert(vectors: { id: string; values: number[]; metadata?: { collection?: string } }[]) {
      calls.push("upsert");
      for (const v of vectors) store.set(v.id, v);
    },
    async query(_vector: number[], opts: { topK: number; filter?: { collection?: { $in?: string[] } } }) {
      calls.push("query");
      const wanted = opts.filter?.collection?.$in ?? [];
      const matches = [...store.values()]
        .filter((v) => wanted.includes(v.metadata?.collection ?? ""))
        .map((v, i) => ({ id: v.id, score: 1 - i / 100 }))
        .slice(0, opts.topK);
      return { matches };
    },
    async getByIds(ids: string[]) {
      calls.push("getByIds");
      return ids.map((id) => store.get(id)).filter(Boolean) as { id: string; values: number[] }[];
    },
    async deleteByIds(ids: string[]) {
      calls.push("deleteByIds");
      for (const id of ids) store.delete(id);
    },
  };
  return { index: index as unknown as VectorizeIndex, calls };
}

describe("the two vector transports", () => {
  it("both no-op on an empty input without touching the backend", async () => {
    const { index, calls } = fakeVectorize();
    const hosted = makeVectorIndex(index);
    const local = makeLocalVectorIndex(db);

    for (const store of [hosted, local]) {
      await store.upsert([]);
      await store.remove([]);
      expect(await store.fetch([])).toEqual(new Map());
      expect(await store.query([1, 0], { topK: 5, collections: [] })).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it("both round-trip an upsert and answer within the collection pre-filter", async () => {
    const { index } = fakeVectorize();
    const hosted = makeVectorIndex(index);
    const local = makeLocalVectorIndex(db);
    const rows = [
      { id: "tickets:t1", values: [1, 0], collection: "tickets" },
      { id: "suggestions:s1", values: [0, 1], collection: "suggestions" },
    ];

    for (const store of [hosted, local]) {
      await store.upsert(rows);
      const hits = await store.query([1, 0], { topK: 10, collections: ["tickets"] });
      // The pre-filter is not an access decision (both headers say so) but it must still BE a filter: a store
      // that ignored it would fill topK with rows the SQL re-check throws away.
      expect(hits.map((h) => h.id)).toEqual(["tickets:t1"]);
      expect(await store.query([0, 1], { topK: 10, collections: ["announcements"] })).toEqual([]);
    }
  });

  it("both leave an id the drain has not reached out of `fetch`, rather than erroring", async () => {
    const { index } = fakeVectorize();
    const hosted = makeVectorIndex(index);
    const local = makeLocalVectorIndex(db);

    for (const store of [hosted, local]) {
      await store.upsert([{ id: "tickets:known", values: [0.5, 0.5], collection: "tickets" }]);
      const got = await store.fetch(["tickets:known", "tickets:missing"]);
      expect(got.get("tickets:known")).toEqual([0.5, 0.5]);
      expect(got.has("tickets:missing")).toBe(false);
    }
  });

  it("both drop what `remove` names", async () => {
    const { index } = fakeVectorize();
    const hosted = makeVectorIndex(index);
    const local = makeLocalVectorIndex(db);

    for (const store of [hosted, local]) {
      await store.upsert([{ id: "tickets:gone", values: [1, 0], collection: "tickets" }]);
      await store.remove(["tickets:gone"]);
      expect(await store.fetch(["tickets:gone"])).toEqual(new Map());
      expect(await store.query([1, 0], { topK: 5, collections: ["tickets"] })).toEqual([]);
    }
  });

  it("both hold topK to the ceiling Vectorize enforces", async () => {
    // 100 is the real index's cap. The local one matches it so a local run cannot pass on a topK production
    // would clamp - the asymmetry that would let a caller ask for 500 neighbours and get them only in dev.
    const { index } = fakeVectorize();
    const hosted = makeVectorIndex(index);
    const local = makeLocalVectorIndex(db);
    const rows = Array.from({ length: 150 }, (_, i) => ({ id: `tickets:t${i}`, values: [1, 0], collection: "tickets" }));

    for (const store of [hosted, local]) {
      await store.upsert(rows);
      expect((await store.query([1, 0], { topK: 500, collections: ["tickets"] })).length).toBe(100);
    }
  });
});
