import { gotoRoute, purge, test, expect } from "./fixtures";

// The SAME `EmojiPicker` component, wired two different ways: `boardSocial.spec.ts` drives it as a
// reaction - one press that calls a verb, no text involved. Here, in the composer, picking an emoji has to
// splice a character into markdown-lite SOURCE at wherever the caret actually is (`insertEmoji` in
// PostComposer.tsx), then leave the caret sitting right after what it just inserted - not appended to the
// end of the box, which is the shortcut a naive `body + emoji` would take and the one thing this proves it
// doesn't.
test("an emoji is inserted at the caret, not appended to the end of the message", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const title = `E2E emoji ${Date.now()}`;

  await gotoRoute(page, "announcements", "Feed");
  await page.getByRole("button", { name: "Choose what to post" }).click();
  await page.getByRole("menuitem", { name: "Post" }).click();
  const composer = page.getByRole("dialog");
  await composer.getByPlaceholder("Say it in a line").fill(title);

  const box = composer.getByPlaceholder("What's on your mind?");
  await box.fill("Hello world");
  // Mid-string, between "Hello" and " world" - the one place appending to the end would visibly disagree
  // with splicing at the caret.
  await box.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(5, 5);
  });

  await composer.getByRole("button", { name: "Insert emoji" }).click();
  // From the quick row: the same glyph is in the full grid below it too, so the row is what names this one.
  await page.getByRole("group", { name: "Quick picks" }).getByRole("button", { name: "🎉", exact: true }).click();
  await expect(box).toHaveValue("Hello🎉 world");

  // The caret itself moved to right after the emoji, not back to wherever it was or on to the end - typing
  // immediately lands between the emoji and the space it split, not at either end of the message.
  await box.pressSequentially("X");
  await expect(box).toHaveValue("Hello🎉X world");

  await composer.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const card = page.locator('div[id^="post-"]').filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Hello🎉X world")).toBeVisible();

  await purge(page, await postPath(page, title));
});

async function postPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  const post = results.find((a) => a.title === title);
  if (!post) throw new Error(`e2e: the post "${title}" is not on the board`);
  return post.path;
}
