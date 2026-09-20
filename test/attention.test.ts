/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { ListScope } from "../src/domain/access";
import { attentionFor } from "../src/services/attention";
import { rankAttention, ATTENTION_LIMIT, type AttentionItem } from "../src/domain/attention";
import { STALE_AFTER_DAYS } from "../src/domain/goals";

// "What needs me": the properties that make this a surface somebody can trust rather than a second inbox.
//
// The two that matter most are about AGREEMENT and ACCESS. It must flag exactly what the Goals page would
// flag, because it is the same predicates - a surface that does its own arithmetic becomes a second opinion.
// And it must be bound by the caller's ordinary list scope, because it reads across three collections and
// would otherwise be a way to learn about records somebody cannot open.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const DAY = 86_400_000;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

// `settings` and `aiUsage` are cleared with the rest: the summary reads the org's AI switch and records what
// it spends, and a test that asserts "asked nothing" is only meaningful against a clean slate.
const TABLES = [schema.cards, schema.boards, schema.reviews, schema.reviewCycles, schema.goals, schema.employees, schema.settings, schema.aiUsage, schema.aiCache];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  // Absent unless a test wires one. The list must stand up with no model at all, which is most of these.
  deps.ai = undefined;
});

const ME = { uuid: genId(), code: "04-001-001" };
const OTHER = { uuid: genId(), code: "04-001-002" };

const user = (employeeId: string | null): AppUser => ({ employeeId } as unknown as AppUser);
const all = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });
const scopes = (...names: string[]) => new Map(names.map((n) => [n, all()]));

async function people() {
  await deps.db.insert(schema.employees).values([
    { uuid: ME.uuid, code: ME.code, firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" },
    { uuid: OTHER.uuid, code: OTHER.code, firstName: "Other", lastName: "Y", workEmail: "o@x.test", status: "active", managerId: ME.uuid },
  ]);
}

/** A goal owned by `who`, positioned relative to now by how long ago it started and when it is due. */
async function goal(over: Partial<typeof schema.goals.$inferInsert> & { title: string }) {
  const uuid = genId();
  await deps.db.insert(schema.goals).values({
    uuid, code: `g-${uuid.slice(0, 6)}`, employeeId: ME.uuid,
    status: "in_progress", progress: 0, ...over,
  });
  return uuid;
}

describe("goals in trouble", () => {
  it("flags a goal that is far behind the line from its start to its due date", async () => {
    await people();
    // Started 90 days ago, due in 10: about 90% of the way through, and 10% done. Deep in at_risk.
    await goal({ title: "Platform rewrite", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 10 });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items.map((i) => i.kind)).toEqual(["goal_at_risk"]);
    // The detail carries the specific fact rather than a label, because "at risk" on its own tells somebody
    // to go and look, which is the work this is supposed to save.
    expect(items[0]!.detail).toMatch(/10% done, \d+% expected by now, 1[01] days left/);
  });

  it("says nothing about a goal that is on track", async () => {
    await people();
    await goal({ title: "Fine", createdAt: new Date(Date.now() - 10 * DAY), dueDate: new Date(Date.now() + 90 * DAY), progress: 15 });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items).toEqual([]);
  });

  it("says nothing about a finished goal, however late it finished", async () => {
    await people();
    // The predicate's own rule, and the reason it is worth re-checking here: reporting delivered work as
    // "behind" would put a permanent red chip on it.
    await goal({ title: "Done late", status: "completed", progress: 100, createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() - 30 * DAY) });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items).toEqual([]);
  });

  it("flags silence on a goal with no due date, which cannot be behind", async () => {
    await people();
    const old = new Date(Date.now() - (STALE_AFTER_DAYS + 5) * DAY);
    await goal({ title: "Forgotten", createdAt: old, updatedAt: old, dueDate: null });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items.map((i) => i.kind)).toEqual(["goal_stale"]);
    expect(items[0]!.detail).toMatch(/no progress recorded in 2[5-9] days/);
  });

  it("reports a goal that is both behind and silent once, not twice", async () => {
    await people();
    const old = new Date(Date.now() - 90 * DAY);
    await goal({ title: "Both", createdAt: old, updatedAt: old, dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    // One problem with two symptoms. Listing it twice would push something else off a list of eight.
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("goal_at_risk");
  });
});

describe("what the caller may not see", () => {
  it("contributes nothing for a collection absent from the scopes map", async () => {
    await people();
    await goal({ title: "Platform rewrite", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 10 });
    // Fail closed is `applyScope`'s behaviour for an absent scope, and this is the test that the surface
    // inherits it rather than quietly reading the table.
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("cards", "reviews"));
    expect(items).toEqual([]);
  });
});

describe("reviews waiting on this person", () => {
  async function cycleAndReview(state: "SELF" | "MANAGER" | "SHARED", employeeId: string, reviewerId: string | null) {
    const cycle = genId();
    await deps.db.insert(schema.reviewCycles).values({ uuid: cycle, code: `c-${cycle.slice(0, 6)}`, name: "H1", state: "ACTIVE" });
    const uuid = genId();
    await deps.db.insert(schema.reviews).values({ uuid, code: `r-${uuid.slice(0, 6)}`, cycleId: cycle, employeeId, reviewerId, state });
    return uuid;
  }

  it("flags my own self-assessment", async () => {
    await people();
    await cycleAndReview("SELF", ME.uuid, null);
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items.map((i) => i.kind)).toEqual(["review_waiting"]);
    expect(items[0]!.detail).toMatch(/self-assessment/);
  });

  it("flags one I owe as the reviewee's MANAGER, with no reviewer named", async () => {
    await people();
    // reviewer_id null means the manager chain, which is the case the join exists for. Getting this wrong
    // would silently drop every ordinary review a manager owes.
    await cycleAndReview("MANAGER", OTHER.uuid, null);
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items.map((i) => i.detail)).toEqual(["your review of this person is due"]);
  });

  it("says nothing about one waiting on somebody else", async () => {
    await people();
    // Somebody else's self-assessment. Visible to me by scope, and still not my problem.
    await cycleAndReview("SELF", OTHER.uuid, null);
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items).toEqual([]);
  });
});

