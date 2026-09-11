import { SPA_HEADERS, purge, test, expect, toast } from "./fixtures";

// Deleting a card from inside its own detail dialog - a soft delete ("removed from view... restorable by an
// admin"), and never pressed anywhere. `kanban.spec.ts` moves cards, `cardWork.spec.ts` works inside one,
// `cardBlocking.spec.ts` covers being blocked - none of them ever removes one.
test("a card is deleted from its own dialog, and reads back soft-deleted", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now();
  const title = `E2E delete card ${stamp}`;

  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E delete board ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string };
  const boardId = board.path.split("/")[1]!;
  const cardRes = await page.request.post("/v1/cards", { headers: SPA_HEADERS, data: { board: board.path, title, column_key: "backlog" } });
  expect(cardRes.status(), await cardRes.text()).toBe(200);
  const cardPath = ((await cardRes.json()) as { path: string }).path;

  try {
    await page.goto(`/#/boards?board=${boardId}`);
    await expect(page.getByRole("main")).toBeVisible();
    await page.getByText(title).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Title")).toHaveValue(title, { timeout: 30_000 });

    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: /^Delete .+\?/ });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText(/removed from view \(soft delete\)\. Restorable by an admin\./)).toBeVisible();
    await confirm.getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(toast(page, "Task deleted")).toBeVisible({ timeout: 30_000 });

    // Off the board, and the dialog it lived in with it.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(title)).toHaveCount(0, { timeout: 30_000 });

    // Soft-deleted, not erased. Plain GET 404s on a deleted row by design (the generic crud factory's default
    // `get` throws notFound on `deleteTime`), so `show_deleted=true` on the list is the way to check.
    const after = await page.request.get(`/v1/cards?show_deleted=true&page_size=200&board=boards/${boardId}`);
    expect(after.ok(), await after.text()).toBe(true);
    const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
    const found = results.find((r) => r.path === cardPath);
    expect(found?.delete_time, "the card should survive soft-deleted, not be gone entirely").toBeTruthy();
  } finally {
    await purgeBoard(page, boardId);
  }
});

async function purgeBoard(page: import("@playwright/test").Page, boardId: string) {
  const res = await page.request.get(`/v1/cards?page_size=200&board=boards/${boardId}`);
  if (res.ok()) {
    const { results = [] } = (await res.json()) as { results?: { path: string; board?: string }[] };
    for (const c of results.filter((x) => x.board === `boards/${boardId}`)) await purge(page, c.path);
  }
  await purge(page, `boards/${boardId}`);
}
