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
import worker, { app } from "../src/index";

// The asset write surface OVER HTTP, which is a different question from the services being right.
//
// This file exists because of a shipped 400: the stocktake scanner sends `stocktake` with every `:verify`, the
// OpenAPI contract declares it, and the route's zod body was `.strict()` without it - so every real scan was
// rejected while the service-level tests (which call verifyAsset directly) stayed green. A request body is a
// contract of its own, and the only test that can hold it is one that goes through the route.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const DEV_EMAIL = "dev@example.com"; // the dev-auth bypass (vitest.config.ts) is the ambient credential

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const CLEAR = [schema.assets, schema.assetCategories, schema.stocktakes, schema.auditLog, schema.eventLog, schema.notifications, schema.settings, schema.accessRules, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }]).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: "04-001-001", firstName: "Dev", lastName: "User", workEmail: DEV_EMAIL, status: "active" });
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin", status: "active", employeeId });
});

// A browser-shaped call: the ambient dev credential plus the CSRF header the SPA sends.
const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } }, b as unknown as Record<string, unknown>);
const send = (path: string, body: unknown) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
// Read the body ONCE: on a non-200 the text becomes the failure message, else it is parsed as JSON.
async function json(res: Response): Promise<Record<string, any>> {
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text) as Record<string, any>;
}
// Items are addressed by their INTERNAL id here, as every other route-level suite does: the wire edge only
// rewrites what looks like a token, so a raw id flows straight through to the handler under test.

async function seedAsset(over: Record<string, unknown> = {}) {
  await json(await send("/v1/assets", { name: "MacBook Pro 14", ...over }));
  return (await deps.db.select().from(schema.assets))[0]!;
}

async function openCount(statuses: string[] = ["in_stock", "pending_verification", "repair"]) {
  await json(await send("/v1/stocktakes", { label: "Q3 walk", scope: { statuses } }));
  return (await deps.db.select().from(schema.stocktakes))[0]!;
}

describe("POST /v1/assets/{id}:verify", () => {
  it("takes the scan AND the count the scanner files it against, and checks the asset in", async () => {
    const asset = await seedAsset();
    const count = await openCount();
    expect(asset.status).toBe("pending_verification");

    const res = await send(`/v1/assets/${asset.uuid}:verify`, {
      scan: asset.tagSecret, // the QR's secret: the only thing that PROVES somebody held the sticker
      condition: "good",
      stocktake: `stocktakes/${count.uuid}`,
    });
    expect(await json(res)).toMatchObject({ status: "in_stock", condition: "good" });
    const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, asset.uuid)))[0]!;
    expect(row.lastStocktakeId).toBe(count.uuid); // the sighting is filed against the walk, not floating
    expect(row.verifiedScanned).toBe(true);
  });

  // The evidence tier, over the route: the human tag on a Code 128 label is a real scan of a real sticker, so
  // it checks the asset in - but it is also printed on every list the caller could already read, so it can
  // never be the thing that makes a sighting count as PROVED.
  it("checks in on the human tag but records that sighting as unscanned", async () => {
    const asset = await seedAsset();
    const res = await json(await send(`/v1/assets/${asset.uuid}:verify`, { scan: asset.assetTag }));
    expect(res).toMatchObject({ status: "in_stock" });
    expect(res.last_verified_scanned).toBe(false);
  });

  it("still accepts a plain check-in scan with no count, and a hand-marked one with a note", async () => {
    const scanned = await seedAsset({ name: "Dock" });
    expect((await json(await send(`/v1/assets/${scanned.uuid}:verify`, { scan: scanned.assetTag }))).status).toBe("in_stock");

    await deps.db.delete(schema.assets);
    const byHand = await seedAsset({ name: "Monitor" });
    const manual = await json(await send(`/v1/assets/${byHand.uuid}:verify`, { override: true, note: "sticker destroyed" }));
    expect(manual.last_verified_scanned).toBe(false);
  });

  it("rejects a field the body does not declare, and a scan that belongs to another asset", async () => {
    const asset = await seedAsset();
    const id = asset.uuid;
    expect((await send(`/v1/assets/${id}:verify`, { scan: asset.assetTag, nope: 1 })).status).toBe(400);
    expect((await send(`/v1/assets/${id}:verify`, { scan: "MS-AST-999" })).status).toBe(400);
    // Untouched by either rejection.
    expect((await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, asset.uuid)))[0]!.status).toBe("pending_verification");
  });
});

