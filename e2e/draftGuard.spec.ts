import { gotoRoute, test, expect } from "./fixtures";

// A half-filled form does not evaporate.
//
// Radix funnels Esc, a click on the backdrop and the X button through one `onOpenChange(false)`, and the app
// intercepts all three in one place (`components/common/dialogGuard.ts`): an untouched form closes instantly,
// a dirty one asks first. On a phone the back gesture joins them - the dialog primitive owns a history entry
// and replays a back press as an Esc (`lib/dialogHistory.ts`), which is what makes a modal behave like the
// screen it looks like.
//
// Every part of that is the browser: real key events, Radix's focus and close plumbing, and the session
// history stack. There is no request to observe, and the source scans can see that a dialog is WIRED to the
// guard but not that a draft survives the press.
test.describe("dialog draft guard", () => {
  test("Esc on a dirty form asks first, keeps what was typed, and discards on purpose", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors", "Vendors");

    const name = `E2E guarded vendor ${Date.now()}`;
    await page.getByRole("button", { name: "New vendor" }).click();
    const form = page.getByRole("dialog").filter({ hasText: "New vendor" });
    const nameField = form.getByPlaceholder("Vendor or supplier name");
    await nameField.fill(name);

    // The accident: Esc with a form full of work.
    await page.keyboard.press("Escape");
    const confirm = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
    await expect(confirm).toBeVisible();

    // Backing out of the discard leaves the draft exactly as it was - the whole point of asking.
    await confirm.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Discard your changes?" })).toHaveCount(0);
    await expect(nameField).toHaveValue(name);

    // Meaning it: the second answer really throws the draft away.
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").filter({ hasText: "Discard your changes?" }).getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Nothing was written, and the page underneath never moved.
    await expect(page.locator("tbody tr").filter({ hasText: name })).toHaveCount(0);
    expect(page.url()).toMatch(/#\/vendors\b/);
  });

  test("an untouched form closes at once, and the back press closes the dialog rather than the page", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors", "Vendors");

    // Nothing typed: a guard that fires here would just be a second click on every cancel.
    await page.getByRole("button", { name: "New vendor" }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "New vendor" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The back gesture: the dialog owns a history entry, so going back dismisses the modal and leaves the
    // reader on the page they opened it from - not on whatever they were looking at before it.
    await page.getByRole("button", { name: "New vendor" }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "New vendor" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Vendors" })).toBeVisible();
    expect(page.url()).toMatch(/#\/vendors\b/);
  });

  test("the back press is guarded too, so a draft cannot be swiped away", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "vendors", "Vendors");

    await page.getByRole("button", { name: "New vendor" }).click();
    const form = page.getByRole("dialog").filter({ hasText: "New vendor" });
    const nameField = form.getByPlaceholder("Vendor or supplier name");
    await nameField.fill(`E2E back-press vendor ${Date.now()}`);

    await page.goBack();
    const confirm = page.getByRole("dialog").filter({ hasText: "Discard your changes?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Keep editing" }).click();
    await expect(form).toBeVisible();
    await expect(nameField).not.toHaveValue("");
  });
});
