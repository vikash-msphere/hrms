/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppEnv } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { dbContext } from "../src/middleware/dbContext";
import { found } from "../src/routes/found";

// The public lost-and-found page is the one UNAUTHENTICATED read surface over asset data, so its
// gates get their own tests: opt-in only, unguessable-token only, and a strict allowlist of what
// leaks (org name / tag / contact / opt-in display name - never serial, assignee or notes).
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

const app = new Hono<AppEnv>();
app.use("*", dbContext);
app.route("/found", found);
const fetchFound = (token: string) => app.request(`/found/${token}`, {}, b as unknown as Record<string, unknown>);

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
  await deps.db.delete(schema.assets);
  await deps.db.delete(schema.settings);
});

async function seedAsset() {
  const uuid = genId();
  await deps.db.insert(schema.assets).values({
    uuid,
    code: `a-${genId().slice(0, 6)}`,
    assetTag: "MS-LAP-042",
    name: "MacBook Pro 14",
    serialNumber: "SECRET-SN-999",
    notes: "assigned to the CFO",
    status: "assigned",
  });
  return { uuid, token: await deps.idCodec.encode("assets", uuid) };
}

async function enableFoundPage(extra: Record<string, unknown> = {}) {
  await deps.db.insert(schema.settings).values({ key: "asset-tags", value: JSON.stringify({ found_page: { enabled: true, contact: "hr@example.com", ...extra } }) });
}

describe("public /found/<token> page", () => {
  it("404s when the org has not opted in (no settings row, or disabled)", async () => {
    const { token } = await seedAsset();
    expect((await fetchFound(token)).status).toBe(404);
    await deps.db.insert(schema.settings).values({ key: "asset-tags", value: JSON.stringify({ found_page: { enabled: false, contact: "hr@example.com" } }) });
    expect((await fetchFound(token)).status).toBe(404);
  });

  it("404s for garbage, forged and raw-uuid tokens even when enabled", async () => {
    const { uuid } = await seedAsset();
    await enableFoundPage();
    expect((await fetchFound("not-a-token")).status).toBe(404);
    expect((await fetchFound(uuid)).status).toBe(404); // the internal uuid is NOT a valid wire token
  });

  it("serves org name, tag and contact for a valid token - and only that", async () => {
    const { token } = await seedAsset();
    await enableFoundPage();
    await deps.db.insert(schema.settings).values({ key: "organization", value: JSON.stringify({ name: "Meridian Systems" }) });
    const res = await fetchFound(token);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("MS-LAP-042");
    expect(html).toContain("Meridian Systems");
    expect(html).toContain("hr@example.com");
    // The strict never-leak list: display name (not opted in), serial, notes.
    expect(html).not.toContain("MacBook");
    expect(html).not.toContain("SECRET-SN-999");
    expect(html).not.toContain("CFO");
    // Never indexable, never frameable, CSP allows only the inline styles.
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(html).toContain('name="robots" content="noindex"');
  });

  it("shows the display name only when the org opted into show_name", async () => {
    const { token } = await seedAsset();
    await enableFoundPage({ show_name: true });
    const html = await (await fetchFound(token)).text();
    expect(html).toContain("MacBook Pro 14");
    expect(html).not.toContain("SECRET-SN-999"); // serial stays private regardless
  });
});
