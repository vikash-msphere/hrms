import { gotoRoute, test, expect } from "./fixtures";

// The dashboard's own shortcut row - the org's pick of destinations and create flows (Settings → Dashboard →
// Shortcuts), read back by `resolveDashboardShortcuts` and drawn as a row of tiles that LEAD the page.
// `catalogEditors`/`settingsPanels` own the editor that builds the list; this is the one place that list is
// actually rendered and pressed, which is a different code path from the top-bar "+" menu that
// `quickCreate.spec.ts` covers - the same catalog, wired into the page a second way.
//
// Both kinds a tile can be, off the built-in default set: a PAGE tile is a plain navigation, an ACTION tile
// lands on its route with the create dialog already open (the intent hand-off `quickCreate` also exercises,
// from the menu rather than a tile).
test("a page tile navigates and an action tile opens its flow, both from the dashboard's own shortcut row", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("employee");

  await gotoRoute(page, "dashboard");
  const directoryTile = page.getByRole("button", { name: "Directory" });
  await expect(directoryTile).toBeVisible({ timeout: 30_000 });
  await directoryTile.click();
  await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible({ timeout: 30_000 });

  await gotoRoute(page, "dashboard");
  await page.getByRole("button", { name: "Request leave" }).click();
  // The intent that made the trip worth taking: the tile didn't just land on the page, it opened the form.
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Request leave" })).toBeVisible({ timeout: 30_000 });
  // The page underneath is asserted only once the dialog is gone: a modal takes the rest of the document out
  // of the accessibility tree, so its h1 is unreachable by role while the form is open.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Leaves" })).toBeVisible({ timeout: 30_000 });
});
