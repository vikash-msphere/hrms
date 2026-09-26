/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import type { TextModel, VectorIndex } from "../src/ports";
import { drainSearchEmbeddings, embedText } from "../src/services/searchEmbed";
import { vectorIdOf } from "../src/lib/vector";
import { MODELS, BUDGET } from "../src/domain/aiPolicy";

// The embed drain is a RECONCILIATION, not a notification: `search_docs` is maintained by SQL triggers, so
// nothing can tell the app a row changed. Everything below is a statement about convergence - after a tick,
// the index holds exactly the indexable, visible rows, whatever state it was in before.
//
// The two that matter most for privacy rather than correctness:
//   - a row that becomes `deleted` or `restricted` is REMOVED from the index, not merely left unrefreshed;
//   - a collection taken out of INDEXABLE has its existing entries removed, because revoking a collection
//     has to actually revoke what is already embedded.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

/** In-memory Vectorize, so the drain's effects are inspectable as a plain map. */
function fakeIndex(): VectorIndex & { store: Map<string, { values: number[]; collection: string }>; fail: boolean } {
  const f = {
    store: new Map<string, { values: number[]; collection: string }>(),
    fail: false,
    async upsert(vectors: { id: string; values: number[]; collection: string }[]) {
      if (f.fail) throw new Error("index down");
      for (const v of vectors) f.store.set(v.id, { values: v.values, collection: v.collection });
    },
    async query() {
      return [];
    },
    async fetch(ids: string[]) {
      const out = new Map<string, number[]>();
      for (const id of ids) {
        const v = f.store.get(id);
        if (v) out.set(id, v.values);
      }
      return out;
    },
    async remove(ids: string[]) {
      if (f.fail) throw new Error("index down");
      for (const id of ids) f.store.delete(id);
    },
  };
  return f;
}

function fakeModel(): TextModel & { calls: number; fail: boolean; texts: string[] } {
  const f = {
    calls: 0,
    fail: false,
    texts: [] as string[], // every text sent to the model, in order
    async embed(texts: string[]) {
      f.calls++;
      if (f.fail) throw new Error("model down");
      f.texts.push(...texts);
      return texts.map((t) => [t.length, [...t].reduce((n, c) => n + c.charCodeAt(0), 0) % 97, 0.5]);
    },
    async generate() { return ""; },
    async rerank() { return []; },
  };
  return f;
}

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
  // Semantic search defaults to OFF for the org, so the drain would no-op without this. Turning it on here
  // rather than in `beforeEach` because the setting is org state, not per-test state.
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "search.semantic": true } }) }).onConflictDoNothing();
});

beforeEach(async () => {
  await deps.db.delete(schema.searchVectors);
  await deps.db.delete(schema.aiUsage);
  // `search_docs` is trigger-maintained in production; here it is written directly, which is what lets a test
  // put the table in a state (deleted, restricted, orphaned) without driving a whole service to get there.
  await deps.db.delete(schema.searchDocs);
  deps.ai = fakeModel();
  deps.vectors = fakeIndex();
});

const doc = (over: Partial<typeof schema.searchDocs.$inferInsert> = {}) => ({
  collection: "tickets",
  recordId: `rec-${Math.random().toString(36).slice(2, 10)}`,
  code: null,
  ownerId: null,
  title: "Laptop overheating",
  subtitle: "Reported from the Bangalore office",
  deleted: false,
  restricted: false,
  createdAt: new Date(),
  ...over,
});

const index = () => (deps.vectors as ReturnType<typeof fakeIndex>).store;
const model = () => deps.ai as ReturnType<typeof fakeModel>;

describe("no bindings", () => {
  it("no-ops rather than failing the tick", async () => {
    const out = await drainSearchEmbeddings({ ...deps, ai: undefined, vectors: undefined });
    expect(out.embedded).toBe(0);
    expect(out.skipped).toBeTruthy();
  });
});

