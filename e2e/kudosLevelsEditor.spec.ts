import { gotoRoute, toast, test, expect } from "./fixtures";

// The recognition LEVELS themselves - `kudosCategoryIcon.spec.ts` and its art-picker sibling already prove
// the CATEGORY rows (icon/art/name) survive a save, but neither ever touches a level: the tiers whose
// points actually feed the "most recognized" leaderboard. Add one, give it a point value, and prove it reads
// back after a save and reload rather than only living in the open editor's own state.
test("a new kudos level is added with its own points, and reads back after a save and reload", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E level ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/kudos", "Kudos levels");
  await page.getByRole("button", { name: "Add level" }).click();
  const row = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Level name (e.g. Impact)") }).last();
  await row.getByPlaceholder("Level name (e.g. Impact)").fill(name);
  await row.locator('input[type="number"]').fill("77");

  try {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Kudos config saved")).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Kudos levels" }).first()).toBeVisible({ timeout: 30_000 });
    // "Add level" only ever appends, so the level this spec made is still the last row.
    const saved = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Level name (e.g. Impact)") }).last();
    await expect(saved.getByPlaceholder("Level name (e.g. Impact)")).toHaveValue(name, { timeout: 30_000 });
    await expect(saved.locator('input[type="number"]')).toHaveValue("77");
  } finally {
    // Leave the org's levels exactly as found - scoped by the name this spec typed, not by position, since
    // the try block above may have failed before ever reaching the saved row.
    const rows = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Level name (e.g. Impact)") });
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const candidate = rows.nth(i);
      if ((await candidate.getByPlaceholder("Level name (e.g. Impact)").inputValue()) === name) {
        await candidate.getByRole("button", { name: "Remove level" }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(toast(page, "Kudos config saved")).toBeVisible({ timeout: 30_000 });
        break;
      }
    }
  }
});
