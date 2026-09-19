import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A category picks the picture, so a giver who has said "Teamwork" never has to say it twice.
//
// `kudos.spec.ts` covers the hand-off from the top bar and the wall the message lands on. What it leaves
// untouched is the ONE thing kudos does that no other post kind does: picking a category seeds the card with
// one of that category's own curated stickers at random, chosen the moment the category is picked rather
// than waited on - a giver who never opens the sticker picker at all still posts a card with art on it. If
// that wiring broke, every kudos would quietly go out blank and nothing about the message or the recipient
// would say so.
test("picking a kudos category seeds the card with one of its own stickers, unprompted", async ({ as }) => {
  test.setTimeout(120_000);
  const giver = await as("hr");
  const message = `E2E kudos art ${Date.now()}`;

  await gotoRoute(giver, "dashboard");
  // Kudos is a configurable "+" menu entry, not a top-bar button of its own (see kudos.spec.ts).
  await giver.getByRole("button", { name: "New", exact: true }).click();
  await giver.getByRole("menuitem", { name: "Give kudos" }).click();
  const form = giver.getByRole("dialog");
  await expect(form.getByRole("heading", { name: /kudos/i })).toBeVisible();

  await form.getByRole("button", { name: "Select a colleague…" }).click();
  await giver.getByPlaceholder("Search colleagues…").fill("Eve");
  await expect(giver.getByRole("option", { name: /Eve Employee/ })).toBeVisible();
  await giver.keyboard.press("Enter");

  // Nothing to tune yet - no category has been picked, so nothing has put art on the card.
  await expect(form.getByRole("slider", { name: "Sticker size" })).toHaveCount(0);

  await form.getByLabel("Category").click();
  // Whichever category the org has seeded first - this is about the WIRING (pick a category, get art), not
  // about any one category's own curated set.
  const firstCategory = giver.getByRole("option").filter({ hasNotText: "None" }).first();
  await firstCategory.click();

  // The dials exist NOW, unprompted: nobody opened the sticker picker or clicked a suggestion tile, and the
  // card already has a picture worth tuning.
  await expect(form.getByRole("slider", { name: "Sticker size" })).toBeVisible({ timeout: 15_000 });
  await expect(form.getByRole("slider", { name: "Sticker opacity" })).toBeVisible();

  await form.locator("textarea").first().fill(message);
  await form.getByRole("button", { name: "Send kudos" }).click();
  await expect(toast(giver, /Kudos sent/)).toBeVisible();

  const card = giver.locator("div.shadow-card").filter({ hasText: message }).first();
  await expect(card).toBeVisible();
  await expect(card.locator("img")).toBeVisible();

  await purge(giver, await kudosPath(giver, message));
});

/** The wire path of the kudo this spec gave. */
async function kudosPath(page: import("@playwright/test").Page, message: string): Promise<string> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; body?: string }[] };
  const post = results.find((a) => (a.body ?? "").includes(message));
  if (!post) throw new Error(`e2e: the kudos "${message}" is not on the board`);
  return post.path;
}
