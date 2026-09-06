import { SPA_HEADERS, gotoRoute, test, expect, toast } from "./fixtures";

// Banks & currency (Settings -> Company) - the allow-list every currency/bank picker in the app draws from,
// plus the per-currency display/payout decimal places (INR at 0 renders whole rupees, not paise). Never
// touched by any spec: additive only here (a currency ADDED to the list, nothing already allowed removed),
// so this can't disturb whatever default_currency or existing allowed codes any other spec relies on.
test("a currency is added to the allow-list with its own decimal places, saved, and read back", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");

  const before = await page.request.get("/v1/settings/organization");
  const previous = before.ok() ? ((await before.json()) as { value?: Record<string, unknown> }).value ?? {} : {};

  try {
    await gotoRoute(page, "settings/banks-currency", "Banks & currency");

    const currenciesField = page.getByLabel("Allowed currencies");
    const current = await currenciesField.inputValue();
    expect(current.toUpperCase()).not.toContain("JPY");
    await currenciesField.fill(`${current}, JPY`);

    // The decimal-places list follows the allowed list live - JPY gets its own row with a preview the moment
    // it's added, before anything is saved.
    const jpyRow = page.locator("div").filter({ hasText: /^JPY/ }).last();
    await expect(jpyRow).toBeVisible({ timeout: 15_000 });
    const jpyDp = jpyRow.getByRole("spinbutton");
    await jpyDp.fill("0");
    await expect(jpyRow.getByText("¥1,235", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Banks & currency saved")).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Allowed currencies")).toHaveValue(/JPY/i, { timeout: 30_000 });
    const jpyRow2 = page.locator("div").filter({ hasText: /^JPY/ }).last();
    await expect(jpyRow2.getByRole("spinbutton")).toHaveValue("0");

    const reread = await page.request.get("/v1/settings/organization");
    expect(reread.status(), await reread.text()).toBe(200);
    const value = ((await reread.json()) as { value?: { currencies?: string[]; currency_decimals?: Record<string, number> } }).value ?? {};
    expect(value.currencies).toContain("JPY");
    expect(value.currency_decimals?.JPY).toBe(0);
  } finally {
    await page.request.patch("/v1/settings/organization", { headers: SPA_HEADERS, data: { value: previous } });
  }
});