describe("POST /v1/assets:batchCreate", () => {
  it("creates a delivery, one contiguous tag run per category, each row printable", async () => {
    const cat = await json(await send("/v1/asset-categories", { display_name: "Adapter", tag_code: "ADP" }));
    const catId = (await deps.db.select().from(schema.assetCategories))[0]!.uuid;
    const { results } = await json(await send("/v1/assets:batchCreate", {
      items: [
        { name: "USB-C to HDMI adapter", category: `asset-categories/${catId}`, quantity: 3 },
        { name: "MacBook Pro 14", serial_number: "C02XK1FTQ6LR" },
      ],
    }));
    expect(results).toHaveLength(4);
    // One contiguous run per category code (the prefix comes from the org's name, not seeded here).
    const tags = results.map((r: Record<string, string>) => r.asset_tag);
    expect(new Set(tags).size).toBe(4);
    expect(tags[0]).toMatch(/ADP-0*1$/);
    expect(tags[1]).toMatch(/ADP-0*2$/);
    expect(tags[2]).toMatch(/ADP-0*3$/);
    expect(tags[3]).toMatch(/AST-0*1$/); // the uncategorised laptop is its own run
    // Refs go back out tokenized, and every row carries the caller's affordances plus the tag secret - which
    // is what lets the client send the run straight to the sticker printer.
    expect(results[0].category).toBe(cat.path);
    expect(results[0].access.can).toContain("printTag");
    expect(results[0].tag_secret).toBeTruthy();
  });

  it("rejects an empty list, an unknown field, and more than the cap", async () => {
    expect((await send("/v1/assets:batchCreate", { items: [] })).status).toBe(400);
    expect((await send("/v1/assets:batchCreate", { items: [{ name: "X", status: "in_stock" }] })).status).toBe(400);
    expect((await send("/v1/assets:batchCreate", { items: [{ name: "X", quantity: 101 }] })).status).toBe(400);
    expect(await deps.db.select().from(schema.assets)).toEqual([]);
  });
});

// Through the worker's own fetch, which is where the wire edge lives (`app` alone never sees a token). A bulk
// body is the first one in this app whose refs are NESTED - one per item, inside an array - so "does a token
// inside items[] become an internal id" is a real question, and the answer is what decides whether the SPA's
// category picker works at all.
describe("the wire edge, over the worker's fetch", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const edge = (path: string, body: unknown) =>
    worker.fetch(
      new Request(`https://hr.example${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", "X-Requested-By": "hrms-spa" },
      }),
      b as unknown as Parameters<typeof worker.fetch>[1],
      ctx,
    );

  it("decodes a tokenized category ref inside every item of a batch", async () => {
    const cat = await json(await send("/v1/asset-categories", { display_name: "Adapter", tag_code: "ADP" }));
    const catId = (await deps.db.select().from(schema.assetCategories))[0]!.uuid;
    const { results } = await json(await edge("/v1/assets:batchCreate", {
      items: [{ name: "USB-C to HDMI adapter", category: cat.path, quantity: 2 }],
    }));
    expect(results).toHaveLength(2);
    expect(results[0].category).toBe(cat.path);
    // The rows really are filed under that category, so the tag took its code (not the AST fallback).
    const rows = await deps.db.select().from(schema.assets);
    expect(rows.map((r) => r.categoryId)).toEqual([catId, catId]);
    expect(rows[0]!.assetTag).toContain("ADP");
  });

  it("decodes the asset in the path and the count in the body of a scan", async () => {
    const asset = await seedAsset();
    const count = await openCount();
    const scanned = await json(await edge(`/v1/assets/${await deps.idCodec.encode("assets", asset.uuid)}:verify`, {
      scan: asset.assetTag,
      stocktake: `stocktakes/${await deps.idCodec.encode("stocktakes", count.uuid)}`,
    }));
    expect(scanned.status).toBe("in_stock");
    expect((await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, asset.uuid)))[0]!.lastStocktakeId).toBe(count.uuid);
  });
});
