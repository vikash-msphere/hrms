/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { drizzle } from "drizzle-orm/d1";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import type { ListScope } from "../src/domain/access";
import { listAccessRules, type AccessRuleListFilters } from "../src/services/accessRules";
import { loadObjectExceptionCodes, loadRoleGrantUncached, loadUserGrantUncached } from "../src/lib/policyLoad";

// A PAGE OF ACCESS RULES COSTS A PAGE, NOT THE TABLE.
//
// The access editors follow the cursor to the end (web/src/components/access/permMatrix.ts fetchAllAccessRules),
// so every page's cost is paid as many times as there are pages. Three plans cost far more than a page, and this
// file catches each: a cursor bound spelled `created_at < at OR (created_at = at AND uuid < uid)` is a filter
// rather than a seek, so page k walks k pages, and every seeded rule shares ONE `created_at`, so its timestamp
// half bounds nothing at all; a subject's page without its own index reads the subject's whole set and sorts it;
// and a collection's page without one walks the whole table newest first until a page of matches turns up.
// Access mode's deny tint reads `effect=deny`, which is the denies and nothing else.
//
// So the check here is the number D1 bills: `meta.rows_read` for the statement `listAccessRules` actually sends,
// captured on the way out and replayed, for each page of the walks below, over a table shaped like a real org's:
// the seeded role rules at one instant, share rows and denies written since.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const b = env as unknown as Bindings;
let base: Deps;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  base = makeDeps(b);
});

const NOW = Date.parse("2026-10-01T09:00:00.000Z");
const MIN = 60_000;
// The seed's instant: every role rule bootstrap.sql writes carries the same `created_at`.
const SEEDED_AT = NOW - 30 * 24 * 60 * MIN;
// Role rules, round-robin over three roles; every even one is on `employees`, the rest spread over 40 others.
const ROLE_RULES = 1_500;
// Ticket shares written since, one a minute: the newest rows, and enough that page 2 crosses into the seed.
const SHARES = 150;
const DENIES = 10;
const PAGE = 100;
const PAGES = 4;
// A page is 101 rows (the page plus the one that says there is more), and the walks measured 101 to 102. A plan
// that sorts the subject's whole set reads 500 here on every page, and a filtering cursor reads k pages for page k.
const ROWS_READ_CEILING = 150;
// A collection's page also pays a sort. `namespace IN (c, '*')` comes off ar_namespace_created_idx one namespace
// at a time, so SQLite orders what it collects in a temp B-tree, and D1 bills each of those rows twice, into the
// B-tree and out of it: about two pages of rows a page (208 to 210 measured), where walking ar_created_idx for
// the matches costs the whole table.
const SORTED_ROWS_READ_CEILING = 250;

// Real ids: 13 Crockford base32 characters ending in an even one, because a page hands back a cursor that
// wire-encodes the last row's uuid.
const idOf = (prefix: string, n: number) => `${prefix}${String(n).padStart(9, "0")}0`;
const ALL: ListScope = { breadth: "all", deptCode: null, ownerId: null, seeRestricted: false };

async function seed(): Promise<void> {
  const cols = "uuid, subject, subject_kind, namespace, pattern, scope_kind, scope_code, match_code, level, effect, source, status, created_at, updated_at";
  await b.DB.batch([
    b.DB.prepare(
      `with recursive n(i) as (select 0 union all select i + 1 from n where i < ?1 - 1),
       r(i, ns) as (select i, case when i % 2 = 0 then 'employees' else 'ns' || (i % 40) end from n)
       insert into access_rules (${cols})
       select 'arr' || printf('%09d', i) || '0', 'role' || (i % 3), 'role', ns, ns || '.f' || i || '.**', 'all', '', null, 'read', 'allow', 'acl', 'active', ?2, ?2 from r`,
    ).bind(ROLE_RULES, SEEDED_AT),
    // The two blanket rules, which every collection-narrowed read keeps.
    b.DB.prepare(
      `insert into access_rules (${cols}) values
       ('arx0000000000', 'role1', 'role', '*', '**', 'all', '', null, 'admin', 'allow', 'acl', 'active', ?1, ?1),
       ('arx0000000010', 'role2', 'role', '*', '**', 'all', '', null, 'read', 'allow', 'acl', 'active', ?1, ?1)`,
    ).bind(SEEDED_AT),
    b.DB.prepare(
      `with recursive n(i) as (select 0 union all select i + 1 from n where i < ?1 - 1)
       insert into access_rules (${cols})
       select 'ard' || printf('%09d', i) || '0', 'role1', 'role', 'compensation', 'compensation.d' || i || '.**', 'all', '', null, null, 'deny', 'acl', 'active', ?2 + (i + 1) * ?3, ?2 + (i + 1) * ?3 from n`,
    ).bind(DENIES, SEEDED_AT, MIN),
    b.DB.prepare(
      `with recursive n(i) as (select 0 union all select i + 1 from n where i < ?1 - 1)
       insert into access_rules (${cols})
       select 'ars' || printf('%09d', i) || '0', 'per' || printf('%09d', i % 10) || '0', 'user', 'tickets', 'tickets.t-' || i || '.**', 'exact', '', 't-' || i, 'read', 'allow', 'ticket-share', 'active', ?2 - (?1 - i) * ?3, ?2 - (?1 - i) * ?3 from n`,
    ).bind(SHARES, NOW, MIN),
  ]);
}

type Sent = { sql: string; params: unknown[] };
const capturing = (sent: Sent[]): Deps => ({ ...base, db: drizzle(b.DB, { logger: { logQuery: (sql, params) => void sent.push({ sql, params }) } }) as Deps["db"] });

