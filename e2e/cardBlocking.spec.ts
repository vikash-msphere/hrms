import { SPA_HEADERS, purge, test, expect } from "./fixtures";

// A card blocked by another one - never touched by `cardWork.spec.ts` (checklist/comments) or
// `boardsAdvanced.spec.ts` (WIP/swimlanes/CFD). The dependency is a real edge between two cards: the
// blocked side names who it's waiting on and why, with a link that opens that other card, and the blocker's
// OWN card shows the reverse edge - who is waiting on it - computed client-side from the cards already on
// the board, not a separate query.
test("blocking a card names the blocker, links to it, and shows the reverse edge on the other card", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now();
  const titleA = `E2E blocker task ${stamp}`;
  const titleB = `E2E blocked task ${stamp}`;
  const reason = `waiting on ${stamp % 100000}`;

  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E block board ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string };
  const boardId = board.path.split("/")[1]!;
  const madeA = await page.request.post("/v1/cards", { headers: SPA_HEADERS, data: { board: board.path, title: titleA, column_key: "backlog" } });
  expect(madeA.status(), await madeA.text()).toBe(200);
  const madeB = await page.request.post("/v1/cards", { headers: SPA_HEADERS, data: { board: board.path, title: titleB, column_key: "backlog" } });
  expect(madeB.status(), await madeB.text()).toBe(200);

  try {
    await page.goto(`/#/boards?board=${boardId}`);
    await expect(page.getByRole("main")).toBeVisible();

    // B is blocked by A, with a note.
    await page.getByText(titleB).first().click();
    const cardB = page.getByRole("dialog");
    await expect(cardB.getByLabel("Title")).toHaveValue(titleB, { timeout: 30_000 });
    await cardB.getByPlaceholder("Blocked by a task…").click();
    await page.getByPlaceholder(/Search/).last().fill(titleA);
    await page.getByRole("button", { name: new RegExp(titleA) }).click();
    await cardB.getByPlaceholder("Note (optional)…").fill(reason);
    await cardB.getByRole("button", { name: "Block", exact: true }).click();
    await expect(cardB.getByText("Blocked", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(cardB.getByText(reason, { exact: false })).toBeVisible();
    const blockerLink = cardB.getByRole("button", { name: new RegExp(titleA) });
    await expect(blockerLink).toBeVisible();

    // Follows the link to A, and A shows the other half of the same edge: it "Blocks" B.
    await blockerLink.click();
    const cardA = page.getByRole("dialog");
    await expect(cardA.getByLabel("Title")).toHaveValue(titleA, { timeout: 15_000 });
    await expect(cardA.getByText("Blocks", { exact: false })).toBeVisible();
    await expect(cardA.getByRole("button", { name: new RegExp(titleB) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    // Unblocked: B's own controls return to offering to block it, not still showing it as blocked.
    await page.getByText(titleB).first().click();
    const cardB2 = page.getByRole("dialog");
    await expect(cardB2.getByLabel("Title")).toHaveValue(titleB, { timeout: 15_000 });
    await cardB2.getByRole("button", { name: "Unblock", exact: true }).click();
    await expect(cardB2.getByPlaceholder("Blocked by a task…")).toBeVisible({ timeout: 15_000 });
    await expect(cardB2.getByRole("button", { name: "Unblock", exact: true })).toHaveCount(0);
  } finally {
    const cards = await page.request.get(`/v1/cards?page_size=200&board=boards/${boardId}`);
    if (cards.ok()) {
      const { results = [] } = (await cards.json()) as { results?: { path: string; board?: string }[] };
      for (const c of results.filter((x) => x.board === `boards/${boardId}`)) await purge(page, c.path);
    }
    await purge(page, `boards/${boardId}`);
  }
});
