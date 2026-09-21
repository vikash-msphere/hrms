/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { makeLocalTextModel } from "../src/lib/aiLocal";
import { makeLocalVectorIndex } from "../src/lib/vectorLocal";
import { drainSearchEmbeddings } from "../src/services/searchEmbed";
import { vectorIdOf } from "../src/lib/vector";
import { parseVerdict } from "../src/domain/moderation";
import { parseConduct } from "../src/domain/conduct";

// The AI layer against a model that actually answers, instead of a fake.
//
// WHAT THIS ADDS TO THE REST OF THE SUITE, which is narrower than "it tests the AI features" and worth being
// exact about. Every other AI test drives a fake, and a fake is a statement about the CALLER: it proves the
// drain reconciles, the budget stops spending, the parser rejects nonsense. What it cannot do is answer the
// two questions where the model is the subject rather than the fixture:
//
//   - do the embeddings DISCRIMINATE? A fake that returns `[text.length, checksum, 0.5]` satisfies every
//     assertion about the index while being useless for search, so nothing in the suite today would notice
//     if the query vector and the stored vectors came from incompatible models, or if the text handed to the
//     embedder was empty.
//   - does a generation come back in a shape the parser ACCEPTS? The strict parsers here (`parseVerdict`,
//     `coerceSpec`) were written against documentation, and a real model's habits - a code fence, a preamble,
//     a trailing sentence - are exactly what they have to survive.
//
// WHAT IT IS STILL NOT EVIDENCE OF. This runs against Ollama on the developer's machine, not Workers AI. It
// says nothing about whether `@cf/meta/llama-3.1-8b-instruct-fast` drafts usefully or whether
// `@cf/meta/llama-guard-3-8b` judges content correctly - the moderation case below deliberately asserts on
// the FORMAT of a verdict and never on the verdict itself. docs/04-testing.md has the full split of what a
// local run proves and what only the real service can answer.
//
// SKIPPED WHEN OLLAMA IS DOWN, because it is an optional dependency of this repository rather than part of
// the stack. So a green suite does not mean these ran: check the skip count.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const BASE = "http://127.0.0.1:11434";

/**
 * Which two models answer, and whether there is anything to answer with.
 *
 * CONFIGURED FIRST: `AI_LOCAL_CHAT_MODEL` / `AI_LOCAL_EMBED_MODEL` from `.dev.vars`, which is the same pair
 * `makeDeps` reads, so this file tests the models the dev stack actually uses.
 *
 * DISCOVERED SECOND, from Ollama's own inventory, and that fallback earns its keep rather than being clever.
 * Ollama names a model with its tag and the installed set differs per machine, so a default would be wrong
 * almost everywhere - and the failure mode of "wrong name" here is not a red test, it is a PERMANENT SKIP.
 * A test that quietly never runs is worse than one that picks a reasonable model and says which. The name
 * test is what distinguishes the two kinds: every embedding model on Ollama carries one of these markers and
 * no instruct model does.
 *
 * SMALLEST FIRST, AND THAT IS THE ORDERING RULE RATHER THAN A PREFERENCE. Taking the first candidate in
 * Ollama's own order picked a different model on two consecutive runs of this file - a 24 GB one, then a
 * 28 GB one - because that order is the server's, not ours. A test whose SUBJECT changes between runs is not
 * a stable test, and here the two choices were seconds apart in one run and past a two-minute timeout in the
 * next. Size is the honest tie-break: the job is to exercise the plumbing, a smaller model does it sooner,
 * and sorting makes the choice reproducible.
 *
 * The probe is given real time for the same reason. At two seconds, a server busy paging a 28 GB model into
 * memory answers nothing and is indistinguishable from a machine with no Ollama at all - so the file skipped
 * silently, which is exactly the "quietly never runs" outcome the discovery above exists to prevent.
 */
const [CHAT, EMBED, LIVE] = await (async () => {
  const none: [string, string, boolean] = ["", "", false];
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return none;
    const installed = (((await res.json()) as { models?: { name?: string; size?: number }[] }).models ?? [])
      .filter((m) => m.name)
      .sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    const names = installed.map((m) => m.name!);
    const isEmbed = (n: string): boolean => /embed|minilm|bge-|gte-|e5-/i.test(n);
    const pick = (want: string | undefined, fallback: () => string | undefined): string => {
      const named = want && names.find((n) => n === want || n.split(":")[0] === want.split(":")[0]);
      return named || fallback() || "";
    };
    const b2 = env as unknown as Record<string, string | undefined>;
    const chat = pick(b2.AI_LOCAL_CHAT_MODEL, () => names.find((n) => !isEmbed(n)));
    const embed = pick(b2.AI_LOCAL_EMBED_MODEL, () => names.find(isEmbed));
    if (!chat || !embed) return none;
    // Printed, because "which model answered" is the first thing to know when an assertion about a model's
    // output fails, and the only place it is recoverable from afterwards.
    console.log(`[aiLocalIntegration] chat=${chat} embed=${embed}`);
    return [chat, embed, true] as [string, string, boolean];
  } catch {
    return none;
  }
})();

