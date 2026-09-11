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
import { getPreference, listPreferences, upsertPreference, MAX_PREFERENCE_BYTES, MAX_PREFERENCE_KEYS } from "../src/services/preferences";
import { PUSH_PREF_KEY, MAX_PUSH_DEVICES } from "../src/services/webPush";

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

// The value is `z.unknown()` at the route, which is the right contract for a store whose payloads are the
// client's business - and was the whole ceiling on it. What follows is the part that is NOT the client's
// business: the size of what lands in D1, how many rows one account may create, and the one key whose
// contents the SERVER acts on.
describe("what a preference may contain", () => {
  it("refuses a value larger than the cap", async () => {
    const actor = await seedActor();
    // Under the cap: fine. Over it: an invalid_argument the caller can act on, rather than the D1 row-size
    // error surfacing through the generic 500 branch, about a limit nothing stated.
    await expect(upsertPreference(deps, actor, "layout", { pad: "x".repeat(MAX_PREFERENCE_BYTES - 100) })).resolves.toBeTruthy();
    await expect(upsertPreference(deps, actor, "layout", { pad: "x".repeat(MAX_PREFERENCE_BYTES) })).rejects.toThrow(/too large/i);
  });

  it("caps how many keys one account may hold, but never blocks a rewrite", async () => {
    const actor = await seedActor();
    for (let i = 0; i < MAX_PREFERENCE_KEYS; i++) await upsertPreference(deps, actor, `k${i}`, { i });
    await expect(upsertPreference(deps, actor, "one-more", {})).rejects.toThrow(/at most/i);
    // A key the person already holds is a rewrite, not a new row, so the cap must not touch it.
    await expect(upsertPreference(deps, actor, "k0", { i: "rewritten" })).resolves.toBeTruthy();
  });

  it("refuses a push subscription the Worker must not fetch", async () => {
    const actor = await seedActor();
    const keys = { p256dh: "BPub", auth: "AAuth" };
    // `push_subscriptions` is the one key whose value becomes an OUTBOUND REQUEST (services/webPush.ts sends
    // to `endpoint`). Unvalidated, any signed-in employee could point the Worker at anything and trigger it
    // by provoking a notification about themselves. Judged by the app's own SSRF guard (lib/urlGuard.ts).
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc", // not https
      "https://127.0.0.1/push", // loopback
      "https://169.254.169.254/latest/meta-data/", // cloud metadata
      "https://[::ffff:127.0.0.1]/push", // loopback in a v6 spelling
      "https://fcm.googleapis.com:8080/fcm/send/abc", // a non-https port on a public host
      "https://localhost/push",
      "https://queue.internal/push",
    ]) {
      await expect(upsertPreference(deps, actor, PUSH_PREF_KEY, { subs: [{ endpoint, keys }] })).rejects.toThrow(/public host/i);
    }
    // A real push endpoint still goes through untouched.
    await expect(
      upsertPreference(deps, actor, PUSH_PREF_KEY, { subs: [{ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }] }),
    ).resolves.toBeTruthy();
  });

  it("refuses a malformed or oversized push registry", async () => {
    const actor = await seedActor();
    const sub = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc", keys: { p256dh: "BPub", auth: "AAuth" } };
    await expect(upsertPreference(deps, actor, PUSH_PREF_KEY, { subs: "nope" })).rejects.toThrow(/subs/i);
    await expect(upsertPreference(deps, actor, PUSH_PREF_KEY, { subs: [{ endpoint: sub.endpoint }] })).rejects.toThrow(/keys/i);
    await expect(
      upsertPreference(deps, actor, PUSH_PREF_KEY, { subs: Array.from({ length: MAX_PUSH_DEVICES + 1 }, () => sub) }),
    ).rejects.toThrow(/at most/i);
    // Every other key stays free-form: that is the contract, and only this one is acted on server-side.
    await expect(upsertPreference(deps, actor, "anything", { deeply: { nested: [1, 2, 3] } })).resolves.toBeTruthy();
  });
});
