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

// Server-side guard: a caller can POST to /v1/time-entries directly (skipping the Timesheets picker, which
// only filters archived projects out of its dropdown client-side). createTimeEntry must reject an archived
// or missing project itself - the UI's "nobody can log new time against it" promise (ProjectsAdmin.tsx's
// archive toggle) has to hold at the API, not just in the picker. See test/projectsAdminEditor.spec.ts for
// the picker/hint side of this same promise.

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

const DEV_EMAIL = "dev@example.com";
const CLEAR = [schema.timeEntries, schema.cards, schema.boards, schema.projects, schema.accessRules, schema.users, schema.employees, schema.roles];
let employeeId: string;

beforeEach(async () => {
  for (const t of CLEAR) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values({ name: "super_admin", label: "Super" }).onConflictDoNothing();
  await deps.db.insert(schema.accessRules).values([
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: "admin", effect: "allow" },
    { subject: "super_admin", subjectKind: "role", namespace: "*", pattern: "**", scopeKind: "all", scopeCode: "", matchCode: null, level: null, effect: "allow" },
  ]);
  employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: "04-900", firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email: DEV_EMAIL, role: "super_admin", employeeId });
});

// A browser-shaped call riding the ambient dev-auth credential (DEV_FAKE_EMAIL, set for the whole suite in
// vitest.config.ts), with the CSRF header a real SPA request would carry.
const asHuman = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { "X-Requested-By": "hrms-spa", ...(init.headers as Record<string, string>) } }, b as unknown as Record<string, unknown>);

const postJson = (path: string, body: unknown) =>
  asHuman(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patchJson = (path: string, body: unknown) =>
  asHuman(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function seedProject(status: "active" | "archived" = "active"): Promise<string> {
  const uuid = genId();
  await deps.db.insert(schema.projects).values({ uuid, code: `pr-${uuid.slice(0, 4)}`, name: "Test Project", status });
  return uuid;
}

describe("time entries reject archived/missing projects server-side", () => {
  it("archiving a project via the API then POSTing a time entry against it is rejected, not silently accepted", async () => {
    const project = await seedProject("active");

    // Archive it the same way ProjectsAdmin.tsx's toggle does: PATCH status -> "archived".
    const archived = await patchJson(`/v1/projects/${project}`, { status: "archived" });
    expect(archived.status).toBe(200);

    // Bypass the Timesheets picker entirely and POST straight to the collection.
    const res = await postJson("/v1/time-entries", { project, date: "2026-09-01", hours: 4 });
    expect(res.status).toBe(409);

    expect(await deps.db.select().from(schema.timeEntries)).toHaveLength(0);
  });

  it("a live (active) project is unaffected", async () => {
    const project = await seedProject("active");
    const res = await postJson("/v1/time-entries", { project, date: "2026-09-01", hours: 4 });
    expect(res.status).toBe(200);
  });

  it("rejects a non-existent project id (authz fails closed on the unresolved reference before the service even runs)", async () => {
    const res = await postJson("/v1/time-entries", { project: genId(), date: "2026-09-01", hours: 4 });
    expect(res.status).toBe(403);
    expect(await deps.db.select().from(schema.timeEntries)).toHaveLength(0);
  });

  it("PATCHing an existing time entry onto an archived project is rejected too", async () => {
    const active = await seedProject("active");
    const created = await postJson("/v1/time-entries", { project: active, date: "2026-09-01", hours: 2 });
    expect(created.status).toBe(200);
    // The id-codec decode step lives in the top-level fetch wrapper (src/index.ts), not on `app` itself, so
    // app.request() calls here (like the rest of this suite) never exercise it. Read the row back for its
    // raw internal id rather than parsing the wire-encoded `path` out of the response.
    const row0 = (await deps.db.select().from(schema.timeEntries))[0]!;

    const archived = await seedProject("archived");
    const res = await patchJson(`/v1/time-entries/${row0.uuid}`, { project: archived });
    expect(res.status).toBe(409);

    const row = (await deps.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.uuid, row0.uuid)))[0]!;
    expect(row.projectId).toBe(active);
  });
});

// The task an hour went into. Booking stays project-first (that is what a timesheet approves and what a
// client is billed for); the card only says WHICH task inside it, so "what did that task cost" has an answer.
describe("time entries name the task they went into", () => {
  async function seedCard(deleted = false): Promise<string> {
    const board = genId();
    await deps.db.insert(schema.boards).values({ uuid: board, code: `01-${genId().slice(0, 3)}`, name: "Board" });
    const uuid = genId();
    await deps.db.insert(schema.cards).values({
      uuid, code: `c-${genId().slice(0, 4)}`, boardId: board, employeeId, columnKey: "doing", rank: 1, title: "Importer",
      ...(deleted ? { deleteTime: new Date() } : {}),
    });
    return uuid;
  }

  it("keeps the link, and is NOT checked against the project - a board is not tied to one", async () => {
    const project = await seedProject("active");
    const card = await seedCard();
    const res = await postJson("/v1/time-entries", { project: `projects/${project}`, card: `cards/${card}`, date: "2026-02-02", hours: 3 });
    expect(res.status).toBe(200);
    const row = (await deps.db.select().from(schema.timeEntries))[0]!;
    expect(row.cardId).toBe(card);
    expect(row.projectId).toBe(project);
  });

  it("refuses a task that does not exist or has been binned", async () => {
    const project = await seedProject("active");
    const gone = await seedCard(true);
    expect((await postJson("/v1/time-entries", { project: `projects/${project}`, card: `cards/${gone}`, date: "2026-02-02", hours: 1 })).status).toBe(400);
    expect((await postJson("/v1/time-entries", { project: `projects/${project}`, card: `cards/${genId()}`, date: "2026-02-02", hours: 1 })).status).toBe(400);
  });

  it("lets the link be cleared without touching the hours", async () => {
    const project = await seedProject("active");
    const card = await seedCard();
    await postJson("/v1/time-entries", { project: `projects/${project}`, card: `cards/${card}`, date: "2026-02-02", hours: 3 });
    const row = (await deps.db.select().from(schema.timeEntries))[0]!;

    expect((await patchJson(`/v1/time-entries/${row.uuid}`, { card: "" })).status).toBe(200);
    const after = (await deps.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.uuid, row.uuid)))[0]!;
    expect(after.cardId).toBeNull();
    expect(after.hours).toBe(3);
  });
});
