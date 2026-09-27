/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, like } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { seedManifest } from "./seedManifest";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { scopeToWire, type KeyScope } from "../src/domain/keyScope";
import { shouldTouchLastUsed, LAST_USED_THROTTLE_MS } from "../src/services/apiKeys";

// The API-key lane, end to end through the real app: auth -> csrf -> authz -> handler, against miniflare D1.
//
// test/keyScope.test.ts proves the pure narrowing can never widen. This suite proves the parts that only
// exist once a request is in flight: that the bearer lane is terminal (never falls back to the ambient
// credential), that the ceiling survives per-object rule merges, and that the things a key must never do -
// simulate a user, mint another key - are actually refused.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // valid 32-byte base64 so makeDeps constructs
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

const CLEAR = [schema.apiKeys, schema.auditLog, schema.holidays, schema.accessRules, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }, { name: "employee", label: "Employee" }]).onConflictDoNothing();
  // Super's `**` is the authority every key here narrows down from. It compiles to TWO rows: the level row
  // (standard methods) and the verb row (level NULL, which is what feeds Grant.allow and therefore every
  // custom method). Seeding only the first would leave super unable to call `:revoke`.
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
});

// The dev-auth bypass (DEV_FAKE_EMAIL, set for the whole suite in vitest.config.ts) is the AMBIENT
// credential here: it stands in for the session cookie a browser would send automatically. Several tests
// below turn on the fact that it is present and must still not rescue a bad bearer.
const DEV_EMAIL = "dev@example.com";

async function seedOwner(role = "super_admin", email = DEV_EMAIL, status: "active" | "disabled" = "active"): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email, role, status });
  return uuid;
}

// Mint a key directly, so a test can hand itself any scope without going through the create endpoint.
async function mintKey(ownerUserId: string, scope: KeyScope, over: Partial<typeof schema.apiKeys.$inferInsert> = {}): Promise<string> {
  const minted = await deps.apiKeySigner.mint();
  await deps.db.insert(schema.apiKeys).values({
    uuid: genId(), code: `ak-${genId().slice(0, 4)}`, name: "test key",
    ownerUserId, prefix: minted.prefix, hash: minted.hash, scopeJson: JSON.stringify(scopeToWire(scope)), ...over,
  });
  return minted.token;
}

const READ_ALL: KeyScope = { collections: "*", maxLevel: "read", verbs: [] };
const WRITE_HOLIDAYS: KeyScope = { collections: ["holidays"], maxLevel: "write", verbs: [] };

const call = (path: string, token?: string, init: RequestInit = {}) =>
  app.request(
    path,
    { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string>) } },
    b as unknown as Record<string, unknown>,
  );
// A browser-shaped call: no bearer, CSRF header present, riding the ambient dev-auth credential.
const asHuman = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } }, b as unknown as Record<string, unknown>);

async function seedHoliday(name = "Diwali"): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.holidays).values({ uuid, code: `h-${genId().slice(0, 4)}`, name, date: new Date("2099-11-01"), kind: "fixed" });
  return uuid;
}

describe("credential verification", () => {
  it("rejects an unknown prefix, a wrong secret, and a malformed token", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, READ_ALL);
    const [, prefix] = token.split("_");

    expect((await call("/v1/holidays", "hrms_zzzzzzzz_notarealsecretatall")).status).toBe(401);
    expect((await call("/v1/holidays", `hrms_${prefix}_wrongsecretbutrightprefix`)).status).toBe(401);
    expect((await call("/v1/holidays", "hrms_short")).status).toBe(401);
    expect((await call("/v1/holidays", token)).status).toBe(200); // the control
  });

  it("rejects an expired key and a revoked key", async () => {
    const owner = await seedOwner();
    const expired = await mintKey(owner, READ_ALL, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = await mintKey(owner, READ_ALL, { revokedAt: new Date() });
    expect((await call("/v1/holidays", expired)).status).toBe(401);
    expect((await call("/v1/holidays", revoked)).status).toBe(401);
  });

  it("rejects a key whose owner is disabled", async () => {
    const owner = await seedOwner("super_admin", DEV_EMAIL, "disabled");
    expect((await call("/v1/holidays", await mintKey(owner, READ_ALL))).status).toBe(403);
  });

  it("rejects a key whose stored scope is corrupt, rather than falling back to full authority", async () => {
    const owner = await seedOwner();
    expect((await call("/v1/holidays", await mintKey(owner, READ_ALL, { scopeJson: "{not json" }))).status).toBe(401);
  });
});