describe("the org switch gates indexing, not just searching", () => {
  it("embeds nothing while semantic search is off", async () => {
    // Otherwise the opt-in would be in name only: the text would already be through a model and sitting in a
    // vector store by the time anyone decided it could be.
    await deps.db.update(schema.settings).set({ value: JSON.stringify({ features: { "search.semantic": false } }) }).where(eq(schema.settings.key, "ai"));
    try {
      await deps.db.insert(schema.searchDocs).values(doc());
      const out = await drainSearchEmbeddings(deps);
      expect(out.embedded).toBe(0);
      expect(index().size).toBe(0);
      expect(await deps.db.select().from(schema.searchVectors)).toEqual([]);
    } finally {
      await deps.db.update(schema.settings).set({ value: JSON.stringify({ features: { "search.semantic": true } }) }).where(eq(schema.settings.key, "ai"));
    }
  });
});

describe("embedding what changed", () => {
  it("embeds a new row and records what it embedded", async () => {
    const row = doc();
    await deps.db.insert(schema.searchDocs).values(row);

    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(1);
    expect(index().has(vectorIdOf("tickets", row.recordId))).toBe(true);

    const [book] = await deps.db.select().from(schema.searchVectors);
    expect(book!.collection).toBe("tickets");
    expect(book!.recordId).toBe(row.recordId);
    expect(book!.model).toBe(MODELS.embed);
  });

  it("does nothing on a second tick when nothing changed", async () => {
    await deps.db.insert(schema.searchDocs).values(doc());
    await drainSearchEmbeddings(deps);
    const after = model().calls;

    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(0);
    expect(model().calls).toBe(after); // not called again
  });

  it("re-embeds when the text changes", async () => {
    const row = doc();
    await deps.db.insert(schema.searchDocs).values(row);
    await drainSearchEmbeddings(deps);
    const first = index().get(vectorIdOf("tickets", row.recordId))!.values;

    await deps.db.update(schema.searchDocs).set({ title: "Laptop will not charge" }).where(eq(schema.searchDocs.recordId, row.recordId));
    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(1);
    expect(index().get(vectorIdOf("tickets", row.recordId))!.values).not.toEqual(first);
  });

  it("skips a row with no title, whatever its subtitle says", async () => {
    // The seeded kudos posts: no title, subtitle `kudos`. Embedded, every one of them got the same one-word
    // vector, and that cluster sat near almost any short query.
    await deps.db.insert(schema.searchDocs).values(doc({ collection: "announcements", title: null, subtitle: "kudos" }));
    await deps.db.insert(schema.searchDocs).values(doc({ title: null, subtitle: null }));
    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(0);
    expect(index().size).toBe(0);
  });

  it("untitled rows do not starve the window", async () => {
    // They are never-embedded, so they sort to the front of every tick. Skipped in JS rather than excluded in
    // SQL, enough of them would fill the window with work that can never complete and the titled rows behind
    // them would never be reached.
    for (let i = 0; i < BUDGET.embedsPerDrain; i++) {
      await deps.db.insert(schema.searchDocs).values(doc({ title: null, subtitle: "kudos" }));
    }
    const real = doc({ title: "A ticket with an actual subject" });
    await deps.db.insert(schema.searchDocs).values(real);

    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(1);
    expect(index().has(vectorIdOf("tickets", real.recordId))).toBe(true);
  });

  it("embeds the collection's noun, except for the collections whose vectors are compared to each other", async () => {
    const asset = doc({ collection: "assets", title: "MacBook Pro 14", subtitle: "LAP-0012" });
    const holiday = doc({ collection: "holidays", title: "Diwali", subtitle: "fixed" });
    const ticket = doc();
    for (const r of [asset, holiday, ticket]) await deps.db.insert(schema.searchDocs).values(r);

    await drainSearchEmbeddings(deps);
    expect(model().texts.sort()).toEqual([
      "Asset: MacBook Pro 14 - LAP-0012",
      "Holiday: Diwali", // a holiday's subtitle is only its kind
      "Laptop overheating - Reported from the Bangalore office", // tickets keep the text triage was tuned on
    ]);
  });

  it("never embeds a collection that is not opted in", async () => {
    // `leave-requests` is on the denylist: the reason on a leave request is a sick note as often as not.
    await deps.db.insert(schema.searchDocs).values(doc({ collection: "leave-requests", title: "Surgery, two weeks" }));
    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(0);
    expect(index().size).toBe(0);
  });
});

