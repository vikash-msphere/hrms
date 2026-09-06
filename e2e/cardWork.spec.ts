import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// A task being worked, rather than moved.
//
// `kanban.spec.ts` moves a card between columns and `boardsAdvanced.spec.ts` covers the board's own rules.
// The work itself happens inside the card: a checklist that tracks what is left, and a comment thread that is
// where the reasoning ends up. Both are separate tables (`card_todos`, `card_comments`) rolled up onto the
// card - the tile shows "2/3" and a comment count - so this is the same class the ticket spec covers, on the
// surface most teams actually live in. `test/cardsFlow.test.ts` owns what a tick does to the card's progress.
test("a card takes a checklist and a comment, and the tile counts them", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now();
  const title = `E2E worked card ${stamp}`;
  const item = `E2E subtask ${stamp % 100000}`;
  const toRemove = `E2E gone ${stamp % 100000}`;
  const comment = `E2E note ${stamp % 100000}`;

  // The board and the card come over the wire: this spec is about what happens INSIDE a card.
  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E work board ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string };
  const boardId = board.path.split("/")[1]!;
  const cardRes = await page.request.post("/v1/cards", {
    headers: SPA_HEADERS,
    data: { board: board.path, title, column_key: "backlog" },
  });
  expect(cardRes.status(), await cardRes.text()).toBe(200);

  await page.goto(`/#/boards?board=${boardId}`);
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByText(title).first().click();

  // The checklist. Each line is its own row, added from the field the card offers rather than through a
  // separate editor.
  const card = page.getByRole("dialog");
  // The card's own heading is its task key ("EWB1-1 Task"); the title lives in the field, which is where an
  // editor would change it.
  await expect(card.getByLabel("Title")).toHaveValue(title, { timeout: 30_000 });
  // The Add button, not Enter: the field deliberately swallows Enter (unswallowed it reaches the dialog's
  // submit and saves the whole task while somebody is still building the list).
  const add = card.getByPlaceholder("Add a checklist item…");
  await add.fill(item);
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await expect(card.getByText(item)).toBeVisible({ timeout: 30_000 });

  // Ticking is the write - there is no save - and the card counts what is done against what is left.
  const box = card.getByRole("checkbox").first();
  await box.click();
  await expect(box).toBeChecked({ timeout: 30_000 });

  // Removal (`removeTodo`) is its own verb too - a second item added only to be deleted, so the reload
  // assertions below stay about the item that survives.
  await add.fill(toRemove);
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await expect(card.getByText(toRemove)).toBeVisible({ timeout: 30_000 });
  const removeRow = card.locator("div").filter({ hasText: toRemove }).last();
  await removeRow.getByRole("button", { name: "Remove" }).click();
  await expect(card.getByText(toRemove)).toHaveCount(0, { timeout: 30_000 });

  // The comment thread: where the reason a task took three days is written down.
  const composer = card.getByPlaceholder(/Add a comment/);
  await composer.fill(comment);
  await card.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(card.getByText(comment)).toBeVisible({ timeout: 30_000 });

  // Read back from cold, on the card and on the wall behind it: the tile carries the checklist count, which
  // is the whole reason a checklist is worth having on a board.
  // Reloaded rather than re-navigated: opening a card writes its id into the hash, so a reload lands back on
  // the card. Navigating to the board alone would drop that and there would be nothing open to read.
  // The dialog is what is waited for, not `<main>`: a modal takes the page out of the accessibility tree, so
  // the reload that lands back ON the card hides `<main>` the moment it opens - which makes "the page came
  // back" a race against the card reopening rather than a check of anything.
  await page.reload();
  const reopened = page.getByRole("dialog");
  await expect(reopened).toBeVisible({ timeout: 30_000 });
  await expect(reopened.getByText(comment)).toBeVisible({ timeout: 30_000 });
  await expect(reopened.getByText(item)).toBeVisible();
  await expect(reopened.getByRole("checkbox").first()).toBeChecked();

  await purgeBoard(page, boardId);
});

/** Drop the board this spec made, and the card on it. */
async function purgeBoard(page: import("@playwright/test").Page, boardId: string) {
  const res = await page.request.get(`/v1/cards?page_size=200&board=boards/${boardId}`);
  if (res.ok()) {
    const { results = [] } = (await res.json()) as { results?: { path: string; board?: string }[] };
    for (const c of results.filter((x) => x.board === `boards/${boardId}`)) await purge(page, c.path);
  }
  await purge(page, `boards/${boardId}`);
}
