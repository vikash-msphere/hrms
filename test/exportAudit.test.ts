/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
import { app } from "../src/index";

// A bulk export is the highest-risk thing a person can do in an HR system - three hundred salaries onto a
// laptop - and it is generated entirely in the browser, so nothing reached the server to be audited. These
// tests are about the one property that matters: the act is recorded, and the DATA is not.
describe("export audit: the act is recorded, the rows never are", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;

  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = "super@test.example";
    (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    await seedManifest(b.DB);
    deps = makeDeps(b);
    await deps.db.insert(schema.roles).values({ name: "super_admin", label: "Super" }).onConflictDoNothing();
    await deps.db.insert(schema.users).values({ uuid: "usr1234567890", code: "u-1", email: "super@test.example", role: "super_admin" });
    await deps.db.insert(schema.accessRules).values([
      { uuid: "arl1234567890", subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", level: "admin", effect: "allow" },
      { uuid: "arl2234567890", subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", level: null, effect: "allow" },
    ]);
  });

  const post = (body: unknown) =>
    app.request("/v1/export:record", { method: "POST", headers: { "content-type": "application/json", "X-Requested-By": "hrms-spa" }, body: JSON.stringify(body) }, b as unknown as Record<string, unknown>);
  const entries = async () => (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === "export.download");

  it("records a real collection against that collection, with the shape of what left", async () => {
    const res = await post({ collection: "compensation", format: "csv", rows: 312, columns: ["Employee", "Annual CTC"] });
    expect(res.status).toBe(204);
    const row = (await entries()).find((r) => r.entity === "compensation")!;
    expect(row).toBeTruthy();
    const meta = JSON.parse(row.meta!) as { note: string; fields: string[] };
    expect(meta.note).toBe("312 rows as CSV");
    expect(meta.fields).toEqual(["Employee", "Annual CTC"]); // which FIELDS left, never their values
  });

  it("records a view export against `export`, keeping it auditable without inventing a resource", async () => {
    await post({ collection: "attendance-register", format: "xlsx", rows: 40 });
    const row = (await entries()).find((r) => r.entity === "export")!;
    expect(row).toBeTruthy();
    expect((JSON.parse(row.meta!) as { of: string }).of).toBe("attendance-register");
  });

  it("refuses a body carrying anything but shape - there is no field for row data to arrive in", async () => {
    const res = await post({ collection: "compensation", format: "csv", rows: 1, data: [["Asha", 1200000]] });
    expect(res.status).toBe(400); // `.strict()`: an unknown key is rejected, not silently dropped
  });

  it("refuses a format it cannot name and a negative count", async () => {
    expect((await post({ collection: "compensation", format: "pdf", rows: 1 })).status).toBe(400);
    expect((await post({ collection: "compensation", format: "csv", rows: -1 })).status).toBe(400);
  });
});
