import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The post that has to stay at the top.
//
// Pinning is the board's one deliberate exception to "newest first": the server folds a pin time into the
// order key, and the browser draws the pinned stretch under its own divider with a badge on the card. That is
// three things that have to agree, and the only place they meet is a rendered board - `test/` can prove the
// order key and nothing about the feed a reader sees.
//
// What only a browser shows: the pin affordance is on the card, the pinned post really leads the board (which
// is a claim about ORDER, not about the row), it still leads after a reload rather than only in the page's
// own copy of the list, and unpinning gives the card back its ordinary state.
test("a pinned post leads the board, and unpinning gives it back", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const title = `E2E pinned ${Date.now()}`;

  // Written over the wire (the composer is `announcementDraft`'s subject) and announced to nobody, so a spec
  // about ordering does not notify every seeded employee.
  const res = await page.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title, body: "Kept at the top of the board.", audience_scope: "none" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const path = ((await res.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "announcements", "Feed");
    const card = posts(page).filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(pinBadge(card)).toHaveCount(0);

    // The per-post tools are drawn while the pointer is on the card, so this is a hover and then a press.
    await card.hover();
    await card.getByRole("button", { name: "Pin", exact: true }).click();
    // Pinning asks first: it puts a post above everything else for the whole company. Which dialog appears
    // depends on whether the seeded board already has a pinned post - "Pin this post?" when nothing is up
    // there, "Replace the pinned post?" when something is - so the press is on whichever confirm button the
    // dialog carries rather than on a fixed label.
    const pinDialog = page.getByRole("dialog");
    await pinDialog.getByRole("button", { name: /^(Pin it|Unpin that, pin this)$/ }).click();

    // The card says what it now is...
    await expect(pinBadge(card)).toBeVisible({ timeout: 30_000 });
    // ...and the board is in a different order because of it. A newly pinned post sorts above everything,
    // including anything pinned before it, so the first post on the feed is this one.
    await expect(posts(page).first()).toContainText(title);

    // From cold: the order is the server's, not this page's copy of the list. Without the reload a pin that
    // was only ever applied to the rows in memory would pass everything above.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(posts(page).first()).toContainText(title, { timeout: 30_000 });

    // And the way back, which is the same button wearing the other label.
    const pinnedCard = posts(page).filter({ hasText: title }).first();
    await pinnedCard.hover();
    await pinnedCard.getByRole("button", { name: "Unpin", exact: true }).click();
    await expect(pinBadge(pinnedCard)).toHaveCount(0, { timeout: 30_000 });
    await expect(pinnedCard.getByRole("button", { name: "Pin", exact: true })).toBeVisible();
  } finally {
    await purge(page, path);
  }
});

type Page = import("@playwright/test").Page;
type Locator = import("@playwright/test").Locator;

/** Every post on the board, in the order the feed draws them.
 *
 *  Not `div.shadow-card`: the composer and the recognition leaderboard are cards too, and they sit ABOVE the
 *  feed - so the "first card on the page" is furniture, not a post. Each post's wrapper carries its own id
 *  (`post-<wire id>`, the anchor a deep link scrolls to), which is the one handle that means "a post". */
const posts = (page: Page) => page.locator('div[id^="post-"]');

/** A post card's "Pinned" badge.
 *
 *  Exact, because this spec's own titles carry the word: `getByText("Pinned")` is a case-insensitive
 *  SUBSTRING match, so it also finds the heading of a post called "E2E pinned 1788554270943" and the badge
 *  assertion passes or fails on the title instead of on the state. */
const pinBadge = (card: Locator) => card.getByText("Pinned", { exact: true });