describe("the one-line summary", () => {
  /** A model that records what it was asked, so the test can assert on the PROMPT rather than the answer. */
  function spy(answer = "Automate the payroll regression pack is furthest behind.") {
    const seen: string[] = [];
    return {
      seen,
      model: {
        async embed(t: string[]) { return t.map(() => [0.1]); },
        async generate(req: { user: string }) { seen.push(req.user); return answer; },
        async rerank() { return []; },
      },
    };
  }

  async function enable() {
    await deps.db.delete(schema.settings);
    await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "attention.summary": true } }) });
  }

  it("never sends a review to the model, only how many there are", async () => {
    // `reviews` is on NEVER_TO_MODEL. A cycle name is not an assessment, but the honest way to keep it that
    // way is to not send review rows at all - so they arrive as a count. This is the assertion that stops a
    // later edit "improving" the summary by naming them.
    await people();
    await enable();
    const cycle = genId();
    await deps.db.insert(schema.reviewCycles).values({ uuid: cycle, code: `c-${cycle.slice(0, 6)}`, name: "H1 Performance Review", state: "ACTIVE" });
    const rid = genId();
    await deps.db.insert(schema.reviews).values({ uuid: rid, code: `r-${rid.slice(0, 6)}`, cycleId: cycle, employeeId: ME.uuid, reviewerId: null, state: "SELF" });
    await goal({ title: "Platform rewrite", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 10 });

    const s = spy();
    deps.ai = s.model as unknown as Deps["ai"];
    const { items, summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));

    expect(items).toHaveLength(2);
    expect(summary).toBeTruthy();
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).not.toContain("H1 Performance Review");
    expect(s.seen[0]).toContain("1 review waiting on you");
    // And the goal, which is not denylisted, is named - or the summary could not say anything useful.
    expect(s.seen[0]).toContain("Platform rewrite");
  });

  it("says nothing, and asks nothing, when the feature is off", async () => {
    await people();
    await deps.db.delete(schema.settings);
    await goal({ title: "A", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    await goal({ title: "B", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 6 });
    const s = spy();
    deps.ai = s.model as unknown as Deps["ai"];
    const { items, summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    // Off must cost NOTHING, not merely produce nothing: the switch is checked before the model is asked.
    expect(items).toHaveLength(2);
    expect(summary).toBeUndefined();
    expect(s.seen).toEqual([]);
  });

  it("keeps the list when the model refuses", async () => {
    await people();
    await enable();
    await goal({ title: "A", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    await goal({ title: "B", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 6 });
    // The whole ordering argument: the list is arithmetic and the sentence is an addition, so a model that
    // throws costs a sentence and nothing else.
    deps.ai = { async embed() { return []; }, async generate() { throw new Error("model down"); }, async rerank() { return []; } } as unknown as Deps["ai"];
    const { items, summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items).toHaveLength(2);
    expect(summary).toBeUndefined();
  });

  it("does not bother summarising a single item", async () => {
    await people();
    await enable();
    await goal({ title: "Only one", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    const s = spy();
    deps.ai = s.model as unknown as Deps["ai"];
    const { summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    // The row already says it, in more detail than a sentence would, and a neuron spent here buys nothing.
    expect(summary).toBeUndefined();
    expect(s.seen).toEqual([]);
  });
});

describe("ranking", () => {
  const item = (kind: AttentionItem["kind"], path: string, days?: number): AttentionItem =>
    ({ kind, path, title: path, detail: "", ...(days === undefined ? {} : { days }) });

  it("puts what goes wrong first, not what is loudest", () => {
    const ranked = rankAttention([
      item("goal_stale", "goals/a", 30),
      item("card_aged", "cards/b", 40),
      item("goal_at_risk", "goals/c"),
      item("review_waiting", "reviews/d"),
    ]);
    // A review blocks another person and has a deadline somebody else set, so it outranks a card that has
    // simply been sitting - even one sitting longer.
    expect(ranked.map((i) => i.path)).toEqual(["goals/c", "reviews/d", "cards/b", "goals/a"]);
  });

  it("puts the older thing first within a kind, and is stable", () => {
    const ranked = rankAttention([item("card_aged", "cards/new", 8), item("card_aged", "cards/old", 30)]);
    expect(ranked.map((i) => i.path)).toEqual(["cards/old", "cards/new"]);
    // Same input, same output: a surface that reorders itself on every refresh reads as noise.
    expect(rankAttention(ranked)).toEqual(ranked);
  });

  it("caps the list, keeping the worst rather than the first found", async () => {
    await people();
    for (let i = 0; i < ATTENTION_LIMIT + 4; i++) {
      await goal({ title: `Late ${i}`, createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    }
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items).toHaveLength(ATTENTION_LIMIT);
  });
});
