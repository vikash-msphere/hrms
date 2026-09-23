import { gotoRoute, toast, test, expect } from "./fixtures";

// The competencies and scale every review in the org rates against - `reviews.spec.ts` launches a cycle
// against whatever this already holds, but never writes to the editor that shapes it. A competency's `key` is
// stable once assigned (a review stores its ratings by key, so relabelling one must never silently detach it
// from ratings already given against it) - proven here by the round trip surviving a save and a cold reload,
// not by reading the key directly, since the editor never shows it.
test("a competency is added, saved, read back after a reload, and removed again", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const label = `E2E competency ${Date.now()}`;

  // "Framework" is the default tab of settings/performance - `reviews.spec.ts` clicks past it to "Review
  // cycles", so this is the one place the tab this spec needs is landed on for free.
  await gotoRoute(page, "settings/performance", "Performance framework");
  await page.getByRole("button", { name: "Add competency" }).click();
  const rows = page.locator("div.flex.items-center.gap-2").filter({ has: page.getByRole("button", { name: "Remove competency" }) });
  const added = rows.last();
  await added.getByPlaceholder("e.g. Impact & results").fill(label);

  await page.getByRole("button", { name: "Save framework" }).click();
  await expect(toast(page, "Framework saved")).toBeVisible({ timeout: 30_000 });

  // Cold, not just still on screen: the same page holding it in local state would pass even if the write
  // never landed.
  await page.reload();
  await expect(page.locator("h1").first()).toHaveText("Performance framework", { timeout: 30_000 });
  const reopenedRows = page.locator("div.flex.items-center.gap-2").filter({ has: page.getByRole("button", { name: "Remove competency" }) });
  await expect(reopenedRows.last().getByPlaceholder("e.g. Impact & results")).toHaveValue(label, { timeout: 30_000 });

  // Leave the org's framework exactly as this run found it - every other review spec reads this list.
  await reopenedRows.last().getByRole("button", { name: "Remove competency" }).click();
  await page.getByRole("button", { name: "Save framework" }).click();
  await expect(toast(page, "Framework saved")).toBeVisible({ timeout: 30_000 });
});
