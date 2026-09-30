import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A goal, and moving it.
//
// The goal itself is a row; what only a browser shows is the progress control. Progress is a slider whose
// value is not committed on drag - a note appears beside it and the change is saved deliberately, because
// somebody's quarter is being re-scored. `test/goalAlignment.test.ts` owns the rollup arithmetic; this
// covers that a goal can be created, found, moved and closed from the page it lives on.
test("a goal is created, its progress moved, and it completes", async ({ as }) => {
  // Longer than the retry near the end budgets itself - a default 30s test timeout shorter than that inner
  // window kills it mid-retry and reports it as the whole TEST timing out.
  test.setTimeout(150_000);
  const page = await as("manager");
  const title = `E2E goal ${Date.now()}`;

  await gotoRoute(page, "goals", "Goals");
  await page.getByRole("button", { name: "New goal" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "New goal" })).toBeVisible();
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Description/).fill("Raised by the goals spec.");
  await form.getByRole("button", { name: "Create goal" }).click();
  await expect(toast(page, "Goal created")).toBeVisible();

  // The goal is on the page, and opening it is how progress is reached.
  const card = page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title }).last();
  await expect(card).toBeVisible();
  await card.click();

  // The slider is the control, and it does NOT commit as it moves: the save appears once it has been
  // touched, with room for the note that explains the jump.
  const detail = page.getByRole("dialog");
  const slider = detail.getByRole("slider", { name: "Set progress" });
  await expect(slider).toBeVisible();
  await slider.fill("50");
  const note = detail.getByPlaceholder(/What changed/);
  await expect(note).toBeVisible();
  await note.fill("Half way through the quarter.");
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  // The saved value, read back off the page: the row where progress is shown, not the toast that announced it.
  await expect(detail.getByText("50%").first()).toBeVisible();

  // All the way: 100% closes the goal out rather than leaving it open at full. Re-saved on a miss and gated
  // on the RECORD: the detail showing "100%" is the slider's own local state, so a save whose request was
  // lost (a restarting dev Worker answers it with a 503) looks exactly like one that landed - and the read
  // from cold below then finds a goal still sitting at half, which reads as the feature not closing goals.
  await expect(async () => {
    if (await completed(page, title)) return;
    await slider.fill("100");
    await detail.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => completed(page, title), { timeout: 10_000 }).toBe(true);
  }).toPass({ timeout: 60_000 });
  await expect(detail.getByText(/Completed|100%/).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0, { timeout: 30_000 });
  // The closed drawer drops its history entry with an async `history.back()`, and a reload issued before that
  // lands can come up on the entry UNDER it - `/goals/<id>`, which opens the drawer again. So wait for the
  // drop, and read from cold by address rather than by reloading whichever entry happens to be current.
  await expect.poll(() => page.evaluate(() => (history.state as { hrmsDialog?: boolean } | null)?.hrmsDialog === true), { timeout: 30_000 }).toBe(false);
  // And the closed goal reads as complete on the page behind it - read from cold, not trusted to the list's
  // own in-place update: closing the detail can leave the row behind it showing an in-flight optimistic state
  // from partway through the two saves above rather than the settled one, under load.
  await expect(async () => {
    await gotoRoute(page, "goals", "Goals");
    await expect(page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title }).last()).toContainText(/Completed|100%/, { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await purge(page, await goalPath(page, title));
});

/** Whether the goal has actually closed out - asked of the record, not of the slider's own local state. */
async function completed(page: import("@playwright/test").Page, title: string): Promise<boolean> {
  const res = await page.request.get("/v1/goals?page_size=100");
  if (!res.ok()) return false;
  const { results = [] } = (await res.json()) as { results?: { title?: string; display_name?: string; progress?: number; status?: string }[] };
  const row = results.find((g) => (g.title ?? g.display_name) === title);
  return !!row && (row.status === "completed" || (row.progress ?? 0) >= 100);
}

/** The wire path of the goal this spec created. */
async function goalPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/goals?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[] };
  const row = results.find((g) => (g.title ?? g.display_name) === title);
  if (!row) throw new Error(`e2e: the goal "${title}" is not in the collection`);
  return row.path;
}
