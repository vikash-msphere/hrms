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
import { seedManifest } from "./seedManifest";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { hashPin, openProof, pinMatches, sealProof, waitAfter, weakPinReason, clientKeyFor, UNLOCK_COOKIE } from "../src/lib/appLock";
import { proofOwner } from "../src/services/appLock";

// The app lock (app-lock-plan.md), end to end through the real app: a person with a PIN is refused on every
// /v1 request until their browser holds a valid unlock proof, and the /auth/lock routes are the only way to get
// one. The dev-auth bypass (DEV_FAKE_EMAIL, vitest.config.ts) is the signed-in browser here.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DEV_EMAIL = "dev@example.com";
const b = env as unknown as Bindings;
let deps: Deps;
let userId: string;

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

beforeEach(async () => {
  for (const t of [schema.appLocks, schema.auditLog, schema.accessRules, schema.users, schema.roles]) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }, { name: "employee", label: "Employee" }]).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  userId = genId();
  await deps.db.insert(schema.users).values({ uuid: userId, code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin" });
});

const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  app.request(
    path,
    {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-By": "hrms-spa",
        ...(init.cookie ? { Cookie: `${UNLOCK_COOKIE}=${init.cookie}` } : {}),
        ...(init.headers as Record<string, string>),
      },
    },
    b as unknown as Record<string, unknown>,
  );

