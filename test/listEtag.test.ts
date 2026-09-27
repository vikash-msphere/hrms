/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { lastWriteAt, listEtag, etagMatches } from "../src/http/listEtag";

// Conditional GET on collection lists (src/http/listEtag.ts). What it saves is the REVALIDATION: the client
// caches a page and re-reads it when its freshness window lapses, which for anything transactional is every
// twenty seconds and almost always returns what it already had. These pin the two properties that make a 304
// safe to serve - it moves on any write, and it is per-caller - and the one that makes it worth serving: it is
// stable while nothing is written.
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
  deps = makeDeps(b);
});

const caller = (over: Partial<AppUser> = {}) =>
  ({
    uuid: "u",
    email: "a@b.c",
    role: "super_admin",
    roles: ["super_admin"],
    status: "active",
    employeeId: null,
    employeeCode: null,
    name: null,
    grant: { levels: { "**": "admin" }, allow: ["**"] },
    policy: DEFAULT_POLICY,
    ...over,
  }) as AppUser;

const URL_A = "https://x.test/v1/holidays?max_page_size=100";
const now = 1_800_000_000_000; // fixed, so the time window never flips mid-test

describe("list etag", () => {
  it("is stable while nothing is written, and moves on any write", async () => {
    const before = await lastWriteAt(deps, now);
    const etagBefore = listEtag(before, caller(), URL_A, now);
    // Same inputs, same answer: this is what lets a revalidation be answered with one indexed row.
    expect(listEtag(await lastWriteAt(deps, now), caller(), URL_A, now)).toBe(etagBefore);

    // A write to an UNRELATED collection still moves it. Deliberate: a list response is not only its own rows
    // (decorate folds in fields from elsewhere, list hooks join, `extra` carries aggregates), so the honest
    // question is "has anything been written", and being wrong in this direction only costs a re-read.
    await deps.db.insert(schema.departments).values({ uuid: genId(), code: "d-etag", name: "Ops" });
    const after = await lastWriteAt(deps, now);
    expect(after).toBeGreaterThan(before);
    expect(listEtag(after, caller(), URL_A, now)).not.toBe(etagBefore);
  });

  it("differs per caller, because the rows carry their access hints and redactions", async () => {
    const at = await lastWriteAt(deps, now);
    const admin = listEtag(at, caller(), URL_A, now);
    const narrowed = listEtag(at, caller({ grant: { levels: { "holidays.**": "read" }, allow: [] } as never }), URL_A, now);
    expect(narrowed).not.toBe(admin);
    // And per scope key: a dept- or self-scoped rule matches on the caller's employee code, so moving them
    // re-scopes rows without any grant changing.
    expect(listEtag(at, caller({ employeeCode: "ops-1" }), URL_A, now)).not.toBe(admin);
  });

  it("differs per query, so a page or a filter is never confused with another", async () => {
    const at = await lastWriteAt(deps, now);
    const base = listEtag(at, caller(), URL_A, now);
    expect(listEtag(at, caller(), `${URL_A}&page_token=abc`, now)).not.toBe(base);
    expect(listEtag(at, caller(), `${URL_A}&show_deleted=true`, now)).not.toBe(base);
    // Parameter ORDER is not a difference: the same request written two ways must share one etag, or a client
    // would revalidate against a validator it can never match.
    expect(listEtag(at, caller(), "https://x.test/v1/holidays?max_page_size=100&a=1&b=2", now)).toBe(
      listEtag(at, caller(), "https://x.test/v1/holidays?b=2&a=1&max_page_size=100", now),
    );
  });

  it("expires on its own, so an answer that depends on the clock cannot be served forever", async () => {
    const at = await lastWriteAt(deps, now);
    // Some list hooks answer relative to now (what is upcoming, what is due today) and change with no write at
    // all. The window bounds how long a 304 can stand for those.
    expect(listEtag(at, caller(), URL_A, now + 6 * 60_000)).not.toBe(listEtag(at, caller(), URL_A, now));
  });

  it("matches the way a GET must: weak comparison, lists, and `*`", () => {
    const etag = listEtag(1, caller(), URL_A, now);
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(etag.replace('W/"', '"'), etag)).toBe(true); // strong form of the same validator
    expect(etagMatches(`W/"other", ${etag}`, etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches('W/"other"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });
});
