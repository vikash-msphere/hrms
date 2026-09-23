import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Disabling a vendor (the generic `useLifecycle` pair, wired through `SoftDeleteRowActions` - never exercised
// for vendors specifically) has a real, distinct consequence unlike the same mechanism on an org document: a
// disabled vendor drops out of the vendor picker on the expense form (`Expenses.tsx` filters
// `vendors.filter(v => !v.disabled)`), so nobody can file a fresh expense against a supplier the org has
// benched. Proven both ways: it disappears, then comes back.
test("disabling a vendor drops it from the expense form's vendor picker, and re-enabling brings it back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.) - it can surface as either status depending on where in the request
  // it lands.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  const name = `E2E disable vendor ${Date.now() % 1_000_000}`;

  const made = await page.request.post("/v1/vendors", { headers: SPA_HEADERS, data: { display_name: name } });
  expect(made.status(), await made.text()).toBe(200);
  const vendor = (await made.json()) as { path: string };

  // The field is the innermost div that BOTH carries the label and holds the picker it labels: on `hasText`
  // alone `.last()` resolves to the label's own wrapper, which has no button in it at all.
  const vendorField = (dialog: import("@playwright/test").Locator) => dialog.locator("div").filter({ hasText: "Vendor (optional)" }).filter({ has: page.getByRole("button") }).last();

  // Open New expense, check whether `name` is offered in the vendor picker, and close it again - three times
  // over in this spec (present, dropped, restored), and each close matters just as much as each check: Escape
  // (even the careful two-press version already here, animation-aware) has proven unreliable at actually
  // closing a dialog under load elsewhere in this suite - a reload is unconditional, so it is what clears a
  // stuck one. Retried too on the way IN: the picker trigger button can be mid-re-render (this dialog's own
  // vendor list re-fetches whenever another spec's own vendor write broadcasts) and briefly detach from under
  // a click already in flight.
  async function checkPicker(expectOffered: boolean) {
    await expect(async () => {
      await gotoRoute(page, "expenses", "Expenses");
      await page.getByRole("button", { name: "New expense" }).click();
      const dialog = page.getByRole("dialog");
      await vendorField(dialog).getByRole("button").click({ timeout: 10_000 });
      await page.getByPlaceholder("Search vendors…").fill(name);
      const option = page.getByRole("option", { name: new RegExp(`^${escapeRe(name)}`) });
      if (expectOffered) await expect(option).toBeVisible({ timeout: 15_000 });
      else await expect(option).toHaveCount(0, { timeout: 15_000 });

      await page.keyboard.press("Escape"); // close the popover
      // Wait for it to actually go: the popover is a dismissable layer with an exit ANIMATION, and while it
      // is still playing it is the topmost layer - a second Escape sent inside that window is spent on it,
      // and the dialog underneath never hears one.
      await expect(page.getByPlaceholder("Search vendors…")).toHaveCount(0);
      await page.keyboard.press("Escape"); // discard the dialog
      const discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
      if (await discard.count()) await discard.first().click();
      if (await page.getByRole("dialog").count()) await page.reload();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
  }

  try {
    // Present, before anything is touched.
    await checkPicker(true);

    await gotoRoute(page, "vendors", "Vendors");
    const row = page.locator("tbody tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
    await expect(toast(page, "Vendor disabled")).toBeVisible({ timeout: 30_000 });

    // Gone from the picker.
    await checkPicker(false);

    await gotoRoute(page, "vendors", "Vendors");
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "Enable", exact: true }).click();
    await expect(toast(page, "Vendor enabled")).toBeVisible({ timeout: 30_000 });

    // Back in the picker.
    await checkPicker(true);
  } finally {
    await purge(page, vendor.path);
  }
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
