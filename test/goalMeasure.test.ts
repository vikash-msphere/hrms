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
import { measureGaps, GAP_MESSAGE } from "../src/domain/goalMeasure";
import { measureGaps as webMeasureGaps, GAP_MESSAGE as WEB_GAP_MESSAGE } from "../web/src/lib/goalMeasure";
import { proposeGoalMeasure, parseProposal } from "../src/services/goalMeasure";
import { createGoal, updateGoal } from "../src/services/goals";

// A goal that cannot measure itself, and the three numbers a model may propose for it.
//
// The properties worth holding: the CHECK costs nothing and runs everywhere, the model is shown the goal's
// own words and nothing else, a refusal is a readable error rather than a silent nothing, and an answer that
// is not exactly the three fields is discarded whole rather than read in part.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

describe("what the goal cannot answer about itself", () => {
  it("says a goal with no unit and no target has no measure", () => {
    expect(measureGaps({ title: "Make onboarding excellent", due_date: "2026-06-30" })).toEqual(["no_measure"]);
  });

  it("asks for a baseline only once there is something to measure", () => {
    // Three complaints about one thing is how a hint gets ignored.
    expect(measureGaps({ unit: "customers", target_value: 60, due_date: "2026-06-30" })).toEqual(["no_baseline"]);
    expect(measureGaps({ due_date: "2026-06-30" })).toEqual(["no_measure"]);
  });

  it("names a missing due date separately, because it is a separate problem", () => {
    expect(measureGaps({ unit: "%", baseline_value: 8, target_value: 4 })).toEqual(["no_due_date"]);
  });

  it("is silent on a goal that measures itself", () => {
    expect(measureGaps({ unit: "%", baseline_value: 8, target_value: 4, due_date: "2026-06-30" })).toEqual([]);
  });
});

describe("the page and the server agree", () => {
  // The hint beside the fields and the check the suggest verb makes are the same rule in two runtimes. A
  // page calling a goal measurable while the server offers to fix it is the drift this stops.
  const CASES = [
    { title: "nothing at all" },
    { unit: "customers", target_value: 60, due_date: "2026-06-30" },
    { unit: "%", baseline_value: 8, target_value: 4 },
    { unit: "%", baseline_value: 8, target_value: 4, due_date: "2026-06-30" },
    { target_value: 60 },
    { unit: " ", due_date: "2026-06-30" },
  ];

  it("answers identically for every shape a goal can be in", () => {
    for (const c of CASES) expect(webMeasureGaps(c)).toEqual(measureGaps(c));
  });

  it("uses the same wording", () => {
    expect(WEB_GAP_MESSAGE).toEqual(GAP_MESSAGE);
  });
});

describe("reading the model's answer", () => {
  it("takes the three fields", () => {
    expect(parseProposal('{"unit":"customers","baseline_value":42,"target_value":60}'))
      .toEqual({ unit: "customers", baseline_value: 42, target_value: 60 });
  });

  it("survives a code fence and surrounding chatter", () => {
    expect(parseProposal('```json\n{"unit":"%","baseline_value":8,"target_value":4}\n```'))
      .toEqual({ unit: "%", baseline_value: 8, target_value: 4 });
  });

  it("refuses an answer with a key that is not one of the three", () => {
    // An extra key is a model answering a different question; reading the parts that parsed would put a
    // number in a field with no idea what the rest was meant to be.
    expect(() => parseProposal('{"unit":"%","baseline_value":8,"target_value":4,"assessment":"ambitious"}')).toThrow();
  });

  it("refuses prose", () => {
    expect(() => parseProposal("This goal could be measured in customers.")).toThrow();
  });

  it("drops a target equal to its baseline", () => {
    // It would read 100% done the moment it was saved.
    expect(parseProposal('{"unit":"days","baseline_value":5,"target_value":5}'))
      .toEqual({ unit: "days", baseline_value: null, target_value: null });
  });
});

