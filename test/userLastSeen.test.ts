/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clearCache } from "../src/lib/cache";
import { LAST_USED_THROTTLE_MS } from "../src/services/apiKeys";
import { app } from "../src/index";

// `users.last_seen_at` answers the one question the audit log cannot: an account that only ever READS leaves
// no audit rows, and a dormant privileged account is exactly the account worth finding. So the stamp has to
// be written by the middleware, on every lane, for every request - and that is also what makes it dangerous:
// a write per request would put a D1 write on every call in the app.
//
// The two properties are therefore in tension, and both are pinned here: it is written (so the field means
// something), and it is written at most once per throttle window (so it costs almost nothing). The throttle
// is also the field's accuracy - it answers "today / last week / never", not "at 09:41:03".
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.accessRules, schema.auditLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee" }]);
  await deps.db.insert(schema.accessRules).values([
    { subject: "employee", subjectKind: "role", namespace: "users", pattern: "users.me.**", scopeKind: "self", scopeCode: "", matchCode: null, level: "read", effect: "allow" },
  ]);
  clearCache();
});

async function seedPerson(email: string) {
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: "04-001-001", firstName: "Ada", lastName: "Test", workEmail: email, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role: "employee", employeeId });
  return uuid;
}

const lastSeen = (userId: string) =>
  deps.db.select({ at: schema.users.lastSeenAt }).from(schema.users).where(eq(schema.users.uuid, userId)).limit(1).then((r) => r[0]!.at);

/** One authenticated request through the real middleware chain, as `email` (the dev-auth lane). */
const asUser = (email: string, path = "/v1/users/me") =>
  app.request(path, { headers: { "X-Requested-By": "hrms-spa" } }, { ...(b as unknown as Record<string, unknown>), DEV_FAKE_EMAIL: email });

describe("users.last_seen_at", () => {
  it("is empty on an account that has never made a request", async () => {
    const id = await seedPerson("ada@test.example");
    expect(await lastSeen(id)).toBeNull();
  });

  it("is stamped by the first request", async () => {
    const id = await seedPerson("ada@test.example");
    await asUser("ada@test.example");
    expect(await lastSeen(id)).not.toBeNull();
  });

  it("does not write again inside the throttle window", async () => {
    const id = await seedPerson("ada@test.example");
    await asUser("ada@test.example");
    const first = +new Date((await lastSeen(id))!);

    // A browsing user makes dozens of requests a minute. None of them may cost a write.
    await asUser("ada@test.example");
    await asUser("ada@test.example");
    expect(+new Date((await lastSeen(id))!)).toBe(first);
  });

  it("writes again once the window has passed", async () => {
    const id = await seedPerson("ada@test.example");
    await asUser("ada@test.example");
    const first = +new Date((await lastSeen(id))!);

    // Age the stamp past the throttle rather than waiting fifteen minutes.
    await deps.db.update(schema.users).set({ lastSeenAt: new Date(first - LAST_USED_THROTTLE_MS - 1000) }).where(eq(schema.users.uuid, id));
    await asUser("ada@test.example");
    expect(+new Date((await lastSeen(id))!)).toBeGreaterThan(first - LAST_USED_THROTTLE_MS);
  });

  it("leaves update_time alone - being seen is not being edited", async () => {
    const id = await seedPerson("ada@test.example");
    const before = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, id)).limit(1))[0]!.updatedAt;
    await asUser("ada@test.example");
    const after = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, id)).limit(1))[0]!.updatedAt;
    // The column carries `$onUpdateFn`, so the obvious one-column write re-stamps it - and with it the row's
    // ETag - every fifteen minutes that somebody merely browses. `GET /v1/users` is a conditional, list-ETag'd
    // read, so every client's cached user list would be invalidated by activity that changed nothing in it,
    // and the record would read in the UI as one somebody edited. This is the assertion that caught it.
    expect(+new Date(after!)).toBe(+new Date(before!));
    // ...and the stamp it was suppressing the hook FOR still landed.
    expect(await lastSeen(id)).not.toBeNull();
  });
});
