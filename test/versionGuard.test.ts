/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { etagOf } from "../src/http/serialize";
import { createEmployee, updateEmployee } from "../src/services/employees";
import { updateUser } from "../src/services/users";
import { awardBonus } from "../src/services/bonuses";
import { upsertSetting } from "../src/services/settings";

// OPTIMISTIC CONCURRENCY, ON THE PATHS THAT HAND-ROLL IT.
//
// services/crud.ts (the collection factory) and services/softDelete.ts have always put the version in the
// WHERE, and crud.ts spells out why: comparing `If-Match` against the row you just read is a read-then-write
// race, so "two callers holding the same ETag both pass it, both write, both get 200, and the first one's
// change is gone". Roughly thirty hand-written `overrides.update` services did exactly that comparison and
// then wrote with `where(uuid = ?)`, so the guarantee the SPA relies on was real for factory-built collections
// and advisory for every bespoke one - including `users` (role and status) and `employees`.
//
// These tests drive the race directly rather than asserting on the shape of the code, because the bug is
// invisible to any test that makes one call at a time.
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

const TABLES = [schema.notifications, schema.bonuses, schema.auditLog, schema.eventLog, schema.employees, schema.users, schema.roles, schema.codeSequences, schema.settings];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([{ name: "employee", label: "Employee", provisioned: true }, { name: "manager", label: "Manager" }]).onConflictDoNothing();
});

const actor: AppUser = { uuid: "u-actor", email: "hr@test.example", role: "super_admin", status: "active", employeeId: null, employeeCode: null } as unknown as AppUser;

const anEmployee = async (first: string) =>
  (await createEmployee(deps, actor, { first_name: first, last_name: "Rao", work_email: `${first.toLowerCase()}@test.example` })).uuid;

describe("a bespoke update is guarded by the version it read", () => {
  it("refuses the second of two writers holding the same employee ETag", async () => {
    const id = await anEmployee("Asha");
    const before = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0]!;
    const stale = etagOf(+new Date(before.updatedAt));

    await updateEmployee(deps, actor, id, { job_title: "Engineer" }, stale);
    // The second caller read the same row and holds the same ETag. Before the guard it won silently, and the
    // first edit was simply gone; now the DB is what settles it.
    await expect(updateEmployee(deps, actor, id, { job_title: "Designer" }, stale)).rejects.toThrow(/changed since it was read|etag mismatch/);

    const after = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0]!;
    expect(after.jobTitle).toBe("Engineer"); // the winner's value, not the loser's
  });

  // The guard applies with or without an If-Match: sending none is a request not to be bothered about a stale
  // read, not permission to overwrite a change you never saw.
  it("refuses a stale write even from a caller that sent no If-Match", async () => {
    const id = await anEmployee("Bhavna");
    const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, id)).limit(1))[0]!;
    // Somebody else writes in between, so the version this caller is about to pin has moved on.
    await deps.db.update(schema.employees).set({ jobTitle: "Lead", updatedAt: new Date(+new Date(row.updatedAt) + 1000) }).where(eq(schema.employees.uuid, id));
    const { updateAtVersion } = await import("../src/services/versionGuard");
    await expect(updateAtVersion(deps, schema.employees, "employee", row, { jobTitle: "Analyst" })).rejects.toThrow(/changed since it was read/);
  });

  it("tells a purged row (404) apart from a moved one (409)", async () => {
    const id = genId();
    await deps.db.insert(schema.users).values({ uuid: id, code: "09", email: "chandni@test.example", role: "employee" });
    const row = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, id)).limit(1))[0]!;
    await deps.db.delete(schema.users).where(eq(schema.users.uuid, id));
    const { updateAtVersion } = await import("../src/services/versionGuard");
    await expect(updateAtVersion(deps, schema.users, "user", row, { role: "manager" })).rejects.toThrow(/not found/);
  });

  // `users` carries role and status, so a lost update here is a lost privilege change.
  //
  // The competing write is made EXPLICITLY, with a version a millisecond on, rather than by calling
  // `updateUser` twice: the Workers runtime freezes `Date.now()` between I/O, so two updates in one test tick
  // stamp the SAME `updated_at` - which is a real limit of a millisecond-granularity version and not something
  // this guard claims to solve (see the note in services/versionGuard.ts).
  it("guards the account row too", async () => {
    const id = genId();
    await deps.db.insert(schema.users).values({ uuid: id, code: "01", email: "asha@test.example", role: "employee" });
    const row = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, id)).limit(1))[0]!;
    const stale = etagOf(+new Date(row.updatedAt));
    await deps.db.update(schema.users).set({ role: "manager", updatedAt: new Date(+new Date(row.updatedAt) + 1000) }).where(eq(schema.users.uuid, id));
    await expect(updateUser(deps, actor, id, { status: "disabled" }, stale)).rejects.toThrow(/changed since it was read|etag mismatch/);
    const after = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, id)).limit(1))[0]!;
    expect(after.role).toBe("manager");
    expect(after.status).toBe("active"); // the loser's write did not land
  });
});

