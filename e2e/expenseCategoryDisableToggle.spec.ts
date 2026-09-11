import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Disabling an expense category (the same `useLifecycle`/`SoftDeleteRowActions` pair as `vendorDisableToggle`,
// never exercised for categories) has the same class of real consequence: a disabled category drops out of
// the "New expense" form's Category picker (`Expenses.tsx` filters `categories.filter(c => !c.disabled)`),
// so nobody can file a fresh expense against a category the org has retired.
test("disabling an expense category drops it from the New expense form, and re-enabling brings it back", async ({ as }) => {
  // Three `checkPicker` passes at 150s apiece, plus the settings work between them.
  test.setTimeout(600_000);
  const page = await as("super");
  const name = `E2E disable category ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/expense-categories", { headers: SPA_HEADERS, data: { display_name: name } });
  expect(made.status(), await made.text()).toBe(200);
  const category = (await made.json()) as { path: string };

  // `has:` matches its inner locator INSIDE each candidate div, so the inner one must be relative: rooted at
  // `dialog` it would look for a dialog nested in the row and match nothing at all.
  const categoryField = (dialog: import("@playwright/test").Locator) => dialog.locator("div").filter({ hasText: "Category" }).filter({ has: page.getByRole("combobox") }).last();

  // Open New expense, check whether `name` is offered in the category picker, and close it again - three
  // times over in this spec (present, dropped, and restored), and each close matters just as much as each
  // check: Escape (with the draft guard's own Discard answered too) has proven unreliable at actually closing
  // a dialog under load elsewhere in this suite - a reload is unconditional, so it is what clears a stuck one.
  async function checkPicker(expectOffered: boolean) {
    await expect(async () => {
      // Every attempt starts from a page with NO dialog on it. An attempt that fails at the picker leaves the
      // New expense dialog open, and an open modal makes the page behind it inert - so the next attempt's
      // `gotoRoute` waits its full 30s for an <h1> the accessibility tree cannot see, and the remaining
      // attempts burn the budget without ever reaching the picker (which is exactly how this timed out).
      if (await page.getByRole("dialog").count()) await page.reload();
      await gotoRoute(page, "expenses", "Expenses");
      await page.getByRole("button", { name: "New expense" }).click();
      const dialog = page.getByRole("dialog");
      await categoryField(dialog).getByRole("combobox").click({ timeout: 10_000 });
      const option = page.getByRole("option", { name, exact: true });
      if (expectOffered) await expect(option).toBeVisible({ timeout: 15_000 });
      else await expect(option).toHaveCount(0, { timeout: 15_000 });

      // Closed by the dialog's OWN button rather than by Escape: a toast is its own dismissable layer, so a key
      // press lands on whatever notification the run happens to be showing and the dialog stays put. Escape is
      // kept only as the fallback for a dialog that offers no such button.
      await page.keyboard.press("Escape"); // the open picker itself, which holds focus and would eat the click below
      const cancel = page.getByRole("dialog").getByRole("button", { name: /^(Cancel|Close)$/ });
      if (await cancel.count()) await cancel.first().click();
      else await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
      if (await discard.count()) await discard.first().click();
      if (await page.getByRole("dialog").count()) await page.reload();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
      // 150s, not 90: `gotoRoute`'s own wait for the page is 30s, so a lane slow enough to miss it spends a
      // whole pass on that one wait and a 90s budget buys only three attempts - which is how this failed
      // "element(s) not found" three times over rather than ever getting to the picker.
    }).toPass({ timeout: 150_000 });
  }

  try {
    // Present, before anything is touched.
    await checkPicker(true);

    await gotoRoute(page, "settings/expenses");
    await page.getByRole("tab", { name: "Categories" }).click();
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
    await expect(toast(page, "Category disabled")).toBeVisible({ timeout: 30_000 });

    // Gone from the picker.
    await checkPicker(false);

    await gotoRoute(page, "settings/expenses");
    await page.getByRole("tab", { name: "Categories" }).click();
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Enable", exact: true }).click();
    await expect(toast(page, "Category enabled")).toBeVisible({ timeout: 30_000 });

    // Back in the picker.
    await checkPicker(true);
  } finally {
    await purge(page, category.path);
  }
});
