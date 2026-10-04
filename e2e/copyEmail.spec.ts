import { ROLES, gotoRoute, test, expect } from "./fixtures";

// The address, on the clipboard.
//
// Every email in the app is rendered through one component, and the reason is a rule: an address is never a
// standalone "copy" button and never plain selectable text somebody has to drag across - it is the address
// with a copy icon that appears on hover (and on keyboard focus, so touch and Tab both reach it). What that
// component does can only be observed in a browser: it writes to the real clipboard through the async
// Clipboard API, which has no server side, no DOM trace, and fails silently when the page is not permitted.
//
// So this is the one spec that reads the clipboard back. The permission is granted to the context on purpose
// - a browser that refuses it is the failure mode this feature was written around, and the assertion has to
// be the text that actually landed, not a toast that says it did.
test("an email is copied from the directory, exactly as written", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  // Reading the clipboard is a permission, and Chromium withholds it from a page that never asked. Granted
  // for this context only, which is what makes the read below possible at all.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await gotoRoute(page, "employees", "Directory");
  await page.getByRole("searchbox", { name: "Search people…" }).first().fill("Eve");
  const row = page.locator('tbody tr[role="button"]').filter({ hasText: "Eve Employee" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });

  // The icon is drawn only while the pointer (or focus) is on the address, so this is a hover and then a
  // press - the same order a person does it in, and the reason the affordance is invisible to a screenshot.
  const email = row.getByText(ROLES.employee);
  await email.hover();
  await row.getByRole("button", { name: "Copy email" }).first().click();

  // What is on the clipboard: the address alone, with none of the row's furniture around it.
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 })
    .toBe(ROLES.employee);
});