describe("the sweep makes progress across ticks", () => {
  it("indexes a corpus larger than one tick's window, a tick at a time", async () => {
    // The regression this pins. The window used to be taken with no ORDER BY and filtered afterwards, so once
    // it filled with already-current rows the drain stopped making progress - and did so silently, looking
    // exactly like "nothing to do". A database bigger than the window would have been mostly unindexed.
    const rows = Array.from({ length: BUDGET.embedsPerDrain + 5 }, (_, i) => doc({ title: `Ticket number ${i}` }));
    for (const r of rows) await deps.db.insert(schema.searchDocs).values(r);

    const first = await drainSearchEmbeddings(deps);
    expect(first.embedded).toBe(BUDGET.embedsPerDrain);

    // The second tick must reach the rows the first could not, rather than re-examining the same window.
    const second = await drainSearchEmbeddings(deps);
    expect(second.embedded).toBe(5);
    expect(index().size).toBe(rows.length);

    // And a third settles: everything is current.
    expect((await drainSearchEmbeddings(deps)).embedded).toBe(0);
  });

  it("stamps every row it examined, so the rotation actually advances", async () => {
    // The rotation only works if `checkedAt` moves. It is stamped best-effort, so a stamp that fails leaves
    // the sweep re-examining the same rows forever - and says nothing. That is precisely what happened: the
    // stamp bound one parameter per id, the window is 200, and D1 caps a statement near 100, so it threw on
    // every realistic tick while the suite stayed green. Asserting on the stamp rather than on the drain's
    // return value is the difference between catching that and not.
    const rows = Array.from({ length: BUDGET.embedsPerDrain }, (_, i) => doc({ title: `Ticket number ${i}` }));
    for (const r of rows) await deps.db.insert(schema.searchDocs).values(r);
    await drainSearchEmbeddings(deps);

    const first = await deps.db.select().from(schema.searchVectors);
    expect(first.length).toBe(rows.length);
    const stampedAt = first.map((v) => +v.checkedAt);

    // A second tick re-examines them all and finds nothing changed. Every row must still be stamped forward.
    await new Promise((r) => setTimeout(r, 5));
    expect((await drainSearchEmbeddings(deps)).embedded).toBe(0);
    const second = await deps.db.select().from(schema.searchVectors);
    expect(second.length).toBe(rows.length);
    expect(Math.min(...second.map((v) => +v.checkedAt))).toBeGreaterThan(Math.min(...stampedAt));
  });

  it("still notices an edit to a row it has already embedded", async () => {
    // The rotation is what makes an edit discoverable at all: `search_docs` is trigger-maintained and has no
    // updated_at, so nothing announces the change - the sweep has to come back round and re-hash the text.
    const row = doc();
    await deps.db.insert(schema.searchDocs).values(row);
    await drainSearchEmbeddings(deps);
    const before = index().get(vectorIdOf("tickets", row.recordId))!.values;

    await deps.db.update(schema.searchDocs).set({ subtitle: "Reported from the Pune office" }).where(eq(schema.searchDocs.recordId, row.recordId));
    expect((await drainSearchEmbeddings(deps)).embedded).toBe(1);
    expect(index().get(vectorIdOf("tickets", row.recordId))!.values).not.toEqual(before);
  });
});

