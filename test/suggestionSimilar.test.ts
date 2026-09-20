/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import type { VectorIndex } from "../src/ports";
import type { ListScope } from "../src/domain/access";
import { similarSuggestions } from "../src/services/suggestionSimilar";
import { vectorIdOf } from "../src/lib/vector";

// Grouping the suggestion box. No generation: this is the ticket-duplicate primitive pointed at a different
// wall, so the tests are about what comes back rather than about a model.
//
// Two properties carry the feature, and both are the kind that fail silently if nobody checks them:
//   SCOPE - a neighbour is re-decided against the caller's own suggestions list scope, so it can never
//   surface a suggestion their list would not have returned.
//   ANONYMITY - the answer carries no submitter for ANY neighbour, signed or not. A "who else asked for
//   this" feature would be a different feature, and on a box that offers anonymity it would break a promise
//   for the rows that used it.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

/** An index that answers with exactly the neighbours a test names, at the scores it names. */
function scriptedIndex(subjectId: string, neighbours: () => { id: string; score: number }[]): VectorIndex {
  return {
    async upsert() {},
    async query() { return neighbours(); },
    async fetch(ids: string[]) {
      const out = new Map<string, number[]>();
      if (ids.includes(vectorIdOf("suggestions", subjectId))) out.set(vectorIdOf("suggestions", subjectId), [0.1, 0.2, 0.3]);
      return out;
    },
    async remove() {},
  };
}

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.suggestionVotes, schema.suggestions, schema.settings, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "suggestions.similar": true } }) });
  deps.vectors = undefined;
});

async function seedEmployee(code: string, first: string): Promise<string> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.employees).values({ uuid, code, firstName: first, lastName: "T", workEmail: `${first.toLowerCase()}@test.example`, status: "active" });
  return uuid;
}

async function seedSuggestion(submitterId: string, code: string, title: string, over: Partial<typeof schema.suggestions.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.suggestions).values({
    uuid, code, title, body: "Please.", submitterId, status: "new", anonymous: false, ...over,
  });
  return uuid;
}

// Complete ListScope values rather than partials cast into shape: `applyScope` reading an absent `ownerId`
// as null silently widens or empties the predicate, which is the one thing these tests exist to check.
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true, subtrees: [] };
const own = (employeeId: string, deptCode: string): ListScope =>
  ({ breadth: "own", deptCode, ownerId: employeeId, seeRestricted: false, subtrees: [] });

describe("nothing to say", () => {
  it("returns [] with no index bound", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const id = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    expect(await similarSuggestions(deps, ALL, id)).toEqual([]);
  });

  it("returns [] while the org has the feature off", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const subject = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    const other = await seedSuggestion(me, "04-a01-s2", "Nicer coffee");
    await deps.db.update(schema.settings).set({ value: JSON.stringify({ features: { "suggestions.similar": false } }) });
    deps.vectors = scriptedIndex(subject, () => [{ id: vectorIdOf("suggestions", other), score: 0.99 }]);
    expect(await similarSuggestions(deps, ALL, subject)).toEqual([]);
  });

  it("returns [] when the suggestion has not been embedded yet", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const subject = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    deps.vectors = scriptedIndex("some-other-id", () => []);
    expect(await similarSuggestions(deps, ALL, subject)).toEqual([]);
  });

  it("never offers the suggestion itself", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const subject = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    deps.vectors = scriptedIndex(subject, () => [{ id: vectorIdOf("suggestions", subject), score: 1 }]);
    expect(await similarSuggestions(deps, ALL, subject)).toEqual([]);
  });

  it("ignores an id that is not a suggestion id", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const subject = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    deps.vectors = scriptedIndex(subject, () => [{ id: "compensation:whatever", score: 0.99 }, { id: "malformed", score: 0.98 }]);
    expect(await similarSuggestions(deps, ALL, subject)).toEqual([]);
  });
});

