import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Disabling a reimbursement category (same `useLifecycle`/`SoftDeleteRowActions` pair as
// `vendorDisableToggle`/`expenseCategoryDisableToggle`) drops it from the "New claim" dialog's Category
// picker (`Reimbursements.tsx` filters `categories.filter(c => !c.disabled)`), so nobody can file a fresh
// claim against a category the org has retired. Never exercised - `reimbursementCategoryReceipt.spec.ts`
// only ever creates categories, never disables one.
test("disabling a reimbursement category drops it from the New claim form, and re-enabling brings it back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E disable reimb category ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/reimbursement-categories", { headers: SPA_HEADERS, data: { display_name: name } });
  expect(made.status(), await made.text()).toBe(200);
  const category = (await made.json()) as { path: string };

  // `has:` matches its inner locator INSIDE each candidate div, so the inner one must be relative: rooted at
  // `dialog` it would look for a dialog nested in the field and match nothing at all.
  const categoryField = (dialog: import("@playwright/test").Locator) => dialog.locator("div").filter({ hasText: "Category" }).filter({ has: page.getByRole("combobox") }).last();

  // Open New claim, check whether `name` is offered in the category picker, and close it again - three times
  // over in this spec (present, dropped, restored), and each close matters just as much as each check: Escape
  // (even the careful two-press version already here, animation-aware) has proven unreliable at actually
  // closing a dialog under load elsewhere in this suite - a reload is unconditional, so it is what clears a
  // stuck one.
  async function checkPicker(expectOffered: boolean) {
    await expect(async () => {
      await gotoRoute(page, "reimbursements", "Reimbursements");
      await page.getByRole("button", { name: "New claim" }).first().click();
      const dialog = page.getByRole("dialog");
      await categoryField(dialog).getByRole("combobox").click({ timeout: 10_000 });
      const option = page.getByRole("option", { name, exact: true });
      if (expectOffered) await expect(option).toBeVisible({ timeout: 15_000 });
      else await expect(option).toHaveCount(0, { timeout: 15_000 });

      await page.keyboard.press("Escape"); // closes the picker
      // Wait for it to actually go: the picker is a dismissable layer with an exit ANIMATION, and while that
      // is still playing it is the topmost layer - a second Escape inside that window is spent on it, and the
      // dialog underneath never hears one.
      await expect(option).toHaveCount(0);
      await page.keyboard.press("Escape"); // and now the dialog
      const discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
      if (await discard.count()) await discard.first().click();
      if (await page.getByRole("dialog").count()) await page.reload();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
  }

  try {
    // Present, before anything is touched.
    await checkPicker(true);

    await gotoRoute(page, "settings/reimbursements");
    await page.getByRole("tab", { name: "Categories" }).click();
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
    await expect(toast(page, "Category disabled")).toBeVisible({ timeout: 30_000 });

    // Gone from the picker.
    await checkPicker(false);

    await gotoRoute(page, "settings/reimbursements");
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
