import type { Locator, Page } from "@playwright/test";
import { SPA_HEADERS, fileLeave, gotoRoute, purge, test, expect } from "./fixtures";

// The wide-screen layout, measured on a wide screen (docs/06-responsive-ui.md, "Wide screens").
//
// This runs only in the `wide` project (2560x1440). Every rule it checks keys off a width past 1440 - `2xl:`,
// `3xl:`, or a container that a 1440 screen never gives its contents - so the `desktop` project at 1440 sees
// none of it, and by the same rule is the baseline that proves none of it leaked down. The source cannot answer
// these: whether a cap binds, how many tracks a grid resolved to, which column a section landed in, and whether
// a docked panel really leaves the list clickable are questions for the layout engine.

async function box(l: Locator) {
  await expect(l).toBeVisible({ timeout: 30_000 });
  const b = await l.boundingBox();
  expect(b, "the element has a box on screen").not.toBeNull();
  return b!;
}

// Boards and Goals are tabs of one workspace, and its tab strip sits inside `<main>`: if the two pages had
// different widths, every press of a tab would resize and re-centre the strip under the pointer (rule 31).
test("main has one width and one position on every page, a board included", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "goals");
  // 2560 minus the sidebar is more than the cap, so the cap is what sets the width here (App.tsx).
  const goals = await box(page.getByRole("main"));
  expect(Math.round(goals.width)).toBe(1920);

  await gotoRoute(page, "boards");
  const boards = await box(page.getByRole("main"));
  expect(Math.round(boards.width), "a board is as wide as the tab beside it").toBe(1920);
  expect(Math.round(boards.x), "and starts where that tab's page starts").toBe(Math.round(goals.x));
});

test("the people grid adds columns instead of widening its cards", async ({ as }) => {
  const page = await as("hr");
  await gotoRoute(page, "employees", "Directory");
  // A fresh browser lands on the table; the cards are a per-browser choice (directoryViews.spec.ts).
  await page.getByRole("button", { name: "Card view" }).click();
  const grid = page.locator('main div.grid:has(> div > button[aria-label^="Open "])').first();
  await expect(grid).toBeVisible({ timeout: 30_000 });

  const tracks = await grid.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { count: cs.gridTemplateColumns.split(" ").filter(Boolean).length, width: el.clientWidth, gap: parseFloat(cs.columnGap) };
  });
  // `[--cell:11rem] 2xl:grid-cols-fill` (Directory.tsx): as many 176px tracks as fit, where the `xl:` step
  // stopped at five.
  expect(tracks.count).toBe(Math.floor((tracks.width + tracks.gap) / (176 + tracks.gap)));
  expect(tracks.count).toBeGreaterThan(5);
});

test("a board's columns share the row, and a card whose content fits goes on one line", async ({ as }) => {
  const page = await as("super");
  const stamp = Date.now();
  // The spec's own board, opened by id: the page otherwise opens whichever board it finds first.
  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E wide board ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string };
  const short = `E2E short ${stamp}`;
  const long = `E2E long ${stamp} - a title written to run past one line of any column, so that the details it carries have to drop under it rather than squeeze it`;
  const cards: string[] = [];
  try {
    for (const title of [short, long]) {
      const res = await page.request.post("/v1/cards", { headers: SPA_HEADERS, data: { board: board.path, title, column_key: "backlog" } });
      expect(res.status(), await res.text()).toBe(200);
      cards.push(((await res.json()) as { path: string }).path);
    }

    await gotoRoute(page, `boards?board=${board.path.split("/")[1]}`);
    const column = page.getByRole("group", { name: "Backlog", exact: true });
    await expect(column.getByText(short, { exact: true })).toBeVisible({ timeout: 30_000 });
    // Five default columns in the 1856px inside the cap: each has grown past its 18rem (288px) basis, to ~360.
    expect((await box(column)).width).toBeGreaterThan(340);

    // The tile is the `role="button"` named after the card; its details row ends in the avatar slot.
    const tile = (title: string) => page.getByRole("button", { name: `Open ${title}`, exact: true });
    const avatarOf = (title: string) => tile(title).locator(".task-tile-meta > .ml-auto");

    // The short card is one line: its title and its avatar share a row.
    const t =await box(tile(short).getByText(short, { exact: true }));
    const a = await box(avatarOf(short));
    expect(Math.abs(t.y + t.height / 2 - (a.y + a.height / 2)), "title and details on one line").toBeLessThan(6);

    // The long one still wraps - nothing is truncated - and its details drop under it.
    const lt = await box(tile(long).getByText(long, { exact: true }));
    const la = await box(avatarOf(long));
    expect(lt.height, "the long title wraps onto more than one line").toBeGreaterThan(30);
    expect(la.y, "its details sit under the title").toBeGreaterThanOrEqual(lt.y + lt.height - 1);
  } finally {
    for (const p of cards) await purge(page, p);
    await purge(page, board.path);
  }
});

