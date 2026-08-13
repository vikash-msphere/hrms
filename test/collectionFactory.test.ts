/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, like } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../src/db/schema";
import type { AppEnv, AppUser, Bindings } from "../src/env";
import type { ListScope } from "../src/domain/access";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { app } from "../src/index";
import { etagOf, toHolidayResource, toEventLogResource } from "../src/http/serialize";
import { holidaySpec } from "../src/services/holidays";
import { collectionRoutes, type CollectionRouteSpec } from "../src/http/collectionRoute";
import { grantFor } from "../src/domain/grants";

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
const CLEAR = [schema.auditLog, schema.holidays, schema.payGrades, schema.eventLog, schema.accessRules, schema.users, schema.roles];
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

  it("honors a user-specified id (AEP `?id`), and 409s when that id is taken", async () => {
    const { id } = await newHoliday();
    const chosen = genId();
    const res = await call(`/v1/holidays?id=${chosen}`, {
      method: "POST",
      body: JSON.stringify({ display_name: "Holi", date: "2099-03-03" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect((await deps.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, chosen))).length).toBe(1);
    // Re-using an id names a resource that exists: a conflict, not a server fault (it was a raw 500 before).
    const dup = await call(`/v1/holidays?id=${id}`, {
      method: "POST",
      body: JSON.stringify({ display_name: "Clash", date: "2099-04-04" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(dup.status).toBe(409);
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

  it("pages every row exactly once across a boundary, even under a custom sort", async () => {
    // The cursor seeks in the DB's (createdAt, uuid) order while `sort` presents within the page. When the two
    // disagree - here creation order 5, 1, 3 against pay-grades' by-level presentation - a cursor compared
    // against the PRESENTED order skips whole rows: paging by 2 used to answer levels [1,3] then nothing at
    // all, losing the row created first. Distinct createdAt values so the boundary is exact.
    const t = 1_700_000_000_000;
    await deps.db.insert(schema.payGrades).values(
      [5, 1, 3].map((level, i) => ({ uuid: genId(), code: `pg-${level}`, name: `L${level}`, level, createdAt: new Date(t + i * 1000), updatedAt: new Date(t + i * 1000) })),
    );
    const first = await body(await call("/v1/pay-grades?max_page_size=2"));
    expect(first.results.map((r: { level: number }) => r.level), "the two oldest rows, presented by level").toEqual([1, 5]);
    expect(first.next_page_token).toBeTruthy();
    const second = await body(await call(`/v1/pay-grades?max_page_size=2&page_token=${encodeURIComponent(first.next_page_token)}`));
    expect(second.results.map((r: { level: number }) => r.level)).toEqual([3]);
    expect(second.next_page_token, "the last page is not labelled partial").toBeUndefined();
  });

  it("keeps the internal row id out of the page token", async () => {
    await send("/v1/pay-grades", "POST", { display_name: "Senior", level: 3 });
    await send("/v1/pay-grades", "POST", { display_name: "Junior", level: 1 });
    const first = await body(await call("/v1/pay-grades?max_page_size=1"));
    const cursor = Buffer.from(first.next_page_token as string, "base64url").toString();
    const uuids = (await deps.db.select().from(schema.payGrades)).map((r) => r.uuid);
    expect(uuids.some((u) => cursor.includes(u)), "the cursor carries the wire token, never the internal uuid").toBe(false);
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

// The three spec dimensions that let EVERY collection sit on this one lane. Exercised against a factory app
// mounted directly over the holidays table: no middleware, so what is under test is the factory itself rather
// than the request pipeline the suites above already cover end to end.
describe("spec dimensions", () => {
  const principal = () =>
    ({ uuid: "u", email: DEV_EMAIL, role: "super_admin", status: "active", employeeId: null, employeeCode: null, name: null, grant: grantFor("super_admin") }) as unknown as AppUser;

  // The row filter the authz middleware puts on every list request. The harness stands in for that middleware,
  // so it supplies one: the generic list binds `c.get("scope")` and answers NOTHING when it is absent.
  const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: true };

  // `null` stands for a request the middleware never scoped - the case the generic list must fail closed on.
  const mount = (spec: Omit<CollectionRouteSpec<any>, "serialize">, scope: ListScope | null = ALL) => {
    const harness = new Hono<AppEnv>();
    harness.use("*", async (c, next) => {
      c.set("deps", deps);
      c.set("user", principal());
      c.set("scope", scope as ListScope);
      await next();
    });
    harness.route("/t", collectionRoutes({ serialize: toHolidayResource, ...spec } as CollectionRouteSpec<any>));
    // COLLECTION is the mount path itself (`/t`, no trailing slash - that is what a real request sends and
    // what Hono's sub-app matches); an item path is `/t/<id>` or `/t/<id>:<verb>`.
    return (path: string, init: RequestInit = {}) => harness.request(`/t${path}`, init);
  };
  const COLLECTION = "";
  const post = (call: ReturnType<typeof mount>, path: string, body?: unknown, method: "POST" | "PATCH" = "POST") =>
    call(path, { method, body: JSON.stringify(body ?? {}), headers: { "Content-Type": "application/json" } });

  it("takes separate create and update schemas, so create can demand what patch forbids", async () => {
    const call = mount({
      ...holidaySpec,
      param: "id",
      // A holiday must be born with a date; a patch of one may not move it.
      createSchema: z.object({ display_name: z.string().min(1), date: z.string() }).strict(),
      updateSchema: z.object({ display_name: z.string().min(1).optional() }).strict(),
    });
    expect((await post(call, COLLECTION, { display_name: "No date" })).status).toBe(400);
    expect((await post(call, COLLECTION, { display_name: "Onam", date: "2099-09-01" })).status).toBe(200);
    const id = (await deps.db.select().from(schema.holidays))[0]!.uuid;
    expect((await post(call, `/${id}`, { date: "2099-09-02" }, "PATCH")).status).toBe(400);
    expect((await post(call, `/${id}`, { display_name: "Onam Day" }, "PATCH")).status).toBe(200);
  });

  it("runs a custom method from a verb entry: parse body, call the service, serialize with the hint", async () => {
    let sawBody: unknown = "never called";
    const call = mount({
      ...holidaySpec,
      param: "id",
      writeSchema: z.object({ display_name: z.string().optional(), date: z.string().optional() }).strict(),
      verbs: {
        // With a schema: the parsed body reaches `run`.
        setKind: {
          schema: z.object({ kind: z.enum(["fixed", "optional"]) }).strict(),
          run: async (d, _user, id, body) => {
            sawBody = body;
            return (await d.db.update(schema.holidays).set({ kind: body.kind }).where(eq(schema.holidays.uuid, id)).returning())[0];
          },
        },
        // Without a schema: a verb that carries no body at all.
        touch: { run: async (d, _user, id, body) => { sawBody = body; return (await d.db.select().from(schema.holidays).where(eq(schema.holidays.uuid, id)))[0]; } },
        // Raw: owns its whole Response (the shape binary downloads need).
        card: { raw: async (c, id) => c.body(`holiday ${id}`, 200, { "Content-Type": "text/plain" }) },
      },
    });
    await post(call, COLLECTION, { display_name: "Pongal", date: "2099-01-15" });
    const id = (await deps.db.select().from(schema.holidays))[0]!.uuid;

    const res = await call(`/${id}:setKind`, { method: "POST", body: JSON.stringify({ kind: "optional" }), headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    expect(sawBody).toEqual({ kind: "optional" });
    const body1 = (await res.json()) as Record<string, any>;
    expect(body1.kind, "the verb's row is serialized like any other item response").toBe("optional");
    expect(body1.access.can, "and carries the item access hint").toContain("update");

    sawBody = "never called";
    expect((await call(`/${id}:touch`, { method: "POST" })).status).toBe(200);
    expect(sawBody, "no schema means no body is parsed or passed").toBeUndefined();

    const raw = await call(`/${id}:card`, { method: "POST" });
    expect(raw.headers.get("Content-Type")).toContain("text/plain");
    expect(await raw.text()).toBe(`holiday ${id}`);

    expect((await call(`/${id}:nosuchverb`, { method: "POST" })).status).toBe(404);
  });

  it("hints only the actions it actually mounted, so the SPA never offers a button that 404s", async () => {
    // Read-only: no insert, no patch, and event_log has no delete_time. Before the hint was derived from the
    // mounted surface, a collection with no ACCESS_VERBS entry inherited the update+delete default and claimed
    // both on rows that have neither route.
    await deps.db.insert(schema.eventLog).values({ uuid: genId(), code: "ev-1", type: "test.event", occurredAt: new Date() });
    const readOnly = mount({
      table: schema.eventLog,
      collection: "event-log",
      auditName: "event",
      notFound: "event not found",
      param: "event",
      serialize: (row: any) => toEventLogResource(row, false),
      list: async () => ({ items: await deps.db.select().from(schema.eventLog), nextPageToken: undefined }),
    } as any);
    const page = (await (await readOnly(COLLECTION)).json()) as Record<string, any>;
    expect(page.results.length).toBe(1);
    expect(page.results[0].access.can, "an append-only row can be neither edited nor deleted").toEqual([]);

    // A writable collection with lifecycle columns still hints the full set it really has.
    const writable = mount({ ...holidaySpec, param: "id", writeSchema: z.object({ display_name: z.string().optional(), date: z.string().optional() }).strict() });
    await post(writable, COLLECTION, { display_name: "Ugadi", date: "2099-03-22" });
    const holidays = (await (await writable(COLLECTION)).json()) as Record<string, any>;
    expect(holidays.results[0].access.can).toEqual(expect.arrayContaining(["update", "delete", "restore", "disable", "lock"]));
  });

  it("hands a route-level list the paging it already resolved, rather than each hook re-deriving it", async () => {
    let saw: unknown;
    const call = mount({ ...holidaySpec, param: "id", list: async (_c, page) => { saw = page; return { items: [] }; } });
    await call(`${COLLECTION}?max_page_size=500&page_token=abc&show_deleted=true`);
    // 500 clamped to the 100-row cap, the cursor as sent, and the flag already read as a boolean.
    expect(saw).toEqual({ maxPageSize: 100, pageToken: "abc", showDeleted: true });
    await call(COLLECTION);
    expect(saw).toEqual({ maxPageSize: 50, pageToken: undefined, showDeleted: false });
  });

  it("binds the caller's list scope, and answers nothing when the request was never scoped", async () => {
    await deps.db.insert(schema.holidays).values({ uuid: genId(), code: "h-scope", name: "Onam", date: new Date("2099-09-01") });
    const spec = { ...holidaySpec, param: "id" };
    const rows = async (call: ReturnType<typeof mount>) => ((await (await call(COLLECTION)).json()) as Record<string, any>).results;

    expect((await rows(mount(spec))).length, "org-wide breadth: the whole catalog").toBe(1);
    // A holiday catalog is flat: a `code` and no owner column. A caller scoped to their own records therefore
    // has nothing to match, and gets nothing - not the whole table, which is what an unbound scope returned.
    expect(await rows(mount(spec, { breadth: "own", deptCode: null, ownerId: "emp-1", seeRestricted: true }))).toEqual([]);
    // Same answer for a dept-scoped caller whose codes cannot match, and for a request with no scope at all.
    expect(await rows(mount(spec, { breadth: "dept", deptCode: "04", ownerId: null, seeRestricted: true }))).toEqual([]);
    expect(await rows(mount(spec, null))).toEqual([]);
  });

  it("mounts no delete or restore for an append-only table (no delete_time column)", async () => {
    // event_log is history: there is no column to mark a row deleted, so the routes that would write one are
    // simply absent rather than 500ing on a missing column.
    const call = mount({
      table: schema.eventLog,
      collection: "event-log",
      auditName: "event",
      notFound: "event not found",
      param: "event",
      list: async () => ({ items: [], nextPageToken: undefined }),
    } as any);
    expect((await call(COLLECTION)).status, "reads still work").toBe(200);
    expect((await call(`/${genId()}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(`/${genId()}:restore`, { method: "POST" })).status).toBe(404);
  });

  it("mounts no write route for a collection that has no insert or patch", async () => {
    const { insert: _i, patch: _p, ...readOnly } = holidaySpec;
    await deps.db.insert(schema.holidays).values({ uuid: genId(), code: "h-ro", name: "History", date: new Date("2099-12-25") });
    const call = mount({ ...readOnly, param: "id", writeSchema: z.object({}).strict() });
    const id = (await deps.db.select().from(schema.holidays))[0]!.uuid;
    // Reads and the delete/restore pair stay: it is the WRITE endpoints that do not exist.
    expect((await call(COLLECTION)).status).toBe(200);
    expect((await call(`/${id}`)).status).toBe(200);
    expect((await post(call, COLLECTION, { display_name: "Nope", date: "2099-01-01" })).status).toBe(404);
    expect((await post(call, `/${id}`, { display_name: "Nope" }, "PATCH")).status).toBe(404);
    expect((await call(`/${id}`, { method: "DELETE" })).status).toBe(204);
  });
});
