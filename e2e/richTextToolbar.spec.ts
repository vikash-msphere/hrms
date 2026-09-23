import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

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
  // Two expected console lines, neither of them this test's failure. The 503/500 is a dev Worker restart
  // mid-request, the same rare hiccup documented elsewhere in this suite (complianceRuleDelete.spec.ts et
  // al.), and the publish retry below is what recovers from it. The 404 is this spec's OWN housekeeping: the
  // post is purged at the end while the board is still on screen watching it, so a read already in flight
  // comes back for a row that is gone (the same note stocktakeAbandon.spec.ts carries).
  allowConsoleErrors(page, /status of 503|status of 500|status of 404/i);
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

  // A frame, not just the value check above: the Heading press's own `apply()` (RichTextToolbar.tsx) schedules
  // a requestAnimationFrame to refocus the box and restore ITS OWN edit's selection, separately from the
  // value landing in the DOM - on a busy lane that frame can fire late enough to still be pending here, and
  // if it lands AFTER the caret() below sets up the real target selection, it clobbers that back to wherever
  // the heading edit's own caret was, which is exactly the bug this waits out rather than reproduces.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

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

  // Re-pressed on a miss, checked by the BOARD first: a dev Worker restart mid-request answers this press
  // with a 503 (the same rare hiccup documented elsewhere in this suite) and leaves the composer open with
  // the reason pinned, which is indistinguishable from a press that never landed. Asking whether the post
  // exists before pressing again is what keeps a retry from publishing the same thing twice.
  // Pressed once, exactly as a person does - the press has to follow the toolbar work directly, with nothing
  // in between (an intervening round trip of this test's own was enough to stop the composer submitting at
  // all). Only a MISS is retried: a dev Worker restart mid-request answers the press with a 503 and leaves
  // the composer open with the reason pinned, which looks the same as a press that never landed. Asking the
  // board whether the post exists before pressing again is what keeps that retry from publishing it twice.
  await composer.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(async () => {
    if (!(await page.getByRole("dialog").count())) return;
    if (await posted(page, title)) return;
    const publish = composer.getByRole("button", { name: "Publish", exact: true });
    if (await publish.count()) await publish.click({ timeout: 8_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });
  }).toPass({ timeout: 45_000 });
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
  // The listener's own state update (RichTextToolbar's `remember`) is React state set from a native event
  // outside React's own synthetic system - it schedules a re-render rather than landing before this resolves,
  // and a toolbar press that follows too closely can still be acting on the PREVIOUS remembered selection.
  await box.page().waitForTimeout(50);
}

/**
 * The post with this title, or undefined.
 *
 * Paged rather than read in one call: the board is one of the busiest collections in the suite - most of the
 * announcement specs post to it - and a page holds a hundred. Reading only the first page found this spec's
 * own post only until a hundred others had been written, which is a lookup that fails for a reason the test
 * it is serving is not about.
 */
async function findPost(page: import("@playwright/test").Page, title: string): Promise<{ path: string } | undefined> {
  let token = "";
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const res = await page.request.get(`/v1/announcements?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
    if (!res.ok()) return undefined;
    const body = (await res.json()) as { results?: { path: string; title?: string }[]; next_page_token?: string };
    const hit = (body.results ?? []).find((a) => a.title === title);
    if (hit) return hit;
    if (!body.next_page_token) return undefined;
    token = body.next_page_token;
  }
  return undefined;
}

/** Whether the post is on the board - asked of the collection, so a lost response cannot be mistaken for a
 *  lost write (and a retry of the press cannot publish it twice). */
async function posted(page: import("@playwright/test").Page, title: string): Promise<boolean> {
  return !!(await findPost(page, title));
}

async function postPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  const post = await findPost(page, title);
  if (!post) throw new Error(`e2e: the post "${title}" is not on the board`);
  return post.path;
}