test("the dashboard puts holidays and the board in its side column", async ({ as }) => {
  // Not `super`: dashboardLayout.spec.ts hides and reorders sections on that login, and a section it has just
  // hidden is not one this can measure.
  const page = await as("it");
  await gotoRoute(page, "dashboard");
  const main = await box(page.getByRole("main"));
  const holidays = await box(page.getByText("Upcoming holidays").first());
  const board = await box(page.getByText("Latest from the board").first());
  // Both in the right-hand column (26rem beside the main one), one above the other.
  expect(holidays.x, "holidays sit in the side column").toBeGreaterThan(main.x + main.width / 2);
  expect(Math.abs(holidays.x - board.x), "the board card shares that column").toBeLessThan(2);
  expect(board.y, "and sits under the holidays").toBeGreaterThan(holidays.y);
});

test("the board's search and filters sit in its side column, once", async ({ as }) => {
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  // A post of the spec's own, so the board is never the empty-board pitch (which carries no filter bar). Announced
  // to nobody: this is about the board's layout, not about notifying the company.
  const res = await page.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title: `E2E wide post ${stamp}`, body: "Posted for the wide-screen spec.", audience_scope: "none" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const post = ((await res.json()) as { path: string }).path;
  try {
    await gotoRoute(page, "announcements", "Feed");
    const side = page.getByRole("complementary", { name: "Board tools" });
    await expect(side.getByRole("searchbox", { name: "Search the board" })).toBeVisible({ timeout: 30_000 });
    // Mounted in ONE place: the inline bar above the feed is not also drawn (Announcements.tsx, `wideBoard`).
    await expect(page.getByRole("searchbox", { name: "Search the board" })).toHaveCount(1);
    // Beside the feed, not above it.
    const s = await box(side);
    const card = await box(page.locator('div[id^="post-"]').first());
    expect(s.x, "the side column starts right of the feed").toBeGreaterThanOrEqual(card.x + card.width - 1);
  } finally {
    await purge(page, post);
  }
});

// The day a filed request sits on, as its row prints it: day-first with the month spelled out ("18 Jan 2027"),
// the format web/src/lib/utils.ts pins. `fileLeave` gives every filing a far-future day nothing else uses.
async function datedRow(page: Page, path: string): Promise<RegExp> {
  const res = await page.request.get(`/v1/${path}`);
  expect(res.ok(), await res.text()).toBe(true);
  const on = ((await res.json()) as { start_date: string }).start_date;
  const [year, , day] = on.split("-");
  const month = new Date(`${on}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return new RegExp(`${Number(day)}\\s+${month}\\s+${year}`);
}

test("a leave request's detail docks beside the list, and another row swaps it", async ({ as }) => {
  test.setTimeout(180_000);
  // The manager's own leave, as in leaveSelfService.spec.ts: the shared employee's list is what six other specs
  // file and decide on while this runs.
  const page = await as("manager");
  const stamp = Date.now();
  // Leftovers from earlier runs of this spec only (its own reason shape), so its rows stay on the first page.
  const old = await page.request.get("/v1/leave-requests?page_size=200");
  if (old.ok()) {
    for (const r of ((await old.json()) as { results?: { path: string; reason?: string }[] }).results ?? []) {
      if (/^E2E wide [AB] \d{13}/.test(r.reason ?? "")) await purge(page, r.path);
    }
  }
  const reasons = [`E2E wide A ${stamp}`, `E2E wide B ${stamp}`];
  const paths: string[] = [];
  try {
    for (const r of reasons) paths.push(await fileLeave(page, r));
    const [onA, onB] = [await datedRow(page, paths[0]!), await datedRow(page, paths[1]!)];

    await gotoRoute(page, "leave-requests", "Leaves");
    await page.getByRole("tab", { name: /^Requests/ }).click();
    // Narrowed through the page's own server-side search, which reaches the whole collection; the date is what
    // makes each row unmistakably this spec's.
    const search = page.getByPlaceholder(/Search all records/);
    if (await search.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)) {
      await search.fill(String(stamp));
    }
    const rowA = page.locator("tbody tr").filter({ hasText: onA }).first();
    const rowB = page.locator("tbody tr").filter({ hasText: onB }).first();
    await expect(rowA).toBeVisible({ timeout: 30_000 });
    await expect(rowB).toBeVisible({ timeout: 30_000 });

    await rowA.getByText(onA).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(reasons[0]!, { exact: true })).toBeVisible({ timeout: 15_000 });

    // Beside the list rather than over it: the page column gave up the panel's width (`--sheet-dock`).
    const s = await box(sheet);
    const m = await box(page.getByRole("main"));
    expect(m.x + m.width, "the list ends where the panel starts").toBeLessThanOrEqual(s.x + 1);

    // A click on another row is the reader picking it - no overlay intercepts it, and the panel stays and
    // shows that request.
    await rowB.getByText(onB).first().click();
    await expect(sheet.getByText(reasons[1]!, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("dialog")).toHaveCount(1);

    // Escape typed in the list belongs to the list; the panel's own close button still closes it.
    await rowB.focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    for (const p of paths) await purge(page, p);
  }
});
