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
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { holidayApplies } from "../src/services/holidays";

// Regional holidays and the subscribable feed, end to end. Two things worth pinning: a holiday scoped to
// another office must NOT read as this employee's day off (it would silently stop their leave being charged),
// and the public feed must stay shut unless the org opened it and the token really decodes.

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const DEV_EMAIL = "dev@example.com"; // the dev-auth bypass (vitest.config.ts) is the ambient credential

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

let empId: string;
const CLEAR = [schema.auditLog, schema.holidaySelections, schema.holidays, schema.positions, schema.users, schema.employees, schema.settings, schema.accessRules, schema.roles];
beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "super_admin", label: "Super" }]).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  empId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: empId, code: `e-${empId.slice(0, 4)}`, firstName: "Dev", lastName: "User", workEmail: DEV_EMAIL, status: "active",
  });
  // Their current position puts them in Mumbai (effectiveTo null = the open row).
  await deps.db.insert(schema.positions).values({
    uuid: genId(), code: `p-${genId().slice(0, 4)}`, employeeId: empId, location: "Mumbai", effectiveFrom: new Date(0),
  });
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin", status: "active", employeeId: empId });
});

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } }, b as unknown as Record<string, unknown>);
const send = (path: string, method: "POST" | "PATCH", body: unknown) =>
  call(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const setting = (key: string, value: unknown) => deps.db.insert(schema.settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });

describe("holidayApplies", () => {
  it("treats an unscoped holiday as everyone's and compares locations loosely", () => {
    expect(holidayApplies(null, "Mumbai")).toBe(true);
    expect(holidayApplies("", null)).toBe(true);
    expect(holidayApplies(" mumbai ", "Mumbai")).toBe(true);
    expect(holidayApplies("Delhi", "Mumbai")).toBe(false);
    expect(holidayApplies("Delhi", null)).toBe(false);
  });
});

describe("location + half-day on the wire", () => {
  it("round-trips both, and says whether a scoped holiday applies to the caller", async () => {
    const mine = await json(await send("/v1/holidays", "POST", { display_name: "Gudi Padwa", date: "2099-03-21", location: "Mumbai", half_day: true }));
    expect(mine).toMatchObject({ location: "Mumbai", half_day: true, applies: true });
    const theirs = await json(await send("/v1/holidays", "POST", { display_name: "Kannada Rajyotsava", date: "2099-11-01", location: "Bengaluru" }));
    expect(theirs).toMatchObject({ location: "Bengaluru", applies: false });
    // A company-wide holiday says nothing about applicability - there is nothing to qualify.
    const all = await json(await send("/v1/holidays", "POST", { display_name: "New Year", date: "2099-01-01" }));
    expect(all.location).toBeUndefined();
    expect(all.applies).toBeUndefined();
    expect(all.half_day).toBeUndefined();
  });

  it("clears the scope back to company-wide on an empty location", async () => {
    await send("/v1/holidays", "POST", { display_name: "Onam", date: "2099-09-01", location: "Kochi" });
    const created = (await deps.db.select().from(schema.holidays))[0]!;
    const patched = await json(await send(`/v1/holidays/${created.uuid}`, "PATCH", { location: "" }));
    expect(patched.location).toBeUndefined();
    const row = (await deps.db.select().from(schema.holidays))[0]!;
    expect(row.location).toBeNull();
  });
});

describe("optional-holiday allowance", () => {
  it("caps picks per calendar year, so next year's allowance is not spent by this year's", async () => {
    await setting("holidays", { max_optional: 1 });
    const mk = async (name: string, date: string) => {
      await send("/v1/holidays", "POST", { display_name: name, date, kind: "optional" });
      return (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.name, name)))[0]!;
    };
    const thisYear = await mk("Holi 2098", "2098-03-04");
    const alsoThisYear = await mk("Onam 2098", "2098-09-01");
    const nextYear = await mk("Holi 2099", "2099-03-24");

    const pick = (id: string) => send("/v1/holiday-selections", "POST", { holiday: `holidays/${id}` });
    expect((await pick(thisYear.uuid)).status).toBe(200);
    const second = await pick(alsoThisYear.uuid);
    expect(second.status).toBe(409); // allowance for 2098 is spent (failed precondition)
    expect((await json(second)).detail).toContain("2098");
    expect((await pick(nextYear.uuid)).status).toBe(200); // 2099 has its own allowance
  });
});

