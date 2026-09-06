import { SPA_HEADERS, purge, test, expect } from "./fixtures";

// The parts of a board that make it a kanban board rather than three lists: a WIP limit, swimlanes, and the
// flow metrics that fall out of the moves.
//
// `kanban.spec.ts` owns moving a card; `test/cardsFlow.test.ts` owns the maths. What only a browser has is
// the configuration loop and what it does to the wall: a limit set in the board's own settings panel has to
// come back as a count against that limit on the column, and as a warning IN THE COMPOSER before a fourth
// task is filed into a column that holds three - a limit nobody is told about is not a limit. Swimlanes
// re-cut the same cards into rows, and the analytics tab draws the cumulative flow the moves produced.
test("a board's WIP limit, swimlanes and flow metrics", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const stamp = Date.now();

  // The seed ships no boards, so this spec brings its own - and takes it away again, because every board is
  // visible to every other spec that opens the page.
  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E flow ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string };
  const boardId = board.path.split("/")[1]!;
  for (const n of [1, 2]) {
    const res = await page.request.post("/v1/cards", {
      headers: SPA_HEADERS,
      data: { board: board.path, title: `E2E flow card ${stamp}-${n}`, column_key: "backlog" },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  // Board configuration is an inline settings panel opened from the board itself - the board IS the object
  // being configured, so its settings live with it rather than in a global list.
  // Navigated by hand rather than through `gotoRoute`: this address opens a modal sheet, and a modal takes
  // the page out of the accessibility tree - so waiting for `<main>` here is a race against the panel the
  // link exists to open. The panel itself is what says the route arrived.
  await page.goto(`/#/boards?board=${boardId}&setting=board-config&settingObj=boards/${boardId}`);
  const columnsTab = page.getByRole("tab", { name: "Columns" });
  await expect(columnsTab).toBeVisible({ timeout: 30_000 });
  await columnsTab.click();
  const columns = page.getByPlaceholder("Column name");
  await expect(columns.first()).toHaveValue("Backlog");
  await page.getByPlaceholder("WIP").first().fill("2");
  // A limit means nothing until it says WHO it applies to, and the choice appears with the number.
  await expect(page.getByText("WIP limit applies").first()).toBeVisible();

  // Swimlanes re-cut the same cards into rows. By priority is the one set of lanes that needs no other data.
  await page.getByRole("tab", { name: "Swimlanes" }).click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "By priority" }).click();
  // Waited on the write itself, not on a toast: the sheet re-renders when the configure call lands, and a
  // Close pressed into that re-render is a click on an element that is being replaced.
  const configured = page.waitForResponse((r) => /\/v1\/boards\/[^/]+:configure$/.test(r.url()) && r.request().method() === "POST", { timeout: 60_000 });
  await page.getByRole("button", { name: /^Save/ }).first().click();
  expect((await configured).ok(), "the board configuration was not saved").toBe(true);
  // The panel is a modal sheet over the board; closing it hands the wall back (and leaves a clean URL - the
  // `?setting=` is the sheet's open state). Pressed until the sheet is gone rather than once: under a full
  // lane the press can land on the sheet mid-render, and what follows needs the wall, not the panel.
  await expect(async () => {
    if (await page.getByRole("tab", { name: "Swimlanes" }).count()) {
      await page.getByRole("button", { name: "Close" }).first().click({ timeout: 10_000 }).catch(() => {});
    }
    await expect(page.getByRole("tab", { name: "Swimlanes" })).toHaveCount(0);
  }).toPass({ timeout: 60_000 });

  // On the wall: the count is now read against the limit, and the priority lanes are there to drop into.
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText(`E2E flow card ${stamp}-1`)).toBeVisible({ timeout: 30_000 });
  const backlog = page.getByRole("group", { name: "Backlog", exact: true });
  await expect(backlog.getByText("2 / 2")).toBeVisible();
  await expect(page.getByText("Urgent").first()).toBeVisible();

  // A limit is a signal, not a lock: a third task can still be filed (work does not stop because a number
  // says so), and the column then reads over its limit rather than silently refusing.
  await page.getByRole("button", { name: "Add a task to Backlog" }).first().click();
  const quickAdd = page.getByPlaceholder("What needs doing?");
  await quickAdd.fill(`E2E flow card ${stamp}-3`);
  await quickAdd.press("Enter");
  await expect(backlog.getByText("3 / 2")).toBeVisible({ timeout: 30_000 });

  // And opening that task SAYS the consequence, in the editor where somebody could move it somewhere else.
  await page.getByText(`E2E flow card ${stamp}-3`).first().click();
  const composer = page.getByRole("dialog");
  await expect(composer.getByText("Backlog already holds 2 tasks - its WIP limit is 2.")).toBeVisible({ timeout: 30_000 });
  await composer.getByRole("button", { name: "Close" }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The analytics tab reads the same cards as flow: lead and cycle time, throughput, and the cumulative flow
  // diagram that shows where work piles up.
  // Reached from the board that is already on screen rather than by re-entering the route: closing a task
  // drops the history entry it opened over, and that step lands a tick or two later - so a navigation issued
  // in between can arrive first and put the task back on top of the tab strip. Anything found in the way is
  // dismissed and the tab pressed again, which is what a person would do with a card that reappeared.
  await expect(async () => {
    if (await page.getByRole("dialog").count()) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await page.getByRole("tab", { name: /Analytics/ }).click({ timeout: 15_000 });
    await expect(page.getByText("Lead time (p50)")).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 120_000 });
  await expect(page.getByText("Throughput")).toBeVisible();
  await expect(page.getByText(/Cumulative flow/i).first()).toBeVisible();

  await purgeBoard(page, boardId);
});

/** Drop the board this spec made, and the cards on it. */
async function purgeBoard(page: import("@playwright/test").Page, boardId: string) {
  const res = await page.request.get(`/v1/cards?page_size=200&board=boards/${boardId}`);
  if (res.ok()) {
    const { results = [] } = (await res.json()) as { results?: { path: string; board?: string }[] };
    for (const c of results.filter((x) => x.board === `boards/${boardId}`)) await purge(page, c.path);
  }
  await purge(page, `boards/${boardId}`);
}
