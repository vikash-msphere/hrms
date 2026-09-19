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
import { redactionGateFor } from "../src/http/fieldAccess";

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

const TABLES = [schema.accessRules, schema.reviews, schema.reviewCycles, schema.leaveRequests, schema.leaveTypes, schema.holidays, schema.announcements, schema.tickets, schema.users, schema.employees, schema.roles];
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
// The gate goes in because the ROUTE always passes it: search renders text copied out of rows, so the per-field
// read gate every serializer applies has to be applied here too, and a helper that left it out would be
// testing a call shape the app never makes.
const search = (user: AppUser, q: string) =>
  searchScopesFor(deps, user).then((scopes) => globalSearch(deps, user, scopes, q, redactionGateFor(user)));

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

// SEARCH NEVER PASSES THROUGH A SERIALIZER, so anything a serializer withholds must not be in the index.
//
// http/serialize.ts withholds the manager's assessment from the owner-employee until the review is SHARED
// (`_managerVisible`, set by routes/reviews.ts), and the employee grant's own comment says so. The index
// listed `managerComment` in both `match` and `title` - so the reviewee could match on their manager's
// unshared words, and since `title` is "first non-empty", a review with no self-assessment yet rendered the
// manager's verbatim comment as the ⌘K hit.
//
// `state_visibility` was NOT the fix: that gate is row-level and applies to every item method, so marking an
// unshared review restricted would also have blocked the employee's own read and their `:submitSelf`. The
// field does not belong in an index at all.
const REVIEW_GRANT: Grant = { levels: { reviews: "read", "reviews.me.**": "read" }, allow: [] };

type ReviewState = typeof schema.reviews.$inferInsert["state"];
async function reviewFor(emp: AppUser, opts: { self?: string | null; manager?: string | null; state: ReviewState }) {
  const cycleId = genId();
  await deps.db.insert(schema.reviewCycles).values({ uuid: cycleId, code: `rc-${cycleId.slice(0, 4)}`, name: "H1", state: "ACTIVE" });
  await deps.db.insert(schema.reviews).values({
    uuid: genId(), code: `${emp.employeeCode}-001`, cycleId, employeeId: emp.employeeId!,
    state: opts.state, selfComment: opts.self ?? null, managerComment: opts.manager ?? null,
  });
}

describe("a review's manager assessment is not searchable", () => {
  it("does not surface an unshared manager comment to the reviewee", async () => {
    const asha = await seedPerson("04-001", "Asha", "Rao", REVIEW_GRANT);
    // Mid-cycle: no self-assessment written yet, manager has typed a candid assessment.
    await reviewFor(asha, { manager: "Not meeting the bar; recommend a performance plan", state: "MANAGER" });

    // The words themselves are not matchable...
    expect(await search(asha, "performance")).toEqual([]);
    expect(await search(asha, "recommend")).toEqual([]);
    // ...and nothing renders them as a hit title either.
    const all = await search(asha, "MANAGER");
    expect(JSON.stringify(all)).not.toMatch(/Not meeting the bar/);
  });

  it("still finds the review by the employee's own words", async () => {
    const asha = await seedPerson("04-001", "Asha", "Rao", REVIEW_GRANT);
    await reviewFor(asha, { self: "Shipped the billing migration", manager: "Secret assessment", state: "SHARED" });

    const hits = await search(asha, "billing");
    expect(hits.map((h) => h.collection)).toContain("reviews");
    expect(hits.find((h) => h.collection === "reviews")?.title).toBe("Shipped the billing migration");
  });

  // The structural half: the rule is "a field the API serves conditionally is never indexed". Stated as the
  // two surfaces that actually have such a gate, so re-adding either fails here rather than in production.
  it("indexes no column the API serves conditionally", () => {
    const withheld: Record<string, string[]> = {
      // Withheld from the owner until the review is shared (serialize.ts `_managerVisible`).
      reviews: ["managerComment", "ratingsJson", "overallRating", "goalRatingsJson"],
      // Each side of a 1:1 keeps one note only they can read (schema.ts check_ins).
      "check-ins": ["employeeNote", "counterpartNote"],
    };
    for (const [collection, columns] of Object.entries(withheld)) {
      const entry = SEARCH_INDEX.find((e) => e.collection === collection);
      expect(entry, `${collection} is no longer in SEARCH_INDEX`).toBeDefined();
      const indexed = [...(entry!.match ?? []), ...(entry!.title ?? []), ...(entry!.subtitle ?? [])];
      for (const c of columns) {
        expect(indexed, `${collection}.${c} is withheld by the serializer but indexed for search`).not.toContain(c);
      }
    }
  });
});

