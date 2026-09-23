import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Two card-level actions `goals.spec.ts` never reaches, because it does everything through the DETAIL
// drawer's own slider: the card's own one-click "Mark complete" (same `onProgress(100)` the slider fires,
// but reachable without opening the drawer at all - gated on `canProgress && !closed`, hidden the instant the
// card the reader is looking at IS closed), and Delete, a plain `useSoftDelete` instance `undo.spec.ts`
// proves the mechanism for once already (on vendors) - this page's own copy of it had never been pressed.
test("a goal is completed from its own card in one press, then deleted", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("manager");
  const title = `E2E quick-complete goal ${Date.now()}`;

  const made = await page.request.post("/v1/goals", { headers: SPA_HEADERS, data: { title } });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  await gotoRoute(page, "goals", "Goals");
  const card = page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });

  await card.getByRole("button", { name: "Mark complete" }).click();
  await expect(card).toContainText(/Completed|100%/, { timeout: 30_000 });
  // Closed, so there is nothing left to mark complete a second time.
  await expect(card.getByRole("button", { name: "Mark complete" })).toHaveCount(0);

  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Goal deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("div.shadow-card, tbody tr, li").filter({ hasText: title })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get` throws notFound
  // on `deleteTime` for every collection) - `show_deleted=true` on the list is the way to prove it survived.
  const after = await page.request.get(`/v1/goals?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((r) => r.path === path);
  expect(found?.delete_time, "the goal should survive soft-deleted, not be gone entirely").toBeTruthy();
});
