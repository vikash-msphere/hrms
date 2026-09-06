import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// One reaction per viewer - `boardSocial.spec.ts` only ever adds a single chip through the picker, which
// disappears the moment you have one (so it can never itself be used to switch). What actually reaches a
// second emoji is clicking a DIFFERENT chip that's already on the post: your own chip has to clear (down to
// zero, it vanishes) while the other one picks your count up, and the "Add reaction" button has to come
// back once you have none of your own again.
test("reacting with a second emoji clears the first, and toggling it off brings the picker back", async ({ as }) => {
  test.setTimeout(90_000);
  const author = await as("hr");
  const reader = await as("super");
  const title = `E2E reaction switch ${Date.now()}`;

  const made = await author.request.post("/v1/announcements", {
    headers: SPA_HEADERS,
    data: { title, body: "Raised by the board-reaction-switch spec.", kind: "announcement" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const post = (await made.json()) as { path: string };

  // A second emoji group already on the post, from someone else - so there is another chip to switch to
  // without the picker (which vanishes once the reader has reacted).
  const seeded = await author.request.post(`/v1/${post.path}:react`, { headers: SPA_HEADERS, data: { emoji: "❤️" } });
  expect(seeded.status(), await seeded.text()).toBe(200);

  try {
    await gotoRoute(reader, "announcements", "Feed");
    const card = reader.locator("div.shadow-card").filter({ hasText: title }).first();
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /❤️/ })).toContainText("1");

    // React with a different emoji through the picker.
    await card.getByRole("button", { name: "Add reaction" }).click();
    const picker = reader.getByRole("dialog").or(reader.locator("[data-radix-popper-content-wrapper]"));
    // Quick picks: named, because the same glyph also appears in the full grid below it - the picker without
    // a name has two identical "👍" buttons and nothing to say which one this is.
    await picker.getByRole("group", { name: "Quick picks" }).getByText("👍").click();
    await expect(card.getByRole("button", { name: /👍/ })).toContainText("1");
    // Reacted once: the add button steps aside until it's cleared again.
    await expect(card.getByRole("button", { name: "Add reaction" })).toHaveCount(0);

    // Switching to the OTHER chip already on the post: the 👍 clears to zero and disappears, ❤️ picks up
    // the count - not two reactions from the same person.
    await card.getByRole("button", { name: /❤️/ }).click();
    await expect(card.getByRole("button", { name: /👍/ })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /❤️/ })).toContainText("2");

    // Toggled off again: MY share of it clears, but the author's own ❤️ (seeded above) is still there -
    // one person clearing their reaction doesn't erase somebody else's.
    await card.getByRole("button", { name: /❤️/ }).click();
    await expect(card.getByRole("button", { name: "Add reaction" })).toBeVisible();
    await expect(card.getByRole("button", { name: /❤️/ })).toContainText("1");
  } finally {
    await purge(author, post.path);
  }
});
