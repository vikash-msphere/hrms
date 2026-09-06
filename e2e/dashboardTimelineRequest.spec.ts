import { gotoRoute, test, expect } from "./fixtures";

// The dashboard team timeline's own way of asking for leave - drag a range on your own row and the request
// dialog opens pre-filled with it. Nothing in the suite opens this widget at all, and the interaction has no
// button to click through DevTools-style: a cell is a real `onMouseDown`/`onMouseMove`/window-`mouseup`
// sequence, arms only on the caller's own row (hoisted to the top), and refuses weekends, holidays and days
// already on leave rather than letting a drag land on one.
//
// Never submitted: this only proves the press opens the right dialog, pre-filled with a real day from the
// grid - not a live leave request against a shared seeded person.
test("clicking a day on your own row opens Request leave, pre-filled with that day", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  await gotoRoute(page, "dashboard");

  // The section is lazy (its data loads only once scrolled into view), so it is brought on screen
  // explicitly rather than assumed to already be there above the fold.
  await page.getByText("Team timeline").first().scrollIntoViewIfNeeded();

  // Selectable cells exist ONLY on the caller's own row (every other row's cells are `cursor-default`), so
  // this needs no row-scoping of its own - whichever comes first is a real, unblocked working day.
  const cell = page.locator("div.cursor-cell").first();
  await expect(cell).toBeVisible({ timeout: 30_000 });
  await cell.click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Request leave" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const start = dialog.getByLabel("Start date");
  const end = dialog.getByLabel("End date");
  await expect(start).not.toHaveValue("");
  // One cell pressed once - the range is a single day, not whatever the form defaulted to on its own.
  await expect(end).toHaveValue(await start.inputValue());

  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog");
  if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
    await discard.getByRole("button", { name: /Discard|Leave/ }).click();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
});
