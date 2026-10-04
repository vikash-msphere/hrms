import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// The picture on a board post.
//
// Every kind the board makes - an announcement, a post, a poll, a kudos - carries the same optional sticker,
// and the control for it is the one part of the composer that cannot be tested anywhere but in a browser: the
// row of suggestions is matched against what the author has typed (client-side, against a 1700-item
// illustration index that is loaded lazily), the picture is placed ON the card in a live preview, and how it
// reads is two dials - size and opacity - whose effect exists only as rendered output.
//
// So this drives the whole control: the suggestions appear, one is picked and reported back, the dials move,
// the catalogue behind "Browse" opens and takes over the choice, removing it puts the card back, and what was
// finally picked is on the card the board shows.
test("a sticker is suggested, picked, tuned, browsed for, removed, and posted", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("hr");
  const title = `E2E sticker ${Date.now()}`;
  // The shared board: a whole family of specs post, edit and delete on the SAME feed this page renders, org-
  // wide and unscoped to this test's own row - a 404 landing on a background refetch for a post another one
  // of them just took out from under this page's own poll is that collision, not this spec's own doing.
  allowConsoleErrors(page, /status of 404/i);

  await gotoRoute(page, "announcements", "Feed");
  await page.getByRole("button", { name: "Choose what to post" }).click();
  await page.getByRole("menuitem", { name: "Post" }).click();
  const composer = page.getByRole("dialog");
  // By placeholder: the title field shares its Field with three alignment buttons, so the label names the
  // group rather than the input.
  await composer.getByPlaceholder("Say it in a line").fill(title);
  // The words are what the suggestions are matched against, so they are part of the test rather than filler.
  await composer.getByPlaceholder("What's on your mind?").fill("A celebration for the team - well done everybody.");

  // On a wide screen the card and the controls that act ON it are a column of their own, because a picture
  // can only be judged against the card it sits on.
  const panel = composer.locator("aside");
  await expect(panel.getByText("On the board")).toBeVisible();

  // The suggestions: a short row of art worth offering for what has just been typed, plus the way out to the
  // whole catalogue. Waited for - the index is a lazy chunk, and the row holds placeholders until it lands.
  const tiles = panel.locator("button[aria-pressed]");
  await expect(tiles.first()).toBeVisible({ timeout: 60_000 });
  const suggested = await tiles.first().getAttribute("aria-label");
  expect(suggested, "a suggestion tile with no name is a tile nobody can pick").toBeTruthy();

  // Picking one is a toggle, and the panel reports the choice rather than leaving the card to speak for it.
  await tiles.first().click();
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByText("Drag the picture on the card to move it, or its corner to resize.")).toBeVisible();

  // The dials only exist once there is something to tune - before that the panel says what a sticker is for
  // instead of offering controls that do nothing.
  const size = panel.getByRole("slider", { name: "Sticker size" });
  const opacity = panel.getByRole("slider", { name: "Sticker opacity" });
  await expect(size).toBeVisible();
  await expect(opacity).toBeVisible();
  const shownSize = panel.locator("label", { hasText: "Size" }).locator("span").last();
  const wasSize = await shownSize.innerText();
  await size.fill("0.5");
  await expect(shownSize).not.toHaveText(wasSize);
  await expect(shownSize).toHaveText("50%");

  // "Browse" is the whole catalogue, and what is picked there takes the place of the suggestion so the two
  // can be compared rather than one silently winning.
  await panel.getByRole("button", { name: "Browse" }).click();
  const picker = page.getByRole("dialog").filter({ hasText: "Choose a sticker" });
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await picker.getByRole("searchbox", { name: "Search all illustrations…" }).fill("team");
  const grid = picker.getByRole("group", { name: "Illustrations" });
  // The second tile: the first is "No sticker", which is a choice like any other and leads the grid.
  const browsed = grid.locator("button[data-tile]").nth(1);
  await expect(browsed).toBeVisible({ timeout: 30_000 });
  await browsed.click();
  await expect(page.getByRole("dialog").filter({ hasText: "Choose a sticker" })).toHaveCount(0, { timeout: 30_000 });

  // Removing lives in the section's header, because putting the card back the way it was should not require
  // opening the thing that changed it - and it really does put it back.
  await panel.getByRole("button", { name: "Remove" }).click();
  await expect(panel.getByRole("slider", { name: "Sticker size" })).toHaveCount(0);
  await expect(panel.getByText("Optional. Sits behind your words - pick one and place it where you like.")).toBeVisible();

  // Picked again, and posted: whatever the author settled on has to be the picture the board draws.
  await tiles.first().click();
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");
  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const post = await postByTitle(page, title);
  expect(post.illustration, "the post was filed without the sticker that was picked").toBeTruthy();
  const card = page.locator("div.shadow-card").filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The art itself, on the card: the value stored is a path into the catalogue, and the card's image is
  // built from it in the browser.
  const slug = post.illustration!.split("/").pop()!;
  await expect(card.locator(`img[src*="${slug}"]`).first()).toBeVisible({ timeout: 30_000 });

  await purge(page, post.path);
});

/** The post this spec made, with what it was filed with. */
async function postByTitle(
  page: import("@playwright/test").Page,
  title: string,
): Promise<{ path: string; illustration?: string }> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string; illustration?: string }[] };
  const post = results.find((a) => a.title === title);
  if (!post) throw new Error(`e2e: the post "${title}" is not on the board`);
  return post;
}
