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
import { narrateBoard } from "../src/services/boardNarrate";

// A sentence about how a board's flow moved, over the top of numbers it already had.
//
// The properties worth holding, all three inherited from the team report and all three worth re-proving on
// a second surface: the model never sees the data, a sentence with a number nobody computed is thrown away,
// and a quiet period costs no inference at all.

const DAY = 86_400_000;
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

const BOARD = genId();
const ME = genId();
const USER = genId();
const user = { uuid: USER, employeeId: ME } as unknown as AppUser;
const TABLES = [schema.cardMovements, schema.cards, schema.boards, schema.aiUsage, schema.aiCache, schema.users, schema.employees, schema.settings];

beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.employees).values({ uuid: ME, code: "04-001-001", firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" });
  await deps.db.insert(schema.roles).values({ name: "hr_admin", label: "HR" }).onConflictDoNothing();
  await deps.db.insert(schema.users).values({ uuid: USER, code: "u-bn", email: "me@test.example", role: "hr_admin", employeeId: ME });
  // `delivery: true` is what says which column is the delivery point - the same flag the board's own config
  // carries, and what `valuesOf` takes out of work-in-flight.
  await deps.db.insert(schema.boards).values({ uuid: BOARD, code: "b-1", name: "Delivery", columnsJson: JSON.stringify([{ key: "todo", label: "To do" }, { key: "done", label: "Done", delivery: true }]) });
  deps.ai = undefined;
});

const enable = () => deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "boards.narrate": true } }) });

let n = 0;
/** A card delivered `daysAgo`, having started `took` days before that. */
async function delivered(daysAgo: number, took: number) {
  const now = Date.now();
  const uuid = genId();
  await deps.db.insert(schema.cards).values({
    uuid, code: `c-${uuid.slice(0, 6)}`, boardId: BOARD, employeeId: ME, title: `Card ${++n}`, columnKey: "done",
    committedAt: new Date(now - (daysAgo + took) * DAY),
    startedAt: new Date(now - (daysAgo + took) * DAY),
    deliveredAt: new Date(now - daysAgo * DAY),
  });
  return uuid;
}

const model = (answer: string, seen: string[] = []) => ({
  async embed() { return []; },
  async generate(req: { system: string; user: string }) { seen.push(`${req.system}\n${req.user}`); return answer; },
  async rerank() { return []; },
});

describe("what the board says changed", () => {
  it("finds the movement and hands the model only the movement", async () => {
    await enable();
    // Eight delivered in the current fortnight, one in the one before it.
    for (let i = 0; i < 8; i++) await delivered(3, 2);
    await delivered(20, 2);
    const seen: string[] = [];
    deps.ai = model("Delivery rose from 1 to 8 this period.", seen) as unknown as Deps["ai"];

    const out = await narrateBoard(deps, user, BOARD, 14);
    expect(out.findings.some((f) => f.key === "throughput")).toBe(true);
    expect(out.source).toBe("model");
    // The prompt is labels and numbers. No card title reaches it, so there is nothing about a person in it
    // even by accident.
    const prompt = seen.join("\n");
    expect(prompt).toContain("Tasks delivered");
    expect(prompt).not.toContain("Card 1");
  });

  it("throws away a sentence carrying a number nobody computed", async () => {
    await enable();
    for (let i = 0; i < 8; i++) await delivered(3, 2);
    await delivered(20, 2);
    deps.ai = model("Delivery rose 4000% and the team is now at 97% capacity.") as unknown as Deps["ai"];
    const out = await narrateBoard(deps, user, BOARD, 14);
    // A fabricated figure beside a real diagram is worse than no sentence, so the plain summary stands.
    expect(out.source).toBe("plain");
    expect(out.text).not.toContain("97");
  });

  it("does not count the delivery column as work in flight", async () => {
    await enable();
    // Eight cards delivered this period all sit in `done`, which the diagram counts like any other column.
    // Summing every column would therefore report work in flight as UP on any board that delivered anything,
    // every single time, and hand the model that as a finding to write about.
    for (let i = 0; i < 8; i++) await delivered(3, 2);
    deps.ai = model("unused") as unknown as Deps["ai"];
    const out = await narrateBoard(deps, user, BOARD, 14);
    expect(out.findings.map((f) => f.key)).not.toContain("wip");
  });

  it("spends no inference on a quiet period", async () => {
    await enable();
    let asked = false;
    deps.ai = {
      async embed() { return []; },
      async generate() { asked = true; return "something"; },
      async rerank() { return []; },
    } as unknown as Deps["ai"];
    const out = await narrateBoard(deps, user, BOARD, 14);
    expect(out.findings).toEqual([]);
    expect(out.source).toBe("plain");
    expect(asked).toBe(false);
  });

  it("still reports the movements with the feature switched off", async () => {
    for (let i = 0; i < 8; i++) await delivered(3, 2);
    await delivered(20, 2);
    deps.ai = model("unused") as unknown as Deps["ai"];
    const out = await narrateBoard(deps, user, BOARD, 14);
    // The numbers are the feature; the sentence is an addition to them.
    expect(out.source).toBe("plain");
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.text.length).toBeGreaterThan(0);
  });
});
