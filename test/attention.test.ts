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
import { attentionFor, weeklyAttentionDigest } from "../src/services/attention";
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
const TABLES = [schema.cards, schema.boards, schema.reviewFeedback, schema.reviews, schema.reviewCycles, schema.goals, schema.employees, schema.settings, schema.aiUsage, schema.aiCache];
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

describe("cards that are ageing, and cards that are finished", () => {
  const BOARD = genId();
  /** One card on a board, positioned by how long ago it last changed column. */
  async function boardCard(over: Partial<typeof schema.cards.$inferInsert> & { title: string }) {
    await deps.db.insert(schema.boards).values({ uuid: BOARD, code: `b-${BOARD.slice(0, 5)}`, name: "Delivery", columnsJson: JSON.stringify([{ key: "done", label: "Done" }]) }).onConflictDoNothing();
    const uuid = genId();
    await deps.db.insert(schema.cards).values({
      uuid, code: `c-${uuid.slice(0, 6)}`, boardId: BOARD, employeeId: ME.uuid, columnKey: "done", ...over,
    });
    return uuid;
  }
  const longAgo = () => new Date(Date.now() - 100 * DAY);

  it("says nothing about a card that was delivered, however long ago it last moved", async () => {
    await people();
    // `column_since` is restamped by EVERY move, the delivery one included, so a card delivered months ago
    // carries an old stamp and would otherwise read as "in done for 100 days" - filling all eight slots of
    // this surface with finished work on any board older than the threshold.
    await boardCard({ title: "Long since done", columnSince: longAgo(), deliveredAt: longAgo() });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items).toEqual([]);
  });

  it("still flags one that is genuinely stuck", async () => {
    await people();
    await boardCard({ title: "Stuck in review", columnKey: "review", columnSince: longAgo() });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items.map((i) => i.kind)).toEqual(["card_aged"]);
  });

  it("keeps the roundup clear of delivered work too", async () => {
    await people();
    // The digest reads its own query rather than calling `attentionFor`, so the same gap had to be closed
    // twice - and without this it mails everybody a list of their long-closed cards.
    //
    // The clock is frozen on a Monday (the digest is a no-op on the other six days) and PUT BACK after: the
    // suites below position their fixtures against the real clock, and a frozen one left behind moves the
    // week they are testing.
    const real = deps.clock;
    deps.clock = { now: () => new Date("2026-09-21T09:00:00Z") };
    try {
      await boardCard({ title: "Long since done", columnSince: longAgo(), deliveredAt: longAgo() });
      expect(await weeklyAttentionDigest(deps)).toBe(0);
    } finally {
      deps.clock = real;
    }
  });
});

describe("the cycle's own deadline", () => {
  async function dated(state: "SELF" | "MANAGER", employeeId: string, due: { selfDueDate?: Date; managerDueDate?: Date }) {
    const cycle = genId();
    await deps.db.insert(schema.reviewCycles).values({ uuid: cycle, code: `c-${cycle.slice(0, 6)}`, name: "H1", state: "ACTIVE", ...due });
    const uuid = genId();
    await deps.db.insert(schema.reviews).values({ uuid, code: `r-${uuid.slice(0, 6)}`, cycleId: cycle, employeeId, reviewerId: null, state });
    return uuid;
  }

  it("says how long is left, not just that it is due", async () => {
    await people();
    await dated("SELF", ME.uuid, { selfDueDate: new Date(Date.now() + 3 * DAY) });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    // "Due" reads the same on the first day of the window as on the last, which is how a cycle closes with a
    // third of the self-assessments unwritten.
    expect(items[0]!.detail).toMatch(/due in 3 days/);
  });

  it("says overdue once the day has passed, and ranks it above one not yet due", async () => {
    await people();
    await dated("SELF", ME.uuid, { selfDueDate: new Date(Date.now() - 2 * DAY) });
    await dated("MANAGER", OTHER.uuid, { managerDueDate: new Date(Date.now() + 5 * DAY) });
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items[0]!.detail).toMatch(/1 day overdue|2 days overdue/);
    expect(items[1]!.detail).toMatch(/due in 5 days/);
  });

  it("claims no deadline for a cycle that set none", async () => {
    await people();
    await dated("SELF", ME.uuid, {});
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"));
    expect(items[0]!.detail).toBe("your self-assessment is due");
  });
});

