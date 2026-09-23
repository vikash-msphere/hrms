import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// One post, on a page of its own.
//
// The board is a feed: a page of cards, paged as it is scrolled. The pop-out (`/announcements/<id>/view`) is
// the same post with the board taken away - reached from the card's own icon, and the address a long thread
// gets read at. It is a genuinely different render path from the deep link the rest of the lane uses
// (`/announcements/<id>` scrolls the FEED to a card): the collection is not read at all, the post is fetched
// on its own, and the page's chrome - header, composer, filters, leaderboard - is not drawn.
//
// So the two things a browser has to show are that the pop-out really is alone (the other post on the board
// is not on it, which is the only way to tell the feed was not simply scrolled), and that it stands up from
// COLD - a pasted link has no board behind it to have loaded the row.
test("a post pops out onto its own page, and the way back is on it", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now();
  const subject = `E2E solo ${stamp}`;
  const other = `E2E neighbour ${stamp}`;

  // Two posts, so "only this one is on the page" is a claim about the pop-out rather than about an empty
  // board. Written over the wire - the composer is `announcementDraft`'s subject, not this one - and to
  // nobody: `audience_scope: none` puts them on the wall without notifying the company, so a spec about a
  // rendering decision does not raise a notification for every seeded employee.
  const subjectPath = await post(page, subject);
  const otherPath = await post(page, other);

  try {
    await gotoRoute(page, "announcements", "Feed");
    const card = page.locator("div.shadow-card").filter({ hasText: subject }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(other).first()).toBeVisible();

    // The per-post tools are drawn while the pointer is on the card, so this is a hover and then a press -
    // the same order a reader does it in.
    await card.hover();
    await card.getByRole("button", { name: "Open in its own page" }).click();

    const id = subjectPath.split("/")[1]!;
    await expect.poll(() => page.url()).toContain(`/announcements/${id}/view`);
    await expect(page.getByText(subject).first()).toBeVisible({ timeout: 30_000 });
    // The board is gone, not scrolled: its other post, its heading and its composer are all off the page.
    await expect(page.getByText(other)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Feed" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Choose what to post" })).toHaveCount(0);

    // From cold, which is what a pasted link is: the post is fetched on its own, with no feed load to have
    // brought it along.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(subject).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(other)).toHaveCount(0);

    // The one thing a page with no chrome owes its reader.
    await page.getByRole("button", { name: "Back to the feed" }).click();
    await expect.poll(() => page.url()).toMatch(/\/announcements$/);
    await expect(page.getByRole("heading", { level: 1, name: "Feed" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(other).first()).toBeVisible();
  } finally {
    await purge(page, subjectPath);
    await purge(page, otherPath);
  }
});

/** A post on the board, announced to nobody. Returns its wire path. */
async function post(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title, body: "Written for the pop-out spec.", audience_scope: "none" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}