// INVARIANT 2. This is what makes the CSRF skip in middleware/csrf.ts sound: an `hrms_`-shaped bearer is
// resolved as that key or it 401s. If it could fall through to the ambient credential, an attacker could
// attach a junk bearer from a cross-site page purely to suppress the CSRF check and ride the victim's
// session. These two tests are the load-bearing ones for that argument.
describe("the bearer lane is terminal", () => {
  it("a junk bearer 401s even though the ambient credential would have authenticated", async () => {
    await seedOwner(); // the dev-auth identity exists and is super
    expect((await asHuman("/v1/holidays")).status).toBe(200); // ambient credential works...
    expect((await call("/v1/holidays", "hrms_zzzzzzzz_notarealsecretatall")).status).toBe(401); // ...and does not rescue a bad key
  });

  it("a junk bearer 401s on a mutation too - it never downgrades to the ambient credential", async () => {
    await seedOwner();
    const res = await call("/v1/holidays", "hrms_zzzzzzzz_notarealsecretatall", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Requested-By": "hrms-spa" },
      body: JSON.stringify({ display_name: "Forged", date: "2099-01-01" }),
    });
    expect(res.status).toBe(401);
    expect(await deps.db.select().from(schema.holidays)).toHaveLength(0);
  });
});

describe("the ceiling", () => {
  it("a read-only key reads but cannot write", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, READ_ALL);
    await seedHoliday();
    expect((await call("/v1/holidays", token)).status).toBe(200);
    const res = await call("/v1/holidays", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "New", date: "2099-01-01" }),
    });
    expect(res.status).toBe(403);
  });

  it("a collection-scoped key cannot reach another collection", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, { collections: ["holidays"], maxLevel: "read", verbs: [] });
    expect((await call("/v1/holidays", token)).status).toBe(200);
    expect((await call("/v1/users", token)).status).toBe(403);
  });

  it("a verb outside the allowlist is refused even when the level would allow it", async () => {
    const owner = await seedOwner();
    const id = await seedHoliday();
    const token = await mintKey(owner, { collections: ["holidays"], maxLevel: "admin", verbs: ["restore"] });
    expect((await call(`/v1/holidays/${id}:lock`, token, { method: "POST" })).status).toBe(403);
  });

  // The reason the ceiling is enforced in TWO places. authz merges per-object exception rules onto the
  // caller's grant at decision time; without the gate on the resolved request, such a rule would re-widen a
  // key past its scope.
  it("a per-object exception rule cannot lift a key above its ceiling", async () => {
    const owner = await seedOwner();
    const id = await seedHoliday();
    const holiday = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)).limit(1))[0]!;
    // An exact per-object grant of admin on this very holiday, addressed to the key's owner.
    await deps.db.insert(schema.accessRules).values({
      subject: owner, subjectKind: "user", namespace: "holidays", pattern: `holidays.${holiday.code}.**`,
      scopeKind: "exact", scopeCode: holiday.code!, matchCode: holiday.code, level: "admin", effect: "allow",
    });
    // A key scoped away from holidays entirely must still be refused, exception rule or not.
    const token = await mintKey(owner, { collections: ["users"], maxLevel: "admin", verbs: "*" });
    expect((await call(`/v1/holidays/${id}`, token)).status).toBe(403);
    // And a holidays-scoped READ key must not be lifted to admin by it either.
    const readToken = await mintKey(owner, { collections: ["holidays"], maxLevel: "read", verbs: [] });
    expect((await call(`/v1/holidays/${id}`, readToken)).status).toBe(200);
    expect((await call(`/v1/holidays/${id}?force=true`, readToken, { method: "DELETE" })).status).toBe(403);
  });

  // The transports (search, dashboard-summary, activity, batch) own no data, but they are NOT exempt from
  // the collection axis: a collection-scoped key simply cannot use them. Uniform, and fails closed.
  it("a collection-scoped key cannot use the search or batch transports; a `*`-scoped one can", async () => {
    const owner = await seedOwner();
    const scoped = await mintKey(owner, { collections: ["holidays"], maxLevel: "read", verbs: [] });
    expect((await call("/v1/search?q=test", scoped)).status).toBe(403);
    expect((await call("/v1/batch:run", scoped, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests: [] }) })).status).toBe(403);
    expect((await call("/v1/activity-counts?tabs=holidays:0", scoped)).status).toBe(403);
    expect((await call(`/v1/changes?since=${Date.now() - 60_000}`, scoped)).status).toBe(403);
    const broad = await mintKey(owner, { collections: "*", maxLevel: "read", verbs: "*" });
    expect((await call("/v1/search?q=test", broad)).status).toBe(200);
    // The tab-badge counts are the same shape of transport: the envelope is open to an authenticated caller,
    // and what it may count is decided per collection inside (searchScopes).
    const counts = await call("/v1/activity-counts?tabs=holidays:0", broad);
    expect(counts.status).toBe(200);
    expect(typeof ((await counts.json()) as { counts?: unknown }).counts).toBe("object");
    // Same for the change feed, which answers with collection NAMES gated by the same list decision.
    const changed = await call(`/v1/changes?since=${Date.now() - 60_000}`, broad);
    expect(changed.status).toBe(200);
    const body = (await changed.json()) as { now?: number; collections?: string[] };
    expect(typeof body.now).toBe("number");
    expect(Array.isArray(body.collections)).toBe(true);
  });

  // The `access.denied` row is the abuse signal, and "a key acted outside its scope" is the single most
  // useful thing it can say. The ceiling check raises its refusal from the middle of the lane structure, and
  // the resolution block's catch used to swallow every throw into `decision = null` - so the request was
  // still refused, but the row and the DENY log both read "unresolved request (fail-closed)", which is what
  // an unparseable path says too. The two are not the same event and must not read the same.
  it("records WHY a key was refused, not a generic fail-closed", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, { collections: ["holidays"], maxLevel: "read", verbs: [] });
    expect((await call("/v1/users", token)).status).toBe(403);
    const rows = await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "access.denied"));
    const reasons = rows.map((r) => (JSON.parse(r.meta ?? "{}") as { reason?: string }).reason);
    expect(reasons).toContain("outside api key scope");
  });
});

