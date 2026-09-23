import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// "This changes the CTC build-up, go ask Payroll" - the half of `useSplitStaleness` a caller who cannot
// re-apply gets instead of the banner. Editing a pay component can move every employee's cached basic /
// Special-Allowance split, and the old code only ever surfaced that to whoever COULD fix it - a cost-shifting
// edit by HR (who holds `pay-components.write` but not `compensation:reapplySplit`, per the seeded policy)
// used to go completely silent. It fires on every save regardless of whether anything actually moved (the
// dry-run is Payroll's to run, not HR's), which is what makes it safe to prove without staging real
// staleness: a throwaway component saved and removed is enough.
test("HR saving a pay component gets the advisory, not the reapply banner it cannot use", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("hr");
  const admin = await as("super"); // a `?force=true` purge is an admin's to make - HR's comes back 403
  const name = `E2E advisory component ${Date.now()}`;

  await gotoRoute(page, "settings/pay-components");
  // `.first()`: the toolbar button. An EMPTY table offers the very same action again in its placeholder
  // (DataTable takes one `createBtn` for both `toolbar` and `emptyAction`), and this catalog starts empty.
  await page.getByRole("button", { name: "New component" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Create", exact: true }).click();

  await expect(toast(page, "Pay component created")).toBeVisible({ timeout: 30_000 });
  // The advisory, not a "re-apply to all employees" button HR holds no grant to press.
  await expect(toast(page, "Employee splits may be out of date")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Re-apply to all employees" })).toHaveCount(0);

  await purgeComponent(admin, name);
});

async function purgeComponent(page: import("@playwright/test").Page, name: string): Promise<void> {
  const res = await page.request.get("/v1/pay-components?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  const row = results.find((c) => c.display_name === name);
  if (row) await purge(page, row.path);
}
