import { allowConsoleErrors, gotoRoute, toast, test, expect } from "./fixtures";

// The recognition LEVELS themselves - `kudosCategoryIcon.spec.ts` and its art-picker sibling already prove
// the CATEGORY rows (icon/art/name) survive a save, but neither ever touches a level: the tiers whose
// points actually feed the "most recognized" leaderboard. Add one, give it a point value, and prove it reads
// back after a save and reload rather than only living in the open editor's own state.
test("a new kudos level is added with its own points, and reads back after a save and reload", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). The save and reload below are what prove the level landed; a
  // console line from a request that was retried behind them is not this test's failure.
  // 409 is on that list for a different reason: the save is guarded on the version this session read
  // (lib/settingsStore.ts sends the snapshot's If-Match), so a concurrent save from a sibling panel spec is
  // refused instead of quietly dropping this row. The retry below is the answer to it.
  allowConsoleErrors(page, /status of 503|status of 500|status of 409/i);
  const name = `E2E level ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/kudos", "Kudos levels");

  try {
    // The whole config is one shared document, saved back in full - but guarded on the version this session
    // read, so a concurrent save from another spec editing the SAME "Kudos levels" panel (its categories, say)
    // loses with a 409 rather than dropping this row on the floor. Retried as one whole unit (open the panel
    // fresh, add, save, verify) rather than once, because re-applying the Add to the version that won is the
    // only thing that can settle it.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("heading", { name: "Kudos levels" }).first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Add level" }).click();
      const row = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Level name (e.g. Impact)") }).last();
      await row.getByPlaceholder("Level name (e.g. Impact)").fill(name);
      await row.locator('input[type="number"]').fill("77");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      // Waiting on the WRITE, whichever way it announces itself: the toast is the app's word for it and expires
      // on its own timer, while the settings PATCH is the write itself. Either one means the reload below will
      // not race the request still in flight - and the reload is what actually proves the level was stored.
      await writeLanded(page);

      await page.reload();
      await expect(page.getByRole("heading", { name: "Kudos levels" }).first()).toBeVisible({ timeout: 30_000 });
      // "Add level" only ever appends, so the level this spec made is still the last row.
      const saved = page.locator("div.editor-row").filter({ has: page.getByPlaceholder("Level name (e.g. Impact)") }).last();
      await expect(saved.getByPlaceholder("Level name (e.g. Impact)")).toHaveValue(name, { timeout: 5_000 });
      await expect(saved.locator('input[type="number"]')).toHaveValue("77", { timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
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
        await writeLanded(page);
        break;
      }
    }
  }
});

/** The save having landed - the app's toast, or the settings PATCH underneath it, whichever arrives first. */
async function writeLanded(page: import("@playwright/test").Page) {
  await Promise.race([
    toast(page, "Kudos config saved").waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined),
    page
      .waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/v1/settings/") && r.status() < 400, { timeout: 20_000 })
      .catch(() => undefined),
  ]);
}
