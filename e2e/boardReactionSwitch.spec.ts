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

  /** The emoji the reader holds on this post, or null for none - asked of the record. */
  const mine = async (): Promise<string | null | undefined> => {
    const res = await reader.request.get(`/v1/${post.path}`);
    if (!res.ok()) return undefined; // unknown is neither side of the toggle
    const { reactions = [] } = (await res.json()) as { reactions?: { emoji: string; reacted?: boolean }[] };
    return reactions.find((r) => r.reacted)?.emoji ?? null;
  };
  /** Whether the reader still holds a reaction of their own on this post. */
  const reacted = async (): Promise<boolean> => (await mine()) !== null;

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
    // The chips above move before their requests land, so the record can still be a tap behind. The loop below
    // reads "not reacted" as "already cleared", which is only true once the switch itself is on the record.
    await expect.poll(mine, { timeout: 15_000 }).toBe("❤️");

    // Toggled off again: MY share of it clears, but the author's own ❤️ (seeded above) is still there -
    // one person clearing their reaction doesn't erase somebody else's.
    //
    // Pressed against the RECORD rather than once and hoped for: the chip is one control that both adds and
    // clears, and the feed re-renders on any board write, org-wide - a press that landed on a chip being
    // replaced mid-render toggles nothing, and re-pressing blindly would put the reaction straight back on.
    // `reacted` on the post says which side of the toggle the reader is actually on.
    await expect(async () => {
      if (!(await reacted())) return;
      await card.getByRole("button", { name: /❤️/ }).first().click({ timeout: 5_000 });
      await expect.poll(reacted, { timeout: 10_000 }).toBe(false);
    }).toPass({ timeout: 30_000 });
    // What the feed SHOWS, from the record it was told about: the same org-wide re-render that makes the
    // press above unreliable can also leave this reader's own cleared chip on screen a moment longer than the
    // post it came from. The server side of it is already settled by the loop above, so this waits on the
    // page catching up, rather than on one particular render being the right one.
    await expect(async () => {
      await expect(card.getByRole("button", { name: "Add reaction" })).toBeVisible({ timeout: 5_000 });
      await expect(card.getByRole("button", { name: /❤️/ })).toContainText("1", { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
  } finally {
    await purge(author, post.path);
  }
});
