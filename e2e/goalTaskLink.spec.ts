import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// A goal that scores itself off the work.
//
// A goal's progress can be typed in by hand (that is `goals.spec.ts`), or it can be DERIVED: link board
// tasks to it and the server re-computes the goal from the delivered share of them, weighted by story
// points, on every link, unlink and delivery. So the number on the goal is a fact about the board, and the
// linking is done from the goal's own drawer - which is where the lazy read of the board lives, and the only
// place the two halves are on screen together.
//
// `test/goalAlignment.test.ts` owns the arithmetic. What only a browser shows is the loop: the drawer offers
// the unlinked tasks, the linked list reads back the points, and the progress moves without being typed.
test("linked tasks score the goal by their delivered points", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const stamp = Date.now();
  const title = `E2E derived goal ${stamp}`;
  const doneTask = `E2E goal task done ${stamp}`;
  const openTask = `E2E goal task open ${stamp}`;

  // The board and its two tasks, over the wire: 3 points delivered and 5 points still open, so the goal has
  // one honest answer (3 of 8 points) that no amount of typing could produce by accident.
  const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E goal board ${stamp}` } });
  expect(boardRes.status(), await boardRes.text()).toBe(200);
  const board = (await boardRes.json()) as { path: string; columns?: { key: string }[] };
  const boardId = board.path.split("/")[1]!;
  const delivered = await makeCard(page, board.path, doneTask, 3);
  const open = await makeCard(page, board.path, openTask, 5);

  const lastColumn = board.columns?.[board.columns.length - 1]?.key;
  if (!lastColumn) throw new Error("e2e: the new board has no columns to deliver into");

  const goalRes = await page.request.post("/v1/goals", {
    headers: SPA_HEADERS,
    data: { title, description: "Scored from the board by the goalTaskLink spec." },
  });
  expect(goalRes.status(), await goalRes.text()).toBe(200);
  const goal = (await goalRes.json()) as { path: string };

  await gotoRoute(page, "goals", "Goals");
  await page.getByText(title).first().click();
  const drawer = page.getByRole("dialog");
  // Linked tasks live on the drawer's Connections tab; it opens on Overview.
  await drawer.getByRole("tab", { name: /^Connections/ }).click();
  await expect(drawer.getByText("Linked tasks")).toBeVisible({ timeout: 30_000 });

  // Nothing linked yet, so there is nothing to weigh - the section's count says so by being absent rather
  // than showing 0 of 0 points.
  await expect(drawer.getByText(/^\d+\/\d+ pts$/)).toHaveCount(0);

  // The board is read only while this drawer is open, and what it offers is the unlinked, undelivered work.
  await drawer.getByRole("button", { name: "Link tasks" }).click();
  // The offer is the app's shared Combobox: a trigger, then a search box in a portal at the page root.
  await drawer.getByRole("button", { name: "Select…" }).click();
  await page.getByPlaceholder("Search tasks…").fill(openTask);
  await page.getByRole("option", { name: openTask }).click();
  // The linked list is the assertion, not the toast: it names the task, its points, and the delivered share
  // (the section's count beside its "Linked tasks" heading).
  await expect(drawer.getByText("0/5 pts", { exact: true })).toBeVisible({ timeout: 30_000 });

  await drawer.getByRole("button", { name: "Link tasks" }).click();
  await drawer.getByRole("button", { name: "Select…" }).click();
  await page.getByPlaceholder("Search tasks…").fill(doneTask);
  await page.getByRole("option", { name: doneTask }).click();
  // Both linked, neither delivered: eight points of work and nothing done.
  await expect(drawer.getByText("0/8 pts", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => goalProgress(page, goal.path), { timeout: 30_000 }).toBe(0);

  // Delivering one is what moves the goal - "reached the delivery column" is the move verb's business, not a
  // flag, and the server re-derives the goal from it. Done over the wire because dragging a card across a
  // board is `kanban.spec.ts`'s subject.
  // Re-read for the etag rather than reusing the one the create answered with: linking the task to the goal
  // WROTE to this card, so the version held since it was made is two edits old and the move is correctly
  // refused as a lost update.
  const fresh = await page.request.get(`/v1/${delivered.path}`, { headers: SPA_HEADERS });
  expect(fresh.status(), await fresh.text()).toBe(200);
  const moved = await page.request.post(`/v1/${delivered.path}:move`, {
    headers: { ...SPA_HEADERS, "If-Match": fresh.headers()["etag"]! },
    data: { to_column: lastColumn },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  await expect.poll(() => goalProgress(page, goal.path), { timeout: 30_000 }).toBe(38);

  // And the drawer reads that back: three of eight points delivered, scored 38% without anybody typing a
  // percentage.
  // The drawer is what is waited for, not `<main>`: a modal takes the page out of the accessibility tree, so
  // a reload that lands back ON the goal hides `<main>` the moment the drawer opens.
  await page.reload();
  const again = page.getByRole("dialog");
  await expect(again).toBeVisible({ timeout: 30_000 });
  await again.getByRole("tab", { name: /^Connections/ }).click();
  await expect(again.getByText("3/8 pts", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The drawer wears the score in its own heading (the ring's number beside the title), which is where a
  // reader looks for "how is this goal doing".
  await expect(again.getByRole("heading", { level: 2 })).toContainText("38");

  // Unlinking is the same loop backwards, from the task's own row - and the score follows it.
  await again.getByRole("button", { name: `Unlink ${doneTask}` }).click();
  await expect(again.getByText("0/5 pts", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => goalProgress(page, goal.path), { timeout: 30_000 }).toBe(0);

  await purge(page, delivered.path);
  await purge(page, open.path);
  await purge(page, `boards/${boardId}`);
  await purge(page, goal.path);
});

/** A board task with an estimate, over the wire. */
async function makeCard(
  page: import("@playwright/test").Page,
  board: string,
  cardTitle: string,
  size: number,
): Promise<{ path: string; etag: string }> {
  const res = await page.request.post("/v1/cards", { headers: SPA_HEADERS, data: { board, title: cardTitle, size } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { path: string; etag: string };
}

/** The goal's progress as the server derives it - the number the ring and the chip both read. */
async function goalProgress(page: import("@playwright/test").Page, path: string): Promise<number | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { progress?: number }).progress;
}
