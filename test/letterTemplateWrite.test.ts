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
import { clearCache } from "../src/lib/cache";
import { app } from "../src/index";

// A letter template names the letterhead its type is issued on. The SERVICE has always understood the field -
// but the route's write schema is `.strict()`, and a writable field missing from it is rejected at the door
// with "Unrecognized key(s)", which is exactly what shipped. These drive the real route so the two halves
// cannot drift apart again: what the service can store, the wire must accept.
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

beforeEach(async () => {
  for (const t of [schema.letterTemplates, schema.letterheads, schema.accessRules, schema.users, schema.employees, schema.roles]) await deps.db.delete(t);
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
const json = (method: string, body: unknown, contentType = "application/json") =>
  ({ method, headers: { "Content-Type": contentType }, body: JSON.stringify(body) });

async function seedLetterhead(label = "Acme") {
  const uuid = genId();
  await deps.db.insert(schema.letterheads).values({ uuid, code: `lh-${uuid.slice(0, 4)}`, label });
  return uuid;
}

// `app.request` enters BELOW the wire-id edge (index.ts wraps app.fetch with the decoder), so a test addresses
// rows by their internal id and reads the etag back off a GET rather than off a create's encoded response.
async function seedTemplate(label: string, letterheadId?: string) {
  const uuid = genId();
  await deps.db.insert(schema.letterTemplates).values({
    uuid, code: `lt-${uuid.slice(0, 4)}`, label, blocks: [], ...(letterheadId ? { letterheadId } : {}),
  });
  const etag = ((await (await req(`/v1/letter-templates/${uuid}`)).json()) as { etag: string }).etag;
  return { uuid, etag };
}

describe("letter templates carry their letterhead over the wire", () => {
  it("accepts a letterhead on create and hands it back", async () => {
    const id = await seedLetterhead();
    const res = await req("/v1/letter-templates", json("POST", { label: "Offer", blocks: [], letterhead: `letterheads/${id}` }));
    expect(res.status).toBe(200);
    const row = (await res.json()) as { path: string; letterhead?: string };
    expect(row.letterhead).toBeTruthy();
    // The wire speaks tokens, not internal ids - what matters here is that the field survived the round trip.
    expect(row.letterhead).not.toBe(`letterheads/${id}`);
  });

  it("accepts a letterhead on update - the case that 400'd with \"Unrecognized key(s)\"", async () => {
    const id = await seedLetterhead();
    const tpl = await seedTemplate("Increment");
    const res = await req(`/v1/letter-templates/${tpl.uuid}`, {
      ...json("PATCH", { letterhead: `letterheads/${id}` }, "application/merge-patch+json"),
      headers: { "Content-Type": "application/merge-patch+json", "If-Match": tpl.etag },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { letterhead?: string }).letterhead).toBeTruthy();
  });

  it("clears the letterhead with null, falling the type back to the org-wide default", async () => {
    const id = await seedLetterhead();
    const tpl = await seedTemplate("Relieving", id);
    const res = await req(`/v1/letter-templates/${tpl.uuid}`, {
      ...json("PATCH", { letterhead: null }, "application/merge-patch+json"),
      headers: { "Content-Type": "application/merge-patch+json", "If-Match": tpl.etag },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { letterhead?: string }).letterhead).toBeUndefined();
  });

  it("still refuses a genuinely unknown field", async () => {
    const res = await req("/v1/letter-templates", json("POST", { label: "Nope", blocks: [], stationery: "x" }));
    expect(res.status).toBe(400);
  });
});
