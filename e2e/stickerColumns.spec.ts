import { gotoRoute, purge, test, expect } from "./fixtures";

// Words down both sides of a picture - the one placement `stickerWrap.spec.ts` deliberately leaves alone.
//
// A wrapped sticker (Square/Tight/Through) dragged to the CARD'S OWN MIDDLE has nowhere left to float beside:
// there is no side left for the words to keep to, so the only way to still get text down both sides is to
// split the body in two and stand the picture between the halves (`lib/splitSource.ts` cuts the string;
// `needsColumns`/`SplitRichText` in CardSticker.tsx decide when to and lay out the columns). Placement is a
// real pointer drag, not the native HTML5 drag-and-drop `kanban.spec.ts` correctly leaves alone - this is a
// plain `pointerdown`/`pointermove`/`pointerup` gesture, which Playwright drives like any other mouse action.
test("dragging a sticker to the card's middle splits the body into two columns", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const title = `E2E columns ${Date.now()}`;
  const body = "Announcing the first thing you should know about the second thing worth reading here";

  await gotoRoute(page, "announcements", "Feed");
  await page.getByRole("button", { name: "Choose what to post" }).click();
  await page.getByRole("menuitem", { name: "Post" }).click();
  const composer = page.getByRole("dialog");
  await composer.getByPlaceholder("Say it in a line").fill(title);
  await composer.getByPlaceholder("What's on your mind?").fill(body);

  const panel = composer.locator("aside");
  const tiles = panel.locator("button[aria-pressed]");
  await expect(tiles.first()).toBeVisible({ timeout: 60_000 });
  await tiles.first().click();
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");

  // Untouched, the whole sentence is one block - there is nothing to split until the picture is somewhere
  // that forces it.
  await expect(panel.getByText(body, { exact: true })).toBeVisible();

  // The move handle: aria-hidden (it's chrome, not content), so a title selector rather than a role query.
  const handle = panel.locator('[title^="Drag to move"]').first();
  const handleBox = await handle.boundingBox();
  const cardBox = await panel.boundingBox();
  if (!handleBox || !cardBox) throw new Error("e2e: could not measure the sticker handle or the card");

  // Left, middle or right is all a wrapped sticker's horizontal drag can land on (CardSticker.tsx `wrapSide`) -
  // anywhere in the card's own middle half snaps to the same "middle". No need to land it exactly.
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + cardBox.width / 2, handleBox.y + handleBox.height / 2, { steps: 12 });
  await page.mouse.up();

  // Split: the sentence is no longer one block anywhere on the card, but both ends of it are still there,
  // each in its own column either side of the picture.
  await expect(panel.getByText(body, { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Announcing the first thing", { exact: false })).toBeVisible();
  await expect(panel.getByText("worth reading here", { exact: false })).toBeVisible();

  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    // The split is a placement, stored like any other - it has to survive being posted and read back, not
    // only exist while the composer's own drag state is still live.
    const card = page.locator('div[id^="post-"]').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(body, { exact: true })).toHaveCount(0);
    await expect(card.getByText("Announcing the first thing", { exact: false })).toBeVisible();
    await expect(card.getByText("worth reading here", { exact: false })).toBeVisible();
  } finally {
    await purge(page, await postPath(page, title));
  }
});

async function postPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  const post = results.find((a) => a.title === title);
  if (!post) throw new Error(`e2e: the post "${title}" is not on the board`);
  return post.path;
}