describe("holiday feed", () => {
  const feedToken = () => deps.idCodec.encode("holiday-feed", empId);

  it("stays 404 until the org enables it", async () => {
    expect((await call(`/calendar/holidays/${await feedToken()}`)).status).toBe(404);
    await setting("holidays", { feed_enabled: true });
    expect((await call(`/calendar/holidays/${await feedToken()}`)).status).toBe(200);
  });

  it("404s a forged token, and one minted for another purpose", async () => {
    await setting("holidays", { feed_enabled: true });
    expect((await call("/calendar/holidays/notatoken")).status).toBe(404);
    // The same employee id encoded under its NORMAL collection is not a feed token (domain separation).
    expect((await call(`/calendar/holidays/${await deps.idCodec.encode("employees", empId)}`)).status).toBe(404);
  });

  // Offboarding is the only thing that revokes this URL. The token is unguessable but permanent, and it sits
  // in whatever calendar client the employee pasted it into - there is no session to expire and no cookie to
  // clear. Checking `delete_time` alone left a leaver subscribed to the org's calendar indefinitely.
  it("404s once the employee is terminated", async () => {
    await setting("holidays", { feed_enabled: true });
    expect((await call(`/calendar/holidays/${await feedToken()}`)).status).toBe(200);
    await deps.db.update(schema.employees).set({ status: "terminated" }).where(eq(schema.employees.uuid, empId));
    expect((await call(`/calendar/holidays/${await feedToken()}`)).status).toBe(404);
  });

  it("serves this employee's days off only: their location, and the optional ones they picked", async () => {
    await setting("holidays", { feed_enabled: true });
    const year = new Date().getUTCFullYear();
    const mk = async (name: string, month: number, over: Record<string, unknown> = {}) =>
      json(await send("/v1/holidays", "POST", { display_name: name, date: `${year}-${String(month).padStart(2, "0")}-10`, ...over }));
    await mk("Company Day", 1);
    await mk("Mumbai Day", 2, { location: "Mumbai" });
    await mk("Bengaluru Day", 3, { location: "Bengaluru" });
    const picked = await mk("Picked Optional", 4, { kind: "optional" });
    await mk("Unpicked Optional", 5, { kind: "optional" });
    await mk("Half Day", 6, { half_day: true });
    const pickedRow = (await deps.db.select().from(schema.holidays).where(eq(schema.holidays.name, "Picked Optional")))[0]!;
    await deps.db.insert(schema.holidaySelections).values({ uuid: genId(), code: `hs-${genId().slice(0, 4)}`, employeeId: empId, holidayId: pickedRow.uuid });
    expect(picked.path).toBeTruthy();

    const res = await call(`/calendar/holidays/${await feedToken()}`);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    const ics = await res.text();
    expect(ics).toContain("Company Day");
    expect(ics).toContain("Mumbai Day");
    expect(ics).toContain("Picked Optional");
    expect(ics).toContain("Half Day (half day)");
    expect(ics).not.toContain("Bengaluru Day");
    expect(ics).not.toContain("Unpicked Optional");
    // All-day events end on the exclusive next day.
    expect(ics).toContain(`DTSTART;VALUE=DATE:${year}0110`);
    expect(ics).toContain(`DTEND;VALUE=DATE:${year}0111`);
  });

  it("hands the caller their subscribe token on users/me, but only once the feed is on", async () => {
    expect((await json(await call("/v1/users/me"))).holiday_feed_token).toBeUndefined();
    await setting("holidays", { feed_enabled: true });
    const me = await json(await call("/v1/users/me"));
    expect(me.holiday_feed_token).toBe(await feedToken());
  });
});
