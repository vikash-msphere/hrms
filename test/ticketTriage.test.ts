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
import type { VectorIndex } from "../src/ports";
import type { ListScope } from "../src/domain/access";
import { suggestTriage, decideTriage, vote } from "../src/services/ticketTriage";
import { vectorIdOf } from "../src/lib/vector";

// Ticket triage: nearest-neighbour vote, no generation anywhere.
//
// The property this file exists for is the access one. The vector index knows nothing about who may read a
// ticket, so if a neighbour reached the caller on the index's say-so, triage would be a way to read other
// people's tickets - and a subtler one than it looks, because a suggestion does not have to SHOW a ticket to
// leak it. "4 of the 7 nearest resolved tickets say Facilities" is a fact about rows the caller may not see.
// So the tests below check the counts as well as the links.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

/** An index that returns exactly the ids a test names, in order, and holds a vector for the subject ticket. */
function scriptedIndex(subjectId: string, neighbours: () => { id: string; score: number }[]): VectorIndex {
  return {
    async upsert() {},
    async query() { return neighbours(); },
    async fetch(ids: string[]) {
      const out = new Map<string, number[]>();
      // Only the subject is "indexed"; a test that wants the not-yet-embedded case passes a different id.
      if (ids.includes(vectorIdOf("tickets", subjectId))) out.set(vectorIdOf("tickets", subjectId), [0.1, 0.2, 0.3]);
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
  // Triage defaults to OFF for the org: binding a model is an operator's act, deciding it may read the org's
  // ticket text is a separate one. Every test below is about what happens after that decision is made; the
  // "off" behaviour has its own test, which clears this.
  await deps.db.insert(schema.settings).values({ key: "ai", value: JSON.stringify({ features: { "tickets.triage": true } }) }).onConflictDoNothing();
});

const TABLES = [schema.aiSuggestions, schema.tickets, schema.departments, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  deps.vectors = undefined;
});

