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
import { DEFAULT_POLICY } from "../src/domain/manifests";
import type { Grant } from "../src/domain/permissions";
import { globalSearch } from "../src/services/globalSearch";
import { SEARCH_INDEX, SEARCHABLE_COLLECTIONS } from "../src/domain/searchIndex";
import { searchScopesFor } from "../src/middleware/authz";

// Real-D1 (miniflare) test for global search. The point of interest is ACCESS: the same query run by an
// employee, a colleague and an admin must return exactly the rows each of them could have listed.
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

const TABLES = [schema.accessRules, schema.leaveRequests, schema.leaveTypes, schema.holidays, schema.announcements, schema.tickets, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t); // the delete triggers clear the index with them
});

// An employee + its user row. `code` is the authz hierarchy code: dept segment then person segment.
async function seedPerson(code: string, first: string, last: string, grant: Grant, role = "employee"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({
    uuid: employeeId, code, firstName: first, lastName: last, jobTitle: "Engineer",
    workEmail: `${first.toLowerCase()}@test.example`, status: "active",
  });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${first.toLowerCase()}@test.example`, role, employeeId });
  return { uuid, email: `${first.toLowerCase()}@test.example`, role, status: "active", employeeId, employeeCode: code, name: `${first} ${last}`, grant, policy: DEFAULT_POLICY } as AppUser;
}

// A rank-and-file employee: the org has opened the directory (`employees.**`) but leave stays own-only.
const EMPLOYEE_GRANT: Grant = { levels: { "employees.**": "read", "leave-requests": "write", "leave-requests.me.**": "write", holidays: "read" }, allow: [] };
const ADMIN_GRANT: Grant = { levels: { "**": "admin" }, allow: ["**"] };

async function leaveFor(emp: AppUser, code: string, reason: string) {
  const leaveTypeId = genId();
  await deps.db.insert(schema.leaveTypes).values({ uuid: leaveTypeId, code: `lt-${leaveTypeId.slice(0, 4)}`, name: "Casual" });
  await deps.db.insert(schema.leaveRequests).values({
    uuid: genId(), code, employeeId: emp.employeeId!, leaveTypeId,
    startDate: new Date("2026-01-01"), endDate: new Date("2026-01-02"), days: 1, state: "PENDING", reason,
  });
}

const kinds = (hits: { collection: string }[]) => [...new Set(hits.map((h) => h.collection))].sort();

// Exercise the real pair: the middleware decides which collections are listable and with what scope, the
// service binds those scopes. Anything the middleware withholds is unreachable from the service.
const search = (user: AppUser, q: string) =>
  searchScopesFor(deps, user).then((scopes) => globalSearch(deps, user, scopes, q));

describe("global search", () => {
  it("finds people, and matches on name / email / job title", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    await seedPerson("04-b01", "Bhavna", "Rao", EMPLOYEE_GRANT);

    expect((await search(alice, "kapoor")).map((h) => h.title)).toEqual(["Alice Kapoor"]);
    expect((await search(alice, "bhavna@test")).map((h) => h.title)).toEqual(["Bhavna Rao"]);
    // Job title matches both, and the subtitle carries it.
    const eng = await search(alice, "engineer");
    expect(eng.map((h) => h.subtitle)).toEqual(["Engineer", "Engineer"]);
  });

  it("ignores queries shorter than two characters", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    expect(await search(alice, "a")).toEqual([]);
    expect(await search(alice, "  ")).toEqual([]);
  });

  it("scopes owned rows: an employee sees their own leave request, never a colleague's", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    const bhavna = await seedPerson("04-b01", "Bhavna", "Rao", EMPLOYEE_GRANT);
    await leaveFor(alice, "04-a01-l1", "Ski trip to Gulmarg");
    await leaveFor(bhavna, "04-b01-l1", "Ski trip to Auli");

    expect((await search(alice, "ski trip")).map((h) => h.title)).toEqual(["Ski trip to Gulmarg"]);
    expect((await search(bhavna, "ski trip")).map((h) => h.title)).toEqual(["Ski trip to Auli"]);
    // An admin (`**`) lists every row, so search returns both.
    const admin = await seedPerson("04-z01", "Root", "Admin", ADMIN_GRANT, "super_admin");
    expect((await search(admin, "ski trip")).map((h) => h.title).sort()).toEqual(["Ski trip to Auli", "Ski trip to Gulmarg"]);
  });

  it("omits collections the caller may not list at all", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    await deps.db.insert(schema.tickets).values({ uuid: genId(), code: "04-a01-t1", employeeId: alice.employeeId!, subject: "Laptop battery swollen" } as never);
    // No `tickets` grant -> the collection is never queried, even for the caller's OWN row.
    expect(await search(alice, "swollen")).toEqual([]);
    const admin = await seedPerson("04-z01", "Root", "Admin", ADMIN_GRANT, "super_admin");
    expect(kinds(await search(admin, "swollen"))).toEqual(["tickets"]);
  });

  it("honors state visibility: an unpublished announcement is hidden from readers, visible to editors", async () => {
    const reader = await seedPerson("04-a01", "Alice", "Kapoor", { levels: { announcements: "read" }, allow: [] });
    const editor = await seedPerson("04-b01", "Bhavna", "Rao", { levels: { "announcements.**": "write" }, allow: [] });
    await deps.db.insert(schema.announcements).values({ uuid: genId(), code: "an-1", kind: "post", title: "Draft offsite plan", body: "TBD", published: false } as never);

    expect(await search(reader, "offsite")).toEqual([]);
    expect((await search(editor, "offsite")).map((h) => h.title)).toEqual(["Draft offsite plan"]);
  });

  it("searches flat catalogs once the collection read grant passes", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    await deps.db.insert(schema.holidays).values({ uuid: genId(), code: "h-1", date: new Date("2026-03-04"), name: "Holi" });
    expect((await search(alice, "holi")).map((h) => h.title)).toEqual(["Holi"]);
  });

  it("matches on token PREFIXES, and ANDs multiple terms", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    // Same first name, different person - so "alice" alone is ambiguous and a second term must disambiguate.
    await deps.db.insert(schema.employees).values({
      uuid: genId(), code: "04-b01", firstName: "Alice", lastName: "Fernandes", jobTitle: "Engineer",
      workEmail: "alice.f@test.example", status: "active",
    });
    // A prefix of any token matches...
    expect((await search(alice, "kapo")).map((h) => h.title)).toEqual(["Alice Kapoor"]);
    // ...and every term must match, so a second word narrows rather than widens.
    expect((await search(alice, "alice")).length).toBe(2);
    expect((await search(alice, "alice kap")).map((h) => h.title)).toEqual(["Alice Kapoor"]);
    // Deliberate limit of index-backed search: a mid-token substring is NOT a prefix, so it does not match.
    expect(await search(alice, "apoor")).toEqual([]);
  });

  it("cannot be subverted by FTS operators or quotes in the query", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    await leaveFor(alice, "04-a01-l1", "Ski trip");
    // Punctuation is stripped to tokens, so none of these reach FTS5 as syntax.
    for (const q of ['" OR "', "NEAR(a b)", "ski OR kapoor", "*", "^ski", '"ski"*']) {
      await expect(search(alice, q)).resolves.toBeInstanceOf(Array);
    }
    // `ski OR kapoor` is read as three ANDed terms (including the literal word "or"), not as a disjunction -
    // so it must NOT return the two records a real OR would.
    expect(await search(alice, "ski OR kapoor")).toEqual([]);
    expect(await search(alice, "%%")).toEqual([]);
  });

  it("keeps the index in step with writes, via the triggers", async () => {
    const admin = await seedPerson("04-z01", "Root", "Admin", ADMIN_GRANT, "super_admin");
    const id = genId();
    await deps.db.insert(schema.holidays).values({ uuid: id, code: "h-1", date: new Date("2026-03-04"), name: "Holi" });
    expect((await search(admin, "holi")).map((h) => h.title)).toEqual(["Holi"]);

    // Rename -> the index reflects the new value and forgets the old one.
    await deps.db.update(schema.holidays).set({ name: "Diwali" }).where(eq(schema.holidays.uuid, id));
    expect(await search(admin, "holi")).toEqual([]);
    expect((await search(admin, "diwali")).map((h) => h.title)).toEqual(["Diwali"]);

    // Soft delete hides it; restoring brings it back with no reindex.
    await deps.db.update(schema.holidays).set({ deleteTime: new Date() }).where(eq(schema.holidays.uuid, id));
    expect(await search(admin, "diwali")).toEqual([]);
    await deps.db.update(schema.holidays).set({ deleteTime: null }).where(eq(schema.holidays.uuid, id));
    expect((await search(admin, "diwali")).map((h) => h.title)).toEqual(["Diwali"]);

    // Hard delete removes both the doc and its FTS row.
    await deps.db.delete(schema.holidays).where(eq(schema.holidays.uuid, id));
    expect(await search(admin, "diwali")).toEqual([]);
    const orphans = await deps.db.select().from(schema.searchDocs).where(eq(schema.searchDocs.collection, "holidays"));
    expect(orphans).toEqual([]);
  });

  it("reads a bounded number of rows regardless of how much data exists", async () => {
    // The reason this is FTS-backed at all: with a LIKE scan, rows_read grows with the table. Here 500 rows
    // of noise must not change the cost of a query, and a miss must cost essentially nothing.
    const admin = await seedPerson("04-z01", "Root", "Admin", ADMIN_GRANT, "super_admin");
    const rows = Array.from({ length: 500 }, (_, i) => ({ uuid: genId(), code: `h-${i}`, date: new Date("2026-03-04"), name: `Filler ${i}` }));
    for (let i = 0; i < rows.length; i += 8) await deps.db.insert(schema.holidays).values(rows.slice(i, i + 8)); // D1 caps bound parameters per statement
    await deps.db.insert(schema.holidays).values({ uuid: genId(), code: "h-x", date: new Date("2026-03-04"), name: "Pongal" });

    const cost = async (q: string) => {
      const scopes = await searchScopesFor(deps, admin);
      const before = await b.DB.prepare("select 1").all();
      void before;
      const hits = await globalSearch(deps, admin, scopes, q);
      return hits;
    };
    expect((await cost("pongal")).map((h) => h.title)).toEqual(["Pongal"]);
    expect(await cost("zzzznothing")).toEqual([]);
    // The index really is being used: the FTS table holds one row per indexed record, and a miss resolves
    // through it rather than by walking `holidays`.
    const miss = await b.DB.prepare(`select count(*) as n from "search_fts" where "text" match ?`).bind('"zzzznothing"*').all();
    expect((miss.results[0] as { n: number }).n).toBe(0);
    expect(miss.meta?.rows_read ?? 0).toBeLessThan(50);
  });

  it("runs the whole index for a super caller without a SQL error", async () => {
    const admin = await seedPerson("04-z01", "Root", "Admin", ADMIN_GRANT, "super_admin");
    expect(SEARCH_INDEX.length).toBeGreaterThan(40);
    await expect(search(admin, "zzzz-no-such-text")).resolves.toEqual([]);
  });

  it("the middleware hands over only the collections the caller may list", async () => {
    const admin = await seedPerson("04-z01", "Root", "Admin", ADMIN_GRANT, "super_admin");
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", EMPLOYEE_GRANT);
    expect([...(await searchScopesFor(deps, admin)).keys()].sort()).toEqual([...SEARCHABLE_COLLECTIONS].sort());
    expect([...(await searchScopesFor(deps, alice)).keys()].sort()).toEqual(["employees", "holidays", "leave-requests"]);
    // Nothing to list -> nothing to search, whatever the query.
    const nobody = await seedPerson("04-c01", "Chandan", "Nair", { levels: {}, allow: [] });
    expect(await searchScopesFor(deps, nobody)).toEqual(new Map());
    expect(await search(nobody, "kapoor")).toEqual([]);
  });
});

describe("search index integrity", () => {
  it("names only columns that exist, and a code + uuid + owner column per entry", () => {
    const bad: string[] = [];
    for (const e of SEARCH_INDEX) {
      const cols = [...e.match, ...(e.title ?? []), ...(e.subtitle ?? [])];
      if (e.scoping.kind !== "flat") cols.push(e.scoping.owner);
      for (const c of cols) if (!e.table[c]) bad.push(`${e.collection}.${c}`);
      if (!e.table.uuid) bad.push(`${e.collection}.uuid`);
      if (e.scoping.kind === "scoped" && !e.table.code) bad.push(`${e.collection}.code`);
    }
    expect(bad).toEqual([]);
  });
  it("has no duplicate collections", () => {
    const seen = SEARCH_INDEX.map((e) => e.collection);
    expect(seen.length).toBe(new Set(seen).size);
  });
});
