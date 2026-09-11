import { gotoRoute, test, expect } from "./fixtures";

// The dashboard, arranged the way one person wants it.
//
// Sections are laid out in a flex column ordered by CSS `order` (Dashboard.tsx), so a reorder is purely
// visual and nothing remounts - which also means the only way to check a section really moved is to measure
// where it is drawn. A hidden section is not rendered at all, and both choices are persisted per user. None
// of it exists outside a browser: the server stores an opaque preference blob and has no idea what a
// "section" is.
//
// The spec puts the layout back before it leaves. A dashboard left with a section switched off would quietly
// change what other specs measure - `requestBudget` counts what a dashboard load reads, and a section that
// is not there reads nothing.
test("sections reorder and hide, survive a reload, and reset", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "dashboard");

  // Substring matches, deliberately: the board's title carries an unread count beside it ("Latest from the
  // board" + "3 unread") whenever the reader has announcements they have not opened, so an exact match finds
  // the section on a quiet board and nothing at all after another spec has posted. Both titles are unique on
  // the page either way.
  const holidays = page.getByText("Upcoming holidays");
  const board = page.getByText("Latest from the board");
  await expect(holidays).toBeVisible();
  await expect(board).toBeVisible();
  // Start from the shipped layout whatever the last run left behind: a failed attempt (or a retry of this
  // one) leaves a customised order in the preferences row, and the assertions below only mean something
  // against the default.
  await resetLayout(page);
  await expect
    .poll(async () => (await topOf(holidays)) < (await topOf(board)), { timeout: 15_000 })
    .toBe(true); // holidays ship above the board

  // Move the board above it, and the page redraws in the new order without reloading. Press until the board
  // really is drawn higher rather than exactly once: "up" swaps with the previous entry in the saved ORDER,
  // where a section with nothing to show still holds its slot while drawing no pixels, so one press only
  // clears the holidays while the two are neighbours in that order.
  await expect
    .poll(
      async () => {
        if ((await topOf(board)) < (await topOf(holidays))) return true;
        // The dashboard's own live-polling widgets can re-render the page while this popover is open, and
        // once in a while that detaches the very button being clicked mid-actionability-wait (the same class
        // of transient churn `accessModeGating.spec.ts` already hits on this same page). Caught rather than
        // retried in its own inner loop: the outer poll already retries this whole measure-and-click up to
        // 30s across several intervals, so a swallowed miss here just costs it one of those, tried again
        // fresh on the next - stacking a second retry loop on top only fragments that same budget.
        try {
          const up = page.getByRole("button", { name: "Move Board & announcements up" });
          if (!(await up.isVisible())) await page.getByRole("button", { name: "Customize dashboard layout" }).click();
          if (await up.isEnabled()) await up.click();
          await page.keyboard.press("Escape");
        } catch { /* a detached button here just means this interval's click missed - the next one retries it */ }
        return (await topOf(board)) < (await topOf(holidays));
      },
      { intervals: [300, 600, 1000, 2000], timeout: 30_000 },
    )
    .toBe(true);

  // Switch a section off: it is gone from the page, not merely collapsed.
  await page.getByRole("button", { name: "Customize dashboard layout" }).click();
  await page.getByRole("button", { name: "Hide Holidays & celebrations" }).click();
  await page.keyboard.press("Escape");
  await expect(holidays).toHaveCount(0);

  // Both choices survive a reload - this is the local snapshot doing its job before the server row lands.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText("Upcoming holidays")).toHaveCount(0);

  // Put it back, and wait for the write that carries the reset off this machine - otherwise the next spec
  // (or the next run) meets a dashboard missing a section.
  await resetLayout(page);
  await expect(page.getByText("Upcoming holidays")).toBeVisible();
});

/**
 * Back to the shipped layout, and off this machine before the next reader looks: the reset is a write to the
 * preferences row, and a dashboard left reordered or missing a section quietly changes what other specs
 * measure. "Reset layout" is only offered while the layout is customised, so an already-default dashboard is
 * left alone.
 */
async function resetLayout(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Customize dashboard layout" }).click();
  const reset = page.getByRole("button", { name: "Reset layout" });
  const customised = (await reset.count()) > 0;
  const written = customised
    ? page.waitForResponse(
        (r) => r.url().includes("/v1/preferences/dashboard") && r.request().method() !== "GET",
        { timeout: 30_000 },
      )
    : Promise.resolve(null);
  if (customised) await reset.click();
  await page.keyboard.press("Escape");
  await written;
}

/** Where an element is drawn down the page - the only way to see a CSS `order` change. */
async function topOf(locator: import("@playwright/test").Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("the section is not on the page");
  return box.y;
}