describe("what counts as the same ask", () => {
  it("offers a close neighbour and not a distant one", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const subject = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    const near = await seedSuggestion(me, "04-a01-s2", "Nicer coffee in the kitchen");
    const far = await seedSuggestion(me, "04-a01-s3", "Standing desks");

    deps.vectors = scriptedIndex(subject, () => [
      { id: vectorIdOf("suggestions", near), score: 0.93 },
      { id: vectorIdOf("suggestions", far), score: 0.40 },
    ]);
    const out = await similarSuggestions(deps, ALL, subject);
    expect(out.map((s) => s.path)).toEqual(["suggestions/" + near]);
  });

  it("leaves a soft-deleted suggestion out - there is nothing to merge into", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const subject = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    const gone = await seedSuggestion(me, "04-a01-s2", "Nicer coffee", { deleteTime: new Date() });
    deps.vectors = scriptedIndex(subject, () => [{ id: vectorIdOf("suggestions", gone), score: 0.99 }]);
    expect(await similarSuggestions(deps, ALL, subject)).toEqual([]);
  });

  it("carries net votes, so a moderator can see which way round to merge", async () => {
    const me = await seedEmployee("04-a01", "Ana");
    const voter = await seedEmployee("04-a02", "Bo");
    const subject = await seedSuggestion(me, "04-a01-s1", "Better coffee");
    const near = await seedSuggestion(me, "04-a01-s2", "Nicer coffee");
    await deps.db.insert(schema.suggestionVotes).values([
      { suggestionId: near, employeeId: me, value: 1 },
      { suggestionId: near, employeeId: voter, value: 1 },
    ]);

    deps.vectors = scriptedIndex(subject, () => [{ id: vectorIdOf("suggestions", near), score: 0.95 }]);
    const out = await similarSuggestions(deps, ALL, subject);
    expect(out[0]!.votes).toBe(2);
  });
});

describe("a neighbour the caller cannot list is not a neighbour", () => {
  it("is absent for an own-breadth caller", async () => {
    const ana = await seedEmployee("04-a01", "Ana");
    const bo = await seedEmployee("07-b01", "Bo");
    const subject = await seedSuggestion(ana, "04-a01-s1", "Better coffee");
    const mine = await seedSuggestion(ana, "04-a01-s2", "Nicer coffee");
    const theirs = await seedSuggestion(bo, "07-b01-s1", "Coffee upgrade");

    deps.vectors = scriptedIndex(subject, () => [
      { id: vectorIdOf("suggestions", theirs), score: 0.97 },
      { id: vectorIdOf("suggestions", mine), score: 0.95 },
    ]);

    // An HR-style caller who may list everything sees both.
    expect((await similarSuggestions(deps, ALL, subject)).map((s) => s.path).sort()).toEqual(["suggestions/" + mine, "suggestions/" + theirs].sort());

    // Ana, who may list only her own, sees only her own - however highly the index ranked the other.
    const asAna = await similarSuggestions(deps, own(ana, "04"), subject);
    expect(asAna.map((s) => s.path)).toEqual(["suggestions/" + mine]);
  });

  it("honours a per-object deny, even for a caller who may list everything", async () => {
    // A deny is the half of a scope that must never soften, and this surface is where it was softening: the
    // authz middleware loaded the caller's per-object exceptions for collection LISTS only, so on
    // `suggestions/<id>:similar` the scope arrived with an empty `denies` and a suggestion an ACL explicitly
    // hid from somebody came back to them as a neighbour, title and votes and all. The middleware now loads
    // them for the item verbs that list rows (SCOPE_READING_VERBS); this pins the half that binds them.
    const ana = await seedEmployee("04-a01", "Ana");
    const bo = await seedEmployee("07-b01", "Bo");
    const subject = await seedSuggestion(ana, "04-a01-s1", "Better coffee");
    const open = await seedSuggestion(bo, "07-b01-s1", "Coffee upgrade");
    const hidden = await seedSuggestion(bo, "07-b01-s2", "Coffee machine replacement");

    deps.vectors = scriptedIndex(subject, () => [
      { id: vectorIdOf("suggestions", hidden), score: 0.97 },
      { id: vectorIdOf("suggestions", open), score: 0.95 },
    ]);

    const denied = { ...ALL, denies: ["07-b01-s2"] };
    const out = await similarSuggestions(deps, denied, subject);
    expect(out.map((s) => s.path)).toEqual(["suggestions/" + open]);
    // Nothing of the denied row travels - not its title, which is the part a neighbour panel would show.
    expect(JSON.stringify(out)).not.toContain("replacement");
  });
});

describe("anonymity", () => {
  it("carries no submitter for any neighbour, anonymous or signed", async () => {
    const ana = await seedEmployee("04-a01", "Ana");
    const subject = await seedSuggestion(ana, "04-a01-s1", "Better coffee");
    const signed = await seedSuggestion(ana, "04-a01-s2", "Nicer coffee", { anonymous: false });
    const hidden = await seedSuggestion(ana, "04-a01-s3", "Coffee please", { anonymous: true });

    deps.vectors = scriptedIndex(subject, () => [
      { id: vectorIdOf("suggestions", signed), score: 0.95 },
      { id: vectorIdOf("suggestions", hidden), score: 0.94 },
    ]);
    const out = await similarSuggestions(deps, ALL, subject);
    expect(out).toHaveLength(2);
    // Not "the anonymous one is hidden" - NOBODY is named. The shape has no field for a submitter, and the
    // serialized answer must not carry the id in any form.
    expect(JSON.stringify(out)).not.toContain(ana);
    for (const s of out) expect(Object.keys(s).sort()).toEqual(["path", "score", "status", "title", "votes"]);
  });
});
