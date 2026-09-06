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
import { getPreference, listPreferences, upsertPreference } from "../src/services/preferences";

// A preference is one row per (person, key), and the person is not one session: a second tab, a phone, a
// window restored on sign-in. Writing "theme" from two of them at the same instant is the ordinary case, not
// an exotic one, so the write has to be a single conflict-resolving statement rather than a look-then-insert.
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.preferences, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: "employee", label: "Employee" }).onConflictDoNothing();
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role: "employee" });
  return { uuid, email: `${uuid}@test.example`, role: "employee", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;
}

describe("a person's preferences", () => {
  it("keeps one row per key, replacing the value", async () => {
    const actor = await seedActor();
    const first = await upsertPreference(deps, actor, "theme", { mode: "dark" });
    const second = await upsertPreference(deps, actor, "theme", { mode: "light" });

    expect(second.uuid).toBe(first.uuid); // the same row, rewritten
    expect(JSON.parse((await getPreference(deps, actor, "theme")).value)).toEqual({ mode: "light" });
    const { items } = await listPreferences(deps, actor);
    expect(items).toHaveLength(1);
  });

  it("survives two of the person's sessions writing the same key at once", async () => {
    const actor = await seedActor();
    // Both writes read and write across the same await points, so neither can see the other's row before
    // inserting - which is exactly what the two tabs do, and what a look-then-insert would 500 on.
    const [a, z] = await Promise.all([
      upsertPreference(deps, actor, "theme", { mode: "dark" }),
      upsertPreference(deps, actor, "theme", { mode: "light" }),
    ]);

    expect(a.uuid).toBe(z.uuid);
    const rows = await deps.db.select().from(schema.preferences);
    expect(rows).toHaveLength(1);
    // One of the two won; which one is a race, and either answer is correct.
    expect([{ mode: "dark" }, { mode: "light" }]).toContainEqual(JSON.parse(rows[0]!.value));
  });

  it("scopes a key to its owner", async () => {
    const mine = await seedActor();
    const theirs = await seedActor();
    await upsertPreference(deps, mine, "tabs", { pinned: ["leave"] });
    await upsertPreference(deps, theirs, "tabs", { pinned: ["payroll"] });

    expect(JSON.parse((await getPreference(deps, mine, "tabs")).value)).toEqual({ pinned: ["leave"] });
    expect((await listPreferences(deps, theirs)).items).toHaveLength(1);
  });
});