let deps: Deps;
const b = env as unknown as Bindings;

/**
 * Per-test budget, against vitest's 5s default.
 *
 * A model on a laptop answers in seconds, not milliseconds, and a cold one has to be paged in first - so the
 * default turned every test here into a timeout that said nothing about the code. Generous rather than tuned:
 * the point of a ceiling in this file is to stop a wedged model hanging the suite, not to measure anything.
 */
const SLOW = 120_000;

beforeAll(async () => {
  if (!LIVE) return;
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
  deps.ai = makeLocalTextModel(BASE, { chat: CHAT, embed: EMBED });
  deps.vectors = makeLocalVectorIndex(deps.db);
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "search.semantic": true, moderation: true, "moderation.conduct": true } }) }).onConflictDoNothing();
});

beforeEach(async () => {
  if (!LIVE) return;
  await deps.db.delete(schema.searchVectors);
  await deps.db.delete(schema.aiUsage);
  await deps.db.delete(schema.aiCache);
  await deps.db.delete(schema.searchDocs);
  await deps.vectors?.remove([...await allVectorIds()]);
});

async function allVectorIds(): Promise<string[]> {
  const rows = await deps.db.select({ collection: schema.searchVectors.collection, recordId: schema.searchVectors.recordId }).from(schema.searchVectors);
  return rows.map((r) => vectorIdOf(r.collection, r.recordId));
}

const doc = (recordId: string, title: string, subtitle: string) => ({
  collection: "tickets",
  recordId,
  code: null,
  ownerId: null,
  title,
  subtitle,
  deleted: false,
  restricted: false,
  createdAt: new Date(),
});

describe.skipIf(!LIVE)("the embed drain against a real model", () => {
  it("fills the index with vectors of the model's own width", async () => {
    await deps.db.insert(schema.searchDocs).values([
      doc("t1", "Laptop overheating", "Reported from the Bangalore office"),
      doc("t2", "Cannot reset my password", "Locked out of the portal since Monday"),
    ]);

    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(2);

    const stored = await deps.vectors!.fetch([vectorIdOf("tickets", "t1"), vectorIdOf("tickets", "t2")]);
    expect(stored.size).toBe(2);
    // Not a fixed number: the width belongs to whichever model is configured, and pinning 384 here would fail
    // for anybody testing with `embeddinggemma`. What must hold is that it is a real embedding and that both
    // rows agree - two widths in one index is the failure that makes every later score meaningless.
    const widths = new Set([...stored.values()].map((v) => v.length));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBeGreaterThan(100);

    // And the ledger recorded the spend. With a fake this only ever proved the caller's arithmetic; here it
    // is a row per call that actually happened.
    const usage = await deps.db.select().from(schema.aiUsage);
    expect(usage.length).toBeGreaterThan(0);
  }, SLOW);

  it("spends nothing on a second tick over unchanged text", async () => {
    await deps.db.insert(schema.searchDocs).values([doc("t1", "Laptop overheating", "Reported from the Bangalore office")]);
    await drainSearchEmbeddings(deps);
    await deps.db.delete(schema.aiUsage);

    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(0);
    // The reconcile's whole economy: an unchanged row is CHECKED, not re-embedded. A regression here is
    // invisible in a fake-driven test right up until it spends a day's allowance re-embedding a static table.
    expect(await deps.db.select().from(schema.aiUsage)).toHaveLength(0);
  }, SLOW);
});