describe("360 feedback nobody has answered", () => {
  async function request(authorId: string, revieweeId: string, state: "REQUESTED" | "SUGGESTED" | "SUBMITTED", daysAgo = 6) {
    const cycle = genId();
    await deps.db.insert(schema.reviewCycles).values({ uuid: cycle, code: `c-${cycle.slice(0, 6)}`, name: "H1", state: "ACTIVE" });
    const review = genId();
    // Written by the reviewee's own nominee rather than by the caller: this block is about the FEEDBACK
    // request, and a review the caller also owes would put a second item on the list.
    await deps.db.insert(schema.reviews).values({ uuid: review, code: `r-${review.slice(0, 6)}`, cycleId: cycle, employeeId: revieweeId, reviewerId: revieweeId, state: "MANAGER" });
    const uuid = genId();
    await deps.db.insert(schema.reviewFeedback).values({
      uuid, code: `f-${uuid.slice(0, 6)}`, reviewId: review, revieweeId, authorId, state,
      createdAt: new Date(Date.now() - daysAgo * DAY),
    });
    return uuid;
  }

  it("flags a request addressed to me, naming who it is about and how long it has waited", async () => {
    await people();
    await request(ME.uuid, OTHER.uuid, "REQUESTED");
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews", "review-feedback"));
    expect(items.map((i) => i.kind)).toEqual(["feedback_requested"]);
    expect(items[0]!.title).toBe("360 feedback on Other Y");
    expect(items[0]!.detail).toMatch(/asked 6 days ago/);
    // The reviews page, where the requests are answered and where the notification for the same thing goes.
    expect(items[0]!.path).toBe("reviews");
  });

  it("folds several requests into one errand, naming the oldest", async () => {
    await people();
    await request(ME.uuid, OTHER.uuid, "REQUESTED", 9);
    await request(ME.uuid, OTHER.uuid, "REQUESTED", 2);
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews", "review-feedback"));
    // Eight slots have to hold everything off track for a person; three of them spent on one errand pushes
    // out the goal that is about to miss its date.
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("360 feedback on Other Y and 1 other");
    expect(items[0]!.detail).toMatch(/asked 9 days ago/);
  });

  it("says nothing about a suggestion or an answered request", async () => {
    await people();
    await request(ME.uuid, OTHER.uuid, "SUGGESTED");
    await request(ME.uuid, OTHER.uuid, "SUBMITTED");
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews", "review-feedback"));
    // A suggestion asks nobody for anything; a submitted one is done.
    expect(items).toEqual([]);
  });

  it("says nothing about a request addressed to somebody else", async () => {
    await people();
    // A request asked OF the other person, about the caller. Visible to the caller by scope, and still not
    // theirs to answer. (The caller's own review of themselves is on the list, which is a different signal.)
    await request(OTHER.uuid, ME.uuid, "REQUESTED");
    const { items } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews", "review-feedback"));
    expect(items.filter((i) => i.kind === "feedback_requested")).toEqual([]);
  });

  it("contributes nothing when the caller may not list the collection", async () => {
    await people();
    await request(ME.uuid, OTHER.uuid, "REQUESTED");
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

  /**
   * The summary is ASKED FOR, never part of the load - `GET /v1/attention?summary=1` (services/attention.ts).
   * Every test below drives the asked-for path, because the other one is the subject of exactly one assertion
   * ("does not bother summarising a single item" reaches it through the same option) and a test that reads
   * `summary` off a plain load is asserting about a request nobody made.
   */
  const ASK = { summary: true } as const;

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
    const { items, summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"), ASK);

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
    const { items, summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"), ASK);
    // Off must cost NOTHING, not merely produce nothing: the switch is checked before the model is asked - and
    // it is asked here, so "nothing happened" is the feature switch answering rather than nobody asking.
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
    const { items, summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"), ASK);
    expect(items).toHaveLength(2);
    expect(summary).toBeUndefined();
  });

  it("sends a 360 request as a count, never as the name of who is being reviewed", async () => {
    await people();
    await enable();
    await goal({ title: "A goal", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    const cycle = genId();
    await deps.db.insert(schema.reviewCycles).values({ uuid: cycle, code: `c-${cycle.slice(0, 6)}`, name: "H1", state: "ACTIVE" });
    const review = genId();
    await deps.db.insert(schema.reviews).values({ uuid: review, code: `r-${review.slice(0, 6)}`, cycleId: cycle, employeeId: OTHER.uuid, reviewerId: OTHER.uuid, state: "MANAGER" });
    const fb = genId();
    await deps.db.insert(schema.reviewFeedback).values({ uuid: fb, code: `f-${fb.slice(0, 6)}`, reviewId: review, revieweeId: OTHER.uuid, authorId: ME.uuid, state: "REQUESTED" });
    const s = spy();
    deps.ai = s.model as unknown as Deps["ai"];
    await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews", "review-feedback"), ASK);
    const prompt = s.seen.join("\n");
    // `reviews` is on NEVER_TO_MODEL, and the name of somebody being reviewed is the same category of fact
    // arriving by a different route.
    expect(prompt).not.toContain("Other Y");
    expect(prompt).toContain("360 feedback request");
  });

  it("does not bother summarising a single item", async () => {
    await people();
    await enable();
    await goal({ title: "Only one", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    const s = spy();
    deps.ai = s.model as unknown as Deps["ai"];
    const { summary } = await attentionFor(deps, user(ME.uuid), scopes("goals", "cards", "reviews"), ASK);
    // The row already says it, in more detail than a sentence would, and a neuron spent here buys nothing.
    expect(summary).toBeUndefined();
    expect(s.seen).toEqual([]);
  });
});

describe("the Monday roundup", () => {
  const notifications = () => deps.db.select().from(schema.notifications);

  /** Freeze the clock on a known weekday. `2026-09-21` is a Monday, `2026-09-22` a Tuesday. */
  const on = (ymd: string) => { deps.clock = { now: () => new Date(`${ymd}T09:00:00Z`) }; };

  it("sends nothing on the other six days", async () => {
    await people();
    await goal({ title: "Late", createdAt: new Date(Date.now() - 90 * DAY), dueDate: new Date(Date.now() + 10 * DAY), progress: 5 });
    on("2026-09-22");
    expect(await weeklyAttentionDigest(deps)).toBe(0);
    expect(await notifications()).toHaveLength(0);
  });

  it("sends one notification to the person whose goal it is, naming what is wrong", async () => {
    await people();
    on("2026-09-21");
    // Positioned against the FROZEN clock, not `Date.now()`, or the goal would be in trouble relative to a
    // different week than the one being tested.
    const now = deps.clock.now().getTime();
    await goal({ title: "Platform rewrite", createdAt: new Date(now - 90 * DAY), dueDate: new Date(now + 10 * DAY), progress: 10 });
    expect(await weeklyAttentionDigest(deps)).toBe(1);

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientId).toBe(ME.uuid);
    expect(rows[0]!.title).toMatch(/1 thing needs you this week/);
    // The specifics travel with it: a notification saying only "you have things to do" is one more thing to
    // do rather than a reason to open the dashboard.
    expect(rows[0]!.body).toContain("Platform rewrite");
    expect(rows[0]!.body).toMatch(/expected by now/);
  });

  it("gives each person only their own, never their team's", async () => {
    await people();
    on("2026-09-21");
    const now = deps.clock.now().getTime();
    // OTHER reports to ME. On the dashboard a manager's scope can reach their team's goals; the digest is
    // deliberately narrower - it is somebody's own week, and it is sent without anybody asking for it.
    await goal({ title: "Their goal", employeeId: OTHER.uuid, createdAt: new Date(now - 90 * DAY), dueDate: new Date(now + 10 * DAY), progress: 5 });
    expect(await weeklyAttentionDigest(deps)).toBe(1);
    const rows = await notifications();
    expect(rows.map((r) => r.recipientId)).toEqual([OTHER.uuid]);
  });

  it("says nothing to somebody with nothing wrong", async () => {
    await people();
    on("2026-09-21");
    const now = deps.clock.now().getTime();
    await goal({ title: "Fine", createdAt: new Date(now - 10 * DAY), dueDate: new Date(now + 90 * DAY), progress: 15 });
    expect(await weeklyAttentionDigest(deps)).toBe(0);
    expect(await notifications()).toHaveLength(0);
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
