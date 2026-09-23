/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { desc } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import type { TextModel } from "../src/ports";
import { aiEmbed, aiGenerate, aiRerank } from "../src/services/ai";
import { BUDGET, ESTIMATED_NEURONS, MODELS } from "../src/domain/aiPolicy";

// The properties services/ai.ts exists to have, against real D1. Three of them are the ones that decide
// whether an AI layer over HR data is safe to turn on at all:
//
//   - Inference being unavailable, out of budget or broken NEVER throws. Every AI feature is optional and
//     falls back; a thrown error would let an optional feature fail a request.
//   - Sending a forbidden collection to a model DOES throw. That is a bug, not a runtime condition.
//   - The trail records a HASH, never the text. If this ever regresses, the app has quietly rebuilt the
//     retained copy of salary and review text that the whole design is arranged to avoid.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
/** The account the per-user rate-limit test spends. Seeded in `beforeAll` because the trail references it. */
const RATE_LIMITED_USER = "user-under-test";
let deps: Deps;
const b = env as unknown as Bindings;

/** Deterministic stand-in for Workers AI: no network, no neurons, and a call counter so a cache hit is
 *  observable as the model NOT being called rather than as a flag we set ourselves. */
function fakeModel(): TextModel & { calls: { embed: number; generate: number; rerank: number }; fail: boolean } {
  const f = {
    calls: { embed: 0, generate: 0, rerank: 0 },
    fail: false,
    async embed(texts: string[]) {
      f.calls.embed++;
      if (f.fail) throw new Error("model exploded");
      // A vector derived from the text, so equal text gives equal vectors and a test can assert on it.
      return texts.map((t) => [t.length, [...t].reduce((n, c) => n + c.charCodeAt(0), 0) % 97, 0.5]);
    },
    async generate({ user }: { system: string; user: string }) {
      f.calls.generate++;
      if (f.fail) throw new Error("model exploded");
      return `drafted: ${user.slice(0, 20)}`;
    },
    async rerank(_query: string, candidates: string[]) {
      f.calls.rerank++;
      if (f.fail) throw new Error("model exploded");
      return candidates.map((_c, i) => ({ index: i, score: 1 - i / 10 }));
    },
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
  // `ai_usage.user_id` is a real foreign key to `users`: the accountability question is "who asked for this",
  // and a row naming an account that never existed cannot answer it. So the rate-limit test gets an account.
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  await deps.db.insert(schema.users).values({ uuid: RATE_LIMITED_USER, code: "u-ai", email: "ai@test.example", role: "employee" }).onConflictDoNothing();
});

beforeEach(async () => {
  await deps.db.delete(schema.aiUsage);
  await deps.db.delete(schema.aiCache);
  deps.ai = fakeModel();
});

const lastUsage = () => deps.db.select().from(schema.aiUsage).orderBy(desc(schema.aiUsage.createdAt)).limit(1).then((r) => r[0]!);
const ctx = { feature: "test.embed", reads: { collection: "tickets" } } as const;