describe("what a key may never do", () => {
  it("cannot simulate another user", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, { collections: "*", maxLevel: "admin", verbs: "*" });
    const victim = await seedOwner("employee", "victim@example.com");
    const res = await call("/v1/holidays", token, { headers: { "X-View-As": `users/${victim}` } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("API keys");
  });

  it("cannot mint another key", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, { collections: "*", maxLevel: "admin", verbs: "*" });
    const res = await call("/v1/api-keys", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "escalation" }),
    });
    expect(res.status).toBe(403);
    expect(await deps.db.select().from(schema.apiKeys)).toHaveLength(1); // only the one we minted directly
  });
});

describe("CSRF posture", () => {
  it("a key mutation needs no X-Requested-By header, while a browser one still does", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, WRITE_HOLIDAYS);
    const res = await call("/v1/holidays", token, {
      method: "POST",
      headers: { "content-type": "application/json" }, // deliberately no X-Requested-By
      body: JSON.stringify({ display_name: "Key-made", date: "2099-05-01" }),
    });
    expect(res.status).toBe(200);
    // The browser lane is unchanged: ambient credential + no CSRF header = refused.
    const human = await app.request(
      "/v1/holidays",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "No header", date: "2099-05-02" }) },
      b as unknown as Record<string, unknown>,
    );
    expect(human.status).toBe(403);
  });
});

