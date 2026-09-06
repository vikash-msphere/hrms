import { gotoRoute, purge, test, expect } from "./fixtures";

// The composer's formatting bar, editing markdown-lite SOURCE rather than any editor state of its own.
//
// `RichTextToolbar` is wiring over pure functions in lib/richTextEdit.ts - what `toggleMark`/`togglePrefix` do
// to a string and a selection is tested without a DOM. What only a browser shows is the two things either side
// of that: a real caret and selection driving the buttons (their pressed state has to read back off wherever
// the caret actually is), and the stored markdown rendering back as the thing it names once the post is on the
// board - a bold mark that never becomes a `<strong>`, or a heading that stays a line of `#`, is a feature that
// only ever worked in the textarea.
test("bold acts on the selection, a heading acts on the caret's line, and both render", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const title = `E2E rich text ${Date.now()}`;
  const heading = "Read before you go";
  const body = "Please read this urgent notice";
  const marked = "urgent";
  const markedAt = body.indexOf(marked);

  await gotoRoute(page, "announcements", "Feed");
  await page.getByRole("button", { name: "Choose what to post" }).click();
  await page.getByRole("menuitem", { name: "Announcement" }).click();
  const composer = page.getByRole("dialog");
  await composer.getByPlaceholder("Say it in a line").fill(title);

  const box = composer.getByPlaceholder("What's on your mind?");
  await box.fill(`${heading}\n${body}`);

  // Heading: nothing selected, so it acts on the line the caret sits in - the first one.
  await caret(box, 0);
  const headingBtn = composer.getByRole("button", { name: /^Heading/ });
  await expect(headingBtn).toHaveAttribute("aria-pressed", "false");
  await headingBtn.click();
  await expect(headingBtn).toHaveAttribute("aria-pressed", "true");
  await expect(box).toHaveValue(`## ${heading}\n${body}`);
  // The second line was never touched: a line control that leaked onto its neighbour would be the whole bug.
  await expect(box).toHaveValue(new RegExp(`\\n${body}$`));

  // The word itself, on the second line. `## ` is now in front of the heading, so the body starts that much
  // further along.
  const bodyAt = `## ${heading}\n`.length;
  await caret(box, bodyAt + markedAt, bodyAt + markedAt + marked.length);

  const boldBtn = composer.getByRole("button", { name: /^Bold/ });
  await expect(boldBtn).toHaveAttribute("aria-pressed", "false");
  await boldBtn.click();
  await expect(boldBtn).toHaveAttribute("aria-pressed", "true");
  await expect(box).toHaveValue(`## ${heading}\nPlease read this **${marked}** notice`);

  // Pressed again on the same (still-selected) word it comes back off - a mark that only ever turns on is
  // half a toggle.
  await boldBtn.click();
  await expect(boldBtn).toHaveAttribute("aria-pressed", "false");
  await expect(box).toHaveValue(`## ${heading}\n${body}`);
  await boldBtn.click(); // leave it on for the render check below

  // Typeface: a menu rather than a Select (it draws each face IN that face, so a plain option list won't do),
  // and it acts on the block the caret is in - still the body line, from the bold selection just above. A
  // block control rather than a mark, so it belongs to the paragraph, not the word.
  await composer.getByRole("button", { name: "Typeface" }).click();
  await page.getByRole("menuitem", { name: "Serif", exact: true }).click();

  await composer.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const card = page.locator("div.shadow-card").filter({ hasText: title }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // `##` renders as an h3, not an h2: lib/richText.tsx shifts every body heading one level down on purpose,
  // so a post's own headings nest under the post's title rather than competing with it.
  await expect(card.getByRole("heading", { name: heading, level: 3 })).toBeVisible();
  const paragraph = card.locator("p").filter({ hasText: marked });
  await expect(paragraph.locator("strong").filter({ hasText: marked })).toBeVisible();
  // The face rides on the block as a real CSS font-family, not just a stored token nobody applied.
  await expect(paragraph).toHaveCSS("font-family", /Georgia/);

  await purge(page, await postPath(page, title));
});

/**
 * Park the caret at `start`, or select `start`..`end`.
 *
 * Not arrow keys and not Home/End: caret keys are not portable across platforms, and this spec is about WHERE
 * the caret is. On macOS Chromium `Home` moves to the start of the whole textarea rather than the start of the
 * line, and `Control+Home` is not an editing command at all - so the same presses leave the caret on a
 * different line depending on who runs the suite, and the toolbar then correctly formats the wrong line.
 *
 * The offsets go straight onto the textarea, followed by the `select` event the bar listens for (see
 * RichTextToolbar's `remember`) - so the button state under test is still derived from a real selection on a
 * real focused control, which is the half a browser is needed for.
 */
async function caret(box: import("@playwright/test").Locator, start: number, end = start) {
  await box.evaluate((el, [from, to]) => {
    const ta = el as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(from, to);
    ta.dispatchEvent(new Event("select", { bubbles: true }));
  }, [start, end] as [number, number]);
}

async function postPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  const post = results.find((a) => a.title === title);
  if (!post) throw new Error(`e2e: the post "${title}" is not on the board`);
  return post.path;
}
