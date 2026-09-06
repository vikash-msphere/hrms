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

  const card = page.locator("div").filter({ hasText: title }).last();
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
