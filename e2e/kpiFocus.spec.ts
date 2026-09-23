import { fileLeave, gotoRoute, test, expect } from "./fixtures";

// A number you can click.
//
// Every metric strip in the app is a filter: clicking a tile narrows the list below to exactly the rows that
// produced the number, clicking it again clears it, and the choice lives in the URL query (`?focus=`) so a
// narrowed page is shareable and closes with the back button (`lib/kpiFocus.ts`).
//
// All of that is browser state. The rows are already in the client, no request is made, and nothing about the
// narrowing exists in the API - so the vitest suite cannot see whether a tile filters, whether the URL follows,
// or whether the metrics stay counting the WHOLE queue while the list narrows underneath them (the property
// that keeps the numbers from moving under the reader as they drill in).
test.describe("clickable metrics", () => {
  test("a metric narrows the queue, writes the URL, and clears again", async ({ as }) => {
    const page = await as("super");
    // Its own arrival: "Arrived today" only exists as a tile if something arrived today, and the seeded queue
    // is months old by design.
    await fileLeave(await as("employee"), `E2E focus ${Date.now()}`);
    await gotoRoute(page, "approvals", "Approvals");

    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve.first()).toBeVisible();

    // The queue-wide tile is a figure, not a filter target: it must read the same before and after, because
    // the metrics describe the queue and the tabs below describe the slice.
    const queueTile = page.getByRole("button", { name: /Awaiting your decision/ });
    const today = page.getByRole("button", { name: /Arrived today/ });

    // Baseline and narrowing retried AS A PAIR: that tile counts the whole inbox, which is shared - the rest
    // of this suite files and decides requests against it for the length of the run. A figure that moved
    // between the two reads is somebody else's write landing, not the narrowing under test, so the baseline
    // is taken again and the narrowing repeated rather than reported as the metric having followed the filter.
    let whole = 0;
    await expect(async () => {
      if ((await today.getAttribute("aria-pressed")) === "true") {
        await today.click();
        await expect(today).toHaveAttribute("aria-pressed", "false", { timeout: 8_000 });
      }
      const queueValue = (await queueTile.innerText()).trim();
      whole = await approve.count();

      await today.click();
      await expect(today).toHaveAttribute("aria-pressed", "true", { timeout: 8_000 });
      await expect.poll(() => page.url(), { timeout: 8_000 }).toContain("focus=today");
      // The seeded queue was raised long before today, so narrowing to today really has to remove rows.
      await expect.poll(() => approve.count(), { timeout: 10_000 }).toBeLessThan(whole);
      expect((await queueTile.innerText()).trim(), "the metrics moved when the list narrowed").toBe(queueValue);
    }).toPass({ timeout: 60_000 });

    // The narrowed page is the shareable one: a reload comes back to it from the URL alone.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("button", { name: /Arrived today/ })).toHaveAttribute("aria-pressed", "true");
    const narrowed = await approve.count();
    expect(narrowed).toBeLessThan(whole);

    // And the same tile is the way out - a filter you cannot see how to remove is a trap. What the widened
    // queue must show is the rows the filter was hiding, NOT the exact baseline figure: the inbox is shared with
    // every other spec in the run, so a request filed or decided since `whole` was read moves that number for
    // reasons that have nothing to do with the filter (the baseline pair above is retried for the same reason).
    await page.getByRole("button", { name: /Arrived today/ }).click();
    await expect.poll(() => page.url()).not.toContain("focus=today");
    await expect(page.getByRole("button", { name: /Arrived today/ })).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => approve.count()).toBeGreaterThan(narrowed);
  });
});
