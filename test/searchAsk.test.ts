/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { parseAskAnswer } from "../src/domain/searchAsk";
import { askSearch } from "../src/services/searchAsk";
import { openLabel, pruneInsights, recordInsight, zeroLabel } from "../src/services/searchInsights";

// ⌘K's Ask (domain/searchAsk.ts) and the usage counters behind Search insights (services/searchInsights.ts).
// What is worth holding: Ask only ever names a destination it was offered, sees no record, and says so
// readably when it cannot answer; the counters keep no identifier and never grow a row per event.

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

const OFFERED = new Set(["action:leave", "reimbursements", "settings/leave-types"]);

describe("parseAskAnswer", () => {
  it("keeps only destinations that were offered, once each, at most three", () => {
    const raw = JSON.stringify({
      destinations: [
        { key: "reimbursements", why: "File the claim here" },
        { key: "admin/secret-page", why: "Invented" },
        { key: "reimbursements", why: "Again" },
        { key: "action:leave", why: "Apply for leave" },
        { key: "settings/leave-types", why: "See the types" },
      ],
      search: null,
    });
    expect(parseAskAnswer(raw, OFFERED)).toEqual({
      destinations: [
        { key: "reimbursements", why: "File the claim here" },
        { key: "action:leave", why: "Apply for leave" },
        { key: "settings/leave-types", why: "See the types" },
      ],
      search: null,
    });
  });

  it("reads a fenced answer and reduces search to plain words", () => {
    const raw = '```json\n{"destinations":[],"search":"internet \\"bill\\" OR 1=1"}\n```';
    expect(parseAskAnswer(raw, OFFERED)).toEqual({ destinations: [], search: "internet bill OR 1 1" });
  });

  it("refuses prose and extra keys rather than reading part of them", () => {
    expect(parseAskAnswer("Go to the reimbursements page.", OFFERED)).toBeNull();
    expect(parseAskAnswer('{"destinations":[],"search":null,"answer":"42"}', OFFERED)).toBeNull();
  });
});

describe("askSearch", () => {
  const ME = genId();
  const USER = genId();
  const user = { uuid: USER, employeeId: ME } as unknown as AppUser;
  const destinations = [
    { key: "reimbursements", label: "Reimbursements", group: "Money" },
    { key: "action:leave", label: "Request leave", group: "Action" },
  ];
  const TABLES = [schema.aiUsage, schema.aiCache, schema.searchInsights, schema.users, schema.employees, schema.settings];

  beforeEach(async () => {
    for (const t of TABLES) await deps.db.delete(t);
    await deps.db.insert(schema.employees).values({ uuid: ME, code: "04-001-001", firstName: "Me", lastName: "X", workEmail: "me@x.test", status: "active" });
    await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
    await deps.db.insert(schema.users).values({ uuid: USER, code: "u-sa", email: "me@x.test", role: "employee", employeeId: ME });
    deps.ai = undefined;
  });

  const enable = () => deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "search.ask": true } }) });
  const model = (answer: string, seen: string[] = []) => ({
    async embed() { return []; },
    async generate(req: { system: string; user: string }) { seen.push(`${req.system}\n${req.user}`); return answer; },
    async rerank() { return []; },
  }) as unknown as Deps["ai"];

  it("routes a question to an offered destination, and shows the model only the question and the names", async () => {
    await enable();
    const seen: string[] = [];
    deps.ai = model('{"destinations":[{"key":"reimbursements","why":"Claim it here"}],"search":null}', seen);
    const out = await askSearch(deps, user, "how do I claim my internet bill ABCDE1234F", destinations);
    expect(out.destinations).toEqual([{ key: "reimbursements", why: "Claim it here" }]);
    const prompt = seen.join("\n");
    expect(prompt).toContain("claim my internet bill");
    expect(prompt).toContain("reimbursements | Reimbursements | Money");
    expect(prompt).not.toContain("ABCDE1234F"); // a pasted PAN is scrubbed before it is sent
    const [counted] = await deps.db.select().from(schema.searchInsights).where(eq(schema.searchInsights.kind, "ask"));
    expect(counted).toMatchObject({ label: "answered", count: 1 });
  });

  it("refuses readably when Ask is switched off, and sends nothing", async () => {
    const seen: string[] = [];
    deps.ai = model("{}", seen);
    await expect(askSearch(deps, user, "where are my payslips", destinations)).rejects.toThrow(/switched off/);
    expect(seen).toEqual([]);
  });

  it("says the model could not be understood rather than answering nothing", async () => {
    await enable();
    deps.ai = model("You should look at payroll.");
    await expect(askSearch(deps, user, "where are my payslips", destinations)).rejects.toThrow(/did not answer/);
  });
});

describe("search insights", () => {
  beforeEach(async () => {
    await deps.db.delete(schema.searchInsights);
  });

  it("keeps a zero-result query only when it carries no identifier", () => {
    expect(zeroLabel("  Work   From Home ")).toBe("work from home");
    expect(zeroLabel("ABCDE1234F")).toBeNull(); // a PAN
    expect(zeroLabel("account 123456789012")).toBeNull(); // a long number
    expect(zeroLabel("priya@example.com")).toBeNull();
    expect(zeroLabel("ab")).toBeNull();
  });

  it("buckets an opened result's position", () => {
    expect([0, 1, 2, 3, 9, 10].map((p) => openLabel("keyword", p))).toEqual(["keyword:1", "keyword:2-3", "keyword:2-3", "keyword:4-10", "keyword:4-10", "keyword:11+"]);
    expect(openLabel("somewhere", 0)).toBeNull();
  });

  it("counts into one row per day, kind and label", async () => {
    for (let i = 0; i < 3; i++) await recordInsight(deps, "zero", "work from home");
    const rows = await deps.db.select().from(schema.searchInsights);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
  });

  it("drops counters past the retention window", async () => {
    await deps.db.insert(schema.searchInsights).values([
      { uuid: genId(), day: "2020-01-01", kind: "zero", label: "old", count: 1, createdAt: new Date(), updatedAt: new Date() },
      { uuid: genId(), day: new Date().toISOString().slice(0, 10), kind: "zero", label: "new", count: 1, createdAt: new Date(), updatedAt: new Date() },
    ]);
    expect(await pruneInsights(deps)).toBe(1);
    expect((await deps.db.select().from(schema.searchInsights)).map((r) => r.label)).toEqual(["new"]);
  });
});