describe("a field the caller may not read is not searchable text either", () => {
  // `policy.redacted_fields` is enforced where resources are serialized (http/accessHint.ts). Search does not
  // serialize a resource - it renders text the INDEX copied out of the row - so the gate never reached it: a
  // deny on `leave-requests.*.reason` hid the reason on the request, in its list and in every export, and left
  // it rendering as the title of the search result. `tickets.description` was not shown but was still matched,
  // which is the same probe a hidden filter was on a custom grid.
  const DENY_REASON: Grant = {
    levels: { "employees.**": "read", "leave-requests": "write", "leave-requests.me.**": "write" },
    allow: [],
    deny: ["leave-requests.*.reason.**"],
  };
  const TICKETS_NO_DESCRIPTION: Grant = { levels: { "**": "admin" }, allow: ["**"], deny: ["tickets.*.description.**"] };

  it("does not render a denied field as the hit's title", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", DENY_REASON);
    await leaveFor(alice, "04-a01-l1", "Ski trip to Gulmarg");
    // The request is still theirs and still findable by what they may read (its state) - but the reason, which
    // is the only thing the title is built from, is withheld rather than printed.
    const byState = await search(alice, "pending");
    expect(byState.map((h) => h.collection)).toEqual(["leave-requests"]);
    expect(byState[0]!.title).toBeNull();
  });

  it("does not let the query match on a denied field", async () => {
    const alice = await seedPerson("04-a01", "Alice", "Kapoor", DENY_REASON);
    await leaveFor(alice, "04-a01-l1", "Ski trip to Gulmarg");
    // Guessing at the text is how a withheld field gets read a word at a time. The row matched in the index;
    // nothing the caller may read explains that match, so the hit does not come back.
    expect(await search(alice, "gulmarg")).toEqual([]);
    // ...and the same query for somebody who may read the field still finds it.
    const admin = await seedPerson("04-z01", "Root", "Admin", ADMIN_GRANT, "super_admin");
    expect((await search(admin, "gulmarg")).map((h) => h.title)).toEqual(["Ski trip to Gulmarg"]);
  });

  it("judges each row on its own verdict when the deny names one record", async () => {
    // A deny can be scoped to a code, so two rows of one collection can differ in what they withhold. Both
    // tickets carry the same word in their description; only the named one is withheld.
    const admin = await seedPerson("04-z01", "Root", "Admin", {
      levels: { "**": "admin" }, allow: ["**"], deny: ["tickets.04-z01-t1.description.**"],
    }, "super_admin");
    await deps.db.insert(schema.tickets).values([
      { uuid: genId(), code: "04-z01-t1", employeeId: admin.employeeId!, subject: "Hidden one", description: "the Dhanbad incident" },
      { uuid: genId(), code: "04-z01-t2", employeeId: admin.employeeId!, subject: "Visible one", description: "the Dhanbad incident" },
    ] as never);
    expect((await search(admin, "dhanbad")).map((h) => h.title)).toEqual(["Visible one"]);
  });

  it("keeps a hit the caller's own readable text explains", async () => {
    const admin = await seedPerson("04-z01", "Root", "Admin", TICKETS_NO_DESCRIPTION, "super_admin");
    await deps.db.insert(schema.tickets).values({
      uuid: genId(), code: "04-z01-t1", employeeId: admin.employeeId!,
      subject: "Laptop battery swollen", description: "escalated after the Dhanbad incident",
    } as never);
    // The subject is readable and contains the term, so the hit stands, title and all.
    expect((await search(admin, "swollen")).map((h) => h.title)).toEqual(["Laptop battery swollen"]);
    // The description is not readable, and nothing else on the row carries the word.
    expect(await search(admin, "dhanbad")).toEqual([]);
  });
});
