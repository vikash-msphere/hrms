import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Disabling an expense category (the same `useLifecycle`/`SoftDeleteRowActions` pair as `vendorDisableToggle`,
// never exercised for categories) has the same class of real consequence: a disabled category drops out of
// the "New expense" form's Category picker (`Expenses.tsx` filters `categories.filter(c => !c.disabled)`),
// so nobody can file a fresh expense against a category the org has retired.
test("disabling an expense category drops it from the New expense form, and re-enabling brings it back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E disable category ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/expense-categories", { headers: SPA_HEADERS, data: { display_name: name } });
  expect(made.status(), await made.text()).toBe(200);
  const category = (await made.json()) as { path: string };

  const categoryField = (dialog: import("@playwright/test").Locator) => dialog.locator("div").filter({ hasText: "Category" }).filter({ has: dialog.getByRole("combobox") }).last();

  try {
    // Present, before anything is touched.
    await gotoRoute(page, "expenses", "Expenses");
    await page.getByRole("button", { name: "New expense" }).click();
    let dialog = page.getByRole("dialog");
    await categoryField(dialog).getByRole("combobox").click();
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    let discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    await gotoRoute(page, "settings/expenses");
    await page.getByRole("tab", { name: "Categories" }).click();
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
    await expect(toast(page, "Category disabled")).toBeVisible({ timeout: 30_000 });

    // Gone from the picker.
    await gotoRoute(page, "expenses", "Expenses");
    await page.getByRole("button", { name: "New expense" }).click();
    dialog = page.getByRole("dialog");
    await categoryField(dialog).getByRole("combobox").click();
    await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    await gotoRoute(page, "settings/expenses");
    await page.getByRole("tab", { name: "Categories" }).click();
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Enable", exact: true }).click();
    await expect(toast(page, "Category enabled")).toBeVisible({ timeout: 30_000 });

    // Back in the picker.
    await gotoRoute(page, "expenses", "Expenses");
    await page.getByRole("button", { name: "New expense" }).click();
    dialog = page.getByRole("dialog");
    await categoryField(dialog).getByRole("combobox").click();
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
  } finally {
    await purge(page, category.path);
  }
});
