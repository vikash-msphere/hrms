import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The word a mixed result list uses for a kanban card - "Task", not "Card" and not the wire collection's own
// name ("cards"). `lib/entityKinds.ts` exists so a result list blending a person, a settings page and a board
// card reads as a list of THINGS rather than a list of table names, and `cards -> Task/Tasks` is exactly the
// irregular mapping a naive "singularize the collection name" would get wrong (it would say "Cards" and
// "Card", which is what the wire calls it, not what anyone calls the thing on the board).
test("a board card in search results is labelled Task, grouped under Tasks", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const stamp = Date.now();

  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E kind board ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string };

  const title = `E2E kind card ${stamp}`;
  const cardRes = await page.request.post("/v1/cards", {
    headers: SPA_HEADERS,
    data: { board: board.path, title, column_key: "backlog" },
  });
  expect(cardRes.status(), await cardRes.text()).toBe(200);
  const card = (await cardRes.json()) as { path: string };

  try {
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await expect(search).toBeVisible();
    await search.fill(title);

    await expect(page.getByText("Tasks", { exact: true })).toBeVisible({ timeout: 30_000 });
    const result = page.getByRole("button").filter({ hasText: title }).first();
    await expect(result).toBeVisible();
    await expect(result.getByText("Task", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
  } finally {
    await purge(page, card.path);
    await purge(page, board.path);
  }
});
