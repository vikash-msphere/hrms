import { gotoRoute, purge, test, expect } from "./fixtures";

// How the words treat the picture standing on a card - the one dial `postSticker.spec.ts` deliberately leaves
// alone, because a sticker is worth a whole spec on its own and this is a second control worth its own: the
// wrap mode a post's picture sits in (Square, Tight, Through, Behind text, ...). `WrapSelect` is one component
// shared by a post's sticker, a kudos card's art and its recipient tile, so proving it here is proving it for
// all three.
//
// What only a browser shows: the choice is read back off the menu it was set on (not assumed from a click
// that landed), and it survives round-tripping through the server - editing the post it was set on has to
// open with the SAME wrap chosen, not the default it would fall back to with nothing stored.
test("a sticker's wrap mode is chosen, posted, and reopens set to what was chosen", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const title = `E2E wrap ${Date.now()}`;

  await gotoRoute(page, "announcements", "Feed");
  await page.getByRole("button", { name: "Choose what to post" }).click();
  await page.getByRole("menuitem", { name: "Post" }).click();
  const composer = page.getByRole("dialog");
  await composer.getByPlaceholder("Say it in a line").fill(title);
  await composer.getByPlaceholder("What's on your mind?").fill("A celebration for the team - well done everybody.");

  const panel = composer.locator("aside");
  await expect(panel.getByText("On the board")).toBeVisible();
  const tiles = panel.locator("button[aria-pressed]");
  await expect(tiles.first()).toBeVisible({ timeout: 60_000 });
  await tiles.first().click();
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");

  // The default every sticker starts in - proven rather than assumed, so a change away from it is a real move.
  const wrap = panel.getByRole("combobox");
  await expect(wrap).toHaveText("Square");
  await wrap.click();
  await page.getByRole("option", { name: "Through" }).click();
  await expect(wrap).toHaveText("Through");

  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    const card = page.locator('div[id^="post-"]').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Reopened: the choice has to come back off the SAVED post, not off whatever the control defaults to.
    await card.hover();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByPlaceholder("Say it in a line")).toHaveValue(title, { timeout: 30_000 });
    const editPanel = edit.locator("aside");
    await expect(editPanel.getByRole("combobox")).toHaveText("Through", { timeout: 30_000 });
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
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
