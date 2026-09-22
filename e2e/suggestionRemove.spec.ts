import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// Withdrawing a suggestion outright - not a status HR sets, a delete the submitter (or an admin) presses
// themselves. `suggestions.spec.ts` covers the anonymous-authorship promise and HR's triage response; neither
// ever removes one. The confirm copy says "permanently removed", but the table is soft-delete (moderation can
// still see what was pulled) - so what actually needs proving is both halves: the card is gone from the board
// a normal reader sees, and the row survives underneath with its delete_time set, not actually erased.
test("a suggestion is permanently removed from its own card", async ({ as }) => {
  const page = await as("super");
  const title = `E2E remove suggestion ${Date.now()}`;

  await gotoRoute(page, "suggestions", "Suggestion Box");
  await page.getByRole("button", { name: "New suggestion" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Details").fill("Filed to be removed by this spec.");
  await form.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const card = page.locator("div.shadow-card, div.rounded-lg.border").filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });

  await card.getByRole("button", { name: "Remove" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Remove this suggestion?")).toBeVisible();
  // The dialog now comes from the shared decision vocabulary, like Hide beside it, and its copy says what
  // separates the two buttons: removing takes the votes with it, hiding keeps them and can be undone. The
  // old wording ("permanently removed") described only this button, which was fine when it was the only
  // one on the card.
  await expect(confirm.getByText(/votes come off the box/)).toBeVisible();
  await expect(confirm.getByText(/Hiding it instead keeps the votes/)).toBeVisible();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(toast(page, "Suggestion removed")).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveCount(0, { timeout: 30_000 });

  // Gone from the ordinary read...
  const listed = await page.request.get("/v1/suggestions?page_size=200");
  const { results = [] } = (await listed.json()) as { results?: { title?: string; display_name?: string }[] };
  expect(results.some((s) => (s.title ?? s.display_name) === title)).toBe(false);

  // ...but soft-deleted, not erased: the row is still there with `show_deleted=true`, the way every other
  // moderated collection in the app behaves.
  const withDeleted = await page.request.get("/v1/suggestions?page_size=200&show_deleted=true");
  const { results: all = [] } = (await withDeleted.json()) as { results?: { title?: string; display_name?: string; path: string }[] };
  const soft = all.find((s) => (s.title ?? s.display_name) === title);
  expect(soft, "the removed suggestion should still be readable soft-deleted").toBeTruthy();

  await purge(page, soft!.path);
});
