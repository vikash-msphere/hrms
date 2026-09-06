import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Disabling a vendor (the generic `useLifecycle` pair, wired through `SoftDeleteRowActions` - never exercised
// for vendors specifically) has a real, distinct consequence unlike the same mechanism on an org document: a
// disabled vendor drops out of the vendor picker on the expense form (`Expenses.tsx` filters
// `vendors.filter(v => !v.disabled)`), so nobody can file a fresh expense against a supplier the org has
// benched. Proven both ways: it disappears, then comes back.
test("disabling a vendor drops it from the expense form's vendor picker, and re-enabling brings it back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E disable vendor ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/vendors", { headers: SPA_HEADERS, data: { display_name: name } });
  expect(made.status(), await made.text()).toBe(200);
  const vendor = (await made.json()) as { path: string };

  try {
    // Present, before anything is touched.
    await gotoRoute(page, "expenses", "Expenses");
    await page.getByRole("button", { name: "New expense" }).click();
    let dialog = page.getByRole("dialog");
    const vendorField = () => dialog.locator("div").filter({ hasText: "Vendor (optional)" }).last();
    await vendorField().getByRole("button").click();
    await page.getByPlaceholder("Search vendors…").fill(name);
    await expect(page.getByRole("button", { name: new RegExp(`^${escapeRe(name)}`) })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape"); // close the popover
    await page.keyboard.press("Escape"); // discard the dialog
    const discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    await gotoRoute(page, "vendors", "Vendors");
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
    await expect(toast(page, "Vendor disabled")).toBeVisible({ timeout: 30_000 });

    // Gone from the picker.
    await gotoRoute(page, "expenses", "Expenses");
    await page.getByRole("button", { name: "New expense" }).click();
    dialog = page.getByRole("dialog");
    await vendorField().getByRole("button").click();
    await page.getByPlaceholder("Search vendors…").fill(name);
    await expect(page.getByRole("button", { name: new RegExp(`^${escapeRe(name)}`) })).toHaveCount(0, { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const discard2 = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard2.count()) await discard2.first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    await gotoRoute(page, "vendors", "Vendors");
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Enable", exact: true }).click();
    await expect(toast(page, "Vendor enabled")).toBeVisible({ timeout: 30_000 });

    // Back in the picker.
    await gotoRoute(page, "expenses", "Expenses");
    await page.getByRole("button", { name: "New expense" }).click();
    dialog = page.getByRole("dialog");
    await vendorField().getByRole("button").click();
    await page.getByPlaceholder("Search vendors…").fill(name);
    await expect(page.getByRole("button", { name: new RegExp(`^${escapeRe(name)}`) })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const discard3 = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard3.count()) await discard3.first().click();
  } finally {
    await purge(page, vendor.path);
  }
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
