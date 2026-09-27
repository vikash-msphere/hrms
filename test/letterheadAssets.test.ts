/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
import { genId } from "../src/lib/idCodec";
import { clearCache } from "../src/lib/cache";
import { app } from "../src/index";

// Uploading an image must show up on the ROW, because that is what the designer reads to know an image
// exists: it draws the card's thumbnail and its settings from `assets`, not from the render. An upload that
// lands in object storage but never appears on the row looks, to the reader, like nothing happened - the
// preview redraws while the card still says "Add".
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
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
  await seedManifest(b.DB);
  deps = makeDeps(b);
});

beforeEach(async () => {
  for (const t of [schema.letterheads, schema.accessRules, schema.users, schema.employees, schema.roles]) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }]);
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: "04-001", firstName: "Admin", lastName: "Test", workEmail: "admin@test.example", status: "active" });
  await deps.db.insert(schema.users).values({ uuid: genId(), code: "u-adm", email: "admin@test.example", role: "super_admin", employeeId });
  (b as Record<string, unknown>).DEV_FAKE_EMAIL = "admin@test.example";
  clearCache();
});

const req = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } }, b as unknown as Record<string, unknown>);

type Assets = Record<string, Record<string, { size_bytes?: number }> | undefined>;
const seed = async (label = "Acme") => {
  const uuid = genId();
  await deps.db.insert(schema.letterheads).values({ uuid, code: `lh-${uuid.slice(0, 4)}`, label });
  return uuid;
};
const put = (id: string, slot: string, variant: string) =>
  req(`/v1/letterheads/${id}:uploadImage?slot=${slot}&variant=${variant}&content_type=image/png`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: PNG,
  });
const getRow = async (id: string) => (await (await req(`/v1/letterheads/${id}`)).json()) as { assets?: Assets };

describe("letterhead images show up on the row", () => {
  it("puts an uploaded image on the row, under its version and slot", async () => {
    const id = await seed();
    expect((await getRow(id)).assets ?? {}).toEqual({});

    expect((await put(id, "stationery", "screen")).status).toBe(200);
    const row = await getRow(id);
    expect(Object.keys(row.assets ?? {})).toEqual(["screen"]);
    expect(row.assets!.screen!.stationery!.size_bytes).toBe(PNG.byteLength);
  });

  it("answers the upload itself with the updated row, so a client need not refetch to see it", async () => {
    const id = await seed();
    const body = (await (await put(id, "mark", "screen")).json()) as { assets?: Assets };
    expect(body.assets?.screen?.mark).toBeTruthy();
  });

  it("keeps the two versions' images apart", async () => {
    const id = await seed();
    await put(id, "stationery", "screen");
    await put(id, "stationery", "print");
    await put(id, "mark", "print");
    const { assets } = await getRow(id);
    expect(Object.keys(assets!.screen!).sort()).toEqual(["stationery"]);
    expect(Object.keys(assets!.print!).sort()).toEqual(["mark", "stationery"]);
  });

  it("removes one image from one version, leaving the other slots and the other version alone", async () => {
    const id = await seed();
    await put(id, "mark", "screen");
    await put(id, "stationery", "screen");
    await put(id, "stationery", "print");

    const res = await req(`/v1/letterheads/${id}:deleteImage?slot=stationery&variant=screen`, { method: "POST" });
    expect(res.status).toBe(200);
    const { assets } = await getRow(id);
    expect(Object.keys(assets!.screen!)).toEqual(["mark"]); // the sibling slot survived
    expect(Object.keys(assets!.print!)).toEqual(["stationery"]); // the other version never moved
  });

  it("refuses to delete from a version that never had that image, instead of silently hitting the other one", async () => {
    const id = await seed();
    await put(id, "stationery", "screen");
    const res = await req(`/v1/letterheads/${id}:deleteImage?slot=stationery&variant=print`, { method: "POST" });
    expect(res.status).toBe(404);
    expect((await getRow(id)).assets!.screen!.stationery).toBeTruthy(); // and the screen one is untouched
  });

  // The preview backs the EDITOR, where a print version is normally being designed before it has been saved.
  // It must draw the version it was asked for and nothing else: an embedded image makes the PDF measurably
  // bigger, so "did it draw the screen sheet?" is answerable by size.
  const preview = async (id: string, variant: string) => {
    const res = await req(`/v1/letterheads/${id}:preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ design: {}, variant }),
    });
    expect(res.status).toBe(200);
    return (await res.arrayBuffer()).byteLength;
  };

  it("previews the print version WITHOUT the screen version's artwork", async () => {
    const id = await seed();
    await put(id, "stationery", "screen"); // screen has a sheet; print has nothing of its own
    const withSheet = await preview(id, "screen");
    const bare = await preview(id, "print");
    expect(bare).toBeLessThan(withSheet); // the screen sheet did not come along
  });

  it("previews the print version with ITS OWN artwork once it has some", async () => {
    const id = await seed();
    await put(id, "stationery", "screen");
    const bare = await preview(id, "print");
    await put(id, "stationery", "print");
    expect(await preview(id, "print")).toBeGreaterThan(bare);
  });

  it("prints as it renders only while there is no print version at all", async () => {
    // No print version: a printed document uses the screen version wholesale, images included. Give print an
    // image of its own and that stops - it is now its own version and answers for itself.
    const id = await seed();
    await put(id, "stationery", "screen");
    const asRendered = await preview(id, "screen");
    await put(id, "mark", "print");
    expect(await preview(id, "print")).toBeLessThan(asRendered); // no screen sheet, just print's own mark
  });

  it("tells a document whether its letterhead has a print version, so the UI offers one download or two", async () => {
    const lh = await seed("Acme");
    const employeeId = (await deps.db.select().from(schema.employees).limit(1))[0]!.uuid;
    const docId = genId();
    await deps.db.insert(schema.personalDocuments).values({
      uuid: docId, code: `pd-${docId.slice(0, 4)}`, employeeId, documentType: "LETTER", title: "Offer",
      r2Key: `personal-documents/${docId}`, contentType: "application/pdf", sizeBytes: 10, letterheadId: lh,
    });

    // No print version yet: one version, one download.
    const before = (await (await req(`/v1/personal-documents/${docId}`)).json()) as { print_variant?: boolean };
    expect(before.print_variant).toBeUndefined();

    // An image uploaded against print IS a print version, even with no design changes.
    await put(lh, "stationery", "print");
    const after = (await (await req(`/v1/personal-documents/${docId}`)).json()) as { print_variant?: boolean };
    expect(after.print_variant).toBe(true);

    // And the list says the same, since that is where the download control lives.
    const list = (await (await req("/v1/personal-documents")).json()) as { results: { print_variant?: boolean }[] };
    expect(list.results[0]!.print_variant).toBe(true);
  });

  it("lists the images too - the catalogue row is what the settings list draws its thumbnail from", async () => {
    const id = await seed();
    await put(id, "mark", "screen");
    const list = (await (await req("/v1/letterheads")).json()) as { results: { assets?: Assets }[] };
    expect(list.results[0]!.assets?.screen?.mark).toBeTruthy();
  });
});
