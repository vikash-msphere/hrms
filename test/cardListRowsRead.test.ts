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
import { listCards } from "../src/services/cards";

// A PAGE OF CARDS COSTS A PAGE, NOT EVERY CARD THE CALLER CAN SEE.
//
// Every caller below `all` breadth lists cards through an OR: their own cards, plus the employee role's
// `cards.ve-*.**` and `cards.vr-*.**` subtrees, which are every card on every org-visible board. Each branch can
// seek an index, so SQLite answered the OR as a MULTI-INDEX OR: it collected every card any branch matched,
// sorted them all, and only then applied the LIMIT, on the first page and on every page after it
// (services/cards.ts `listCards` and services/listScope.ts have the numbers). The Boards page then read every
// board's cards to draw one board, a long board paid its whole range again on every page, and the cursor's
// `key < at OR (key = at AND uuid < uid)` bound was a filter rather than a seek, so page k walked k pages.
//
// So the check here is the number D1 bills: `meta.rows_read` for the statement `listCards` actually sends,
// captured on the way out and replayed, over a table holding far more visible cards than a page, for each of
// the first four pages. A scope bound as an index union, a board read that stops matching card_board_created_idx,
// or a cursor that stops seeking shows up as a row count that grows with the table or with the page number.
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

const NOW = Date.parse("2026-09-30T09:00:00.000Z");
const MIN = 60_000;
const CARDS = 1_200;
const PEOPLE = 30;
// Board 0 holds every even-numbered card. Boards 1-8 are org-editable (`ve`), 9-10 org-readable (`vr`), and 11
// is private (`vp`), so the caller below can see every card but the private board's and its own are a few
// dozen of the rest: the shape a real org has, where the visible set is most of the table.
const BOARDS = 12;
const PAGE = 100;

// Real ids: 13 Crockford base32 characters ending in an even one, because a page hands back a cursor that
// wire-encodes the last row's uuid.
const idOf = (prefix: string, n: number) => `${prefix}${String(n).padStart(9, "0")}0`;
const ME = idOf("emp", 7);
const BIG_BOARD = idOf("brd", 0);

// What the employee role's grants bind to: own breadth, plus the two org-visible board classes.
const SCOPE: ListScope = { breadth: "own", deptCode: null, ownerId: ME, seeRestricted: false, subtrees: ["ve", "vr"] };

// A page is 101 rows (the page plus the one that says there is more), and the walks measured 101 to 111. The
// plans this replaced read over 2,000 for any page of the union, over 1,000 for any page of a board-wide sort,
// and 201 or more from the second page on with a cursor that filtered instead of seeking.
const ROWS_READ_CEILING = 150;
const PAGES = 4;

async function seed(): Promise<void> {
  const seg = (col: string) => `(case when ${col} <= 8 then 've' when ${col} <= 10 then 'vr' else 'vp' end)`;
  await b.DB.batch([
    b.DB.prepare(
      `with recursive n(i) as (select 0 union all select i + 1 from n where i < ?1 - 1)
       insert into employees (uuid, code, first_name, last_name, work_email, created_at, updated_at)
       select 'emp' || printf('%09d', i) || '0', '04-' || printf('%03d', i), 'Person', 'N' || i, 'p' || i || '@test.example', ?2, ?2 from n`,
    ).bind(PEOPLE, NOW),
    b.DB.prepare(
      `with recursive n(i) as (select 0 union all select i + 1 from n where i < ?1 - 1)
       insert into boards (uuid, code, name, created_at, updated_at)
       select 'brd' || printf('%09d', i) || '0', ${seg("i")} || '-' || printf('%02d', i), 'Board ' || i, ?2, ?2 from n`,
    ).bind(BOARDS, NOW),
    // One card a minute, the newest a minute ago; every 25th deleted.
    b.DB.prepare(
      `with recursive n(i) as (select 0 union all select i + 1 from n where i < ?1 - 1),
       c(i, bd) as (select i, case when i % 2 = 0 then 0 else 1 + (i / 2) % (?2 - 1) end from n)
       insert into cards (uuid, code, board_id, seq, employee_id, column_key, title, created_at, updated_at, delete_time)
       select 'crd' || printf('%09d', i) || '0', ${seg("bd")} || '-' || printf('%02d', bd) || '-' || printf('%04d', i),
         'brd' || printf('%09d', bd) || '0', i, 'emp' || printf('%09d', i % ?3) || '0', 'todo', 'Task ' || i,
         ?4 - (?1 - i) * ?5, ?4 - (?1 - i) * ?5, case when i % 25 = 0 then ?4 else null end
       from c`,
    ).bind(CARDS, BOARDS, PEOPLE, NOW, MIN),
  ]);
}