describe.skipIf(!LIVE)("embeddings that actually discriminate", () => {
  it("ranks the semantically closest row first, for a query sharing no words with it", async () => {
    // THE ASSERTION THE FAKES CANNOT MAKE. "my computer gets too hot" shares not one token with "Laptop
    // overheating", so the FTS half of global search finds nothing for it - which is the entire reason the
    // semantic half exists. If this passes, the embeddings carry meaning and the query vector is comparable
    // with the stored ones; if it fails, semantic search is decoration.
    await deps.db.insert(schema.searchDocs).values([
      doc("t1", "Laptop overheating", "The fan runs constantly and the case is hot to touch"),
      doc("t2", "Cannot reset my password", "Locked out of the portal since Monday"),
      doc("t3", "Expense claim rejected", "The receipt was attached but the claim came back"),
    ]);
    await drainSearchEmbeddings(deps);

    const [query] = await deps.ai!.embed(["my computer gets too hot"]);
    const hits = await deps.vectors!.query(query!, { topK: 3, collections: ["tickets"] });

    expect(hits[0]?.id).toBe(vectorIdOf("tickets", "t1"));
    // Ordered, not merely present: a list that contains the right answer third is a search result nobody
    // scrolls to.
    expect(hits.map((h) => h.id)).toHaveLength(3);
    expect(hits[0]!.score).toBeGreaterThan(hits[2]!.score);
  }, SLOW);

  it("keeps the collection pre-filter honest", async () => {
    await deps.db.insert(schema.searchDocs).values([doc("t1", "Laptop overheating", "hot to touch")]);
    await drainSearchEmbeddings(deps);

    const [query] = await deps.ai!.embed(["my computer gets too hot"]);
    // Asking about a collection the row is not in returns nothing, however close the text. This is a
    // pre-filter rather than an access decision - globalSearch re-decides every id in SQL - but a pre-filter
    // that leaked would fill topK with rows the re-check then discards, which is how semantic search quietly
    // returns an empty page for a scoped caller.
    expect(await deps.vectors!.query(query!, { topK: 5, collections: ["announcements"] })).toEqual([]);
  }, SLOW);
});

describe.skipIf(!LIVE)("generations come back in a shape the parsers accept", () => {
  it("answers the safety classifier's prompt in the format parseVerdict reads", async () => {
    // ON THE FORMAT, NEVER ON THE VERDICT. Llama Guard's judgement is not reproducible here and asserting on
    // it would make this test a claim about a model this app does not call. What IS testable is the thing
    // that actually broke once: a generative model answering the moderation prompt in prose, `parseVerdict`
    // correctly rejecting every word of it, and the feature flagging nothing at all while looking healthy.
    const raw = await deps.ai!.generate({
      system: "You judge whether a message posted on a company noticeboard is acceptable.",
      user: "The canteen is serving biryani on Friday, come early.",
      role: "moderate",
      maxTokens: 64,
    });
    expect(parseVerdict(raw)).not.toBeNull();
  }, SLOW);

  it("answers the conduct rubric in JSON rather than in prose", async () => {
    // ON THE FORMAT, NOT THE JUDGEMENT, for the same reason as the case above - with one difference worth
    // stating: the conduct pass DOES run on a general instruct model in production, so unlike Llama Guard
    // this local model is at least the same class of thing. It is still not the same model, so what is
    // asserted is the property the drain depends on: an answer `parseConduct` can read. A model that writes
    // "Sure! Here is my analysis" leaves every post unflagged and the queue looks healthy and empty.
    const { CONDUCT_SYSTEM } = await import("../src/services/moderation");
    for (const post of [
      "The canteen is serving biryani on Friday, come early.",
      "Bob in accounts is a useless idiot and everyone knows it.",
    ]) {
      const raw = await deps.ai!.generate({ system: CONDUCT_SYSTEM, user: post, maxTokens: 48 });
      expect(parseConduct(raw), `no parseable answer for: ${post}`).not.toBeNull();
    }
  }, SLOW);

  it("answers a constrained-JSON prompt with something the coercer can read", async () => {
    // The table assist's contract in miniature: ask for one JSON object, get keys back out. `coerceSpec`
    // tolerates a preamble and a code fence by slicing between the first `{` and the last `}`, which is a
    // tolerance written against documentation - this is the check that a real model's habits stay inside it.
    const { coerceSpec, systemFor } = await import("../src/services/tableAssist");
    const offered = [
      { key: "title", label: "Title", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "created_at", label: "Created", kind: "date" },
    ] as Parameters<typeof systemFor>[0];

    const raw = await deps.ai!.generate({
      system: systemFor(offered),
      user: "open tickets with their title and status, newest first",
      maxTokens: 400,
    });
    const { spec } = coerceSpec(raw, offered);
    expect(spec.columns.length).toBeGreaterThan(0);
    // Everything that survives coercion is a key the catalogue offered - which is the property that makes
    // this the safest place in the app to put a model, and it holds whatever the model invented.
    for (const c of spec.columns) expect(["title", "status", "created_at"]).toContain(c.field);
  }, SLOW);
});
