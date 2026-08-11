/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, like } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { AppUser, Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { etagOf } from "../src/http/serialize";
import { createHoliday } from "../src/services/holidays";

// The generic collection surface (http/collectionRoute.ts + services/crud.ts), end to end through the real
// app. Every plain-CRUD collection converted to the factory inherits exactly these behaviors, so this suite is
// the one place they are pinned - which is the point of the factory: the paging cursor, the If-Match check, the
// soft-delete/restore pair and the audit action names were previously re-typed per collection and could drift
// per collection.
//
// Two collections on purpose: `holidays` carries the lifecycle columns (disabled/locked) and a per-caller row
// decoration, `pay-grades` carries a non-default page order and cross-field validation that merges the patch
// over the stored row. Between them they cover every hook the spec exposes.

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

const DEV_EMAIL = "dev@example.com"; // the dev-auth bypass (vitest.config.ts) is the ambient credential
const CLEAR = [schema.auditLog, schema.holidays, schema.payGrades, schema.accessRules, schema.users, schema.roles];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }]).onConflictDoNothing();
  // Super's `**` compiles to two rows: the level row (standard methods) and the verb row (level NULL, which is
  // what every custom method - :restore, :disable - is decided against).
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin", status: "active" });
});

// A browser-shaped call: the ambient dev credential plus the CSRF header the SPA sends.
const call = (path: string, init: RequestInit = {}) =>
  app.request(
    path,
    { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } },
    b as unknown as Record<string, unknown>,
  );
const send = (path: string, method: "POST" | "PATCH", body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

const body = async (res: Response) => (await res.json()) as Record<string, any>;
const actions = async (prefix: string) =>
  (await deps.db.select().from(schema.auditLog).where(like(schema.auditLog.action, `${prefix}.%`))).map((r) => r.action).sort();

async function newHoliday(over: Record<string, unknown> = {}): Promise<{ id: string; res: Response }> {
  const res = await send("/v1/holidays", "POST", { display_name: "Diwali", date: "2099-11-01", ...over });
  const rows = await deps.db.select().from(schema.holidays);
  return { id: rows[rows.length - 1]!.uuid, res };
}

describe("create", () => {
  it("allocates a code, maps wire fields onto columns, and audits the create", async () => {
    const { id, res } = await newHoliday({ kind: "optional" });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ display_name: "Diwali", date: "2099-11-01", kind: "optional" });
    const row = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)))[0]!;
    expect(row.code, "the internal matching key every access decision is made against").toBeTruthy();
    expect(await actions("holiday")).toEqual(["holiday.create"]);
  });

  it("rejects a missing required field and an unknown one, before anything is written", async () => {
    expect((await send("/v1/holidays", "POST", { date: "2099-11-01" })).status).toBe(400); // no display_name
    expect((await send("/v1/holidays", "POST", { display_name: "X" })).status).toBe(400); // no date
    expect((await send("/v1/holidays", "POST", { display_name: "X", date: "nonsense" })).status).toBe(400);
    expect((await send("/v1/holidays", "POST", { display_name: "X", date: "2099-01-01", nope: 1 })).status).toBe(400); // .strict()
    expect(await deps.db.select().from(schema.holidays)).toEqual([]);
  });

  it("honors a user-specified id (AEP `?id`), so a caller can make a create idempotent", async () => {
    const actor = { uuid: "u", email: DEV_EMAIL, role: "super_admin", status: "active", employeeId: null, employeeCode: null, name: null } as unknown as AppUser;
    const chosen = genId();
    const row = await createHoliday(deps, actor, { display_name: "Holi", date: "2099-03-03" }, chosen);
    expect(row.uuid).toBe(chosen);
  });
});

describe("read", () => {
  it("serializes one row, with the per-caller decoration the spec adds", async () => {
    const { id } = await newHoliday();
    const res = await call(`/v1/holidays/${id}`);
    expect(res.status).toBe(200);
    // `selected` is holidays' own decorate() hook: false here because the dev caller is not an employee.
    expect(await body(res)).toMatchObject({ display_name: "Diwali", selected: false });
  });

  it("404s an unknown id with the collection's own wording", async () => {
    const res = await call(`/v1/holidays/${genId()}`);
    expect(res.status).toBe(404);
    expect((await body(res)).detail).toBe("holiday not found");
  });

  it("pages with an opaque cursor and ships a per-row access hint", async () => {
    await newHoliday({ display_name: "One" });
    await newHoliday({ display_name: "Two" });
    const first = await body(await call("/v1/holidays?max_page_size=1"));
    expect(first.results.length).toBe(1);
    expect(first.results[0].access.can, "the UX hint the SPA disables actions from").toContain("update");
    expect(first.next_page_token).toBeTruthy();
    const second = await body(await call(`/v1/holidays?max_page_size=1&page_token=${encodeURIComponent(first.next_page_token)}`));
    expect(second.results.length).toBe(1);
    expect(second.results[0].display_name).not.toBe(first.results[0].display_name);
    expect(second.next_page_token, "a complete page must not be labelled partial").toBeUndefined();
  });
});

