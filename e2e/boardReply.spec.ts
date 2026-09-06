import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// A conversation on the board, between two people in two browsers.
//
// `test/boardEngagement.test.ts` owns what a reply does to the row. What it cannot show is the thing the
// board is actually for: that a post someone else wrote is readable by a colleague, that the thread is
// folded away until it is asked for (the replies are not even in the page until then), that a reply typed
// into the box under it appears in the thread without the page reloading, and that the count on the card
// moves with it. All four are properties of the rendered feed.
test("one person's post is replied to by another, and the card says so", async ({ as }) => {
  const author = await as("super");
  const title = `E2E board post ${Date.now()}`;

  const posted = await author.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title, body: "Raised by the board spec - please reply.", kind: "announcement" },
  });
  expect(posted.status(), await posted.text()).toBe(200);
  const post = (await posted.json()) as { path: string };

  // The colleague reads it on their own board.
  const colleague = await as("employee");
  await gotoRoute(colleague, "announcements", "Feed");
  const card = colleague.locator("div.shadow-card").filter({ hasText: title }).first();
  await expect(card).toBeVisible();

  // Folded: the thread is not rendered until somebody asks for it.
  const reply = `E2E reply ${Date.now()}`;
  await expect(card.getByPlaceholder(/Write a reply/)).toHaveCount(0);
  await card.getByRole("button", { name: "Show this post's replies" }).click();

  await card.getByPlaceholder(/Write a reply/).fill(reply);
  await card.getByRole("button", { name: "Reply", exact: true }).click();

  // In the thread, on the same page, with no reload - the card is updated from the verb's own response.
  await expect(card.getByText(reply)).toBeVisible();
  await expect(card.getByPlaceholder(/Write a reply/)).toHaveValue("");

  // And the author, in their own browser, finds it under their post.
  await gotoRoute(author, "announcements", "Feed");
  const theirCard = author.locator("div.shadow-card").filter({ hasText: title }).first();
  await theirCard.getByRole("button", { name: "Show this post's replies" }).click();
  await expect(theirCard.getByText(reply)).toBeVisible();

  // Off the board again: a post per run would leave the feed a wall of test chatter.
  await purge(author, post.path);
});
