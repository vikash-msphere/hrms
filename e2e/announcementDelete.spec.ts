import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Deleting a post from the board - none of the announcement specs (draft, poll, solo, mentions, reactions,
// replies, pin, sticker) ever remove one; all of them purge through the API. Shares the generic
// `useSoftDelete` mechanism `undo.spec.ts` proves once (on vendors); this is this page's own copy.
test("a post is deleted from the board", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const title = `E2E delete post ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title, body: "Written to be deleted by this spec.", audience_scope: "none" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  await gotoRoute(page, "announcements", "Feed");
  const card = page.locator("div").filter({ hasText: title }).filter({ has: page.getByRole("button", { name: "Delete" }) }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  // Deleting a post asks first. It is a soft delete and `useSoftDelete` does not confirm on its own, but on
  // THIS card the bin sits beside a moderator's Hide, which does ask - and two adjacent buttons where the
  // quieter one is the more destructive is how somebody deletes a post they meant to hide. The dialog's own
  // button carries the same word, so it is addressed through the dialog rather than by name alone.
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Post deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("div").filter({ hasText: title })).toHaveCount(0, { timeout: 30_000 });

  // Plain GET 404s for a soft-deleted row by design (the generic crud factory's default `get` throws notFound
  // on `deleteTime` for every collection) - `show_deleted=true` on the list is the way to prove it survived.
  const after = await page.request.get(`/v1/announcements?show_deleted=true&page_size=200`);
  expect(after.ok(), await after.text()).toBe(true);
  const { results = [] } = (await after.json()) as { results?: { path: string; delete_time?: string }[] };
  const found = results.find((r) => r.path === path);
  expect(found?.delete_time, "the post should survive soft-deleted, not be gone entirely").toBeTruthy();
});
