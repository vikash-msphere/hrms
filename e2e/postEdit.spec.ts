import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Fixing a post that has already gone out.
//
// The composer is one component in two moods: composing, and correcting something the company has already
// read. In the second mood it has to arrive carrying the post - title, body, the publishing choice - because
// a form that opens blank invites somebody to retype an announcement from memory, and it has to say it is
// saving rather than posting, because pressing "Publish" on a post that is already published reads like it
// will go out twice.
//
// `announcementDraft` covers the staging half of the composer and `announcementPoll` the poll half.
// `test/` owns the row. What only a browser shows is the edit arriving pre-filled, the submit changing its
// wording, and the board showing the correction without being reloaded.
test("a published post is corrected in place, and the board shows the correction", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now() % 1_000_000;
  const before = `E2E typo ${stamp}`;
  const after = `E2E corrected ${stamp}`;

  // Announced to nobody: this spec is about the composer, not about notifying the company.
  const created = await page.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title: before, body: "Frist draft of this notice.", audience_scope: "none" },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "announcements", "Feed");
    const card = page.locator('div[id^="post-"]').filter({ hasText: before }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The per-post tools appear while the pointer is on the card.
    await card.hover();
    await card.getByRole("button", { name: "Edit", exact: true }).click();

    const composer = page.getByRole("dialog");
    // Carrying the post: a correction dialog that opens empty is how the second version loses half the first.
    await expect(composer.getByPlaceholder("Say it in a line")).toHaveValue(before, { timeout: 30_000 });
    // And saying what it will do - not "Publish", which reads like sending it a second time.
    await expect(composer.getByRole("button", { name: "Save changes" })).toBeVisible();

    await composer.getByPlaceholder("Say it in a line").fill(after);
    await composer.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // The board has the correction without a reload - the write refreshed the collection, which is the whole
    // reason an edit is bearable from the feed at all.
    await expect(page.locator('div[id^="post-"]').filter({ hasText: after }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(before)).toHaveCount(0);

    // And from cold, because a correction that lives in the page's state is the typo everybody still reads.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator('div[id^="post-"]').filter({ hasText: after }).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await purge(page, path);
  }
});
