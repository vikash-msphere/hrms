import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Catching up on the whole board in one press.
//
// Unread on the feed is not a local flag: it is a read receipt per post per person, which is what lets an
// author see who has read their announcement (`readReceipts`). So "mark all read" is a collection verb that
// stamps a receipt for everything on the board, and the browser has to do three things with the answer -
// drop the count chip, fade the dots without a refetch, and still be right after a reload, when the state
// comes back from the server rather than from the page.
//
// `test/announcementReadBy.test.ts` owns the receipts. What only a browser shows is the reader's side: the
// affordance appearing only while something IS unread, and the dot on a particular post going out.
test("a reader clears the board's unread state in one press", async ({ as }) => {
  test.setTimeout(180_000);
  const author = await as("super");
  const reader = await as("employee");
  const stamp = Date.now() % 1_000_000;
  const titles = [`E2E unread A ${stamp}`, `E2E unread B ${stamp}`];

  // Announced to nobody: this spec is about the board's own unread state, not about notifying the company.
  const paths: string[] = [];
  for (const title of titles) {
    const res = await author.request.post("/v1/announcements", {
      headers: SPA_HEADERS,
      data: { title, body: "Posted for the mark-all-read spec.", audience_scope: "none" },
    });
    expect(res.status(), await res.text()).toBe(200);
    paths.push(((await res.json()) as { path: string }).path);
  }

  try {
    await gotoRoute(reader, "announcements", "Feed");
    const card = reader.locator('div[id^="post-"]').filter({ hasText: titles[0]! }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The chip that counts what is unread, and the dot on this particular post. The count itself is not
    // asserted as a number: other specs post to the same board while this runs, and what this test is about
    // is ITS post going quiet.
    await expect(reader.getByRole("button", { name: /^Unread \d+$/ })).toBeVisible({ timeout: 30_000 });
    // The dot is drawn while the post is unread and only hidden (not removed) once it is marked, so that the
    // fade can be seen rather than the mark jumping off the card.
    const dot = card.locator('[aria-label="New"]');
    await expect(dot).toHaveCount(1, { timeout: 30_000 });

    // One press, offered only because something was unread.
    await reader.getByRole("button", { name: "Mark all read" }).click();

    // Faded in place - no reload, which is the point of stamping the receipts and updating the page at once.
    await expect(dot).toHaveAttribute("aria-hidden", "true", { timeout: 30_000 });

    // And true from cold: the receipts are the server's, so the post comes back with no "new" mark at all.
    // Retried: the press above leaves the page writing its receipts, and a reload issued into that lands on
    // a frame going away - `net::ERR_ABORTED; maybe frame was detached?` - which is the reload failing to
    // start, not the page failing to come back. Asking again gets a clean one.
    await expect(async () => {
      await reader.reload();
      await expect(reader.getByRole("main")).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 60_000 });
    const afterReload = reader.locator('div[id^="post-"]').filter({ hasText: titles[0]! }).first();
    await expect(afterReload).toBeVisible({ timeout: 30_000 });
    await expect(afterReload.locator('[aria-label="New"]')).toHaveCount(0);
  } finally {
    for (const path of paths) await purge(author, path);
  }
});
