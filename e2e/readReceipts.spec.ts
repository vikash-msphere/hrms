import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// "Has anybody read this?"
//
// The board records a read receipt when a post has actually been LOOKED at - a card that stays on screen for
// a moment, or one that is unfolded - and the author's card then carries the count with the names behind it.
// Both halves are browser-only by construction: the receipt is raised by dwell/unfold in the reader's
// browser (there is no "mark as read" button to press), and the answer is drawn on the author's card in
// another browser entirely. `test/announcementReadBy.test.ts` owns the rows.
test("a post read by a colleague reads back on the author's card", async ({ as }) => {
  test.setTimeout(180_000);
  const author = await as("hr");
  const reader = await as("employee");
  const title = `E2E receipt ${Date.now()}`;

  const posted = await author.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title, body: "Raised by the read-receipts spec - please read me.", kind: "announcement" },
  });
  expect(posted.status(), await posted.text()).toBe(200);
  const post = (await posted.json()) as { path: string };

  // Nobody has read it yet, and the card says so rather than leaving the author guessing.
  await gotoRoute(author, "announcements", "Feed");
  const card = author.locator("div.shadow-card").filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByLabel(/^Read by /)).toHaveCount(0);

  // The colleague reads it: unfolding a post is the deliberate half of the receipt (the other is dwell, which
  // is a timer and not something to hang an assertion on).
  await gotoRoute(reader, "announcements", "Feed");
  const theirs = reader.locator("div.shadow-card").filter({ hasText: title }).first();
  await expect(theirs).toBeVisible({ timeout: 30_000 });
  await theirs.click();
  // Polled from the AUTHOR's session on purpose: `read_count` is exposed only to the post's author (or
  // somebody who may edit it), so a reader asking "how many have read this?" is answered with nothing.
  await expect.poll(() => readCount(author, post.path), { timeout: 30_000 }).toBeGreaterThan(0);

  // And the author's card carries it, from cold, with the reader named behind the count - which is the
  // question an author opens their own post to ask.
  await author.reload();
  await expect(author.getByRole("main")).toBeVisible();
  const again = author.locator("div.shadow-card").filter({ hasText: title }).first();
  const receipt = again.getByLabel(/^Read by [1-9]/);
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await receipt.hover();
  await expect(author.getByText("Eve Employee").first()).toBeVisible({ timeout: 30_000 });

  await purge(author, post.path);
});

/** How many receipts the post carries, as the server counts them for its author. */
async function readCount(page: import("@playwright/test").Page, path: string): Promise<number> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return 0;
  return ((await res.json()) as { read_count?: number }).read_count ?? 0;
}
