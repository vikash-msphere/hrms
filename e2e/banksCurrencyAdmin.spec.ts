import { allowConsoleErrors, gotoRoute, patchOrgSettings, test, expect, toast } from "./fixtures";

// Banks & currency (Settings -> Company) - the allow-list every currency/bank picker in the app draws from,
// plus the per-currency display/payout decimal places (INR at 0 renders whole rupees, not paise). Never
// touched by any spec: additive only here (a currency ADDED to the list, nothing already allowed removed),
// so this can't disturb whatever default_currency or existing allowed codes any other spec relies on.
test("a currency is added to the allow-list with its own decimal places, saved, and read back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). What the allow-list reads back is what this test proves, and the
  // retry below already re-reads it; a console line from a request retried behind that is not its failure.
  // A 409 belongs on that list too, and for a better reason than a hiccup: the panel's Save is GUARDED on the
  // version it read (lib/settingsStore.ts sends the snapshot's If-Match), so a concurrent save from another
  // settings-panel spec is REFUSED rather than allowed to overwrite. That refusal is the app working, and the
  // retry below is what answers it - from a fresh mount, holding the version that save then wins on.
  allowConsoleErrors(page, /status of 503|status of 500|status of 409/i);

  try {
    // Retried as one whole unit: this panel's Save reads the WHOLE settings/organization blob at page-mount
    // and writes the whole thing back (Settings.tsx's useOrgBlob), guarded on the version that mount read. A
    // concurrent Save from another settings-panel spec (default department, quick actions, letter defaults)
    // therefore does not silently overwrite `currencies` - it makes THIS save lose, with a 409, which is the
    // outcome worth having. Redone from a fresh mount whenever the save, the reload or the reread doesn't
    // confirm it.
    await expect(async () => {
      await gotoRoute(page, "settings/banks-currency", "Banks & currency");

      const currenciesField = page.getByLabel("Allowed currencies");
      const current = await currenciesField.inputValue();
      if (current.toUpperCase().includes("JPY")) return; // a previous pass of this retry already landed it
      await currenciesField.fill(`${current}, JPY`);

      // The decimal-places list follows the allowed list live - JPY gets its own row with a preview the
      // moment it's added, before anything is saved.
      const jpyRow = page.locator("div").filter({ hasText: /^JPY/ }).last();
      await expect(jpyRow).toBeVisible({ timeout: 15_000 });
      const jpyDp = jpyRow.getByRole("spinbutton");
      await jpyDp.fill("0");
      await expect(jpyRow.getByText("¥1,235", { exact: false })).toBeVisible();

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Banks & currency saved")).toBeVisible({ timeout: 30_000 });

      await page.reload();
      await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByLabel("Allowed currencies")).toHaveValue(/JPY/i, { timeout: 5_000 });
      const jpyRow2 = page.locator("div").filter({ hasText: /^JPY/ }).last();
      await expect(jpyRow2.getByRole("spinbutton")).toHaveValue("0", { timeout: 5_000 });

      const reread = await page.request.get("/v1/settings/organization");
      expect(reread.status(), await reread.text()).toBe(200);
      const value = ((await reread.json()) as { value?: { currencies?: string[]; currency_decimals?: Record<string, number> } }).value ?? {};
      expect(value.currencies).toContain("JPY");
      expect(value.currency_decimals?.JPY).toBe(0);
    }).toPass({ timeout: 90_000 });
  } finally {
    // Only the two fields this spec itself set, merged onto whatever the row looks like NOW rather than a
    // snapshot from before this test's own edit - by cleanup time that snapshot is definitely stale (this
    // test's own Save already moved the row past it), and restoring it whole would take back out whatever
    // ANOTHER panel's spec (banks, quick actions, letter defaults, default department) wrote to a different
    // key of this same blob in the meantime.
    await patchOrgSettings(page, (blob) => {
      const currencies = (Array.isArray(blob.currencies) ? (blob.currencies as string[]) : []).filter((c) => c !== "JPY");
      const decimals = { ...((blob.currency_decimals as Record<string, number> | undefined) ?? {}) };
      delete decimals.JPY;
      return { ...blob, currencies, currency_decimals: decimals };
    });
  }
});
