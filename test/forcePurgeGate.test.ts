/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
// `?force=true` is the ONE parameter in the app that raises a request's required level: it turns a `write`
// soft delete into an `admin` hard purge, cascading to every FK child the collection declares. The gate that
// decides the lift (middleware/authz.ts) and the handler that performs it (http/collectionRoute.ts) are in
// different files reading the same parameter, and they once read it with different parsers.
//
// `new URL(url).searchParams` splits the fragment off first; Hono's `c.req.query()` (before 4.13.5,
// GHSA-crvj-82cr-hjcx) scanned the raw string to the end. So `DELETE /v1/holidays/<id>#?force=true` was gated
// as an ordinary write and executed as a hard purge - a caller holding only `write` could permanently destroy
// rows, and the same split slipped past the API-key scope ceiling, which is computed from the same `force`.
//
// Two things keep that shut, and this suite is what proves BOTH rather than trusting either:
//   - package.json pins hono >= 4.13.5, so its parser drops the fragment too;
//   - the handler reads `force` through http/query.ts, the same parser the gate used.
// Either alone would hold today. The test is written against the OBSERVABLE outcome - was the row purged -
// so it fails whichever of the two is undone.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";

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
  await seedManifest(b.DB);
  deps = makeDeps(b);
});

const DEV_EMAIL = "dev@example.com"; // the dev-auth bypass (vitest.config.ts) is the ambient credential
const CLEAR = [schema.auditLog, schema.holidays, schema.accessRules, schema.users, schema.roles];

/**
 * Seed the caller with `level` on holidays and nothing else.
 *
 * A DISTINCT ROLE NAME per level, not one role re-seeded: the role grant is compiled and cached BY ROLE
 * (lib/policyLoad.ts), which is what keeps the hot path off a per-request policy join - so rewriting `hr`'s
 * rules between tests leaves the first compilation in the isolate cache and the second caller silently
 * decides with the first one's authority.
 */
async function callerHolding(level: "write" | "admin") {
  const role = `hr_${level}`;
  for (const t of CLEAR) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: role, label: role }]).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: role, subjectKind: "role", namespace: "holidays", pattern: "holidays.**", scopeKind: "all", scopeCode: "", matchCode: null, level, effect: "allow" },
    // The verb row (level NULL) is what every custom method is decided against; without it `:restore` 403s.
    { subject: role, subjectKind: "role", namespace: "holidays", pattern: "holidays.**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role, status: "active" });
}

beforeEach(() => callerHolding("write"));

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } }, b as unknown as Record<string, unknown>);

async function newHoliday(): Promise<string> {
  await call("/v1/holidays", { method: "POST", body: JSON.stringify({ display_name: "Diwali", date: "2099-11-01" }), headers: { "Content-Type": "application/json" } });
  const rows = await deps.db.select().from(schema.holidays);
  return rows[rows.length - 1]!.uuid;
}

const rows = () => deps.db.select().from(schema.holidays);

describe("the ?force hard purge is gated at admin, however the parameter is spelled", () => {
  it("a write-only caller soft-deletes, and the row survives", async () => {
    const id = await newHoliday();
    expect((await call(`/v1/holidays/${id}`, { method: "DELETE" })).status).toBe(204);
    const after = await rows();
    expect(after.length).toBe(1);
    expect(after[0]!.deleteTime).not.toBeNull();
  });

  it("a write-only caller is refused the plain ?force=true purge", async () => {
    const id = await newHoliday();
    expect((await call(`/v1/holidays/${id}?force=true`, { method: "DELETE" })).status).toBe(403);
    expect((await rows()).length).toBe(1);
  });

  // THE REGRESSION. Both spellings put `force` after a `#`, where the WHATWG parser cannot see it and the old
  // Hono parser could. The row must still be here afterwards: either the request is refused, or it is treated
  // as the plain soft delete it was gated as. What must never happen is a hard purge.
  it.each([
    ["no query string at all", (id: string) => `/v1/holidays/${id}#?force=true`],
    ["appended to a real query string", (id: string) => `/v1/holidays/${id}?show_deleted=false#&force=true`],
  ])("does not purge when ?force rides behind a fragment (%s)", async (_label, path) => {
    const id = await newHoliday();
    const res = await call(path(id), { method: "DELETE" });
    const after = await rows();
    expect(res.status, "the fragment must not be read as a query parameter by either parser").not.toBe(500);
    expect(after.length, "the row was hard-purged by a caller holding only write").toBe(1);
    expect(after[0]!.deleteTime, "so the request must have been the soft delete it was gated as").not.toBeNull();
  });

  it("an admin caller still gets the real purge on the documented spelling", async () => {
    await callerHolding("admin");
    const id = await newHoliday();
    expect((await call(`/v1/holidays/${id}?force=true`, { method: "DELETE" })).status).toBe(204);
    expect((await rows()).length).toBe(0);
  });
});