describe("update", () => {
  it("applies only the fields the caller sent, and audits the diff", async () => {
    const { id } = await newHoliday();
    const res = await send(`/v1/holidays/${id}`, "PATCH", { display_name: "Deepavali" });
    expect(res.status).toBe(200);
    const row = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)))[0]!;
    expect(row.name).toBe("Deepavali");
    expect(row.kind, "a field the patch never mentioned").toBe("fixed");
    const audits = await deps.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "holiday.update"));
    expect(JSON.parse(audits[0]!.meta!).diff.name).toEqual({ from: "Diwali", to: "Deepavali" });
  });

  it("enforces If-Match, so a stale editor cannot overwrite a newer version", async () => {
    const { id } = await newHoliday();
    const row = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)))[0]!;
    expect((await send(`/v1/holidays/${id}`, "PATCH", { display_name: "A" }, { "If-Match": '"stale"' })).status).toBe(409);
    const ok = await send(`/v1/holidays/${id}`, "PATCH", { display_name: "B" }, { "If-Match": etagOf(+new Date(row.updatedAt)) });
    expect(ok.status).toBe(200);
  });

  it("refuses to edit a locked row (workflow precondition, not access control)", async () => {
    const { id } = await newHoliday();
    expect((await call(`/v1/holidays/${id}:lock`, { method: "POST" })).status).toBe(200);
    const res = await send(`/v1/holidays/${id}`, "PATCH", { display_name: "Nope" });
    expect(res.status).toBe(409);
    expect((await body(res)).detail).toMatch(/locked/);
  });
});

describe("delete, restore, purge", () => {
  it("hides a soft-deleted row from the list, shows it under ?show_deleted, and restores it", async () => {
    const { id } = await newHoliday();
    expect((await call(`/v1/holidays/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await body(await call("/v1/holidays"))).results).toEqual([]);
    expect((await body(await call("/v1/holidays?show_deleted=true"))).results.length).toBe(1);
    expect((await call(`/v1/holidays/${id}:restore`, { method: "POST" })).status).toBe(200);
    expect((await body(await call("/v1/holidays"))).results.length).toBe(1);
    expect(await actions("holiday")).toEqual(["holiday.create", "holiday.delete", "holiday.restore"]);
  });

  it("?force=true removes the row for good", async () => {
    const { id } = await newHoliday();
    expect((await call(`/v1/holidays/${id}?force=true`, { method: "DELETE" })).status).toBe(204);
    expect(await deps.db.select().from(schema.holidays)).toEqual([]);
    expect(await actions("holiday")).toContain("holiday.purge");
  });
});

describe("custom methods", () => {
  it("handles the shared lifecycle verbs", async () => {
    const { id } = await newHoliday();
    expect((await call(`/v1/holidays/${id}:disable`, { method: "POST" })).status).toBe(200);
    expect((await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)))[0]!.disabled).toBe(true);
    expect((await call(`/v1/holidays/${id}:enable`, { method: "POST" })).status).toBe(200);
    expect((await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)))[0]!.disabled).toBe(false);
  });

  it("404s a verb the collection does not declare, rather than falling through to another handler", async () => {
    const { id } = await newHoliday();
    expect((await call(`/v1/holidays/${id}:teleport`, { method: "POST" })).status).toBe(404);
  });

  it("404s a lifecycle verb whose state the table cannot hold, rather than writing a missing column", async () => {
    await send("/v1/pay-grades", "POST", { display_name: "Lead", level: 5 });
    const id = (await deps.db.select().from(schema.payGrades))[0]!.uuid;
    // pay_grades has no locked/disabled column: the member is simply not there for this collection.
    expect((await call(`/v1/pay-grades/${id}:lock`, { method: "POST" })).status).toBe(404);
    expect((await call(`/v1/pay-grades/${id}:disable`, { method: "POST" })).status).toBe(404);
  });
});

describe("a collection's own rules ride on the same surface", () => {
  it("orders the page the way the spec asks, not by age", async () => {
    await send("/v1/pay-grades", "POST", { display_name: "Senior", level: 3 });
    await send("/v1/pay-grades", "POST", { display_name: "Junior", level: 1 });
    const page = await body(await call("/v1/pay-grades"));
    expect(page.results.map((r: { level: number }) => r.level)).toEqual([1, 3]);
  });

  it("validates across fields on create, and across the patch merged over the stored row", async () => {
    expect((await send("/v1/pay-grades", "POST", { display_name: "Bad", band_min: 900, band_mid: 100 })).status).toBe(400);
    const created = await send("/v1/pay-grades", "POST", { display_name: "Mid", band_min: 100, band_mid: 500, band_max: 900 });
    expect(created.status).toBe(200);
    const id = (await deps.db.select().from(schema.payGrades))[0]!.uuid;
    // band_mid is not in this patch; it still bounds the new band_min.
    expect((await send(`/v1/pay-grades/${id}`, "PATCH", { band_min: 700 })).status).toBe(400);
    expect((await send(`/v1/pay-grades/${id}`, "PATCH", { band_min: 200 })).status).toBe(200);
  });

  it("keeps its own audit action stem", async () => {
    await send("/v1/pay-grades", "POST", { display_name: "Lead", level: 5 });
    expect(await actions("pay_grade")).toEqual(["pay_grade.create"]);
  });
});