/** The unlock proof a response set, or undefined. */
const proofCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${UNLOCK_COOKIE}=`))
    ?.slice(UNLOCK_COOKIE.length + 1);

async function setPin(pin = "482916"): Promise<string> {
  const res = await call("/auth/lock/pin", { method: "PUT", body: JSON.stringify({ pin }) });
  expect(res.status).toBe(200);
  return proofCookie(res)!;
}

describe("lib/appLock", () => {
  it("hashes a PIN under a key and a user, and verifies it", async () => {
    const h = await hashPin(KEY, "u1", "482916");
    expect(await pinMatches(KEY, "u1", "482916", h)).toBe(true);
    expect(await pinMatches(KEY, "u1", "482917", h)).toBe(false);
    // Another person with the same PIN stores a different value.
    expect(await hashPin(KEY, "u2", "482916")).not.toBe(h);
    // A different key cannot verify it: a leaked table is useless without the secret.
    expect(await pinMatches("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", "u1", "482916", h)).toBe(false);
    expect(await pinMatches(KEY, "u1", "482916", "not base64 !!")).toBe(false);
  });

  it("refuses the PINs people pick first", () => {
    for (const pin of ["0000", "111111", "1234", "654321", "4321", "1212", "123123", "2580", "12345", "12a4"]) {
      expect(weakPinReason(pin), pin).not.toBeNull();
    }
    expect(weakPinReason("4829", ["EMP-4829"])).not.toBeNull();
    for (const pin of ["4829", "482916", "7305", "905172"]) expect(weakPinReason(pin), pin).toBeNull();
  });

  it("seals a proof that tampering, a wrong key and expiry all break", async () => {
    const now = Date.now();
    const proof = { u: "a", s: "-", i: "x", iat: now, exp: now + 60_000, max: now + 3_600_000 };
    const token = await sealProof(proof, KEY);
    expect(await openProof(token, KEY, now)).toEqual(proof);
    expect(await openProof(token, KEY, now + 61_000)).toBeNull();
    const forged = `${Buffer.from(JSON.stringify({ ...proof, u: "b" })).toString("base64url")}.${token.split(".")[1]}`;
    expect(await openProof(forged, KEY, now)).toBeNull();
    expect(await openProof(await sealProof(proof, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="), KEY, now)).toBeNull();
    // A sitting wider than the ceiling is not one this app issues.
    expect(await openProof(await sealProof({ ...proof, max: now + 48 * 3_600_000 }, KEY), KEY, now)).toBeNull();
  });

  it("waits longer the more wrong PINs there are, after the free ones", () => {
    expect([1, 2, 3, 4].map(waitAfter)).toEqual([0, 0, 0, 0]);
    expect(waitAfter(5)).toBe(30_000);
    expect(waitAfter(6)).toBe(60_000);
    expect(waitAfter(9)).toBe(3_600_000);
    expect(waitAfter(40)).toBe(3_600_000);
  });

  it("derives a client key per person and epoch", async () => {
    const k = await clientKeyFor(KEY, "u1", 0);
    expect(Buffer.from(k, "base64url")).toHaveLength(32);
    expect(await clientKeyFor(KEY, "u1", 0)).toBe(k);
    expect(await clientKeyFor(KEY, "u1", 1)).not.toBe(k);
    expect(await clientKeyFor(KEY, "u2", 0)).not.toBe(k);
  });
});

describe("the lock on /v1", () => {
  it("leaves a person with no PIN alone, and hands their browser a storage key", async () => {
    const res = await call("/v1/users/me");
    expect(res.status).toBe(200);
    const me = (await res.json()) as { app_lock: { enabled: boolean }; client_key: string };
    expect(me.app_lock.enabled).toBe(false);
    expect(me.client_key).toBe(await clientKeyFor(KEY, userId, 0));
  });

  it("refuses every request from a browser with no proof, and says it is a lock, not a sign-out", async () => {
    await setPin();
    for (const path of ["/v1/users/me", "/v1/users", "/v1/changes?since=0"]) {
      const res = await call(path);
      expect(res.status, path).toBe(401);
      const p = (await res.json()) as { type: string; lock: { pin_length: number } };
      expect(p.type).toBe("/errors/app-locked");
      expect(p.lock.pin_length).toBe(6);
    }
    // The batch transport is refused at the envelope, before any sub-request runs.
    const batch = await call("/v1/batch:run", { method: "POST", body: JSON.stringify({ requests: [{ method: "GET", path: "/v1/users/me" }] }) });
    expect(batch.status).toBe(401);
  });

  it("opens for the proof setting the PIN hands back, and tells the page when it lapses", async () => {
    const proof = await setPin();
    const res = await call("/v1/users/me", { cookie: proof });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { app_lock: { enabled: boolean; pin_length: number; idle_minutes: number; expire_time: string } };
    expect(me.app_lock).toMatchObject({ enabled: true, pin_length: 6, idle_minutes: 15 });
    expect(Date.parse(me.app_lock.expire_time)).toBeGreaterThan(Date.now());
  });

  it("does not accept a proof for somebody else, or a forged one", async () => {
    await setPin();
    const now = Date.now();
    const other = await sealProof({ u: proofOwner("someone-else"), s: "-", i: "x", iat: now, exp: now + 60_000, max: now + 3_600_000 }, KEY);
    expect((await call("/v1/users/me", { cookie: other })).status).toBe(401);
    expect((await call("/v1/users/me", { cookie: "garbage.token" })).status).toBe(401);
  });
});

describe("/auth/lock", () => {
  it("unlocks with the right PIN and counts the wrong ones", async () => {
    await setPin();
    const wrong = await call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: "111111" }) });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { attempts_left: number }).attempts_left).toBe(4);
    const right = await call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: "482916" }) });
    expect(right.status).toBe(200);
    const proof = proofCookie(right)!;
    expect((await call("/v1/users/me", { cookie: proof })).status).toBe(200);
    // A correct PIN puts the count back.
    const row = (await deps.db.select().from(schema.appLocks).where(eq(schema.appLocks.userId, userId)))[0]!;
    expect(row.failures).toBe(0);
  });

  it("makes the sixth guess wait, even for the right PIN", async () => {
    await setPin();
    for (let i = 0; i < 5; i++) await call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: "000001" }) });
    const res = await call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: "482916" }) });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("counts a burst of parallel guesses one by one", async () => {
    await setPin();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: String(100000 + i) }) })),
    );
    const compared = results.filter((r) => r.status === 403).length;
    // Five free tries, and the fifth wrong one starts the wait: nothing past it was ever compared.
    expect(compared).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(15);
  });

  it("locking revokes this browser's proof even if the cookie comes back", async () => {
    const proof = await setPin();
    const res = await call("/auth/lock", { method: "POST", cookie: proof, body: "{}" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Clear-Site-Data")).toBe('"cache"');
    expect(res.headers.getSetCookie().join(";")).toContain(`${UNLOCK_COOKIE}=;`);
    expect((await call("/v1/users/me", { cookie: proof })).status).toBe(401);
  });

  it("locking everywhere kills every proof, and a PIN change does too", async () => {
    const first = await setPin();
    const second = proofCookie(await call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: "482916" }) }))!;
    // The cut-off is strictly-before, so a proof minted in the same millisecond would survive it.
    await new Promise((r) => setTimeout(r, 5));
    await call("/auth/lock", { method: "POST", cookie: second, body: JSON.stringify({ everywhere: true }) });
    expect((await call("/v1/users/me", { cookie: first })).status).toBe(401);
    expect((await call("/v1/users/me", { cookie: second })).status).toBe(401);

    const a = proofCookie(await call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: "482916" }) }))!;
    await new Promise((r) => setTimeout(r, 5));
    const b2 = proofCookie(await call("/auth/lock/unlock", { method: "POST", body: JSON.stringify({ pin: "482916" }) }))!;
    await new Promise((r) => setTimeout(r, 5));
    const change = await call("/auth/lock/pin", { method: "PUT", cookie: b2, body: JSON.stringify({ pin: "905172", current_pin: "482916" }) });
    expect(change.status).toBe(200);
    expect((await call("/v1/users/me", { cookie: a })).status).toBe(401);
    expect((await call("/v1/users/me", { cookie: proofCookie(change)! })).status).toBe(200);
  });

  it("refuses a change without the current PIN, and a weak new one", async () => {
    const proof = await setPin();
    expect((await call("/auth/lock/pin", { method: "PUT", cookie: proof, body: JSON.stringify({ pin: "905172" }) })).status).toBe(400);
    expect((await call("/auth/lock/pin", { method: "PUT", cookie: proof, body: JSON.stringify({ pin: "111111", current_pin: "482916" }) })).status).toBe(400);
    // A locked browser cannot change it at all.
    expect((await call("/auth/lock/pin", { method: "PUT", body: JSON.stringify({ pin: "905172", current_pin: "482916" }) })).status).toBe(403);
  });

  it("stores the person's own auto-lock time", async () => {
    const proof = await setPin();
    expect((await call("/auth/lock", { method: "PATCH", cookie: proof, body: JSON.stringify({ idle_minutes: 7 }) })).status).toBe(400);
    const res = await call("/auth/lock", { method: "PATCH", cookie: proof, body: JSON.stringify({ idle_minutes: 30 }) });
    expect(res.status).toBe(200);
    const status = (await (await call("/auth/lock", { cookie: proofCookie(res) ?? proof })).json()) as { idle_minutes: number; locked: boolean };
    expect(status).toMatchObject({ idle_minutes: 30, locked: false });
  });

  it("turns off with the current PIN, after which nothing is locked", async () => {
    const proof = await setPin();
    expect((await call("/auth/lock/pin", { method: "DELETE", cookie: proof, body: JSON.stringify({ current_pin: "000000" }) })).status).toBe(403);
    expect((await call("/auth/lock/pin", { method: "DELETE", cookie: proof, body: JSON.stringify({ current_pin: "482916" }) })).status).toBe(200);
    expect((await call("/v1/users/me")).status).toBe(200);
  });

  it("refuses a write without the app's header", async () => {
    await setPin();
    const res = await app.request("/auth/lock", { method: "POST" }, b as unknown as Record<string, unknown>);
    expect(res.status).toBe(403);
  });

  it("reports status to a locked browser", async () => {
    await setPin();
    const res = await call("/auth/lock");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, locked: true, pin_length: 6, attempts_left: 5 });
  });
});

describe("users:resetPin", () => {
  it("clears the PIN, signs the person out and moves their storage key", async () => {
    const proof = await setPin();
    const target = userId;
    const res = await call(`/v1/users/me`, { cookie: proof });
    expect(res.status).toBe(200);
    // Reset by the admin (the same super caller here, acting on their own account through the verb). An
    // internal id: `app.request` skips the inbound wire edge, which lives in the Worker's fetch handler.
    const reset = await call(`/v1/users/${target}:resetPin`, { method: "POST", cookie: proof });
    expect(reset.status).toBe(200);
    const row = (await deps.db.select().from(schema.appLocks).where(eq(schema.appLocks.userId, target)))[0]!;
    expect(row.pinHash).toBeNull();
    expect(row.keyEpoch).toBe(1);
    const user = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, target)))[0]!;
    expect(user.sessionsValidFrom).not.toBeNull();
    // No PIN any more: the browser is open, and its key has moved on.
    const me = (await (await call("/v1/users/me")).json()) as { client_key: string };
    expect(me.client_key).toBe(await clientKeyFor(KEY, target, 1));
  });
});