describe("audit attribution", () => {
  it("records the acting key alongside the owner", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, WRITE_HOLIDAYS);
    await call("/v1/holidays", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Audited", date: "2099-06-01" }),
    });
    const rows = await deps.db.select().from(schema.auditLog).where(like(schema.auditLog.action, "holiday.%"));
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row.actorEmail).toBe(DEV_EMAIL); // the human the key acts as
    expect(JSON.parse(row.meta!).via_api_key).toMatchObject({ name: "test key" }); // ...and which key did it
  });
});

describe("the collection", () => {
  it("returns the plaintext secret exactly once, and never again", async () => {
    await seedOwner();
    const created = await asHuman("/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "CI", scope: { collections: ["holidays"], max_level: "read", verbs: [] } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as Record<string, any>;
    expect(body.secret).toMatch(/^hrms_[a-z2-7]{8}_/);
    expect(body.masked_token).toBe(`hrms_${body.prefix}_...`);
    expect(body.scope).toEqual({ collections: ["holidays"], max_level: "read", verbs: [] });

    // The minted credential works...
    expect((await call("/v1/holidays", body.secret)).status).toBe(200);
    // ...but is unrecoverable: neither the item read nor the list ever carries it, or the stored verifier.
    const got = (await (await asHuman(`/v1/api-keys/${body.path.split("/").pop()}`)).json()) as Record<string, unknown>;
    expect(got.secret).toBeUndefined();
    expect(got.hash).toBeUndefined();
    expect(JSON.stringify(await (await asHuman("/v1/api-keys")).json())).not.toContain(body.secret);
  });

  it("carries an optional description, and omits it when there isn't one", async () => {
    await seedOwner();
    // A credential outlives whoever minted it, so what it is for has to live on the record rather than in
    // somebody's memory - it is what the revoke decision is actually made on.
    const withDesc = (await (
      await asHuman("/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: "Warehouse", description: "  Nightly headcount pull. Ask Priya.  " }),
      })
    ).json()) as Record<string, unknown>;
    // Trimmed on the way in, and readable on the way back out. Re-read by the INTERNAL id: this suite drives
    // `app` directly, and the inbound wire-id decode lives in the worker's fetch above it.
    expect(withDesc.description).toBe("Nightly headcount pull. Ask Priya.");
    const row = (await deps.db.select().from(schema.apiKeys))[0]!;
    expect(row.description).toBe("Nightly headcount pull. Ask Priya.");
    const reread = (await (await asHuman(`/v1/api-keys/${row.uuid}`)).json()) as Record<string, unknown>;
    expect(reread.description).toBe("Nightly headcount pull. Ask Priya.");

    // Optional means absent, not empty string: a key without one carries no field at all.
    const without = (await (
      await asHuman("/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: "No description" }),
      })
    ).json()) as Record<string, unknown>;
    expect(without.description).toBeUndefined();
  });

  it("renames a key, and refuses to edit its authority", async () => {
    const owner = await seedOwner();
    await mintKey(owner, WRITE_HOLIDAYS);
    const row = (await deps.db.select().from(schema.apiKeys))[0]!;

    // The labels are the mistakes worth fixing: a key is named once and read for years.
    const edited = await asHuman(`/v1/api-keys/${row.uuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Warehouse sync", description: "Nightly headcount pull." }),
    });
    expect(edited.status).toBe(200);
    const body = (await edited.json()) as Record<string, unknown>;
    expect(body.display_name).toBe("Warehouse sync");
    expect(body.description).toBe("Nightly headcount pull.");
    // A PATCH of one field leaves the other alone.
    await asHuman(`/v1/api-keys/${row.uuid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: null }) });
    const after = (await deps.db.select().from(schema.apiKeys))[0]!;
    expect(after.name).toBe("Warehouse sync");
    expect(after.description).toBeNull();

    // What the key can DO is not editable: changing authority means minting a new secret and revoking this
    // one, which is the whole reason rotation exists. The scope on the row is untouched either way.
    for (const forbidden of [{ scope: { collections: "*", max_level: "admin", verbs: "*" } }, { expire_time: "2099-01-01T00:00:00Z" }, { owner: `users/${owner}` }]) {
      const res = await asHuman(`/v1/api-keys/${row.uuid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(forbidden) });
      expect(res.status).toBe(400);
    }
    const untouched = (await deps.db.select().from(schema.apiKeys))[0]!;
    expect(JSON.parse(untouched.scopeJson)).toEqual(scopeToWire(WRITE_HOLIDAYS));
    expect(untouched.expiresAt).toBeNull();

    // Revocation closes the record. The row is kept so the audit trail can still resolve the credential that
    // did something, and renaming it afterwards would rewrite the label those rows are read by.
    expect((await asHuman(`/v1/api-keys/${row.uuid}:revoke`, { method: "POST" })).status).toBe(200);
    const afterRevoke = await asHuman(`/v1/api-keys/${row.uuid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Renamed after death" }),
    });
    expect(afterRevoke.status).toBe(409);
    expect((await deps.db.select().from(schema.apiKeys))[0]!.name).toBe("Warehouse sync");
  });

  it("attributes what a key DID to the key, not just to the human it acts as", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, WRITE_HOLIDAYS);
    const key = (await deps.db.select().from(schema.apiKeys))[0]!;

    // A write through the key, and the same write through the browser session it impersonates.
    expect((await call("/v1/holidays", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "By the key", date: "2099-03-01", kind: "fixed" }),
    })).status).toBe(200);
    expect((await asHuman("/v1/holidays", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "By the human", date: "2099-03-02", kind: "fixed" }),
    })).status).toBe(200);

    const rows = await deps.db.select().from(schema.auditLog).where(like(schema.auditLog.action, "holiday.%"));
    const byKey = rows.filter((r) => r.apiKeyId === key.uuid);
    const byHuman = rows.filter((r) => r.apiKeyId === null);
    expect(byKey).toHaveLength(1);
    expect(byHuman).toHaveLength(1);
    // Both rows name the SAME human, which is exactly why the key column has to exist: without it the two are
    // indistinguishable, and "is it safe to revoke this?" has no answer.
    expect(byKey[0]!.actorEmail).toBe(byHuman[0]!.actorEmail);
    // The key's point-in-time name rides along for display, so a renamed or deleted key still reads sensibly.
    expect(JSON.parse(byKey[0]!.meta ?? "{}").via_api_key).toMatchObject({ prefix: key.prefix });

    // And the feed can be narrowed to that one credential.
    const feed = (await (await asHuman(`/v1/activity?api_key=api-keys/${key.uuid}`)).json()) as { results: { action: string }[] };
    expect(feed.results.map((r) => r.action)).toEqual(["holiday.create"]);
  });

  it("searches the whole collection server-side, not just the page the client holds", async () => {
    const owner = await seedOwner();
    await mintKey(owner, READ_ALL, { name: "Warehouse sync", description: "Nightly headcount pull." });
    await mintKey(owner, READ_ALL, { name: "CI deploy" });
    const deleted = (await deps.db.select().from(schema.apiKeys))[0]!;

    const hits = async (q: string) =>
      ((await (await asHuman(`/v1/api-keys?q=${encodeURIComponent(q)}`)).json()) as { results: { display_name: string }[] }).results.map((r) => r.display_name);

    expect(await hits("warehouse")).toEqual(["Warehouse sync"]); // name, case-insensitive
    expect(await hits("headcount")).toEqual(["Warehouse sync"]); // description too - what it's FOR is how it's found
    expect(await hits("deploy")).toEqual(["CI deploy"]);
    expect(await hits("nothing here")).toEqual([]);

    // A search still respects the soft-delete default, so a deleted key does not reappear through the box.
    await asHuman(`/v1/api-keys/${deleted.uuid}`, { method: "DELETE" });
    expect(await hits("warehouse")).toEqual([]);
    const withDeleted = (await (await asHuman("/v1/api-keys?q=warehouse&show_deleted=true")).json()) as { results: unknown[] };
    expect(withDeleted.results).toHaveLength(1);
  });

  it("deletes softly: the row survives for the trail, but the credential stops working", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, READ_ALL);
    const key = (await deps.db.select().from(schema.apiKeys))[0]!;
    expect((await call("/v1/holidays", token)).status).toBe(200); // the control

    expect((await asHuman(`/v1/api-keys/${key.uuid}`, { method: "DELETE" })).status).toBe(204);
    // The row is kept: the audit trail resolves a credential by its id, so destroying it would orphan every
    // line this key ever wrote.
    const [after] = await deps.db.select().from(schema.apiKeys);
    expect(after!.deleteTime).not.toBeNull();
    // But deleted means GONE - a deleted key that still authenticated would make DELETE a cosmetic act.
    expect((await call("/v1/holidays", token)).status).toBe(401);
    // And it drops out of the list unless the caller asks for deleted rows.
    const live = (await (await asHuman("/v1/api-keys")).json()) as { results: unknown[] };
    expect(live.results).toHaveLength(0);
    const withDeleted = (await (await asHuman("/v1/api-keys?show_deleted=true")).json()) as { results: unknown[] };
    expect(withDeleted.results).toHaveLength(1);
    // `only` is the trash BY ITSELF - what makes a "Deleted" view its own fetch instead of a client-side
    // filter over a page of mostly-live rows, which on a list past one page would show an empty trash. Here a
    // live key exists alongside the deleted one, so the two modes must not agree.
    await mintKey(owner, READ_ALL, { name: "Still live" });
    const names = async (qs: string) =>
      ((await (await asHuman(`/v1/api-keys${qs}`)).json()) as { results: { display_name: string }[] }).results.map((r) => r.display_name);
    expect(await names("?deleted_only=true")).toEqual([key.name]);
    expect(await names("")).toEqual(["Still live"]);
    expect((await names("?show_deleted=true")).sort()).toEqual([key.name, "Still live"].sort());

    // Restore brings the credential back, which is the whole point of the delete being soft.
    expect((await asHuman(`/v1/api-keys/${key.uuid}:restore`, { method: "POST" })).status).toBe(200);
    expect((await call("/v1/holidays", token)).status).toBe(200);

    // `?force` is still the way to destroy one for good.
    expect((await asHuman(`/v1/api-keys/${key.uuid}?force=true`, { method: "DELETE" })).status).toBe(204);
    expect((await deps.db.select().from(schema.apiKeys)).map((r) => r.uuid)).not.toContain(key.uuid);
  });

  it("revoke stops the credential on the very next request", async () => {
    const owner = await seedOwner();
    const token = await mintKey(owner, READ_ALL);
    expect((await call("/v1/holidays", token)).status).toBe(200);
    const key = (await deps.db.select().from(schema.apiKeys))[0]!;
    expect((await asHuman(`/v1/api-keys/${key.uuid}:revoke`, { method: "POST" })).status).toBe(200);
    expect((await call("/v1/holidays", token)).status).toBe(401);
    // The row survives revocation so the audit trail can still name the key.
    expect(await deps.db.select().from(schema.apiKeys)).toHaveLength(1);
  });

  it("rejects a scope naming a collection that does not exist", async () => {
    await seedOwner();
    const res = await asHuman("/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "typo", scope: { collections: ["employeez"], max_level: "read", verbs: [] } }),
    });
    expect(res.status).toBe(400);
  });

  it("defaults to the weakest useful scope when none is given", async () => {
    await seedOwner();
    const body = (await (
      await asHuman("/v1/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "default" }) })
    ).json()) as Record<string, any>;
    expect(body.scope).toEqual({ collections: "*", max_level: "read", verbs: [] });
  });

  it("deleting the owner takes the credential with it", async () => {
    const owner = await seedOwner();
    await mintKey(owner, READ_ALL);
    await deps.db.delete(schema.users).where(eq(schema.users.uuid, owner));
    expect(await deps.db.select().from(schema.apiKeys)).toHaveLength(0);
  });
});

describe("last-used throttle", () => {
  it("writes on first use and then at most once per window", () => {
    const now = Date.now();
    expect(shouldTouchLastUsed(null, now)).toBe(true);
    expect(shouldTouchLastUsed(new Date(now - 1000), now)).toBe(false);
    expect(shouldTouchLastUsed(new Date(now - LAST_USED_THROTTLE_MS - 1), now)).toBe(true);
  });
});
