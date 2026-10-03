/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { AppEnv, Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { idempotency, sweepIdempotencyKeys } from "../src/middleware/idempotency";
import { errorHandler } from "../src/middleware/errorHandler";
import { invalidArgument } from "../src/lib/errors";

// A write re-sent with the same Idempotency-Key must land once, and the repeat must be handed the first
// copy's answer. That is the property that lets the SPA retry a create or a `:submit` whose connection dropped
// without risking a duplicate - so it is pinned against the middleware alone, with a handler that counts.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const b = env as unknown as Bindings;
let deps: Deps;
let runs = 0;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

beforeEach(async () => {
  runs = 0;
  await deps.db.delete(schema.idempotencyKeys);
});

function appAs(userId: string) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("user", { uuid: userId } as never);
    c.set("deps", deps);
    await next();
  });
  app.use("*", idempotency);
  app.post("/v1/things", (c) => c.json({ n: ++runs }, 200, { ETag: `"v${runs}"` }));
  app.post("/v1/refused", () => {
    runs++;
    throw invalidArgument("no");
  });
  app.post("/v1/empty", (c) => {
    runs++;
    return c.body(null, 204);
  });
  return app;
}

const post = (app: Hono<AppEnv>, path: string, key?: string) =>
  app.request(path, { method: "POST", headers: key ? { "Idempotency-Key": key } : {} });

describe("Idempotency-Key", () => {
  it("runs a keyed write once and replays its answer, headers included", async () => {
    const app = appAs("u1");
    const first = await post(app, "/v1/things", "key-aaaaaaaa");
    const second = await post(app, "/v1/things", "key-aaaaaaaa");
    expect(runs).toBe(1);
    expect(await first.json()).toEqual({ n: 1 });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ n: 1 });
    expect(second.headers.get("ETag")).toBe('"v1"');
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
  });

  it("leaves an unkeyed write alone", async () => {
    const app = appAs("u1");
    await post(app, "/v1/things");
    await post(app, "/v1/things");
    expect(runs).toBe(2);
    expect(await deps.db.select().from(schema.idempotencyKeys)).toHaveLength(0);
  });

  it("keeps only successes: a refusal releases the key, so the repeat runs fresh", async () => {
    const app = appAs("u1");
    expect((await post(app, "/v1/refused", "key-bbbbbbbb")).status).toBe(400);
    expect((await post(app, "/v1/refused", "key-bbbbbbbb")).status).toBe(400);
    expect(runs).toBe(2);
    expect(await deps.db.select().from(schema.idempotencyKeys)).toHaveLength(0);
  });

  it("replays a 204 with no body", async () => {
    const app = appAs("u1");
    await post(app, "/v1/empty", "key-cccccccc");
    const again = await post(app, "/v1/empty", "key-cccccccc");
    expect(runs).toBe(1);
    expect(again.status).toBe(204);
  });

  it("refuses a key reused for a different request", async () => {
    const app = appAs("u1");
    await post(app, "/v1/things", "key-dddddddd");
    const other = await post(app, "/v1/empty", "key-dddddddd");
    expect(other.status).toBe(400);
    expect(runs).toBe(1);
  });

  it("scopes a key to its principal: another person's same key is a different write", async () => {
    await post(appAs("u1"), "/v1/things", "key-eeeeeeee");
    await post(appAs("u2"), "/v1/things", "key-eeeeeeee");
    expect(runs).toBe(2);
  });

  it("answers a copy arriving mid-flight with 409 and Retry-After", async () => {
    const app = appAs("u1");
    await deps.db.insert(schema.idempotencyKeys).values({ principal: "u:u1", key: "key-ffffffff", method: "POST", path: "/v1/things", status: 0, createdAt: new Date() });
    const res = await post(app, "/v1/things", "key-ffffffff");
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(runs).toBe(0);
  });

  it("refuses a malformed key", async () => {
    expect((await post(appAs("u1"), "/v1/things", "bad key!")).status).toBe(400);
    expect(runs).toBe(0);
  });

  it("sweeps keys older than a day", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await deps.db.insert(schema.idempotencyKeys).values([
      { principal: "u:u1", key: "old-aaaaaaaa", method: "POST", path: "/v1/things", status: 200, createdAt: old },
      { principal: "u:u2", key: "old-bbbbbbbb", method: "POST", path: "/v1/things", status: 200, createdAt: old },
      { principal: "u:u1", key: "new-aaaaaaaa", method: "POST", path: "/v1/things", status: 200, createdAt: new Date() },
    ]);
    expect(await sweepIdempotencyKeys(deps)).toBe(2);
    expect((await deps.db.select().from(schema.idempotencyKeys)).map((r) => r.key)).toEqual(["new-aaaaaaaa"]);
  });

  // D1 bills every index entry as a written row, and each key row is inserted, updated and swept. The primary key
  // is the only index the lookups need; another one costs a write on every claim and every sweep.
  it("indexes the table by its primary key alone", async () => {
    const { results } = await b.DB.prepare("PRAGMA index_list(`idempotency_keys`)").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["sqlite_autoindex_idempotency_keys_1"]);
  });
});
