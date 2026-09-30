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
import { AI_CRON, FAST_CRON, NIGHTLY_CRON } from "../src/cron";
import { genId } from "../src/lib/idCodec";

// `GET /v1/cron-runs?cron=<expression>`: one trigger's runs, newest first. The Operations page reads each card's
// latest run this way, so the daily run is found however many runs the five-minute triggers have recorded since.
describe("cron-runs: one trigger's runs", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const b = env as unknown as Bindings;
  let deps: Deps;

  beforeAll(async () => {
    (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
    (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";
    for (const stmt of migrationSql.split("--> statement-breakpoint")) {
      const t = stmt.trim();
      if (t) await b.DB.prepare(t).run();
    }
    await seedManifest(b.DB);
    deps = makeDeps(b);
    await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }]).onConflictDoNothing();
    await deps.db.insert(schema.users).values([{ uuid: "usr1234567890", code: "u-1", email: "super@test.example", role: "super_admin" }]);
    await deps.db.insert(schema.accessRules).values([
      { uuid: "arl1234567890", subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", level: "admin", effect: "allow" },
      { uuid: "arl2234567890", subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", level: null, effect: "allow" },
    ]);
  });

  const list = async (query: string) => {
    (b as Record<string, unknown>).DEV_FAKE_EMAIL = "super@test.example";
    const res = await app.request(`/v1/cron-runs?${query}`, { headers: { "X-Requested-By": "hrms-spa" } }, b as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { cron: string; start_time: string }[] }).results;
  };

  it("finds the daily run behind more five-minute runs than a page holds", async () => {
    const now = Date.parse("2026-09-30T09:00:00.000Z");
    const nightlyAt = Date.parse("2026-09-30T02:00:00.000Z");
    await deps.db.insert(schema.cronRuns).values({ uuid: genId(), code: "crn-nightly", cron: NIGHTLY_CRON, status: "done", startedAt: new Date(nightlyAt) });
    // Two hundred runs of the frequent triggers after it, a minute apart and alternating: twice a full page. The
    // ids are real ones (13 base32 characters, the spare bit clear), because the list encodes each on the way out.
    await b.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 200)
       insert into cron_runs (uuid, code, cron, status, started_at, created_at, updated_at)
       select 'crn' || printf('%09d', i) || '0', 'crn-' || i, case i % 2 when 0 then ?1 else ?2 end, 'done', ?3 - i * 60000, ?3 - i * 60000, ?3 - i * 60000 from n`,
    ).bind(FAST_CRON, AI_CRON, now).run();

    // Encoded the way the page's list requests are (URLSearchParams: a space travels as `+`).
    const nightly = await list(new URLSearchParams({ cron: NIGHTLY_CRON, max_page_size: "1" }).toString());
    expect(nightly).toHaveLength(1);
    expect(nightly[0]).toMatchObject({ cron: NIGHTLY_CRON, start_time: new Date(nightlyAt).toISOString() });
    // Newest first within the trigger: the even-numbered runs are the five-minute ones, the first of them at -2 min.
    const fast = await list(new URLSearchParams({ cron: FAST_CRON, max_page_size: "1" }).toString());
    expect(fast[0]).toMatchObject({ cron: FAST_CRON, start_time: new Date(now - 2 * 60_000).toISOString() });
    // Unfiltered, the newest page is all frequent runs and the daily one is nowhere in it.
    const page = await list("max_page_size=100");
    expect(page).toHaveLength(100);
    expect(page.some((r) => r.cron === NIGHTLY_CRON)).toBe(false);
  });
});
