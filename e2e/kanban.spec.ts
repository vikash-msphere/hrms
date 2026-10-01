import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Moving a card between columns, and having it stay there.
//
// `test/cardsFlow.test.ts` owns the move itself (rank, WIP limits, commitment/delivery timestamps, the CFD
// that falls out of it). What it cannot see is the board: that the card renders under the column it belongs
// to, that the move affordance is reachable, and that a reload agrees with what the screen said.
//
// The move goes through the card's actions menu rather than a drag. The tiles ARE draggable, but by the HTML5
// drag-and-drop API, whose dataTransfer cannot be driven by synthetic pointer events - so a "drag" here would
// be a test of Playwright, not of the board. The menu path is the same `onMove` handler, and it is the path a
// touch user takes anyway.
test("a card moves column through the actions menu and stays moved", async ({ as }) => {
  const page = await as("super");

  // The seed ships no boards, so this spec brings its own - which also keeps it independent of every other
  // spec's data.
  const stamp = Date.now();
  const boardRes = await page.request.post("/v1/boards", {
    headers: SPA_HEADERS,
    data: { name: `E2E board ${stamp}` },
  });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string };
  const boardId = board.path.split("/")[1]!;

  const title = `E2E card ${stamp}`;
  const cardRes = await page.request.post("/v1/cards", {
    headers: SPA_HEADERS,
    // A board created without an explicit column set gets DEFAULT_BOARD_COLUMNS (src/domain/boards.ts):
    // Backlog / Ready / In progress / Review / Done.
    data: { board: board.path, title, column_key: "backlog" },
  });
  expect(cardRes.status(), await cardRes.text()).toBe(200);

  // Opened ON this spec's board rather than on whatever board the page picks by itself: every other spec that
  // needs a wall makes one too, and the page opens the first board it finds - which is a race, not a choice.
  await gotoRoute(page, `boards?board=${boardId}`);
  // Each column is a named group (web/src/pages/Boards.tsx), so "is this card in that column" is a real
  // containment question rather than a guess about the DOM shape.
  const column = (label: string) => page.getByRole("group", { name: label, exact: true });
  await expect(column("Backlog").getByText(title)).toBeVisible();

  // Filtered by the CONTROL as well as the text: the tile itself is the `role="button"` that opens the card,
  // and the actions menu deliberately sits OUTSIDE it (Boards.tsx - a menu nested inside a button is not a
  // control at all), so the innermost div holding the title no longer holds the menu. The wrapper that holds
  // both is the one this wants.
  const card = page
    .locator("div")
    .filter({ hasText: title })
    .filter({ has: page.getByRole("button", { name: "Task actions" }) })
    .last();
  await card.getByRole("button", { name: "Task actions" }).click();
  await page.getByRole("menuitem", { name: "Move to" }).click();
  await page.getByRole("menuitem", { name: "In progress", exact: true }).click();

  await expect(column("In progress").getByText(title)).toBeVisible();
  await expect(column("Backlog").getByText(title)).toHaveCount(0);

  // It was written, not just re-rendered.
  await page.reload();
  await expect(column("In progress").getByText(title)).toBeVisible();

  // Taken away again: a board is visible to every spec that opens the page, and a list of them is a board
  // somebody else has to scroll past.
  const filed = (await cardRes.json()) as { path: string };
  await purge(page, filed.path);
  await purge(page, board.path);
});

// A deep link names a CARD (`/boards/<cardId>`, what the activity feed and search hand out), never its board, and
// each board view reads only its own board's cards. So the page reads that one card to learn its board, shows
// that board, and opens the card on it. The reader was last on ANOTHER board, which the page would otherwise
// reopen (Boards.tsx, the last-viewed key), so landing on the card's board is the link being followed.
test("a deep link to a card opens the card on its own board", async ({ as }) => {
  const page = await as("super");
  const stamp = Date.now();
  const make = async (name: string) => {
    const res = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name } });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as { path: string };
  };
  const home = await make(`E2E link board ${stamp}`);
  const elsewhere = await make(`E2E other board ${stamp}`);
  const title = `E2E linked card ${stamp}`;
  const cardRes = await page.request.post("/v1/cards", {
    headers: SPA_HEADERS,
    data: { board: home.path, title, column_key: "backlog" },
  });
  expect(cardRes.status(), await cardRes.text()).toBe(200);
  const filed = (await cardRes.json()) as { path: string };

  await gotoRoute(page, `boards?board=${elsewhere.path.split("/")[1]}`);
  await expect(page.getByRole("main")).toBeVisible();

  await gotoRoute(page, `boards/${filed.path.split("/")[1]}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Title")).toHaveValue(title, { timeout: 30_000 });
  // And the board behind it is the card's, not the one the reader was last on. `includeHidden`: the open dialog
  // marks everything behind it aria-hidden, and the question is what is drawn there, not what is focusable.
  await expect(page.getByRole("group", { name: "Backlog", exact: true, includeHidden: true }).getByText(title)).toBeAttached();

  await purge(page, filed.path);
  await purge(page, home.path);
  await purge(page, elsewhere.path);
});
