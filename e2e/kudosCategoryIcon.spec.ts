import { allowConsoleErrors, gotoRoute, toast, test, expect } from "./fixtures";

// The kudos category icon picker: a searchable grid, not a menu of ten fixed choices, and shared verbatim
// with the kudos art picker's own icon needs (`lib/categoryIcons.tsx`'s `IconPicker`). What's worth proving in
// a browser is the thing a grid of un-labelled icon buttons can get wrong that a dropdown never could: the
// search actually narrows to the icon typed for (not just "some" icons), the pick sticks on the trigger that
// opened it, and it survives being saved and read back rather than only living in the open popover's state.
test("a category's icon is found by search, picked, and reads back as picked after a save and reload", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  // The panel's save is guarded on the version this session read (lib/settingsStore.ts sends the snapshot's
  // If-Match), so a concurrent save from a sibling panel spec is REFUSED rather than allowed to drop this
  // category. That refusal is the app working; the retry below is the answer to it.
  allowConsoleErrors(page, /status of 409/i);
  const name = `E2E icon category ${Date.now()}`;

  await gotoRoute(page, "settings/kudos", "Kudos levels");
  const rocket = page.locator('button[title="rocket"]');

  try {
    // The whole config is one shared document, saved back in full - but guarded on the version this session
    // read, so a concurrent save from another spec on this SAME "Kudos levels" panel
    // (`kudosLevelsEditor.spec.ts`'s own levels, say) loses with a 409 instead of dropping this category on
    // the floor. Retried as one whole unit (open the panel fresh, add, pick, save, verify), because
    // re-applying the Add to the version that won is the only thing that can settle it.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("heading", { name: "Kudos levels" }).first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Add category" }).click();
      const row = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Category name (e.g. Teamwork)") }).last();
      await row.getByPlaceholder("Category name (e.g. Teamwork)").fill(name);

      await row.getByRole("button", { name: "Pick icon" }).click();
      await page.getByPlaceholder("Search icons…").fill("rocket");
      // The search actually narrowed the grid - not "rocket is in there somewhere among all of them".
      await expect(page.locator("div.grid button")).toHaveCount(1);
      await expect(rocket).toBeVisible();
      await rocket.click();
      await expect(page.getByPlaceholder("Search icons…")).toHaveCount(0); // the popover closed on pick

      // Reopened, the SAME trigger shows rocket as the one already chosen - proof the pick landed on this
      // row's own state, not merely that the popover closed without erroring.
      await row.getByRole("button", { name: "Pick icon" }).click();
      await page.getByPlaceholder("Search icons…").fill("rocket");
      await expect(rocket).toHaveClass(/ring-primary/);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Kudos config saved")).toBeVisible({ timeout: 30_000 });

      await page.reload();
      await expect(page.getByRole("heading", { name: "Kudos levels" }).first()).toBeVisible({ timeout: 30_000 });
      // Found by its own NAME, whichever position it comes back in. `input[value=...]` would check the
      // ATTRIBUTE React never writes for a controlled field, and `hasText` cannot see an input's value at
      // all - so the rows are read one at a time and matched on the live value. Position is not the thing
      // being tested here, and assuming the row is last made this fail against a config whose final row is
      // simply the last SEEDED category.
      const rows = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Category name (e.g. Teamwork)") });
      const field = (row: import("@playwright/test").Locator) => row.getByPlaceholder("Category name (e.g. Teamwork)");
      let savedRow: import("@playwright/test").Locator | undefined;
      for (let i = 0; i < (await rows.count()); i++) {
        if ((await field(rows.nth(i)).inputValue()) === name) {
          savedRow = rows.nth(i);
          break;
        }
      }
      if (!savedRow) throw new Error(`e2e: the category "${name}" is not in the saved config`);
      await savedRow.getByRole("button", { name: "Pick icon" }).click();
      await page.getByPlaceholder("Search icons…").fill("rocket");
      await expect(rocket).toHaveClass(/ring-primary/, { timeout: 5_000 });
      await page.keyboard.press("Escape");
    }).toPass({ timeout: 150_000 });
  } finally {
    // Leave the org's kudos config exactly as this run found it. Scoped by VALUE here, checked one row at a
    // time - the try block above may have failed before ever reaching the saved row, so this can't assume
    // "last" the way the happy path above does, and `input[value=...]` would only ever check the attribute
    // React never writes for a controlled field, never the live value. Every matching row, not just the
    // first: a retry above that saved successfully but failed its OWN verification re-adds this same name on
    // its next attempt, so more than one can exist by the time this runs.
    await page.reload().catch(() => undefined);
    for (let guard = 0; guard < 5; guard++) {
      const rows = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Category name (e.g. Teamwork)") });
      const count = await rows.count();
      let target: import("@playwright/test").Locator | null = null;
      for (let i = 0; i < count; i++) {
        const candidate = rows.nth(i);
        if ((await candidate.getByPlaceholder("Category name (e.g. Teamwork)").inputValue()) === name) { target = candidate; break; }
      }
      if (!target) break;
      await target.getByRole("button", { name: "Remove category" }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Kudos config saved")).toBeVisible({ timeout: 30_000 });
    }
  }
});