describe("the call", () => {
  const ME = genId();
  const USER = genId();
  const user = { uuid: USER, employeeId: ME } as unknown as AppUser;
  const TABLES = [schema.goals, schema.aiUsage, schema.aiCache, schema.users, schema.employees, schema.settings];

  beforeEach(async () => {
    for (const t of TABLES) await deps.db.delete(t);
    await deps.db.insert(schema.employees).values({ uuid: ME, code: "04-001-001", firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" });
    // A real user row: the usage ledger references it, and without one the record write fails silently and
    // the per-caller hourly quota has nothing to count.
    await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR" }).onConflictDoNothing();
    await deps.db.insert(schema.users).values({ uuid: USER, code: "u-gm", email: "me@test.example", role: "hr_admin", employeeId: ME });
    deps.ai = undefined;
  });

  async function goal(over: Partial<typeof schema.goals.$inferInsert> = {}) {
    const uuid = genId();
    await deps.db.insert(schema.goals).values({ uuid, code: `g-${uuid.slice(0, 6)}`, employeeId: ME, title: "Cut onboarding time", description: "From two weeks to three days", ...over });
    return uuid;
  }
  const enable = () => deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "goals.measure": true } }) });
  const model = (answer: string, seen: string[] = []) => ({
    async embed() { return []; },
    async generate(req: { system: string; user: string }) { seen.push(`${req.system}\n${req.user}`); return answer; },
    async rerank() { return []; },
  });

  it("proposes from the goal's own words, and shows the model nothing else", async () => {
    await enable();
    const id = await goal({ progress: 40 });
    const seen: string[] = [];
    deps.ai = model('{"unit":"days","baseline_value":14,"target_value":3}', seen) as unknown as Deps["ai"];
    const out = await proposeGoalMeasure(deps, user, id);
    expect(out).toMatchObject({ unit: "days", baseline_value: 14, target_value: 3 });
    const prompt = seen.join("\n");
    expect(prompt).toContain("Cut onboarding time");
    // No progress, no owner, no status: it cannot form a view about the person because it is never told
    // there is one.
    expect(prompt).not.toContain("40");
    expect(prompt).not.toContain(ME);
  });

  it("refuses readably when the feature is off", async () => {
    const id = await goal();
    deps.ai = model("{}") as unknown as Deps["ai"];
    await expect(proposeGoalMeasure(deps, user, id)).rejects.toThrow(/switched off/);
  });

  it("refuses readably with no model bound", async () => {
    await enable();
    const id = await goal();
    await expect(proposeGoalMeasure(deps, user, id)).rejects.toThrow(/not available/);
  });

  it("records what was sent, as every call through the ledger does", async () => {
    await enable();
    const id = await goal();
    deps.ai = model('{"unit":"days","baseline_value":14,"target_value":3}') as unknown as Deps["ai"];
    await proposeGoalMeasure(deps, user, id);
    const usage = await deps.db.select().from(schema.aiUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.feature).toBe("goals.measure");
    expect(usage[0]!.subject).toBe(`goals/${id}`);
  });
});

// A measure that already reads its target is finished work, and the record has to say so on the way in.
//
// The rule existed on the UPDATE path only ("reaching the target completes the goal"), so a goal CREATED at
// its target was written progress 100 with whatever status the default supplied - "Not started" - and the form
// offering to record it said in so many words that saving would complete it. One rule, both doors.
describe("a goal filed at its target", () => {
  const TABLES = [schema.auditLog, schema.eventLog, schema.goals, schema.users, schema.employees, schema.roles];
  beforeEach(async () => {
    for (const t of TABLES) await deps.db.delete(t);
  });

  async function seedActor(): Promise<AppUser> {
    await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
    const employeeId = genId();
    await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
    const uuid = genId();
    await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee", employeeId });
    return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId, employeeCode: null, name: "Test User" } as unknown as AppUser;
  }

  it("is created completed, not 'not started' at 100%", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "Sign the last three customers", unit: "customers", baseline_value: 0, target_value: 3, current_value: 3 });
    expect(g.progress).toBe(100);
    expect(g.status).toBe("completed");
  });

  it("leaves a status the caller named alone", async () => {
    // "Cancelled at the target" is a thing somebody can mean - work that landed and was then called off.
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "Abandoned at the line", status: "cancelled", baseline_value: 0, target_value: 3, current_value: 3 });
    expect(g.progress).toBe(100);
    expect(g.status).toBe("cancelled");
  });

  it("does not complete a goal that is only part of the way there", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "Sign three customers", unit: "customers", baseline_value: 0, target_value: 3, current_value: 1 });
    expect(g.progress).toBe(33);
    expect(g.status).toBe("not_started");
  });

  it("completes on an edit that reaches the target without naming a status", async () => {
    const actor = await seedActor();
    const g = await createGoal(deps, actor, { title: "Cut churn", unit: "%", baseline_value: 8, target_value: 4, current_value: 8 });
    expect(g.status).toBe("not_started");
    const done = await updateGoal(deps, actor, g.uuid, { current_value: 4 });
    expect(done.progress).toBe(100);
    expect(done.status).toBe("completed");
  });
});
