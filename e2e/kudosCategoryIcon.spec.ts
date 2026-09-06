import { gotoRoute, toast, test, expect } from "./fixtures";

// The kudos category icon picker: a searchable grid, not a menu of ten fixed choices, and shared verbatim
// with the kudos art picker's own icon needs (`lib/categoryIcons.tsx`'s `IconPicker`). What's worth proving in
// a browser is the thing a grid of un-labelled icon buttons can get wrong that a dropdown never could: the
// search actually narrows to the icon typed for (not just "some" icons), the pick sticks on the trigger that
// opened it, and it survives being saved and read back rather than only living in the open popover's state.
test("a category's icon is found by search, picked, and reads back as picked after a save and reload", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E icon category ${Date.now()}`;

  await gotoRoute(page, "settings/kudos", "Kudos levels");
  await page.getByRole("button", { name: "Add category" }).click();
  const row = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Category name (e.g. Teamwork)") }).last();
  await row.getByPlaceholder("Category name (e.g. Teamwork)").fill(name);

  await row.getByRole("button", { name: "Pick icon" }).click();
  await page.getByPlaceholder("Search icons…").fill("rocket");
  const rocket = page.locator('button[title="rocket"]');
  // The search actually narrowed the grid - not "rocket is in there somewhere among all of them".
  await expect(page.locator("div.grid button")).toHaveCount(1);
  await expect(rocket).toBeVisible();
  await rocket.click();
  await expect(page.getByPlaceholder("Search icons…")).toHaveCount(0); // the popover closed on pick

  // Reopened, the SAME trigger shows rocket as the one already chosen - proof the pick landed on this row's
  // own state, not merely that the popover closed without erroring.
  await row.getByRole("button", { name: "Pick icon" }).click();
  await page.getByPlaceholder("Search icons…").fill("rocket");
  await expect(rocket).toHaveClass(/ring-primary/);
  await page.keyboard.press("Escape");

  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Kudos config saved")).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Kudos levels" }).first()).toBeVisible({ timeout: 30_000 });
    // The one this spec added is still the LAST category row: saving preserves array order, and "Add
    // category" only ever appends. `input[value=...]` would check the ATTRIBUTE React never writes for a
    // controlled field, not the live value, so position - not a CSS value match - is what finds it again.
    const savedRow = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Category name (e.g. Teamwork)") }).last();
    await expect(savedRow.getByPlaceholder("Category name (e.g. Teamwork)")).toHaveValue(name, { timeout: 30_000 });
    await savedRow.getByRole("button", { name: "Pick icon" }).click();
    await page.getByPlaceholder("Search icons…").fill("rocket");
    await expect(rocket).toHaveClass(/ring-primary/);
    await page.keyboard.press("Escape");
  } finally {
    // Leave the org's kudos config exactly as this run found it. Scoped by VALUE here, checked one row at a
    // time - the try block above may have failed before ever reaching the saved row, so this can't assume
    // "last" the way the happy path above does, and `input[value=...]` would only ever check the attribute
    // React never writes for a controlled field, never the live value.
    const rows = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Category name (e.g. Teamwork)") });
    const count = await rows.count();
    let target: import("@playwright/test").Locator | null = null;
    for (let i = 0; i < count; i++) {
      const candidate = rows.nth(i);
      if ((await candidate.getByPlaceholder("Category name (e.g. Teamwork)").inputValue()) === name) { target = candidate; break; }
    }
    if (target) {
      await target.getByRole("button", { name: "Remove category" }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Kudos config saved")).toBeVisible({ timeout: 30_000 });
    }
  }
});