// The bulk award used to do a duplicate-check read, a counter statement, an insert and a `notify()` per
// employee - about six subrequests each against one invocation's budget, which is what made a company-wide
// award stop working on a real headcount. It is batched now; these assert the behaviour that had to survive
// the rewrite.
describe("a company-wide bonus award", () => {
  it("writes one row per active employee, and re-pressing it writes no more", async () => {
    const ids = [await anEmployee("Dia"), await anEmployee("Esha"), await anEmployee("Farah")];
    const first = await awardBonus(deps, actor, { scope: "company", amount: 5000, award_date: "2026-04-01", reason: "Diwali" });
    expect(first).toHaveLength(ids.length);
    expect(new Set(first.map((r) => r.employeeId))).toEqual(new Set(ids));
    // Every row of a group award shares one batch id, and each carries its own allocated code.
    expect(new Set(first.map((r) => r.batchId)).size).toBe(1);
    expect(new Set(first.map((r) => r.code)).size).toBe(ids.length);

    // The double-click guard: an identical unpaid award inside the window is REUSED, not inserted again -
    // otherwise the next payroll run pays the duplicate.
    const again = await awardBonus(deps, actor, { scope: "company", amount: 5000, award_date: "2026-04-01", reason: "Diwali" });
    expect(again.map((r) => r.uuid).sort()).toEqual(first.map((r) => r.uuid).sort());
    expect(await deps.db.select().from(schema.bonuses)).toHaveLength(ids.length);
  });

  it("tells each recipient about their OWN award", async () => {
    const ids = [await anEmployee("Gita"), await anEmployee("Hema")];
    const rows = await awardBonus(deps, actor, { scope: "company", amount: 1000, award_date: "2026-04-01" });
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes).toHaveLength(ids.length);
    const subjectByRecipient = new Map(notes.map((n) => [n.recipientId, n.subject]));
    for (const r of rows) expect(subjectByRecipient.get(r.employeeId)).toBe(`bonuses/${r.uuid}`);
  });

  it("scopes to one person without reading the whole directory back", async () => {
    const keep = await anEmployee("Isha");
    await anEmployee("Jaya");
    const rows = await awardBonus(deps, actor, { scope: "individual", employee: `employees/${keep}`, amount: 250, award_date: "2026-04-01" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.employeeId).toBe(keep);
    expect(rows[0]!.batchId).toBeNull(); // an individual award is not a group
  });
});

describe("a first save of a setting nobody has written yet", () => {
  // Two callers that both read NO row have no version to send, so If-Match cannot guard them; the second of
  // them used to find the first one's row and overwrite it with a value built on the defaults.
  it("is refused once the row exists, when the caller said it read none", async () => {
    await upsertSetting(deps, actor, "ticket-categories", { categories: [{ key: "a" }] }, undefined, "*");
    await expect(upsertSetting(deps, actor, "ticket-categories", { categories: [{ key: "b" }] }, undefined, "*")).rejects.toThrow(/created concurrently/);
    const row = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, "ticket-categories")).limit(1))[0]!;
    expect(JSON.parse(row.value)).toEqual({ categories: [{ key: "a" }] });
  });

  it("still takes a caller that sends neither header, last-write-wins", async () => {
    await upsertSetting(deps, actor, "ticket-categories", { categories: [{ key: "a" }] });
    await upsertSetting(deps, actor, "ticket-categories", { categories: [{ key: "b" }] });
    const row = (await deps.db.select().from(schema.settings).where(eq(schema.settings.key, "ticket-categories")).limit(1))[0]!;
    expect(JSON.parse(row.value)).toEqual({ categories: [{ key: "b" }] });
  });
});
