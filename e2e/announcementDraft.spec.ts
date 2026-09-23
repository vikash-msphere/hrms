import { gotoRoute, purge, test, expect } from "./fixtures";

// A post written now and sent later.
//
// A draft is the one thing on the board that exists without existing: it is a row, it is on its author's own
// list, and it has been announced to nobody - the `publish` verb is what notifies the company, so until it is
// pressed the post must be invisible to everyone else. That is two browsers' worth of fact and it is the
// whole point of the feature; `test/announcementDraft.test.ts` owns the row.
//
// What only a browser shows: the publishing choice is part of the composer (a chip row that renames the
// submit button), saving a draft moves the feed onto its own Drafts list rather than leaving the author
// looking at a feed their post is not in, and publishing moves it back and makes it real.
test("a draft is invisible to everyone else until it is published", async ({ as }) => {
  test.setTimeout(180_000);
  const author = await as("hr");
  const reader = await as("employee");
  const title = `E2E draft ${Date.now()}`;

  await gotoRoute(author, "announcements", "Feed");
  await author.getByRole("button", { name: "Choose what to post" }).click();
  await author.getByRole("menuitem", { name: "Announcement" }).click();
  const composer = author.getByRole("dialog");
  await composer.getByPlaceholder("Say it in a line").fill(title);
  await composer.getByPlaceholder("What's on your mind?").fill("Written now, sent when it is ready.");

  // The publishing choice, and what it does to the button: an announcement's default is to go out, so
  // staging it is a deliberate press that renames the submit from "Publish" to "Save draft".
  await expect(composer.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await composer.getByRole("button", { name: "Save as draft" }).click();
  await composer.getByRole("button", { name: "Save draft" }).click();
  // The dialog closing is the proof the write landed (a failed one keeps it open with the reason pinned) -
  // asserted instead of the toast, which is gone in a few seconds and is the first thing a busy render drops.
  await expect(author.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The feed moved onto the list the post is actually in - a draft that vanished from the feed the moment it
  // was saved would read as a post that was lost.
  await expect(author.getByRole("button", { name: /^Drafts/ })).toBeVisible({ timeout: 30_000 });
  const draftCard = author.locator("div.shadow-card").filter({ hasText: title }).first();
  await expect(draftCard).toBeVisible();
  await expect(draftCard.getByRole("button", { name: "Publish" })).toBeVisible();

  // Nobody else has it, on any list: the draft has been announced to no one.
  await gotoRoute(reader, "announcements", "Feed");
  await expect(reader.locator("div.shadow-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(reader.getByText(title)).toHaveCount(0);

  // Publishing is its own press, on the card whose whole point it is.
  await draftCard.getByRole("button", { name: "Publish" }).click();
  // It moved lists: back on the feed, and off Drafts (which empties out and stops being offered).
  await expect(author.locator("div.shadow-card").filter({ hasText: title }).first()).toBeVisible({ timeout: 30_000 });

  // And now the company has it.
  await reader.reload();
  await expect(reader.getByRole("main")).toBeVisible();
  await expect(reader.getByText(title).first()).toBeVisible({ timeout: 30_000 });

  await purge(author, await postPath(author, title));
});

/** The wire path of the post this spec wrote. */
async function postPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  const post = results.find((a) => a.title === title);
  if (!post) throw new Error(`e2e: the post "${title}" is not on the board`);
  return post.path;
}
