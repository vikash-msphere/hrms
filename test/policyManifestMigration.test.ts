/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Bindings } from "../src/env";
import type { Policy } from "../src/domain/manifests";
import { loadManifest, parsePolicy } from "../src/lib/policyLoad";
import { makeDeps } from "../src/deps";
import { clearCache } from "../src/lib/cache";
import { AppError } from "../src/lib/errors";
import { DEFAULT_POLICY, SUPPORTED_SCOPES } from "../bootstrap/authz/policy";

// Migration 0002 writes into the LIVE `policy` row whatever the Worker's code fallback used to supply, because
// that fallback is gone: the app now refuses on a missing or unreadable manifest rather than inventing one. So
// every shape the row could be in must decide afterwards exactly as the fallback made it decide before - and a
// row that was already complete must not be touched.
//
// 0002 carries several changes, one section each (a comment header, then its statements, then a blank line).
// Only this section is under test: every other migration, and the rest of 0002, is applied first.
const migrations = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const paths = Object.keys(migrations).sort();
const release = paths.find((p) => p.includes("0002_release_two"))!;
const HEADER = "-- The policy manifest becomes the ONLY copy of the policy.";
const whole = migrations[release]!;
const start = whole.indexOf(HEADER);
const end = whole.indexOf("\n\n-- ", start);
const section = whole.slice(start, end < 0 ? undefined : end);
const db = (env as unknown as Bindings).DB;

async function runSql(sql: string) {
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await db.prepare(s).run();
  }
}
const migrate = () => runSql(section);
// The manifest the migration writes is the one the removed fallback SERVED, frozen into its SQL - not whatever
// the seed says today (the seed moves on; an applied migration never does). Read back out of the file.
const FROZEN = JSON.parse(section.match(/SET value_json = '((?:[^']|'')*)'/)![1]!.replace(/''/g, "'")) as Policy;
const stored = async () => (await db.prepare("SELECT value_json FROM policy WHERE key = 'manifest'").first<{ value_json: string }>())?.value_json ?? null;
async function setRow(json: string) {
  await db.prepare("DELETE FROM policy WHERE key = 'manifest'").run();
  await db.prepare("INSERT INTO policy (key, value_json, updated_at) VALUES ('manifest', ?, 0)").bind(json).run();
}

beforeAll(async () => {
  for (const p of paths.filter((p) => p !== release)) await runSql(migrations[p]!);
  await runSql(whole.slice(0, start) + whole.slice(start + section.length));
});
beforeEach(async () => {
  await db.prepare("DELETE FROM policy").run();
});

describe("migration 0002: the manifest row carries what the fallback used to", () => {
  it("adds supported_scopes to a row that predates it, and changes nothing else", async () => {
    const { supported_scopes: _dropped, ...older } = { ...DEFAULT_POLICY, protected_fields: { users: ["role"] } };
    await setRow(JSON.stringify(older));
    await migrate();
    const after = JSON.parse((await stored())!) as Policy;
    expect(after.supported_scopes).toEqual(SUPPORTED_SCOPES);
    expect(after.protected_fields).toEqual({ users: ["role"] }); // the org's own edit survives
    expect(parsePolicy(await stored())).not.toBeNull();
  });

  it("replaces a row that is not JSON with the default the fallback served", async () => {
    await setRow("{not json");
    await migrate();
    expect(JSON.parse((await stored())!)).toEqual(FROZEN);
  });

  it("replaces a row missing a required section with the default the fallback served", async () => {
    const { audit: _gone, ...partial } = DEFAULT_POLICY;
    await setRow(JSON.stringify(partial));
    await migrate();
    expect(JSON.parse((await stored())!)).toEqual(FROZEN);
  });

  it("leaves a complete row byte-for-byte alone, and is idempotent", async () => {
    const edited = JSON.stringify({ ...DEFAULT_POLICY, redacted_fields: { offers: ["base_comp", "notes"] } });
    await setRow(edited);
    await migrate();
    await migrate();
    expect(await stored()).toBe(edited);
  });

  it("does not create a row where there is none (a fresh database gets it from the bootstrap)", async () => {
    await migrate();
    expect(await stored()).toBeNull();
  });
});

describe("the Worker keeps no copy of the manifest", () => {
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const deps = () => {
    (env as unknown as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
    (env as unknown as Record<string, unknown>).WIRE_ID_KEY = KEY;
    return makeDeps(env as unknown as Bindings);
  };

  it("refuses with 503 not-configured when the row is missing, and does not remember the refusal", async () => {
    clearCache("manifest");
    const err = await loadManifest(deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(503);
    expect((err as AppError).type).toBe("/errors/not-configured");
    await setRow(JSON.stringify(DEFAULT_POLICY));
    expect(await loadManifest(deps())).toEqual(DEFAULT_POLICY); // the next call sees the repaired row
  });

  it("refuses an incomplete row rather than filling the gap", async () => {
    clearCache("manifest");
    const { supported_scopes: _dropped, ...older } = DEFAULT_POLICY;
    await setRow(JSON.stringify(older));
    expect(parsePolicy(await stored())).toBeNull();
    await expect(loadManifest(deps())).rejects.toThrow(/policy manifest is missing or unreadable/);
  });
});
