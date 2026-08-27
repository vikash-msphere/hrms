import { fileLeave, gotoRoute, test, expect } from "./fixtures";

// A number you can click.
//
// Every metric strip in the app is a filter: clicking a tile narrows the list below to exactly the rows that
// produced the number, clicking it again clears it, and the choice lives in the hash query (`?focus=`) so a
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
    const whole = await approve.count();

    // The queue-wide tile is a figure, not a filter target: it must read the same before and after, because
    // the metrics describe the queue and the tabs below describe the slice.
    const queueTile = page.getByRole("button", { name: /Awaiting your decision/ });
    const queueValue = (await queueTile.innerText()).trim();

    const today = page.getByRole("button", { name: /Arrived today/ });
    await today.click();
    await expect(today).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.url()).toContain("focus=today");

    // The seeded queue was raised long before today, so narrowing to today really has to remove rows.
    await expect.poll(() => approve.count()).toBeLessThan(whole);
    expect((await queueTile.innerText()).trim(), "the metrics moved when the list narrowed").toBe(queueValue);

    // The narrowed page is the shareable one: a reload comes back to it from the URL alone.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("button", { name: /Arrived today/ })).toHaveAttribute("aria-pressed", "true");
    const narrowed = await approve.count();
    expect(narrowed).toBeLessThan(whole);

    // And the same tile is the way out - a filter you cannot see how to remove is a trap.
    await page.getByRole("button", { name: /Arrived today/ }).click();
    await expect.poll(() => page.url()).not.toContain("focus=today");
    await expect.poll(() => approve.count()).toBe(whole);
  });
});