async function planOf(q: Sent): Promise<string> {
  const plan = await b.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).bind(...q.params).all<{ detail: string }>();
  return plan.results.map((r) => r.detail).join(" | ");
}

/** Run the real `listAccessRules`, then replay the statement it sent to read what D1 bills for it. */
async function listed(filters: AccessRuleListFilters, pageToken?: string) {
  const sent: Sent[] = [];
  const page = await listAccessRules(capturing(sent), ALL, PAGE, pageToken, filters);
  const q = sent.find((s) => /from "access_rules"/.test(s.sql));
  if (!q) throw new Error(`listAccessRules sent no access_rules statement: ${sent.map((s) => s.sql).join(" | ")}`);
  const replay = await b.DB.prepare(q.sql).bind(...q.params).all();
  return { page, rowsRead: replay.meta.rows_read, plan: await planOf(q) };
}

/** The rules that match, newest first, worked out without any plan in the way: what the walk must return. */
async function expectedUuids(where: string, ...params: unknown[]): Promise<string[]> {
  const r = await b.DB.prepare(`select uuid from access_rules where ${where} order by created_at desc, uuid desc limit ${PAGE * PAGES}`)
    .bind(...params)
    .all<{ uuid: string }>();
  return r.results.map((x) => x.uuid);
}

/** Follow the cursor the way the editors do, checking every page's rows and what D1 billed for it. */
async function walk(filters: AccessRuleListFilters, want: string[], label: string, ceiling = ROWS_READ_CEILING): Promise<void> {
  let token: string | undefined;
  const pages = Math.ceil(want.length / PAGE);
  for (let k = 0; k < pages; k++) {
    const { page, rowsRead, plan } = await listed(filters, token);
    expect(page.items.map((r) => r.uuid), `${label} ${k + 1} rows`).toEqual(want.slice(k * PAGE, (k + 1) * PAGE));
    expect(rowsRead, `${label} ${k + 1} read ${rowsRead} rows, planned as: ${plan}`).toBeLessThan(ceiling);
    token = page.nextPageToken;
  }
}

/** Every walk the editors make: the whole table, a collection, a subject, a small collection, the denies. */
async function walkAll(suffix = ""): Promise<void> {
  // Each long walk must outrun its pages, or a later page would be short and cheap for the wrong reason.
  const everything = await expectedUuids("1 = 1");
  const employees = await expectedUuids("namespace in ('employees', '*')");
  const role0 = await expectedUuids("subject_kind = 'role' and subject = 'role0'");
  for (const w of [everything, employees, role0]) expect(w.length).toBe(PAGE * PAGES);
  await walk({}, everything, `page${suffix}`);
  await walk({ collection: "employees" }, employees, `collection page${suffix}`, SORTED_ROWS_READ_CEILING);
  await walk({ subjectKind: "role", subject: "role0" }, role0, `subject page${suffix}`);

  // A collection with a few dozen rules is one page, and costs its own rows twice over (the sort above), not the
  // table: measured 83 for these 40.
  const ns7 = await expectedUuids("namespace in ('ns7', '*')");
  expect(ns7.length).toBeLessThan(PAGE);
  await walk({ collection: "ns7" }, ns7, `small collection${suffix}`, 2 * ns7.length + 10);

  // The deny tint: the denies and nothing else.
  const denies = await expectedUuids("effect = 'deny'");
  expect(denies.length).toBe(DENIES);
  await walk({ effect: "deny" }, denies, `denies${suffix}`, DENIES + 5);
}

/** The decision loads must keep seeking their own index: a new list index that won the plan there would cost every request. */
async function decisionLoadsSeekTheirIndex(user: string): Promise<void> {
  const sent: Sent[] = [];
  const deps = capturing(sent);
  await loadRoleGrantUncached(deps, "role0");
  await loadUserGrantUncached(deps, idOf("per", 3));
  await loadObjectExceptionCodes(deps, user, ["role0", "role1"], "employees");
  const loads = sent.filter((s) => /from "access_rules"/.test(s.sql));
  expect(loads.length).toBe(3);
  for (const q of loads) {
    const plan = await planOf(q);
    expect(plan, `${q.sql} planned as: ${plan}`).toMatch(/ar_subject_kind_match_idx/);
  }
}

describe("access-rule lists read a page per page, not the table", () => {
  it("is measured by a counter that does count a scan here", async () => {
    // Without this, a runtime that reported no row counts would pass every ceiling below by reading zero.
    await seed();
    const scan = await b.DB.prepare("select count(*) as n from access_rules where pattern = 'no such rule'").all();
    expect(scan.meta.rows_read).toBeGreaterThanOrEqual(ROLE_RULES + SHARES + DENIES);
  });

  it("walks every list the editors read a page of rows at a time", async () => {
    await seed();
    await walkAll();
  });

  it("leaves the decision loads on ar_subject_kind_match_idx", async () => {
    await seed();
    // A user nobody has loaded: the per-object rule set is cached per caller, and a warm entry sends nothing.
    await decisionLoadsSeekTheirIndex(idOf("per", 901));
  });

  // Production may carry planner statistics, and stat1 averages change what SQLite thinks an index lookup
  // costs. Last in the file, so nothing after it runs against a database that has statistics.
  it("still reads a page per page once the database has planner statistics", async () => {
    await seed();
    await b.DB.prepare("ANALYZE").run();
    await walkAll(" with statistics");
    await decisionLoadsSeekTheirIndex(idOf("per", 902));
  });
});