describe("removal", () => {
  it("drops a row that was deleted", async () => {
    const row = doc();
    await deps.db.insert(schema.searchDocs).values(row);
    await drainSearchEmbeddings(deps);
    expect(index().size).toBe(1);

    await deps.db.update(schema.searchDocs).set({ deleted: true }).where(eq(schema.searchDocs.recordId, row.recordId));
    const out = await drainSearchEmbeddings(deps);
    expect(out.removed).toBe(1);
    expect(index().size).toBe(0);
    expect(await deps.db.select().from(schema.searchVectors)).toEqual([]);
  });

  it("drops a row that became restricted", async () => {
    // A restricted row is non-public per STATE_VISIBILITY. The FTS path hides it; leaving it embedded would
    // make the semantic path the looser of the two.
    const row = doc();
    await deps.db.insert(schema.searchDocs).values(row);
    await drainSearchEmbeddings(deps);

    await deps.db.update(schema.searchDocs).set({ restricted: true }).where(eq(schema.searchDocs.recordId, row.recordId));
    await drainSearchEmbeddings(deps);
    expect(index().size).toBe(0);
  });

  it("drops a row that lost its title", async () => {
    // Vectors written before untitled rows stopped being embedded are exactly this case: the embed pass
    // skips them now, so nothing would ever replace or remove them.
    const row = doc();
    await deps.db.insert(schema.searchDocs).values(row);
    await drainSearchEmbeddings(deps);
    expect(index().size).toBe(1);

    await deps.db.update(schema.searchDocs).set({ title: null }).where(eq(schema.searchDocs.recordId, row.recordId));
    const out = await drainSearchEmbeddings(deps);
    expect(out.removed).toBe(1);
    expect(index().size).toBe(0);
  });

  it("drops an entry whose row is gone entirely", async () => {
    const row = doc();
    await deps.db.insert(schema.searchDocs).values(row);
    await drainSearchEmbeddings(deps);

    await deps.db.delete(schema.searchDocs).where(eq(schema.searchDocs.recordId, row.recordId));
    const out = await drainSearchEmbeddings(deps);
    expect(out.removed).toBe(1);
    expect(index().size).toBe(0);
  });

  it("drops entries for a collection that is no longer indexable", async () => {
    // Simulated by booking a vector for a collection the policy does not list. Revoking a collection has to
    // remove what is already embedded, not merely stop adding to it.
    await deps.db.insert(schema.searchVectors).values({
      collection: "candidates", recordId: "rec-old", textHash: "x", model: MODELS.embed, embeddedAt: new Date(), checkedAt: new Date(),
    });
    index().set(vectorIdOf("candidates", "rec-old"), { values: [1, 2, 3], collection: "candidates" });

    const out = await drainSearchEmbeddings(deps);
    expect(out.removed).toBe(1);
    expect(index().has(vectorIdOf("candidates", "rec-old"))).toBe(false);
  });
});

describe("failure leaves the index retryable", () => {
  it("records nothing as embedded when the model is down", async () => {
    await deps.db.insert(schema.searchDocs).values(doc());
    model().fail = true;

    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(0);
    expect(out.pending).toBe(1);
    // The crucial half: no bookkeeping row, so the next tick finds the work again. A row marked embedded that
    // is not in the index would be invisible to semantic search permanently.
    expect(await deps.db.select().from(schema.searchVectors)).toEqual([]);

    model().fail = false;
    expect((await drainSearchEmbeddings(deps)).embedded).toBe(1);
  });

  it("sits out the tick when the day's budget is spent", async () => {
    await deps.db.insert(schema.searchDocs).values(doc());
    await deps.db.insert(schema.aiUsage).values({
      feature: "earlier", model: MODELS.embed, role: "embed", inputHash: "0".repeat(64), estimatedNeurons: BUDGET.dailyNeurons,
    });

    const out = await drainSearchEmbeddings(deps);
    expect(out.embedded).toBe(0);
    expect(await deps.db.select().from(schema.searchVectors)).toEqual([]);
  });
});

describe("embedText", () => {
  it("prefixes the collection's noun and joins the label fields", () => {
    expect(embedText("vendors", "WeWork", "ops@wework.example")).toBe("Vendor: WeWork - ops@wework.example");
    expect(embedText("leave-types", "Sick Leave", null)).toBe("Leave type: Sick Leave");
  });

  it("drops a subtitle that is only a status", () => {
    expect(embedText("announcements", "Q2 All-Hands", "announcement")).toBe("Announcement: Q2 All-Hands");
  });

  it("keeps the bare text for a collection whose vectors are compared to each other", () => {
    expect(embedText("tickets", "Title", "Sub")).toBe("Title - Sub");
    expect(embedText("cards", "Title", "done")).toBe("Title - done");
  });

  it("is empty without a title, whatever the subtitle", () => {
    expect(embedText("announcements", null, "kudos")).toBe("");
    expect(embedText("tickets", "  ", "Sub")).toBe("");
    expect(embedText("tickets", null, null)).toBe("");
  });
});