/** Run the real `listCards`, then replay the cards statement it sent to read what D1 bills for it. */
async function listed(pageToken?: string, boardId?: string) {
  const sent: { sql: string; params: unknown[] }[] = [];
  const deps: Deps = { ...base, db: drizzle(b.DB, { logger: { logQuery: (sql, params) => void sent.push({ sql, params }) } }) as Deps["db"] };
  const page = await listCards(deps, SCOPE, PAGE, pageToken, boardId);
  const q = sent.find((s) => /from "cards"/.test(s.sql));
  if (!q) throw new Error(`listCards sent no cards statement: ${sent.map((s) => s.sql).join(" | ")}`);
  const replay = await b.DB.prepare(q.sql).bind(...q.params).all();
  const plan = await b.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).bind(...q.params).all<{ detail: string }>();
  return { page, rowsRead: replay.meta.rows_read, plan: plan.results.map((r) => r.detail).join(" | ") };
}

/** The newest live cards that match, worked out without any plan in the way: what the walk must return. */
async function expectedUuids(where: string, ...params: unknown[]): Promise<string[]> {
  const r = await b.DB.prepare(
    `select uuid from cards where delete_time is null and ${where} order by created_at desc, uuid desc limit ${PAGE * PAGES}`,
  ).bind(...params).all<{ uuid: string }>();
  return r.results.map((x) => x.uuid);
}
const VISIBLE = "(employee_id = ?1 or code glob 've-*' or code glob 'vr-*')";

/** Follow the cursor the way the Boards page does, checking every page's rows and what D1 billed for it. */
async function walk(want: string[], boardId?: string, label = "page"): Promise<void> {
  // The set must outrun the walk, or a later page would be short and cheap for the wrong reason.
  expect(want.length).toBe(PAGE * PAGES);
  let token: string | undefined;
  for (let k = 0; k < PAGES; k++) {
    const { page, rowsRead, plan } = await listed(token, boardId);
    expect(page.items.map((r) => r.uuid), `${label} ${k + 1} rows`).toEqual(want.slice(k * PAGE, (k + 1) * PAGE));
    expect(rowsRead, `${label} ${k + 1} read ${rowsRead} rows, planned as: ${plan}`).toBeLessThan(ROWS_READ_CEILING);
    token = page.nextPageToken;
  }
}

describe("card lists read a page per page, not every card the caller can see", () => {
  it("is measured by a counter that does count a scan here", async () => {
    // Without this, a runtime that reported no row counts would pass every ceiling below by reading zero.
    await seed();
    const scan = await b.DB.prepare("select count(*) as n from cards where title = 'no such task'").all();
    expect(scan.meta.rows_read).toBeGreaterThanOrEqual(CARDS);
  });

  it("walks the caller's cards newest first, a page of rows read for each page", async () => {
    await seed();
    await walk(await expectedUuids(VISIBLE, ME));
  });

  it("walks one board a page at a time, a page of rows read for each page", async () => {
    // The Boards page's read (`?board=`). Board 0 holds half the table, so a plan that reads the board's whole
    // range and sorts it pays several hundred rows for every page of the walk.
    await seed();
    await walk(await expectedUuids("board_id = ?1", BIG_BOARD), BIG_BOARD, "board page");
  });

  // Production may carry planner statistics, and stat1 averages change what SQLite thinks an index lookup
  // costs. Last in the file, so nothing after it runs against a database that has statistics.
  it("still reads a page per page once the database has planner statistics", async () => {
    await seed();
    await b.DB.prepare("ANALYZE").run();
    await walk(await expectedUuids(VISIBLE, ME), undefined, "page with statistics");
    await walk(await expectedUuids("board_id = ?1", BIG_BOARD), BIG_BOARD, "board page with statistics");
  });
});