async function seedPerson(code: string, first: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code, firstName: first, lastName: "Test",
    workEmail: `${first.toLowerCase()}@test.example`, status: "active",
  });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${first.toLowerCase()}@test.example`, role: "employee", employeeId });
  return { uuid, email: `${first.toLowerCase()}@test.example`, role: "employee", status: "active", employeeId, employeeCode: code, name: first } as AppUser;
}

async function seedDept(name: string): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.departments).values({ uuid, code: name.slice(0, 2).toLowerCase(), name });
  return uuid;
}

async function seedTicket(owner: AppUser, code: string, over: Partial<typeof schema.tickets.$inferInsert> = {}): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.tickets).values({
    uuid, code, employeeId: owner.employeeId!, subject: "Laptop overheating", description: "fan noise",
    state: "RESOLVED", priority: "high", category: "hardware", ...over,
  });
  return uuid;
}

// Breadth "all" = an agent who may list every ticket. Breadth "own" = a requester who may list only theirs.
//
// Built as complete `ListScope` values rather than cast from a partial: a cast would compile with a field
// missing, and `applyScope` reading an absent `ownerId` as null would silently widen or empty the predicate -
// which is the one thing these tests are here to check. Every field is spelled out so a change to the type
// fails here instead of quietly changing what "own" means.
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true, subtrees: [] };
const own = (user: AppUser): ListScope => ({
  breadth: "own",
  deptCode: user.employeeCode?.split("-")[0] ?? null,
  ownerId: user.employeeId,
  seeRestricted: false,
  subtrees: [],
});

describe("nothing to suggest", () => {
  it("returns null with no index bound", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const subject = await seedTicket(alice, "04-a01-t1", { state: "OPEN" });
    expect(await suggestTriage(deps, ALL, subject)).toBeNull();
  });

  it("returns null when the ticket is not embedded yet", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const subject = await seedTicket(alice, "04-a01-t1", { state: "OPEN" });
    // The drain runs every five minutes; a ticket filed seconds ago is normally absent, and that is not an error.
    deps.vectors = scriptedIndex("some-other-ticket", () => []);
    expect(await suggestTriage(deps, ALL, subject)).toBeNull();
  });

  it("returns null while the org has the feature off", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const d = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: d });
    const n2 = await seedTicket(alice, "04-a01-t2", { departmentId: d });
    deps.vectors = scriptedIndex(subject, () => [n1, n2].map((id) => ({ id: vectorIdOf("tickets", id), score: 0.9 })));

    await deps.db.update(schema.settings).set({ value: JSON.stringify({ features: { "tickets.triage": false } }) }).where(eq(schema.settings.key, "ai"));
    try {
      // Off must behave exactly as an absent binding: no suggestion, and no row written either.
      expect(await suggestTriage(deps, ALL, subject)).toBeNull();
      expect(await deps.db.select().from(schema.aiSuggestions)).toEqual([]);
    } finally {
      await deps.db.update(schema.settings).set({ value: JSON.stringify({ features: { "tickets.triage": true } }) }).where(eq(schema.settings.key, "ai"));
    }
  });

  it("returns null when the index throws", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const subject = await seedTicket(alice, "04-a01-t1", { state: "OPEN" });
    deps.vectors = {
      async upsert() {}, async remove() {},
      async fetch() { return new Map([[vectorIdOf("tickets", subject), [0.1, 0.2, 0.3]]]); },
      async query() { throw new Error("index down"); },
    };
    expect(await suggestTriage(deps, ALL, subject)).toBeNull();
  });
});

describe("the vote", () => {
  it("suggests the department the resolved neighbours agree on, and says how many", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const facilities = await seedDept("Facilities");
    const it_ = await seedDept("IT");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN", category: null, departmentId: null });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: facilities });
    const n2 = await seedTicket(alice, "04-a01-t2", { departmentId: facilities });
    const n3 = await seedTicket(alice, "04-a01-t3", { departmentId: it_ });

    deps.vectors = scriptedIndex(subject, () => [n1, n2, n3].map((id, i) => ({ id: vectorIdOf("tickets", id), score: 0.9 - i / 100 })));
    const out = (await suggestTriage(deps, ALL, subject))!;
    expect(out.department).toEqual({ value: facilities, votes: 2, of: 3 });
    expect(out.basis.length).toBe(3);
  });

  it("says nothing on a tie rather than breaking it", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const a = await seedDept("Facilities");
    const c = await seedDept("IT");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: a });
    const n2 = await seedTicket(alice, "04-a01-t2", { departmentId: a });
    const n3 = await seedTicket(alice, "04-a01-t3", { departmentId: c });
    const n4 = await seedTicket(alice, "04-a01-t4", { departmentId: c });

    deps.vectors = scriptedIndex(subject, () => [n1, n2, n3, n4].map((id) => ({ id: vectorIdOf("tickets", id), score: 0.9 })));
    const out = await suggestTriage(deps, ALL, subject);
    expect(out?.department ?? null).toBeNull();
  });

  it("says nothing on a single vote", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const d = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: d, category: "hardware" });

    deps.vectors = scriptedIndex(subject, () => [{ id: vectorIdOf("tickets", n1), score: 0.9 }]);
    const out = await suggestTriage(deps, ALL, subject);
    expect(out?.department ?? null).toBeNull();
  });

  it("only RESOLVED neighbours vote", async () => {
    // An open ticket's department is somebody's unconfirmed guess. Letting those vote would let one
    // mis-routed ticket teach the system to mis-route the next one.
    const alice = await seedPerson("04-a01", "Alice");
    const d = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: d, state: "OPEN" });
    const n2 = await seedTicket(alice, "04-a01-t2", { departmentId: d, state: "IN_PROGRESS" });

    deps.vectors = scriptedIndex(subject, () => [n1, n2].map((id) => ({ id: vectorIdOf("tickets", id), score: 0.5 })));
    const out = await suggestTriage(deps, ALL, subject);
    expect(out?.department ?? null).toBeNull();
  });

  it("never votes for itself", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const d = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "RESOLVED", departmentId: d });
    deps.vectors = scriptedIndex(subject, () => [{ id: vectorIdOf("tickets", subject), score: 1 }]);
    expect(await suggestTriage(deps, ALL, subject)).toBeNull();
  });
});

describe("access: a neighbour the caller cannot list contributes nothing", () => {
  it("is absent from the vote, the counts and the basis", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const bob = await seedPerson("07-b01", "Bob");
    const facilities = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN", departmentId: null });
    // Two of Bob's resolved tickets agree on Facilities. Alice may not list them.
    const hidden1 = await seedTicket(bob, "07-b01-t1", { departmentId: facilities });
    const hidden2 = await seedTicket(bob, "07-b01-t2", { departmentId: facilities });
    const mine = await seedTicket(alice, "04-a01-t1", { departmentId: facilities });

    deps.vectors = scriptedIndex(subject, () => [hidden1, hidden2, mine].map((id) => ({ id: vectorIdOf("tickets", id), score: 0.9 })));

    // As an agent who may list everything: three neighbours vote, and the suggestion stands.
    const asAgent = (await suggestTriage(deps, ALL, subject))!;
    expect(asAgent.department).toEqual({ value: facilities, votes: 3, of: 3 });

    // As Alice, who may list only her own: one neighbour survives the re-check, which is under the floor, so
    // there is no suggestion at all - and crucially no "2 of 3" citing tickets she cannot see.
    const asAlice = await suggestTriage(deps, own(alice), subject);
    expect(asAlice?.department ?? null).toBeNull();
    const basisIds = (asAlice?.basis ?? []).map((n) => n.id);
    expect(basisIds).not.toContain(hidden1);
    expect(basisIds).not.toContain(hidden2);
  });

  it("does not offer a duplicate the caller cannot read", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const bob = await seedPerson("07-b01", "Bob");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const bobsOpen = await seedTicket(bob, "07-b01-t1", { state: "OPEN", subject: "Bob's private problem" });

    deps.vectors = scriptedIndex(subject, () => [{ id: vectorIdOf("tickets", bobsOpen), score: 0.99 }]);
    const out = await suggestTriage(deps, own(alice), subject);
    expect((out?.duplicates ?? []).map((d) => d.id)).not.toContain(bobsOpen);
  });

  it("ignores an id that is not a ticket id at all", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    deps.vectors = scriptedIndex(subject, () => [
      { id: "compensation:whatever", score: 0.99 },
      { id: "malformed", score: 0.98 },
    ]);
    expect(await suggestTriage(deps, ALL, subject)).toBeNull();
  });
});

describe("duplicates", () => {
  it("offers a close OPEN neighbour and not a distant one", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const near = await seedTicket(alice, "04-a01-t1", { state: "OPEN", subject: "Laptop runs hot" });
    const far = await seedTicket(alice, "04-a01-t2", { state: "OPEN", subject: "Printer jam" });

    deps.vectors = scriptedIndex(subject, () => [
      { id: vectorIdOf("tickets", near), score: 0.93 },
      { id: vectorIdOf("tickets", far), score: 0.40 },
    ]);
    const out = (await suggestTriage(deps, ALL, subject))!;
    expect(out.duplicates.map((d) => d.id)).toEqual([near]);
  });
});

describe("the suggestion record", () => {
  it("is written pending, and recomputation supersedes a decision", async () => {
    const alice = await seedPerson("04-a01", "Alice");
    const d = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: d });
    const n2 = await seedTicket(alice, "04-a01-t2", { departmentId: d });
    deps.vectors = scriptedIndex(subject, () => [n1, n2].map((id) => ({ id: vectorIdOf("tickets", id), score: 0.9 })));

    await suggestTriage(deps, ALL, subject);
    const [row] = await deps.db.select().from(schema.aiSuggestions);
    expect(row!.state).toBe("pending");
    expect(row!.feature).toBe("tickets.triage");
    expect(row!.basis).toBe(2);

    await decideTriage(deps, alice, subject, true);
    const [decided] = await deps.db.select().from(schema.aiSuggestions);
    expect(decided!.state).toBe("accepted");
    expect(decided!.decidedBy).toBe(alice.uuid);

    // Recomputing replaces the content, so the old verdict is about a suggestion that no longer exists and is
    // cleared with it rather than left attached to different evidence.
    await suggestTriage(deps, ALL, subject);
    const rows = await deps.db.select().from(schema.aiSuggestions);
    expect(rows.length).toBe(1); // replaced, not stacked
    expect(rows[0]!.state).toBe("pending");
    expect(rows[0]!.decidedBy).toBeNull();
  });

  it("decide does not touch the ticket", async () => {
    // Applying a suggestion is the UI calling `:route` / `:prioritize`. If this ever started writing the
    // ticket itself, an accept would bypass those services' validation and their audit rows.
    const alice = await seedPerson("04-a01", "Alice");
    const d = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN", departmentId: null, priority: "low" });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: d });
    const n2 = await seedTicket(alice, "04-a01-t2", { departmentId: d });
    deps.vectors = scriptedIndex(subject, () => [n1, n2].map((id) => ({ id: vectorIdOf("tickets", id), score: 0.9 })));

    await suggestTriage(deps, ALL, subject);
    await decideTriage(deps, alice, subject, true);

    const [ticket] = await deps.db.select().from(schema.tickets).where(eq(schema.tickets.uuid, subject));
    expect(ticket!.departmentId).toBeNull();
    expect(ticket!.priority).toBe("low");
  });
});

describe("no model is ever called", () => {
  it("produces a suggestion with no AI binding at all", async () => {
    // The whole feature is a vector lookup and a count. `deps.ai` is left undefined here on purpose: if a
    // generation ever crept in, this test would start failing rather than quietly spending neurons.
    const alice = await seedPerson("04-a01", "Alice");
    const d = await seedDept("Facilities");
    const subject = await seedTicket(alice, "04-a01-t0", { state: "OPEN" });
    const n1 = await seedTicket(alice, "04-a01-t1", { departmentId: d });
    const n2 = await seedTicket(alice, "04-a01-t2", { departmentId: d });
    deps.ai = undefined;
    deps.vectors = scriptedIndex(subject, () => [n1, n2].map((id) => ({ id: vectorIdOf("tickets", id), score: 0.9 })));

    const out = (await suggestTriage(deps, ALL, subject))!;
    expect(out.department!.value).toBe(d);
    expect(await deps.db.select().from(schema.aiUsage)).toEqual([]);
  });
});

describe("vote() in isolation", () => {
  it("refuses empties, singles and ties; accepts a plurality", () => {
    expect(vote([])).toBeNull();
    expect(vote([null, null])).toBeNull();
    expect(vote(["a"])).toBeNull();
    expect(vote(["a", "b"])).toBeNull(); // tie at one each, and under the floor besides
    expect(vote(["a", "a", "b", "b"])).toBeNull(); // tie at two each
    expect(vote(["a", "a", "b"])).toEqual({ value: "a", votes: 2, of: 3 });
    expect(vote(["a", "a", null])).toEqual({ value: "a", votes: 2, of: 2 }); // nulls are not candidates
  });
});