describe("no model bound", () => {
  it("refuses rather than throwing, so the caller can fall back", async () => {
    const without: Deps = { ...deps, ai: undefined };
    const out = await aiEmbed(without, ctx, ["hello"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unavailable");
  });

  it("refuses generate and rerank the same way", async () => {
    const without: Deps = { ...deps, ai: undefined };
    expect((await aiGenerate(without, { feature: "x", reads: "none" }, { system: "s", user: "u", promptVersion: "v1" })).ok).toBe(false);
    expect((await aiRerank(without, { feature: "x", reads: "none" }, "q", ["a"])).ok).toBe(false);
  });
});

describe("the denylist throws instead of degrading", () => {
  it("refuses a forbidden collection loudly", async () => {
    // Not a refusal object: a call site asking to embed payroll is a bug, and returning a soft refusal would
    // let it ship and look like a model outage.
    await expect(aiEmbed(deps, { feature: "bad", reads: { collection: "compensation" } }, ["x"])).rejects.toThrow(/may not be sent to a model/);
    await expect(aiGenerate(deps, { feature: "bad", reads: { collection: "leave-requests" } }, { system: "s", user: "u", promptVersion: "v1" })).rejects.toThrow(/may not be sent to a model/);
  });

  it("refuses a forbidden sub-resource of an allowed collection", async () => {
    await expect(aiEmbed(deps, { feature: "bad", reads: { collection: "employees", subresource: "bank-account" } }, ["x"])).rejects.toThrow(/may not be sent to a model/);
  });

  it("refuses a BATCH in which one collection is forbidden", async () => {
    // A declaration can name several collections - the search drain embeds a window spanning the whole
    // index - and the check has to be asked about each of them, not about the first.
    await expect(aiEmbed(deps, { feature: "bad", reads: [{ collection: "tickets" }, { collection: "compensation" }] }, ["x"]))
      .rejects.toThrow(/may not be sent to a model/);
  });

  it("nothing was recorded, because nothing was sent", async () => {
    await expect(aiEmbed(deps, { feature: "bad", reads: { collection: "compensation" } }, ["x"])).rejects.toThrow();
    expect(await deps.db.select().from(schema.aiUsage)).toEqual([]);
  });
});

describe("the trail", () => {
  it("records a hash, never the text", async () => {
    const secretish = "Priya asked about her appraisal on the 14th";
    const out = await aiEmbed(deps, { feature: "search.embed", reads: { collection: "tickets" }, subject: "tickets/abc" }, [secretish]);
    expect(out.ok).toBe(true);

    const row = await lastUsage();
    expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.inputChars).toBe(secretish.length);
    expect(row.subject).toBe("tickets/abc");
    expect(row.outcome).toBe("ok");
    // The whole row, serialised, must not contain the source text in any column.
    expect(JSON.stringify(row)).not.toContain("Priya");
    expect(JSON.stringify(row)).not.toContain("appraisal");
  });

  it("records a failed call too, so a model that fails every time is visible", async () => {
    (deps.ai as ReturnType<typeof fakeModel>).fail = true;
    const out = await aiEmbed(deps, ctx, ["hello"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("error");

    const row = await lastUsage();
    expect(row.outcome).toBe("error");
    expect(row.error).toContain("model exploded");
  });
});

describe("budget", () => {
  it("refuses once the day's neurons are spent", async () => {
    await deps.db.insert(schema.aiUsage).values({
      feature: "earlier.today", model: "@cf/baai/bge-small-en-v1.5", role: "embed",
      inputHash: "0".repeat(64), estimatedNeurons: BUDGET.dailyNeurons,
    });
    const out = await aiGenerate(deps, { feature: "draft", reads: "none" }, { system: "s", user: "u", promptVersion: "v1" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("budget");
    expect((deps.ai as ReturnType<typeof fakeModel>).calls.generate).toBe(0);
  });

  it("charges a batch embed per text, so the ledger agrees with the check that reads it", async () => {
    // The pre-flight check scales with the batch. If the recorded spend did not, a 200-row index job would
    // check against one ceiling and report against another, and the ceiling would stop meaning anything.
    const texts = ["a", "b", "c", "d", "e"];
    await aiEmbed(deps, ctx, texts);
    const row = await lastUsage();
    expect(row.estimatedNeurons).toBe(ESTIMATED_NEURONS.embed * texts.length);

    const huge = Array.from({ length: BUDGET.dailyNeurons + 1 }, (_, i) => `row ${i}`);
    const out = await aiEmbed(deps, ctx, huge);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("budget");
  });

  it("a lowered ceiling passed by the caller wins", async () => {
    const out = await aiGenerate(deps, { feature: "draft", reads: "none", limits: { dailyNeurons: 1 } }, { system: "s", user: "u", promptVersion: "v1" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("budget");
  });
});

describe("per-user rate limit", () => {
  it("stops one person spending the org's day", async () => {
    const userId = null; // a system call is not rate limited
    expect((await aiGenerate(deps, { feature: "draft", reads: "none", userId }, { system: "s", user: "sys", promptVersion: "v1" })).ok).toBe(true);
  });

  it("refuses the caller past their hourly generations", async () => {
    // Seed the user's hour as already spent, against the account `beforeAll` created: the count is by
    // equality on `user_id`, and that column is a foreign key, so the id has to name a real row.
    const uid = RATE_LIMITED_USER;
    for (let i = 0; i < BUDGET.perUserHourlyGenerations; i++) {
      await deps.db.insert(schema.aiUsage).values({
        feature: "draft", model: MODELS.generate, role: "generate",
        userId: uid, inputHash: `${i}`.padStart(64, "0"), estimatedNeurons: 0,
      });
    }
    const out = await aiGenerate(deps, { feature: "draft", reads: "none", userId: uid }, { system: "s", user: "u", promptVersion: "v1" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("rate");
  });
});

describe("cache", () => {
  it("serves the second identical generation without calling the model", async () => {
    const req = { system: "sys", user: "summarise this", promptVersion: "v1" };
    const first = await aiGenerate(deps, { feature: "draft", reads: "none" }, req);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.cached).toBe(false);

    const second = await aiGenerate(deps, { feature: "draft", reads: "none" }, req);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.cached).toBe(true);
      expect(second.value).toBe(first.ok ? first.value : "");
    }
    expect((deps.ai as ReturnType<typeof fakeModel>).calls.generate).toBe(1);
  });

  it("a changed prompt version misses, so editing a prompt is not masked by the cache", async () => {
    await aiGenerate(deps, { feature: "draft", reads: "none" }, { system: "sys", user: "u", promptVersion: "v1" });
    await aiGenerate(deps, { feature: "draft", reads: "none" }, { system: "sys-EDITED", user: "u", promptVersion: "v2" });
    expect((deps.ai as ReturnType<typeof fakeModel>).calls.generate).toBe(2);
  });

  it("records the cache hit as usage, so the picture is not flatter than reality", async () => {
    const req = { system: "sys", user: "u", promptVersion: "v1" };
    await aiGenerate(deps, { feature: "draft", reads: "none" }, req);
    await aiGenerate(deps, { feature: "draft", reads: "none" }, req);
    const rows = await deps.db.select().from(schema.aiUsage);
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.cacheHit).length).toBe(1);
    // A cache hit costs no neurons, so it must not consume the day's budget.
    expect(rows.find((r) => r.cacheHit)!.estimatedNeurons).toBe(0);
  });
});
