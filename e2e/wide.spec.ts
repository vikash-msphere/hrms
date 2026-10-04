import type { Locator, Page } from "@playwright/test";
import { SPA_HEADERS, fileLeave, gotoRoute, makeThrowawayPerson, purge, retireThrowawayPerson, searchPanel, test, expect } from "./fixtures";

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

// The search field sits in the middle of the room between the breadcrumb and the clock. Both keep one width -
// the clock in either state, the breadcrumb on every page - so neither a punch nor a page change moves the field
// or narrows it (TopBar.tsx).
test("the top bar's search field is centred between the breadcrumb and the clock, and neither a punch nor a page change moves it", async ({ as }) => {
  // A login of its own: punching one of the seeded five would race clock.spec.ts on the same person.
  const admin = await as("super");
  const person = await makeThrowawayPerson(admin, "WideClock");
  try {
    const page = await as({ email: person.email });
    await gotoRoute(page, "dashboard");
    const bar = page.getByRole("banner");
    const search = bar.locator("[data-search-field]");
    const centredBetweenNeighbours = async () => {
      const [crumb, clock, field] = [await box(bar.getByRole("navigation", { name: "Breadcrumb" })), await box(bar.locator("[data-clock-slot]")), await box(search)];
      expect(Math.abs(field.x + field.width / 2 - (crumb.x + crumb.width + clock.x) / 2), "centred between the breadcrumb and the clock").toBeLessThanOrEqual(1);
      return field;
    };

    const before = await centredBetweenNeighbours();
    // 2560 leaves the field far more room than it needs, so its 36rem cap is what sets the width.
    expect(Math.round(before.width)).toBe(576);

    await bar.getByRole("button", { name: /^Clock in$/ }).click();
    await expect(bar.getByRole("button", { name: /^Clock out/ })).toBeVisible();
    const clockedIn = await centredBetweenNeighbours();
    expect(Math.round(clockedIn.x), "clocking in does not move it").toBe(Math.round(before.x));
    expect(Math.round(clockedIn.width), "or narrow it").toBe(Math.round(before.width));

    // Another page has another breadcrumb, but the breadcrumb is one width on every page, so the field stays put.
    await gotoRoute(page, "attendance", "Attendance");
    const elsewhere = await centredBetweenNeighbours();
    expect(Math.round(elsewhere.x), "another page's breadcrumb does not move it").toBe(Math.round(before.x));
    expect(Math.round(elsewhere.width)).toBe(Math.round(before.width));

    await bar.getByRole("button", { name: /^Clock out/ }).click();
    await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();

    // With the field on screen, ⌘K searches in it - its results drop down under it - rather than opening the
    // modal palette over the page (CommandPalette.tsx).
    await page.keyboard.press("ControlOrMeta+k");
    await expect(bar.getByRole("combobox", { name: "Search everything" })).toBeFocused();
    await expect(searchPanel(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Open, the field grows evenly on both sides to its 64rem cap - the centre stays where it was - and a bar
    // this wide has the room for that between the breadcrumb and the clock, so neither is hidden.
    await expect.poll(async () => Math.round((await search.boundingBox())?.width ?? 0)).toBe(1024);
    // At that width the results have the preview pane beside them.
    await expect(page.getByRole("complementary", { name: "Preview" })).toBeVisible();
    const open = (await search.boundingBox())!;
    expect(Math.abs(open.x + open.width / 2 - (before.x + before.width / 2)), "it grows about its own centre").toBeLessThanOrEqual(1);
    await expect(bar.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(searchPanel(page)).toHaveCount(0);
    await expect.poll(async () => Math.round((await search.boundingBox())?.width ?? 0)).toBe(Math.round(before.width));
  } finally {
    await retireThrowawayPerson(admin, person.path);
  }
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
    const search = page.getByRole("searchbox", { name: "Search all records" });
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
